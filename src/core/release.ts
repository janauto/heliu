/**
 * M4 合并单：preview（只读仓库，只写合并单草稿）与改决定。
 *
 * preview：预约到该版的功能卡 × 绑定分支 → 对账（含 merge-tree 试合，在对象隔离区 + 沙箱内）→ 每项的状态与默认决定 →
 * <台账>/releases/<里程碑>.md。顺序：已进集成（跳过）→ 无冲突 → 有冲突（union 文件优先）→ 未能试合 → 未完成 → 无法合并。
 * 默认决定：可合的「并入」；未能试合「待定」（重新试合或人工确认，绝不算作有冲突）；未完成 / 无法合并「顺延」（未完成可改「等它」）。
 * 试合三态复用 src/core/todo.ts 的 precheckStateOf（与看板、CLI 待办同一口径）。刷新时保留用户改过的决定。
 */
import type { LedgerFeature, LedgerMilestone, SessionView } from "../types.ts";
import { Ledger, LedgerError, normalizeFeatureId } from "./ledger.ts";
import type { HeliuPaths } from "./paths.ts";
import { primaryRepo, type ProjectConfig } from "./project.ts";
import { reconcile } from "./reconcile.ts";
import { precheckStateOf } from "./todo.ts";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  ITEM_STATES,
  itemKey,
  loadPlan,
  mergeWithPrevious,
  parseDecision,
  planFile,
  savePlan,
  type Decision,
  type ItemState,
  type PlanItem,
  type PlanRepo,
  type ReleasePlan,
} from "./release-plan.ts";

export class ReleaseError extends LedgerError {
  constructor(message: string) {
    super(message);
    this.name = "ReleaseError";
  }
}

