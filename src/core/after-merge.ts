/**
 * 合并后同步（M8）：在别处（终端、Claude 会话、GitHub）合并完分支后，把"已经合进去了"这件事同步回台账。
 *
 * 规则（只看 git 事实，不看会话是否还停在"等你"）：
 * - 只看还没完成的卡（想法 / 开发中 / 待合并），以及已合入的卡（可能已进主线，往上升一级）；
 * - 卡片绑定的分支里，有独有提交的那些（尚无提交的分支没有工作可合，不算）全部已被主线包含 → 建议「已进主线」；
 *   全部已被集成分支或主线包含 → 建议「已合入」；
 * - 只往前升，从不降级；没有一条有提交的分支 → 不建议。
 * 只写台账状态，不碰仓库。
 */
import { Ledger } from "./ledger.ts";
import type { HeliuPaths } from "./paths.ts";
import type { ProjectConfig } from "./project.ts";
import { reconcile, type ReconcileResult } from "./reconcile.ts";
import { bindingKey, sourceBranchIndex, zeroCommitBranches } from "./owncommits.ts";
import type { FeatureStatus, LedgerFeature, MergedState } from "../types.ts";

const RANK: Record<string, number> = { 想法: 0, 开发中: 1, 待合并: 2, 已合入: 3, 已进主线: 4, 已发布: 5 };

export interface MergedSuggestion {
  id: string;
  title: string;
  milestone: string | null;
  from: FeatureStatus;
  to: "已合入" | "已进主线";
  branches: Array<{ repo: string; repoLabel: string; branch: string; mergedState: MergedState }>;
}

export interface AfterMergeResult {
  dryRun: boolean;
  scannedAt: string;
  suggestions: MergedSuggestion[];
  /** 实际改了的卡（dry-run 时为空） */
  changed: Array<{ id: string; title: string; from: FeatureStatus; to: FeatureStatus }>;
}

export async function mergedSuggestions(
  project: ProjectConfig,
  paths: HeliuPaths,
  opts: { reconciled?: ReconcileResult; timeoutMs?: number } = {},
): Promise<{ suggestions: MergedSuggestion[]; scannedAt: string }> {
  const rec = opts.reconciled ?? (await reconcile(project, paths, { precheck: false, dirty: false, timeoutMs: opts.timeoutMs ?? 8000 }));
  const ledger = Ledger.of(project);
  const features = ledger.load().features.filter((f) => f.status in RANK && RANK[f.status]! <= RANK["已合入"]!);
  const zero = await zeroCommitBranches(
    rec.report,
    features.flatMap((f) => f.bindings.map((b) => ({ repo: b.repo, branch: b.branch }))),
    { sourceOf: sourceBranchIndex(paths, rec.report), timeoutMs: opts.timeoutMs },
  );
  const repos = new Map(rec.report.repos.map((r) => [r.id, r]));
  const suggestions: MergedSuggestion[] = [];
  for (const f of features) {
    const working = f.bindings
      .map((b) => {
        const repo = repos.get(b.repo);
        const fv = repo?.reachable ? repo.branches.find((x) => x.branch === b.branch) : undefined;
        return repo && fv && !zero.has(bindingKey(b.repo, b.branch)) ? { repo: b.repo, repoLabel: repo.label, branch: b.branch, mergedState: fv.mergedState } : null;
      })
      .filter((x): x is NonNullable<typeof x> => !!x);
    if (!working.length || working.some((w) => w.mergedState === "unmerged")) continue;
    const to: MergedSuggestion["to"] = working.every((w) => w.mergedState === "in_main") ? "已进主线" : "已合入";
    if (RANK[to]! <= RANK[f.status]!) continue;
    suggestions.push({ id: f.id, title: f.title, milestone: ledger.effectiveMilestone(f), from: f.status, to, branches: working });
  }
  return { suggestions, scannedAt: rec.report.generatedAt ?? new Date().toISOString() };
}

/** 按建议写入（ids 为空 = 全部建议）；只往前升 */
export function applyMerged(project: ProjectConfig, suggestions: MergedSuggestion[], ids: string[] | null, now = new Date()): AfterMergeResult["changed"] {
  const ledger = Ledger.of(project);
  const want = ids && ids.length ? new Set(ids.map((x) => x.trim().toUpperCase())) : null;
  const changed: AfterMergeResult["changed"] = [];
  for (const s of suggestions) {
    if (want && !want.has(s.id.toUpperCase())) continue;
    const cur: LedgerFeature = ledger.getFeature(s.id);
    if (!(cur.status in RANK) || RANK[s.to]! <= RANK[cur.status]!) continue;
    ledger.setStatus(s.id, s.to, now);
    changed.push({ id: s.id, title: s.title, from: cur.status, to: s.to });
  }
  return changed;
}

export async function afterMerge(project: ProjectConfig, paths: HeliuPaths, opts: { dryRun: boolean; ids?: string[] | null; reconciled?: ReconcileResult; now?: Date }): Promise<AfterMergeResult> {
  const { suggestions, scannedAt } = await mergedSuggestions(project, paths, { reconciled: opts.reconciled });
  const changed = opts.dryRun ? [] : applyMerged(project, suggestions, opts.ids ?? null, opts.now ?? new Date());
  return { dryRun: opts.dryRun, scannedAt, suggestions, changed };
}
