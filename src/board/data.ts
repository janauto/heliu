/**
 * 看板数据层：在 M1 对账（reconcile）与 M2 台账（Ledger / groupTodo / syncLedger）之上组装看板视图。
 *
 * - 对账结果按「项目 × 是否预检」缓存 20 秒，并发请求共用同一次扫描（页面多处同时拉数据）。
 * - 台账每次请求现读（纯文本，很快），所以改预约后立刻可见，不用清缓存。
 * - 写操作只经过 Ledger（台账目录）与 M4 的 previewRelease（releases/<里程碑>.md 合并单），绝不碰被管理仓库。
 * - 合并预演不自己判档：直接调用 M4 buildReleasePlan（与 heliu 合并 --预演 同一个函数），只做字段映射。
 */
import { readFileSync, statSync } from "node:fs";
import type {
  FeatureBinding,
  FeatureView,
  LedgerFeature,
  LedgerMilestone,
  ReconcileReport,
  RepoReport,
  SessionView,
  TodoGroupKey,
  TodoItem,
  TodoReport,
} from "../types.ts";
import { Cache, type StopRecord } from "../core/cache.ts";
import { DEFAULT_TIMEOUT_MS } from "../core/git.ts";
import { Ledger, LedgerError, NEXT_ALIASES, parseFeatureStatus, VNEXT } from "../core/ledger.ts";
import type { HeliuPaths } from "../core/paths.ts";
import { loadProject, type ProjectConfig } from "../core/project.ts";
import { loadSessionContext, reconcile, type ReconcileResult } from "../core/reconcile.ts";
import { syncLedger, type SyncResult } from "../core/sync.ts";
import { bindingKey, sourceBranchIndex, zeroCommitBranches } from "../core/owncommits.ts";
import { countsTowardTodo, groupTodo, precheckStateOf, STALE_DAYS, summarizePrecheck, TODO_GROUP_DEFS, todoFeatures } from "../core/todo.ts";
import { topActions } from "../cli/render.ts";
import type {
  BaselineData,
  BoardCard,
  BoardColumn,
  BoardMeta,
  CardBinding,
  CardSession,
  CardTag,
  FeaturesData,
  HygieneData,
  Light,
  OverviewData,
  ReleaseAction,
  ReleaseBinding,
  ReleaseItem,
  ReleasePlanResult,
  ReleasePreview,
  ReleaseTier,
} from "./api-types.ts";
import { buildReleasePlan, previewRelease, type BuildResult } from "../core/release.ts";
import { ACTION_TEXT, TIER_OF, type ItemState } from "../core/release-plan.ts";
import { baselinePreview } from "./baseline.ts";
import { buildHygiene } from "./hygiene.ts";

export const STATUS_TTL_MS = 20_000;
export const UNRESERVED = "__unreserved";
export const RELEASED = "__released";

export interface Scan {
  result: ReconcileResult;
  /** 会话 id → 会话 JSON 文件（取 claude:// 链接用） */
  sessionFiles: Map<string, string>;
  at: number;
  ms: number;
  precheck: boolean;
  /** 「尚无独有提交」判定缓存（bindingKey → 是否），随扫描一起过期 */
  zero: Map<string, boolean>;
}

export interface BoardOptions {
  paths: HeliuPaths;
  /** 启动时解析好的项目；每次扫描前按名字重读 project.yaml（读不到就用这份） */
  project: ProjectConfig;
  ttlMs?: number;
  timeoutMs?: number;
  now?: () => Date;
}

const LIGHT_OF: Record<TodoGroupKey, Light> = {
  blocked: "purple",
  conflict: "red",
  mergeable: "green",
  behind: "yellow",
  stale: "gray",
  active: "gray",
  unbound: "gray",
};

const GROUP_ORDER: TodoGroupKey[] = ["blocked", "conflict", "mergeable", "behind", "stale", "active", "unbound"];

const maxIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

