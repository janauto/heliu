/**
 * CLI 与 MCP 共用的命令层：每个操作返回 { text（中文渲染）, data（--json / structured） }。
 * 只做编排：项目解析 → 台账/对账 → 渲染。业务规则在 src/core/*。
 */
import type { FeatureBinding, FeatureSource, LedgerFeature, ProjectRef, TodoReport, WhereAmI } from "../types.ts";
import { Cache } from "../core/cache.ts";
import { Ledger, LedgerError, NEXT_ALIASES, parseAcceptance, parseFeatureStatus, VNEXT } from "../core/ledger.ts";
import type { HeliuPaths } from "../core/paths.ts";
import { loadProject, resolveProject, type ProjectConfig } from "../core/project.ts";
import { reconcile } from "../core/reconcile.ts";
import { syncLedger, type SyncResult } from "../core/sync.ts";
import { afterMerge, type AfterMergeResult } from "../core/after-merge.ts";
import { analyzeTranscripts, applyPairings, loadEvidence, ownCommitsOf, renderApply, renderPairings, selectPairings, suggestPairings, type AnalyzeResult, type ApplyResult, type PairReport } from "../core/pairing.ts";
import { sourceBranchIndex, zeroCommitBranches } from "../core/owncommits.ts";
import { countsTowardTodo, groupTodo, todoFeatures } from "../core/todo.ts";
import { whereami } from "../core/whereami.ts";
import { renderFeatureLine, renderFeatureTable, renderMilestones, renderSync, renderTodo, renderWhereami, type RenderOpts } from "../cli/render-ledger.ts";

export interface OpContext {
  paths: HeliuPaths;
  cwd: string;
  /** --project / MCP project 参数 */
  projectName?: string;
  source: FeatureSource;
  render?: RenderOpts;
  now?: Date;
}

export interface OpResult<T = unknown> {
  text: string;
  data: T;
  project: ProjectRef | null;
}

const ref = (p: ProjectConfig): ProjectRef => ({ name: p.name, source: p.source });

export async function projectOf(ctx: OpContext): Promise<ProjectConfig> {
  return resolveProject(ctx.paths, ctx.projectName, ctx.cwd);
}

/** 当前目录的位置；cwd 不在 --project 指定的项目里时 repo 为 null */
async function locate(ctx: OpContext, project: ProjectConfig): Promise<WhereAmI> {
  return whereami(ctx.paths, ctx.cwd, { project, timeoutMs: 3000 });
}

/* ───────────── init / whereami ───────────── */

export async function opInit(ctx: OpContext): Promise<OpResult<{ dir: string; created: boolean }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  const r = ledger.init();
  const text = [
    `${r.created ? "已建立" : "台账已存在"}：${r.dir}`,
    `  milestones.yaml（里程碑）+ features/（功能卡，每张一个 .md）`,
    `下一步：heliu 新点子 "<一句话需求>"（默认预约到下一版）`,
  ].join("\n");
  return { text, data: r, project: ref(p) };
}

export async function opWhereami(ctx: OpContext, opts: { sessionId?: string | null } = {}): Promise<OpResult<WhereAmI>> {
  const project = ctx.projectName ? loadProject(ctx.paths, ctx.projectName) : undefined;
  const w = await whereami(ctx.paths, ctx.cwd, { project, sessionId: opts.sessionId, timeoutMs: 3000 });
  return { text: renderWhereami(w), data: w, project: w.project };
}

/* ───────────── 功能卡 ───────────── */

export interface FeatureAddInput {
  title: string;
  milestone?: string | null;
  /** 是否自动绑定当前目录所在分支（默认是） */
  bind?: boolean;
  session?: string | null;
  body?: string;
}