/** 本地时间 YYYY-MM-DD HH:mm */
export function stamp(d: Date = new Date()): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** union 文件匹配：精确路径（相对仓库根） */
export function isUnionFile(project: ProjectConfig, file: string): boolean {
  const f = file.normalize("NFC");
  return (project.unionFiles ?? []).some((u) => u.replace(/^\.?\//, "").normalize("NFC") === f);
}

/** 解析里程碑（不新建） */
export function resolveReleaseMilestone(ledger: Ledger, ref: string): LedgerMilestone {
  const r = ledger.resolveMilestone(ref, { create: false });
  if (!r) {
    const list = ledger.listMilestones();
    throw new ReleaseError(`没有里程碑 ${ref}（已有：${list.map((x) => x.id).join("、") || "无"}）`);
  }
  return r.milestone;
}

const STATE_ORDER: Record<ItemState, number> = Object.fromEntries(ITEM_STATES.map((s, i) => [s, i])) as Record<ItemState, number>;

export function sortItems(items: PlanItem[], repoOrder: string[]): PlanItem[] {
  const ro = (r: string | null) => (r ? repoOrder.indexOf(r) : 99);
  return [...items].sort((a, b) => {
    const s = STATE_ORDER[a.state] - STATE_ORDER[b.state];
    if (s) return s;
    if (a.state === "有冲突") {
      const ao = a.precheck?.other.length ?? 99;
      const bo = b.precheck?.other.length ?? 99;
      if (ao !== bo) return ao - bo;
      const ac = a.precheck?.conflicts.length ?? 99;
      const bc = b.precheck?.conflicts.length ?? 99;
      if (ac !== bc) return ac - bc;
    }
    return a.feature.localeCompare(b.feature) || ro(a.repo) - ro(b.repo) || (a.branch ?? "").localeCompare(b.branch ?? "");
  });
}

export function defaultDecision(state: ItemState): Decision {
  if (state === "未能试合") return "待定";
  return state === "未完成" || state === "无法合并" ? "顺延" : "并入";
}

export interface PreviewOptions {
  now?: Date;
  timeoutMs?: number;
}

export interface PreviewResult {
  plan: ReleasePlan;
  kept: number;
  previous: ReleasePlan | null;
  /** 原文件是看板生成的草稿：已备份到这里；它的决定与新默认不同的项列在 differing（未导入，请核对） */
  boardDraft: { backup: string; differing: Array<{ feature: string; board: string; now: string }> } | null;
  milestone: LedgerMilestone;
  file: string;
}

/** 生成/刷新合并单草稿（只读仓库；只写 <台账>/releases/<里程碑>.md） */
export async function previewRelease(project: ProjectConfig, paths: HeliuPaths, ref: string, opts: PreviewOptions = {}): Promise<PreviewResult> {
  const now = opts.now ?? new Date();
  const ledger = Ledger.of(project);
  const m = resolveReleaseMilestone(ledger, ref);
  const loaded = loadPlan(ledger.dir, m.id);
  // 看板草稿（schema 1）不是可执行合并单：先备份，再按本次预演重新生成；它的决定不导入，只列出差异
  let boardBackup: string | null = null;
  if (loaded?.format === "board") {
    const hist = join(ledger.dir, "releases", ".history");
    mkdirSync(hist, { recursive: true });
    const p2 = (x: number) => String(x).padStart(2, "0");
    boardBackup = join(hist, `${m.id.replace(/[/\\:]/g, "-")}-看板草稿-${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}.md`);
    if (existsSync(loaded.file)) copyFileSync(loaded.file, boardBackup);
  }
  const previous = loaded?.format === "board" ? null : loaded;
  if (previous?.status === "已发布") {
    throw new ReleaseError(`${m.id} 已于 ${previous.finalized_at ?? "之前"} 发布（tag 已打）。要重来请先 heliu 回滚 ${m.id}`);
  }
  const milestones = ledger.listMilestones();
  const features = ledger.load().features.filter((f) => f.status !== "已放弃" && ledger.effectiveMilestone(f, milestones) === m.id);
  const rec = await reconcile(project, paths, { precheck: true, dirty: false, timeoutMs: opts.timeoutMs ?? 8000 });
  const sessionsById = new Map(rec.sessions.map((s) => [s.sessionId, s]));

  const repos: PlanRepo[] = project.repos.map((r) => {
    const rr = rec.report.repos.find((x) => x.id === r.id);
    const integ = rr?.branches.find((b) => b.role === "integration") ?? null;
    const main = rr?.branches.find((b) => b.role === "main") ?? null;
    return { repo: r.id, label: r.label, integration_branch: r.integration && integ ? r.integration : null, base_sha: integ?.sha ?? null, main: r.main, main_sha: main?.sha ?? null };
  });

  const items: PlanItem[] = [];
  for (const f of features) {
    if (!f.bindings.length) {
      items.push(mkItem(f, null, null, null, "无法合并", "没有绑定分支"));
      continue;
    }
    for (const b of f.bindings) items.push(itemFor(project, f, b.repo, b.branch, b.session, rec.report.repos, repos, sessionsById));
  }
  const sorted = sortItems(items, project.repos.map((r) => r.id));
  const primary = primaryRepo(project);
  const pr = repos.find((r) => r.repo === primary.id) ?? null;
  const fresh: ReleasePlan = {
    format: "m4",
    milestone: m.id,
    project: project.name,
    status: previous?.status === "待续" ? "待续" : "草稿",
    created: stamp(now),
    updated: stamp(now),
    executed_at: null,
    finalized_at: null,
    rolled_back_at: null,
    integration_branch: pr?.integration_branch ?? null,
    base_sha: pr?.base_sha ?? null,
    milestone_status_before: null,
    repos: repos.filter((r) => sorted.some((i) => i.repo === r.repo)),
    items: sorted,
    refs_moved: [],
    ledger_changes: [],
    resolver_cost_usd: 0,
    tail: "",
    file: planFile(ledger.dir, m.id),
  };
  const { plan, kept } = mergeWithPrevious(fresh, previous);
  if (previous?.status === "已回滚") plan.status = "草稿";
  savePlan(plan);
  let boardDraft: PreviewResult["boardDraft"] = null;
  if (loaded?.format === "board" && boardBackup) {
    const differing: Array<{ feature: string; board: string; now: string }> = [];
    for (const b of loaded.boardDecisions ?? []) {
      const mine = [...new Set(plan.items.filter((i) => i.feature === b.feature).map((i) => i.decision))].join("/");
      if (mine && mine !== b.decision) differing.push({ feature: b.feature, board: b.decision, now: mine });
    }
    boardDraft = { backup: boardBackup, differing };
  }
  return { plan, kept, previous, milestone: m, file: plan.file, boardDraft };
}

function mkItem(f: LedgerFeature, repo: string | null, branch: string | null, sha: string | null, state: ItemState, detail: string | null): PlanItem {
  const d = defaultDecision(state);
  return { feature: f.id, title: f.title, decision: d, default_decision: d, state, detail, repo, branch, branch_sha: sha, behind: null, precheck: null, precheck_state: null };
}

function itemFor(
  project: ProjectConfig,
  f: LedgerFeature,
  repoId: string,
  branch: string,
  cardSession: string | null,
  reports: Awaited<ReturnType<typeof reconcile>>["report"]["repos"],
  repos: PlanRepo[],
  sessionsById: Map<string, SessionView>,
): PlanItem {
  const rr = reports.find((r) => r.id === repoId);
  const pr = repos.find((r) => r.repo === repoId);
  if (!rr || !pr) return mkItem(f, repoId, branch, null, "无法合并", `项目里没有仓库 ${repoId}`);
  if (!rr.reachable) return mkItem(f, repoId, branch, null, "无法合并", `仓库不可达：${rr.error ?? "未知"}`);
  const fv = rr.branches.find((b) => b.branch === branch) ?? null;
  if (!fv) return mkItem(f, repoId, branch, null, "无法合并", "分支不存在");
  if (fv.role !== "feature") return mkItem(f, repoId, branch, fv.sha, "无法合并", `绑定的是${fv.role === "main" ? "主线" : "集成分支"}本身`);
  if (!pr.integration_branch || !pr.base_sha) {
    return mkItem(f, repoId, branch, fv.sha, "无法合并", project.repos.find((r) => r.id === repoId)?.integration ? "集成分支不存在" : "仓库未配置集成分支（project.yaml integration）");
  }
  if (fv.mergedState !== "unmerged") {
    const it = mkItem(f, repoId, branch, fv.sha, "已进集成", fv.mergedState === "in_main" ? "已进主线" : null);
    return it;
  }
  const sess: SessionView[] = [];
  if (cardSession && sessionsById.get(cardSession)) sess.push(sessionsById.get(cardSession) as SessionView);
  for (const s of fv.sessions) {
    if (s.link !== "branch") continue;
    const sv = sessionsById.get(s.sessionId);
    if (sv && !sess.includes(sv)) sess.push(sv);
  }
  const blocked = sess.find((s) => s.status === "blocked");
  const running = sess.find((s) => s.status === "running");
  // 优先级：会话等你回答/运行中 → 未完成；试合没得到结果 → 未能试合（与看板同口径）；卡片 想法/开发中 → 未完成；再看冲突
  const behind = fv.vsIntegration?.behind ?? null;
  const ps = precheckStateOf(fv, true);
  const p = fv.precheck;
  const precheck = ps.state === "checked" && p
    ? { conflicts: p.conflicts, union: p.conflicts.filter((c) => isUnionFile(project, c)), other: p.conflicts.filter((c) => !isUnionFile(project, c)) }
    : null;
  let state: ItemState;
  let detail: string | null = null;
  if (blocked) {
    state = "未完成";
    detail = `会话等你回答：${(blocked.needsAction ?? blocked.statusDetail ?? "").trim().slice(0, 80) || "见 heliu sessions"}`;
  } else if (running) {
    state = "未完成";
    detail = "会话正在运行";
  } else if (ps.state === "failed" || !precheck) {
    state = "未能试合";
    detail = `未能试合：${ps.error ?? "没有得到试合结果"}（不等于有冲突；请重新试合或人工确认后把决定改为并入/顺延）`;
  } else if (f.status === "想法" || f.status === "开发中") {
    state = "未完成";
    detail = `功能卡状态「${f.status}」（做完后改为「待合并」或把决定改成「并入」）`;
  } else if (precheck.conflicts.length) state = "有冲突";
  else {
    state = "无冲突";
    if (p?.contentEquivalent) detail = "内容已等价（只补合并历史）";
  }
  const d = defaultDecision(state);
  return { feature: f.id, title: f.title, decision: d, default_decision: d, state, detail, repo: repoId, branch, branch_sha: fv.sha, behind, precheck, precheck_state: ps.state };
}

/* ───────────── 改决定（CLI release set / MCP heliu_release_plan_set_decision） ───────────── */

export interface SetDecisionResult {
  plan: ReleasePlan;
  changed: PlanItem[];
}

/**
 * 改合并单里某项的决定。target：卡号（F-0003 / 3）或「#序号」（勾选表第一列）。
 * 卡号对应多条绑定时，不给 repo/branch 就一起改。
 */
export function setPlanDecision(project: ProjectConfig, ref: string, target: string, decisionRaw: string, opts: { repo?: string; branch?: string; now?: Date } = {}): SetDecisionResult {
  const ledger = Ledger.of(project);
  const m = resolveReleaseMilestone(ledger, ref);
  const plan = loadPlan(ledger.dir, m.id);
  if (!plan) throw new ReleaseError(`还没有 ${m.id} 的合并单：先 heliu 合并 ${m.id} --预演`);
  if (plan.format === "board") throw new ReleaseError(boardDraftMessage(m.id, plan.file));
  if (plan.status === "已发布" || plan.status === "执行中") throw new ReleaseError(`合并单状态「${plan.status}」，不能再改决定`);
  let decision: Decision;
  try {
    decision = parseDecision(decisionRaw);
  } catch (e) {
    throw new ReleaseError((e as Error).message);
  }
  let hits: PlanItem[];
  const idx = /^#(\d+)$/.exec(target.trim());
  if (idx) {
    const it = plan.items[Number(idx[1]) - 1];
    if (!it) throw new ReleaseError(`合并单只有 ${plan.items.length} 项，没有 ${target}`);
    hits = [it];
  } else {
    const id = normalizeFeatureId(target);
    hits = plan.items.filter((i) => i.feature === id && (!opts.repo || i.repo === opts.repo) && (!opts.branch || i.branch === opts.branch));
    if (!hits.length) throw new ReleaseError(`合并单里没有 ${id}${opts.repo ? ` @${opts.repo}` : ""}${opts.branch ? ` ${opts.branch}` : ""}（可用 #序号）`);
  }
  const changed: PlanItem[] = [];
  for (const it of hits) {
    if (it.state === "已进集成") continue;
    if (it.result === "已合入") continue;
    if (it.decision !== decision) {
      it.decision = decision;
      changed.push(it);
    }
  }
  plan.updated = stamp(opts.now ?? new Date());
  savePlan(plan);
  return { plan, changed };
}

/** 看板草稿不能直接执行 / 改决定 */
export function boardDraftMessage(ms: string, file: string): string {
  return `${file} 是看板生成的合并单草稿（格式不同，不能直接执行）。请先运行 heliu 合并 ${ms} --预演：会把草稿备份到 releases/.history/，再生成可执行合并单（看板草稿里的决定不自动导入，会列出差异供你核对）`;
}

/** 对外：项的人读描述 */
export function itemLabel(i: PlanItem, labelOf: (repo: string) => string): string {
  return `${i.feature}「${i.title}」${i.repo && i.branch ? `（${labelOf(i.repo)} ${i.branch}）` : ""}`;
}

export { itemKey };