/** 会话 JSON 里的 claude:// 链接（只读文件、正则取第一个；没有就 null，绝不自造） */
const LINK_RE = /claude:\/\/[^\s"'\\<>]+/;

export class BoardService {
  readonly paths: HeliuPaths;
  private readonly initial: ProjectConfig;
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly scans = new Map<string, Scan>();
  private readonly inflight = new Map<string, Promise<Scan>>();
  private readonly linkCache = new Map<string, { mtimeMs: number; link: string | null }>();

  constructor(opts: BoardOptions) {
    this.paths = opts.paths;
    this.initial = opts.project;
    this.ttlMs = opts.ttlMs ?? STATUS_TTL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = opts.now ?? (() => new Date());
  }

  get project(): ProjectConfig {
    try {
      return loadProject(this.paths, this.initial.name);
    } catch {
      return this.initial;
    }
  }

  ledger(project = this.project): Ledger {
    return Ledger.of(project);
  }

  /* ───────────── 扫描与缓存 ───────────── */

  /** fresh=true 跳过 20 秒缓存（「重新检查」按钮）；并发请求仍共用同一次扫描 */
  async scan(precheck: boolean, fresh = false): Promise<{ scan: Scan; cached: boolean }> {
    const key = `${this.initial.name}\u0000${precheck ? 1 : 0}`;
    const hit = this.scans.get(key);
    if (!fresh && hit && Date.now() - hit.at < this.ttlMs) return { scan: hit, cached: true };
    let p = this.inflight.get(key);
    const joined = !!p;
    if (!p) {
      p = this.runScan(precheck).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    const scan = await p;
    this.scans.set(key, scan);
    return { scan, cached: joined };
  }

  private async runScan(precheck: boolean): Promise<Scan> {
    const project = this.project;
    const started = performance.now();
    const ctx = loadSessionContext(this.paths);
    const result = await reconcile(project, this.paths, { precheck, dirty: false, timeoutMs: this.timeoutMs }, { now: this.now(), sessionContext: ctx });
    const sessionFiles = new Map(ctx.sessions.map((s) => [s.sessionId, s.file]));
    return { result, sessionFiles, at: Date.now(), ms: Math.round(performance.now() - started), precheck, zero: new Map() };
  }

  /** 预热：启动时后台先扫一遍，打开页面时直接命中缓存 */
  warm(): void {
    void this.scan(false).catch(() => undefined);
    void this.scan(true).catch(() => undefined);
  }

  meta(scan: Scan, cached: boolean): BoardMeta {
    return { scannedAt: scan.result.report.generatedAt, scanMs: scan.ms, cached, precheck: scan.precheck };
  }

  private stops(project: ProjectConfig): StopRecord[] {
    try {
      const c = Cache.open(this.paths, project.name, { readonly: true });
      if (!c) return [];
      try {
        return c.stops();
      } finally {
        c.close();
      }
    } catch {
      return []; // 缓存可删可重建，读不到就当没有
    }
  }

  /** M2 第 2 轮「尚无独有提交」：与 heliu 待办 同一个函数（zeroCommitBranches），结果按扫描缓存 */
  private async zeroCommit(scan: Scan, features: LedgerFeature[]): Promise<Set<string>> {
    const want = features.flatMap((f) => f.bindings.map((b) => ({ repo: b.repo, branch: b.branch })));
    const missing = want.filter((c) => !scan.zero.has(bindingKey(c.repo, c.branch)));
    if (missing.length) {
      const hit = await zeroCommitBranches(scan.result.report, missing, { sourceOf: sourceBranchIndex(this.paths, scan.result.report) });
      for (const c of missing) scan.zero.set(bindingKey(c.repo, c.branch), hit.has(bindingKey(c.repo, c.branch)));
    }
    return new Set([...scan.zero].filter(([, v]) => v).map(([k]) => k));
  }

  private nextOf(milestones: LedgerMilestone[]): { id: string; status: LedgerMilestone["status"] } | null {
    const n = milestones.find((m) => m.status === "规划中");
    return n ? { id: n.id, status: n.status } : null;
  }

  sessionLink(scan: Scan, sessionId: string | null): string | null {
    if (!sessionId) return null;
    const file = scan.sessionFiles.get(sessionId);
    if (!file) return null;
    try {
      const mtimeMs = statSync(file).mtimeMs;
      const c = this.linkCache.get(file);
      if (c && c.mtimeMs === mtimeMs) return c.link;
      const link = LINK_RE.exec(readFileSync(file, "utf8"))?.[0] ?? null;
      this.linkCache.set(file, { mtimeMs, link });
      return link;
    } catch {
      return null;
    }
  }

  /* ───────────── 只读视图 ───────────── */

  async status(precheck: boolean, fresh = false): Promise<{ data: ReconcileReport; meta: BoardMeta }> {
    const { scan, cached } = await this.scan(precheck, fresh);
    return { data: scan.result.report, meta: this.meta(scan, cached) };
  }

  async sessions(): Promise<{ data: { total: number; sessions: SessionView[] }; meta: BoardMeta }> {
    const { scan, cached } = await this.scan(false);
    const sessions = scan.result.sessions;
    return { data: { total: sessions.length, sessions }, meta: this.meta(scan, cached) };
  }

  async hygiene(): Promise<{ data: HygieneData; meta: BoardMeta }> {
    const { scan, cached } = await this.scan(false);
    return { data: buildHygiene(scan.result.report), meta: this.meta(scan, cached) };
  }

  milestones(): { milestones: LedgerMilestone[]; next: string | null } {
    const list = this.ledger().listMilestones();
    return { milestones: list, next: list.find((m) => m.status === "规划中")?.id ?? null };
  }

  /** 解析里程碑引用（下一版 / v1.2 / 1.2），不存在报中文错误 */
  private milestoneOf(ledger: Ledger, ref: string): LedgerMilestone {
    const req = ref.trim() || "下一版";
    const m = ledger.resolveMilestone(req, { create: false })?.milestone ?? null;
    if (m) return m;
    const list = ledger.listMilestones();
    if (NEXT_ALIASES.has(req.toLowerCase()) || NEXT_ALIASES.has(req)) {
      throw new LedgerError(`还没有「规划中」的版本（登记新点子会自动建 ${VNEXT}）`);
    }
    throw new LedgerError(`没有里程碑 ${req}（已有：${list.map((x) => x.id).join("、") || "无"}）`);
  }

  /** M2 待办分组（与 heliu 待办 [--precheck] 同一个函数） */
  async todo(ref: string, precheck: boolean): Promise<{ data: TodoReport; meta: BoardMeta }> {
    const project = this.project;
    const ledger = this.ledger(project);
    const m = this.milestoneOf(ledger, ref);
    const milestones = ledger.listMilestones();
    const features = todoFeatures(ledger.load().features, m.id, (f) => ledger.effectiveMilestone(f, milestones));
    const { scan, cached } = await this.scan(precheck);
    const data = groupTodo({
      milestone: m,
      requested: ref.trim() || "下一版",
      features,
      report: scan.result.report,
      sessions: scan.result.sessions,
      stops: this.stops(project),
      zeroCommit: await this.zeroCommit(scan, features),
      nextMilestone: this.nextOf(milestones),
      now: this.now(),
    });
    return { data, meta: this.meta(scan, cached) };
  }

  /* ───────────── 版本列 ───────────── */

  /** precheck=false 时「有冲突」未检查（与 heliu 待办 不带 --precheck 一致），页面顶部可一键检查 */
  async features(filter?: string | null, precheck = true): Promise<{ data: FeaturesData; meta: BoardMeta }> {
    const project = this.project;
    const ledger = this.ledger(project);
    const { scan, cached } = await this.scan(precheck);
    const milestones = ledger.listMilestones();
    const { features, broken } = ledger.load();
    const next = milestones.find((m) => m.status === "规划中")?.id ?? null;
    const stops = this.stops(project);
    const report = scan.result.report;
    const sessions = scan.result.sessions;
    const zeroCommit = await this.zeroCommit(scan, features.filter(countsTowardTodo));
    const nextMilestone = this.nextOf(milestones);

    // 1) 分列：里程碑（按 milestones.yaml 顺序，已发布的并入「已发布」列）+ 未登记里程碑 + 未预约 + 已发布
    const byColumn = new Map<string, LedgerFeature[]>();
    const push = (k: string, f: LedgerFeature) => byColumn.set(k, [...(byColumn.get(k) ?? []), f]);
    let abandoned = 0;
    const orphanIds: string[] = [];
    for (const f of features) {
      if (f.status === "已放弃") {
        abandoned++;
        continue;
      }
      const eff = ledger.effectiveMilestone(f, milestones);
      const ms = eff ? milestones.find((m) => m.id === eff) : undefined;
      if (f.status === "已发布" || ms?.status === "已发布") push(RELEASED, f);
      else if (!eff) push(UNRESERVED, f);
      else {
        if (!ms && !orphanIds.includes(eff)) orphanIds.push(eff);
        push(eff, f);
      }
    }

    const columns: BoardColumn[] = [];
    const todos: TodoReport[] = [];
    const mk = (key: string, kind: BoardColumn["kind"], title: string, milestone: LedgerMilestone | null): BoardColumn => {
      const list = byColumn.get(key) ?? [];
      const pseudo: LedgerMilestone = milestone ?? { id: key, title, status: "规划中", target_date: null, integration_branch: null, notes: "" };
      const todo =
        kind === "released" ? null : groupTodo({ milestone: pseudo, requested: key, features: list, report, sessions, stops, zeroCommit, nextMilestone, now: this.now() });
      if (todo) todos.push(todo);
      const cards = this.cardsOf(scan, list, todo, key, kind);
      const summary = todo ? summarizePrecheck(todo) : null;
      const count = (g: TodoGroupKey) => todo?.groups.find((x) => x.key === g)?.items.length ?? 0;
      const conflictCount = todo?.groups.find((x) => x.key === "conflict")?.count ?? null;
      let droppable = kind === "unreserved";
      let dropHint: string | null = null;
      if (kind === "milestone") {
        droppable = !milestone || milestone.status === "规划中";
        if (!droppable) dropHint = `「${milestone!.status}」的版本不接新预约`;
      } else if (kind === "released") dropHint = "已发布列只读：发布由合并执行（M4）完成";
      return {
        key,
        kind,
        title,
        milestone,
        droppable,
        dropHint,
        isNext: !!milestone && milestone.id === next,
        owed: todo?.total ?? 0,
        mergeable: count("mergeable"),
        conflict: kind === "released" ? 0 : conflictCount,
        precheckFailed: summary?.failed ?? 0,
        waiting: count("blocked"),
        precheckSummary: summary,
        cards,
      };
    };
    for (const m of milestones) if (m.status !== "已发布") columns.push(mk(m.id, "milestone", m.id, m));
    for (const id of orphanIds) columns.push(mk(id, "milestone", `${id}（milestones.yaml 里没有）`, null));
    columns.push(mk(UNRESERVED, "unreserved", "未预约", null));
    columns.push(mk(RELEASED, "released", "已发布", null));

    const want = filter?.trim();
    let shown = columns;
    if (want) {
      const target = want === "未预约" || want === "none" ? UNRESERVED : want === "已发布" ? RELEASED : (ledger.findMilestone(want, milestones)?.id ?? want);
      shown = columns.filter((c) => c.key === target);
    }
    const groups = TODO_GROUP_DEFS.map((d) => ({ key: d.key, title: d.title, hint: d.hint, light: LIGHT_OF[d.key] }));
    const nextMs = milestones.find((m) => m.status === "规划中") ?? null;
    return {
      data: {
        columns: shown,
        groups,
        abandoned,
        next,
        nextStatus: nextMs?.status ?? null,
        precheck: scan.precheck,
        precheckSummary: summarizePrecheck({ precheck: scan.precheck, groups: todos.flatMap((t) => t.groups) }),
        broken,
        ledgerDir: ledger.dir,
      },
      meta: this.meta(scan, cached),
    };
  }

  private cardsOf(scan: Scan, list: LedgerFeature[], todo: TodoReport | null, column: string, kind: BoardColumn["kind"]): BoardCard[] {
    const titles = new Map((todo?.groups ?? []).map((g) => [g.key, g.title]));
    const report = scan.result.report;
    const repos = new Map(report.repos.map((r) => [r.id, r]));
    const sessionsById = new Map(scan.result.sessions.map((s) => [s.sessionId, s]));
    const byId = new Map(list.map((f) => [f.id, f]));
    const out: BoardCard[] = [];
    const used = new Set<string>();
    const add = (f: LedgerFeature, item: TodoItem | null, doneNote: string | null) => {
      used.add(f.id);
      const bindings = f.bindings.map((b, i) => this.cardBinding(scan, b, repos, sessionsById, item?.bindings[i]?.sessionId ?? null));
      let light: Light = "gray";
      let lightText = "";
      if (item && !doneNote) {
        light = LIGHT_OF[item.group];
        lightText = lightTextOf(item, bindings, titles.get(item.group) ?? item.group);
      } else {
        light = "green";
        lightText = doneNote ?? f.status;
      }
      const facts = cardFacts(item, bindings, doneNote, scan.precheck);
      let last = item?.lastActivityAt ?? null;
      if (!item) for (const b of bindings) last = maxIso(maxIso(last, b.lastCommitAt), b.session?.lastActivityAt ?? null);
      out.push({
        id: f.id,
        title: f.title,
        status: f.status,
        acceptance: f.acceptance,
        milestone: f.milestone,
        column,
        rolledFrom: f.rolled_from,
        source: f.source,
        group: doneNote ? null : (item?.group ?? null),
        light,
        lightText,
        needsAction: item?.needsAction ?? null,
        note: item?.note ?? null,
        suggestion: item?.suggestion ?? null,
        suggestStatus: facts.suggestStatus,
        variant: facts.variant,
        nextStep: facts.nextStep,
        tags: facts.tags,
        lastActivityAt: last,
        idleDays: item?.idleDays ?? null,
        done: !!doneNote,
        doneNote,
        bindings,
        file: f.file,
      });
    };
    if (todo) {
      for (const key of GROUP_ORDER) {
        const items = [...(todo.groups.find((g) => g.key === key)?.items ?? [])];
        // 可合并按 M2 细分排：已进主线 → 已进集成分支（多为「已合入 · 待确认台账」）→ 试合无冲突（组内原顺序不变）
        if (key === "mergeable") items.sort((a, b) => noteRank(a.note) - noteRank(b.note));
        for (const it of items) add(byId.get(it.id)!, it, null);
      }
    }
    // 其余：台账状态已是 已合入/已进主线/已发布 的卡（不计入还欠；口径同 M2 countsTowardTodo）
    const rest = list.filter((f) => !used.has(f.id)).sort((a, b) => b.id.localeCompare(a.id));
    for (const f of rest) add(f, null, kind === "released" ? "已发布" : `台账状态：${f.status}`);
    return out;
  }

  private cardBinding(scan: Scan, b: FeatureBinding, repos: Map<string, RepoReport>, sessionsById: Map<string, SessionView>, todoSession: string | null): CardBinding {
    const repo = repos.get(b.repo);
    const fv: FeatureView | null = repo?.reachable ? (repo.branches.find((x) => x.branch === b.branch) ?? null) : null;
    // 会话：待办分组选中的主会话 > 卡片写明的会话 > 对账里以「记录」关联到该分支的会话
    const sid = todoSession ?? b.session ?? fv?.sessions.find((s) => s.link === "branch")?.sessionId ?? null;
    const sv = sid ? sessionsById.get(sid) : undefined;
    const ref = sid ? fv?.sessions.find((s) => s.sessionId === sid) : undefined;
    const session: CardSession | null = sid
      ? {
          id: sid,
          title: sv?.title ?? ref?.title ?? null,
          status: sv?.status ?? ref?.status ?? null,
          needsAction: sv?.needsAction ?? ref?.needsAction ?? null,
          lastActivityAt: sv?.lastActivityAt ?? ref?.lastActivityAt ?? null,
          link: this.sessionLink(scan, sid),
        }
      : null;
    const p = fv?.precheck ?? null;
    const pc = precheckStateOf(fv, scan.precheck);
    return {
      repo: b.repo,
      repoLabel: repo?.label ?? b.repo,
      branch: b.branch,
      label: fv?.label ?? null,
      randomName: fv?.randomName ?? false,
      exists: !!fv,
      role: fv?.role ?? null,
      mergedState: fv?.mergedState ?? null,
      vsMain: fv?.vsMain ?? null,
      vsIntegration: fv?.vsIntegration ?? null,
      integration: repo?.integration ?? null,
      main: repo?.main ?? "",
      precheckTarget: p?.target ?? null,
      conflictFiles: p?.conflictFiles ?? null,
      conflicts: p?.conflicts ?? [],
      precheckError: pc.error,
      precheckState: pc.state,
      lastCommitAt: fv?.lastCommitAt ?? null,
      worktree: b.worktree ?? fv?.worktree?.path ?? null,
      session,
    };
  }

  /* ───────────── 总览 ───────────── */

  async overview(precheck = false): Promise<{ data: OverviewData; meta: BoardMeta }> {
    const [{ scan, cached }, feats] = await Promise.all([this.scan(false), this.features(null, precheck)]);
    const report = scan.result.report;
    const waiting = scan.result.sessions.filter((s) => s.status === "blocked").length;
    const actions = topActions(report, waiting).map(boardWording);
    const integrations: OverviewData["integrations"] = [];
    let neverPushed = 0;
    let hygieneWarnings = 0;
    for (const r of report.repos) {
      neverPushed += r.counts?.neverPushed ?? 0;
      hygieneWarnings += r.health?.hygieneWarnings ?? 0;
      const i = r.health?.integration;
      if (i && i.exists && !i.mergedIntoMain) integrations.push({ repo: r.id, repoLabel: r.label, branch: i.branch, ahead: i.aheadOfMain, days: i.unmergedDays });
    }
    const columns = feats.data.columns
      .filter((c) => c.kind !== "released")
      .map((c) => ({
        key: c.key,
        title: c.title,
        kind: c.kind,
        isNext: c.isNext,
        owed: c.owed,
        mergeable: c.mergeable,
        conflict: c.conflict,
        precheckFailed: c.precheckFailed,
        waiting: c.waiting,
      }));
    const nextMs = this.ledger().listMilestones().find((m) => m.status === "规划中") ?? null;
    return {
      data: {
        actions,
        waiting,
        neverPushed,
        integrations,
        hygieneWarnings,
        columns,
        next: nextMs ? { id: nextMs.id, status: nextMs.status } : null,
        precheck,
        precheckAt: precheck ? feats.meta.scannedAt : null,
        precheckSummary: feats.data.precheckSummary,
      },
      meta: this.meta(scan, cached),
    };
  }

  /* ───────────── 写台账 ───────────── */

  addFeature(input: { title?: unknown; milestone?: unknown }): { feature: LedgerFeature; milestoneCreated: string | null } {
    const title = typeof input.title === "string" ? input.title : "";
    if (!title.trim()) throw new LedgerError("功能标题不能为空");
    let milestone: string | null = "next";
    if (input.milestone === null || input.milestone === UNRESERVED) milestone = null;
    else if (typeof input.milestone === "string" && input.milestone.trim()) milestone = input.milestone.trim();
    const r = this.ledger().addFeature({ title, milestone, bindings: [], source: "board", now: this.now() });
    return { feature: r.feature, milestoneCreated: r.milestoneCreated?.id ?? null };
  }

  patchFeature(id: string, body: Record<string, unknown>): { feature: LedgerFeature; from: string | null; milestoneCreated: string | null; changed: string[] } {
    const ledger = this.ledger();
    const now = this.now();
    let f = ledger.getFeature(id);
    const changed: string[] = [];
    let from: string | null = f.milestone;
    let milestoneCreated: string | null = null;
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);
    if (!has("title") && !has("milestone") && !has("status")) throw new LedgerError("至少给出 milestone / title / status 之一");
    if (has("title")) {
      if (typeof body.title !== "string") throw new LedgerError("title 必须是字符串");
      f = ledger.rename(f.id, body.title, now);
      changed.push("title");
    }
    if (has("milestone")) {
      const v = body.milestone;
      if (v !== null && typeof v !== "string") throw new LedgerError("milestone 必须是里程碑名或 null（未预约）");
      const ref = v === null || v === UNRESERVED || (typeof v === "string" && !v.trim()) ? null : (v as string).trim();
      const r = ledger.reserve(f.id, ref, now);
      f = r.feature;
      from = r.from;
      milestoneCreated = r.milestoneCreated?.id ?? null;
      changed.push("milestone");
    }
    if (has("status")) {
      if (typeof body.status !== "string") throw new LedgerError("status 必须是字符串");
      f = ledger.setStatus(f.id, parseFeatureStatus(body.status), now);
      changed.push("status");
    }
    return { feature: f, from, milestoneCreated, changed };
  }

  async sync(dryRun: boolean): Promise<SyncResult> {
    const project = this.project;
    const { scan } = await this.scan(false);
    return syncLedger(project, this.paths, { dryRun, now: this.now(), reconciled: scan.result });
  }

  async baseline(id: string): Promise<BaselineData> {
    const project = this.project;
    const f = this.ledger(project).getFeature(id);
    return baselinePreview(project, f, this.timeoutMs);
  }

  /* ───────────── 合并预演（只读）与合并单：直接用 M4 的合并单构建器，规则只有一套 ───────────── */

  /**
   * 合并预演：调用 M4 buildReleasePlan（与 heliu 合并 --预演 / MCP heliu_release_preview 同一个函数，传入看板缓存的试合扫描），
   * 只把它的 items 映射成看板表格字段；不写任何文件。
   */
  async releasePreview(ref: string): Promise<{ data: ReleasePreview; meta: BoardMeta }> {
    const project = this.project;
    const { scan, cached } = await this.scan(true);
    const built = await buildReleasePlan(project, this.paths, ref.trim() || "下一版", { now: this.now(), timeoutMs: this.timeoutMs, reconciled: scan.result });
    return { data: releasePreviewOf(project, this.ledger(project), built, scan), meta: this.meta(scan, cached) };
  }

  /** 生成合并单：调用 M4 previewRelease（schema 2，与 CLI 同一个文件、同一格式；看板旧草稿先备份到 releases/.history/） */
  async releasePlan(ref: string): Promise<ReleasePlanResult> {
    const project = this.project;
    const { scan } = await this.scan(true);
    const r = await previewRelease(project, this.paths, ref.trim() || "下一版", { now: this.now(), timeoutMs: this.timeoutMs, reconciled: scan.result });
    return {
      file: r.file,
      backup: r.boardDraft?.backup ?? null,
      items: r.plan.items.length,
      deferred: new Set(r.plan.items.filter((i) => i.decision === "顺延").map((i) => i.feature)).size,
      kept: r.kept,
      status: r.plan.status,
    };
  }
}

/* ───────────── 纯函数 ───────────── */

const NOTE_ORDER = ["已进主线", "已进集成分支", "试合无冲突"];
const noteRank = (n: string | null | undefined) => {
  const i = NOTE_ORDER.indexOf(n ?? "试合无冲突");
  return i < 0 ? NOTE_ORDER.length : i;
};

const sumConflicts = (bs: Array<{ conflictFiles: number | null }>) => bs.reduce((a, b) => a + (b.conflictFiles ?? 0), 0);

/**
 * 卡片默认态只突出「下一步」一句话 + 次要标签（一卡多标签：等你 / 冲突 N 文件 / 落后 ↓N / 停滞 N 天 / 尚无提交）。
 * 规则全部取自 M2 分组结果与对账事实，不另造判断：
 * - 「已合入 · 待确认台账」= M2 给了改状态建议（分支已被集成分支/主线包含，卡片状态还没改）→ 单独样式 + 一键按钮。
 */
export function cardFacts(
  item: TodoItem | null,
  bindings: CardBinding[],
  doneNote: string | null,
  precheck: boolean,
): { nextStep: string; tags: CardTag[]; variant: BoardCard["variant"]; suggestStatus: BoardCard["suggestStatus"] } {
  const tags: CardTag[] = [];
  const live = bindings.filter((b) => b.exists);
  const waiting = item?.group === "blocked" || live.some((b) => b.session?.status === "blocked");
  // 主分组已由灯色与灯旁文案表达，次要标签只列「另外」成立的事实（一卡多标签）
  const g = item?.group ?? null;
  if (waiting && g !== "blocked") tags.push({ kind: "waiting", text: "等你" });
  const conflicts = sumConflicts(live.filter((b) => b.mergedState === "unmerged"));
  if (precheck && conflicts > 0 && g !== "conflict") tags.push({ kind: "conflict", text: `冲突 ${conflicts} 文件` });
  const behind = Math.max(0, ...live.filter((b) => b.mergedState === "unmerged").map((b) => (b.integration ? b.vsIntegration?.behind : b.vsMain?.behind) ?? 0));
  if (behind > 0 && g !== "behind") tags.push({ kind: "behind", text: `落后 ↓${behind}` });
  if (item && item.idleDays !== null && item.idleDays >= STALE_DAYS && g !== "stale") tags.push({ kind: "stale", text: `停滞 ${item.idleDays} 天` });
  if (item?.note === "尚无提交") tags.push({ kind: "nocommit", text: "尚无提交" });
  // 请求了试合却没得到结果：明确标「未能试合」，不显示「无冲突」
  const failedB = live.find((b) => b.precheckState === "failed");
  if (failedB) tags.push({ kind: "precheck_failed", text: "未能试合" });

  const suggestStatus: BoardCard["suggestStatus"] = item?.suggestion ? (item.note === "已进主线" ? "已进主线" : item.note === "已进集成分支" ? "已合入" : null) : null;
  if (doneNote || !item) return { nextStep: doneNote ?? "", tags, variant: "done", suggestStatus: null };
  const target = live.find((b) => b.precheckTarget)?.precheckTarget ?? (live[0]?.integration ?? "集成分支");
  let nextStep: string;
  let variant: BoardCard["variant"] = "normal";
  switch (item.group) {
    case "blocked":
      nextStep = `等你回答：${item.needsAction ?? "（会话未写明需要什么）"}`;
      break;
    case "conflict":
      nextStep = `需解冲突：试合到 ${target} 有 ${conflicts} 个文件冲突`;
      break;
    case "mergeable":
      if (suggestStatus) {
        variant = "merged-pending";
        nextStep = `已合入 · 待确认台账：分支${item.note === "已进主线" ? "已进主线" : "已被集成分支包含"}，卡片状态还是「${item.status}」`;
      } else if (item.note === "试合无冲突") {
        // 试合无冲突只说明能合，不等于已验收；落后基线时把「建议先同步」写进下一步
        nextStep = `可合并：试合到 ${target} 无冲突（试合无冲突 ≠ 已验收）${behind > 0 ? `；落后 ↓${behind}，建议先同步基线` : ""}`;
      } else nextStep = `可合并：${item.note ?? "已进集成分支"}`;
      break;
    case "behind":
    case "stale":
    case "active":
      if (failedB) {
        // 能不能合不知道：先把「未能试合」说清楚，再补落后/停滞等事实
        const extra = [behind > 0 ? `落后 ↓${behind}` : "", item.group === "stale" ? `停滞 ${item.idleDays ?? "?"} 天` : ""].filter(Boolean).join("，");
        nextStep = `未能试合（${failedB.precheckError ?? "原因未知"}）：重新试合或人工确认${extra ? `；${extra}` : ""}`;
      } else if (item.group === "behind") nextStep = `需同步基线 ↓${behind}${precheck ? "" : "（冲突未检查）"}`;
      else if (item.group === "stale") nextStep = `停滞 ${item.idleDays ?? "?"} 天：确认还做不做`;
      else nextStep = item.note === "尚无提交" ? "开发中 · 分支尚无提交" : precheck ? "开发中" : "开发中（冲突未检查）";
      break;
    case "unbound":
      nextStep = bindings.length ? "绑定的分支已不存在：重新关联开发分支" : "尚未关联开发分支";
      break;
  }
  return { nextStep, tags, variant, suggestStatus };
}

/** 灯旁文案：组名一律取 M2 分组函数返回的 title（TODO_GROUP_DEFS），只在后面补事实细节 */
export function lightTextOf(item: TodoItem, bindings: CardBinding[], groupTitle: string): string {
  const parts = [groupTitle];
  if (item.group === "conflict") parts.push(`${sumConflicts(bindings)} 个文件`);
  else if (item.group === "behind") {
    const n = Math.max(0, ...bindings.map((b) => (b.integration ? b.vsIntegration?.behind : b.vsMain?.behind) ?? 0));
    parts.push(`↓${n}`);
  } else if (item.group === "stale" && item.idleDays !== null) parts.push(`${item.idleDays} 天`);
  if (item.note) parts.push(item.note);
  if (item.group === "active" && !item.note && bindings.some((b) => b.precheckState === "failed")) parts.push("未能试合");
  return parts.join(" · ");
}

/** M1 摘要里的 CLI 指引换成看板页面名（结论句本身不变） */
export function boardWording(s: string): string {
  return s
    .replace("（见 ①，全部：heliu sessions）", "（见「会话」页）")
    .replace("heliu hygiene 查看，", "见「卫生」页，")
    .replace("M2 起可预约版本", "可在「版本列」预约到某一版");
}

/* ───────────── M4 合并单 → 看板表格 ───────────── */

const ACTION_KEY: Record<ItemState, ReleaseAction> = {
  已进集成: "skip",
  无冲突: "merge",
  有冲突: "resolve",
  未能试合: "recheck",
  未完成: "defer",
  无法合并: "fix",
};

/** M4 合并单（buildReleasePlan 的结果）映射成看板预演：档位/动作/决定/原因全部取自合并单，不另算 */
export function releasePreviewOf(project: ProjectConfig, ledger: Ledger, built: BuildResult, scan: Scan): ReleasePreview {
  const { plan } = built;
  const report = scan.result.report;
  const statusOf = new Map(ledger.load().features.map((f) => [f.id, f.status]));
  const repoCfg = new Map(project.repos.map((r) => [r.id, r]));
  const integOf = new Map(plan.repos.map((r) => [r.repo, r.integration_branch]));
  const items: ReleaseItem[] = plan.items.map((it, i) => {
    const tier = TIER_OF[it.state];
    const rr = it.repo ? report.repos.find((r) => r.id === it.repo) : undefined;
    const fv = rr?.reachable && it.branch ? (rr.branches.find((b) => b.branch === it.branch) ?? null) : null;
    const pc = precheckStateOf(fv, true);
    const target = it.repo ? (integOf.get(it.repo) ?? null) : null;
    const bindings: ReleaseBinding[] =
      it.repo && it.branch
        ? [
            {
              repo: it.repo,
              repoLabel: repoCfg.get(it.repo)?.label ?? it.repo,
              branch: it.branch,
              exists: !!fv,
              sha: it.branch_sha,
              mergedState: fv?.mergedState ?? null,
              precheckTarget: target,
              conflictFiles: it.precheck ? it.precheck.conflicts.length : null,
              conflicts: it.precheck?.conflicts ?? [],
              precheckError: it.precheck_state === "failed" ? pc.error : null,
              precheckState: it.precheck_state ?? null,
              behindIntegration: it.behind,
              behindMain: fv?.vsMain?.behind ?? null,
            },
          ]
        : [];
    let reason = it.detail ?? "";
    if (!reason) {
      if (it.state === "已进集成") reason = "绑定分支已被集成分支包含";
      else if (it.state === "无冲突") reason = `试合到 ${target ?? "集成分支"} 无冲突`;
      else if (it.state === "有冲突") {
        const pcx = it.precheck;
        reason = `试合到 ${target ?? "集成分支"} 有 ${pcx?.conflicts.length ?? 0} 个冲突文件${pcx?.union.length ? `（其中 union 文件 ${pcx.union.length} 个，两边都保留）` : ""}`;
      } else reason = it.state;
    }
    return {
      order: i + 1,
      id: it.feature,
      title: it.title,
      status: statusOf.get(it.feature) ?? null,
      tier,
      tierText: it.state,
      action: ACTION_KEY[it.state],
      actionText: ACTION_TEXT[it.state],
      decision: it.decision,
      defaultDecision: it.default_decision,
      reason,
      bindings,
    };
  });
  const counts = { in_integration: 0, clean: 0, conflict: 0, precheck_failed: 0, unfinished: 0, unmergeable: 0 } as Record<ReleaseTier, number>;
  for (const x of items) counts[x.tier]++;
  // 没配集成分支的仓库：M4 判「无法合并 → 顺延」，在页面顶部说清楚怎么补
  const warnings: string[] = [];
  for (const r of project.repos) {
    if (!plan.items.some((i) => i.repo === r.id)) continue;
    if (!r.integration) warnings.push(`${r.label}未配置集成分支：该仓库的功能「无法合并 → 顺延」。补上：heliu project add "${r.path}" --integration <分支>，或编辑 project.yaml 的 integration`);
    else if (!integOf.get(r.id)) warnings.push(`${r.label}的集成分支 ${r.integration} 在本地不存在：该仓库的功能「无法合并 → 顺延」`);
  }
  const loaded = built.loaded;
  return {
    milestone: built.milestone,
    generatedAt: report.generatedAt,
    scanMs: scan.ms,
    repos: plan.repos.map((r) => ({ repo: r.repo, repoLabel: r.label, main: r.main, mainSha: r.main_sha, integration: r.integration_branch, integrationSha: r.base_sha })),
    items,
    counts,
    deferred: [...new Set(plan.items.filter((i) => i.decision === "顺延").map((i) => i.feature))],
    warnings,
    plan: { file: plan.file, exists: !!loaded, format: loaded?.format ?? null, status: loaded?.status ?? null, kept: built.kept },
  };
}