export async function opFeatureAdd(ctx: OpContext, input: FeatureAddInput): Promise<OpResult<{ feature: LedgerFeature; milestoneCreated: string | null; boundHere: boolean; note: string | null }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  const bindings: FeatureBinding[] = [];
  let note: string | null = null;
  if (input.bind !== false) {
    const w = await locate(ctx, p);
    if (w.repo && w.role === "feature" && w.branch) {
      const owner = ledger.findByBinding(w.repo.id, w.branch);
      if (owner) note = `当前分支已绑定在 ${owner.id}「${owner.title}」上，新卡未自动绑定（需要时：heliu feature bind <卡号> --branch ${w.branch}）`;
      else {
        bindings.push({
          repo: w.repo.id,
          branch: w.branch,
          worktree: w.isMainCheckout ? null : w.worktree,
          session: input.session ?? w.session?.sessionId ?? null,
          pr: null,
        });
      }
    } else if (w.repo && (w.role === "main" || w.role === "integration")) {
      note = `当前在${w.role === "main" ? "主线" : "集成分支"} ${w.branch} 上，未自动绑定（功能卡绑定功能分支）`;
    }
  }
  const { feature, milestoneCreated } = ledger.addFeature({
    title: input.title,
    milestone: input.milestone === undefined ? "next" : input.milestone,
    bindings,
    body: input.body,
    source: ctx.source,
    now: ctx.now,
  });
  const lines = [`已登记 ${renderFeatureLine(feature)}`];
  if (milestoneCreated) {
    lines.push(
      milestoneCreated.id.startsWith(VNEXT)
        ? `  （还没有「规划中」的版本，已自动建 ${milestoneCreated.id} 作为下一版；可改名：heliu milestone rename ${milestoneCreated.id} v1.3）`
        : `  （新建里程碑 ${milestoneCreated.id}，状态 规划中）`,
    );
  }
  if (note) lines.push(`  ${note}`);
  lines.push(`  卡片：${feature.file}`);
  return { text: lines.join("\n"), data: { feature, milestoneCreated: milestoneCreated?.id ?? null, boundHere: bindings.length > 0, note }, project: ref(p) };
}

export async function opFeatureList(ctx: OpContext, filter: { milestone?: string; status?: string }): Promise<OpResult<{ features: LedgerFeature[] }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  const status = filter.status ? filter.status.split(/[,，、]/).map((s) => parseFeatureStatus(s)) : undefined;
  const features = ledger.listFeatures({ milestone: filter.milestone, status });
  const title = `合流 · ${p.name} · 功能卡 ${features.length} 张${filter.milestone ? ` · 预约 ${filter.milestone}` : ""}${filter.status ? ` · 状态 ${filter.status}` : ""}`;
  return { text: renderFeatureTable(features, { ...ctx.render, title }), data: { features }, project: ref(p) };
}

export async function opFeatureReserve(ctx: OpContext, id: string, milestone: string): Promise<OpResult<{ feature: LedgerFeature; from: string | null; milestoneCreated: string | null }>> {
  const p = await projectOf(ctx);
  const r = Ledger.of(p).reserve(id, milestone, ctx.now);
  const to = r.feature.milestone ?? "未预约";
  const lines = [r.from === r.feature.milestone ? `${r.feature.id} 本来就预约在 ${to}，未改动` : `已改预约：${r.feature.id}「${r.feature.title}」${r.from ?? "未预约"} → ${to}`];
  if (r.milestoneCreated) lines.push(`  （新建里程碑 ${r.milestoneCreated.id}，状态 规划中）`);
  return { text: lines.join("\n"), data: { feature: r.feature, from: r.from, milestoneCreated: r.milestoneCreated?.id ?? null }, project: ref(p) };
}

export interface BindInput {
  repo?: string;
  branch?: string;
  worktree?: string | null;
  session?: string | null;
  pr?: number | null;
}

export async function opFeatureBind(ctx: OpContext, id: string, input: BindInput): Promise<OpResult<{ feature: LedgerFeature; added: boolean; binding: FeatureBinding }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  let binding: FeatureBinding;
  if (input.branch) {
    const repo = input.repo ?? p.repos[0]?.id;
    if (!repo || !p.repos.some((r) => r.id === repo)) throw new LedgerError(`项目里没有仓库 ${repo}（可选：${p.repos.map((r) => r.id).join("、")}）`);
    binding = { repo, branch: input.branch, worktree: input.worktree ?? null, session: input.session ?? null, pr: input.pr ?? null };
  } else {
    // 没给分支：绑定当前目录所在分支
    const w = await locate(ctx, p);
    if (!w.repo || !w.branch) throw new LedgerError(`当前目录（${ctx.cwd}）不在项目「${p.name}」的分支上；请用 --branch 指定分支`);
    binding = {
      repo: w.repo.id,
      branch: w.branch,
      worktree: input.worktree ?? (w.isMainCheckout ? null : w.worktree),
      session: input.session ?? w.session?.sessionId ?? null,
      pr: input.pr ?? null,
    };
  }
  const owner = ledger.findByBinding(binding.repo, binding.branch);
  const r = ledger.bind(id, binding, ctx.now);
  const lines = [`${r.added ? "已绑定" : "已更新绑定"}：${r.feature.id}「${r.feature.title}」← ${binding.repo}/${binding.branch}${binding.session ? `（会话 ${binding.session}）` : ""}`];
  if (owner && owner.id !== r.feature.id) lines.push(`  注意：该分支也绑定在 ${owner.id}「${owner.title}」上`);
  return { text: lines.join("\n"), data: { feature: r.feature, added: r.added, binding }, project: ref(p) };
}

export async function opFeatureSet(
  ctx: OpContext,
  id: string,
  input: { status?: string; acceptance?: string; title?: string; type?: string | null; module?: string | null },
): Promise<OpResult<{ feature: LedgerFeature }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  if (!input.status && !input.acceptance && !input.title && input.type === undefined && input.module === undefined) throw new LedgerError("至少给出 状态 / 验收档位 / 新标题 / 类型 / 模块 之一");
  let f: LedgerFeature = ledger.getFeature(id);
  if (input.title) f = ledger.rename(id, input.title, ctx.now);
  if (input.type !== undefined || input.module !== undefined) f = ledger.classify(id, { type: input.type, module: input.module }, ctx.now);
  if (input.status) f = ledger.setStatus(id, parseFeatureStatus(input.status), ctx.now);
  if (input.acceptance) f = ledger.setAcceptance(id, parseAcceptance(input.acceptance), ctx.now);
  const cls = f.type || f.module ? ` · 类型 ${f.type ?? "（推测）"} · 模块 ${f.module ?? "（推测）"}` : "";
  return { text: `已更新 ${renderFeatureLine(f)} · 验收 ${f.acceptance}${cls}`, data: { feature: f }, project: ref(p) };
}

/* ───────────── M8：合并后同步 ───────────── */

export async function opAfterMerge(ctx: OpContext, opts: { dryRun: boolean; ids?: string[] | null }): Promise<OpResult<AfterMergeResult>> {
  const p = await projectOf(ctx);
  const r = await afterMerge(p, ctx.paths, { dryRun: opts.dryRun, ids: opts.ids ?? null, now: ctx.now });
  const lines: string[] = [`合流 · ${p.name} · 合并后同步${r.dryRun ? "（预览，没有写入）" : ""}`];
  if (!r.suggestions.length) lines.push("没有需要同步的卡：还没合入的功能，它们的分支也都还没被集成分支 / 主线包含。");
  else {
    lines.push(`对照最新的 git 事实，这些卡的分支已经合进去了：`);
    for (const s of r.suggestions) {
      const done = r.changed.find((c) => c.id === s.id);
      lines.push(`  ${done ? "✓" : "·"} ${s.id} ${s.title} · ${s.from} → ${s.to}（${s.branches.map((b) => `${b.repoLabel} ${b.branch}`).join("、")}）`);
    }
    if (r.dryRun) lines.push("确认后去掉 --dry-run 再运行一次即可写入（只改台账状态，不碰仓库）。");
    else lines.push(`已更新 ${r.changed.length} 张卡的状态（只改台账，不碰仓库）。`);
  }
  return { text: lines.join("\n"), data: r, project: ref(p) };
}

/* ───────────── M9：跨仓配对 ───────────── */

export interface PairOpData {
  analyzedAt: string | null;
  analyze: AnalyzeResult | null;
  report: PairReport;
  applied: ApplyResult | null;
  unknown: string[];
}

/**
 * 会话开在一个仓库、在别的仓库干活：先（增量）分析对话记录，再列建议；confirm 给了才写台账。
 * 对话记录只读；缓存只存路径与次数。
 */
export async function opPair(
  ctx: OpContext,
  opts: { reanalyze?: boolean; confirm?: string[] | null; milestone?: string | null; weak?: boolean; transcriptsRoot?: string } = {},
): Promise<OpResult<PairOpData>> {
  const p = await projectOf(ctx);
  const { report, sessions } = await reconcile(p, ctx.paths, { precheck: false, dirty: false, timeoutMs: 8000 }, { now: ctx.now });
  const analyze = await analyzeTranscripts(ctx.paths, p.name, report, sessions, { force: !!opts.reanalyze, root: opts.transcriptsRoot });
  const ev = loadEvidence(ctx.paths, p.name);
  const ledger = Ledger.of(p);
  const rep = suggestPairings({ report, sessions, features: ledger.load().features, evidence: ev.rows, hasOwnCommits: await ownCommitsOf(ctx.paths, report) });
  const head = `合流 · ${p.name} · 跨仓配对（分析了 ${analyze.files} 份对话记录：新提取 ${analyze.extracted}、没变跳过 ${analyze.skipped}${analyze.missing ? `、找不到 ${analyze.missing}` : ""}，用时 ${(analyze.ms / 1000).toFixed(1)} 秒）`;
  if (!opts.confirm?.length) {
    return { text: `${head}\n${renderPairings(rep, ev.analyzedAt, { weak: opts.weak })}`, data: { analyzedAt: ev.analyzedAt, analyze, report: rep, applied: null, unknown: [] }, project: ref(p) };
  }
  const { chosen, unknown } = selectPairings(rep, opts.confirm);
  const applied = applyPairings(ledger, rep, report, chosen, { milestone: opts.milestone, source: ctx.source, now: ctx.now });
  const extra = unknown.length ? `\n没找到这些编号：${unknown.join("、")}（先不带 --确认 运行一次看编号）` : "";
  return { text: `${head}\n${renderApply(applied)}${extra}`, data: { analyzedAt: ev.analyzedAt, analyze, report: rep, applied, unknown }, project: ref(p) };
}

/* ───────────── 里程碑 ───────────── */

export async function opMilestoneList(
  ctx: OpContext,
): Promise<OpResult<{ milestones: ReturnType<Ledger["listMilestones"]>; next: string | null; counts: Array<{ id: string; todo: number; total: number }> }>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  const list = ledger.listMilestones();
  const features = ledger.load().features;
  const effective = (f: LedgerFeature) => ledger.effectiveMilestone(f, list);
  // 待办数与 `heliu 待办` 用同一个函数（todoFeatures），保证两边一致
  const counts = list.map((m) => ({
    id: m.id,
    todo: todoFeatures(features, m.id, effective).length,
    total: features.filter((f) => effective(f) === m.id).length,
  }));
  const unreserved = features.filter((f) => !f.milestone && countsTowardTodo(f)).length;
  const text = renderMilestones(list, counts, unreserved, ctx.render);
  return { text, data: { milestones: list, next: list.find((m) => m.status === "规划中")?.id ?? null, counts }, project: ref(p) };
}

export async function opMilestoneAdd(ctx: OpContext, input: { id: string; title?: string; target?: string; integration?: string }): Promise<OpResult> {
  const p = await projectOf(ctx);
  const m = Ledger.of(p).addMilestone({ id: input.id, title: input.title, target_date: input.target ?? null, integration_branch: input.integration ?? null });
  return { text: `已新建里程碑 ${m.id}${m.title ? `「${m.title}」` : ""}（规划中）`, data: { milestone: m }, project: ref(p) };
}

export async function opMilestoneFreeze(ctx: OpContext, id: string): Promise<OpResult> {
  const p = await projectOf(ctx);
  const m = Ledger.of(p).freezeMilestone(id);
  return { text: `已冻结 ${m.id}：不再接新预约（「下一版」会指向下一个规划中的版本）`, data: { milestone: m }, project: ref(p) };
}

export async function opMilestoneRename(ctx: OpContext, from: string, to: string): Promise<OpResult> {
  const p = await projectOf(ctx);
  const r = Ledger.of(p).renameMilestone(from, to, ctx.now);
  return { text: `已改名为 ${r.milestone.id}，同步更新 ${r.features} 张功能卡`, data: r, project: ref(p) };
}

export async function opMilestoneTodo(ctx: OpContext, requested: string, opts: { precheck?: boolean; limitPerGroup?: number } = {}): Promise<OpResult<TodoReport | null>> {
  const p = await projectOf(ctx);
  const ledger = Ledger.of(p);
  const req = requested?.trim() || "下一版";
  const m = ledger.resolveMilestone(req, { create: false })?.milestone ?? null;
  if (!m) {
    const isNext = NEXT_ALIASES.has(req.toLowerCase()) || NEXT_ALIASES.has(req);
    const list = ledger.listMilestones();
    if (!isNext) throw new LedgerError(`没有里程碑 ${req}（已有：${list.map((x) => x.id).join("、") || "无"}）`);
    const text = `合流 · ${p.name} · 待办（下一版）\n  还没有「规划中」的版本。heliu 新点子 "<一句话需求>" 会自动建 ${VNEXT} 并预约进去；或 heliu milestone add v1.2。`;
    return { text, data: null, project: ref(p) };
  }
  const milestones = ledger.listMilestones();
  const features = todoFeatures(ledger.load().features, m.id, (f) => ledger.effectiveMilestone(f, milestones));
  const rec = await reconcile(p, ctx.paths, { precheck: !!opts.precheck, dirty: false, timeoutMs: 8000 });
  // 「尚无独有提交」：来源分支 → reflog 提交类条目 → 结构兜底（零提交分支的 tip 恒为主线/集成祖先，不能据此当成已合入）
  const zeroCommit = await zeroCommitBranches(
    rec.report,
    features.flatMap((f) => f.bindings.map((b) => ({ repo: b.repo, branch: b.branch }))),
    { sourceOf: sourceBranchIndex(ctx.paths, rec.report) },
  );
  const next = milestones.find((x) => x.status === "规划中") ?? null;
  let stops: ReturnType<Cache["stops"]> = [];
  try {
    const c = Cache.open(ctx.paths, p.name, { readonly: true });
    if (c) {
      stops = c.stops();
      c.close();
    }
  } catch {
    /* 缓存可删可重建，读不到就当没有 */
  }
  const todo = groupTodo({
    milestone: m,
    requested: req,
    features,
    report: rec.report,
    sessions: rec.sessions,
    stops,
    zeroCommit,
    nextMilestone: next ? { id: next.id, status: next.status } : null,
    now: ctx.now,
  });
  return { text: renderTodo(p.name, todo, { ...ctx.render, limitPerGroup: opts.limitPerGroup }), data: todo, project: ref(p) };
}

/* ───────────── sync ───────────── */

export async function opSync(ctx: OpContext, opts: { dryRun: boolean }): Promise<OpResult<SyncResult>> {
  const p = await projectOf(ctx);
  const r = await syncLedger(p, ctx.paths, { dryRun: opts.dryRun, now: ctx.now });
  return { text: renderSync(p.name, r, ctx.render), data: r, project: ref(p) };
}
