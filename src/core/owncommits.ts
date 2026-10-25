/**
 * 「尚无独有提交」判定（M2 第 2、3 轮，Codex 第 1、2 轮反馈）。
 *
 * 问题：刚切出、还没提交的分支，tip 就是主线/集成分支上的某个提交，git 祖先判断恒为「已进主线/已进集成分支」，
 * 但并没有任何工作被合入。反过来，有过提交、后来被快进合并（ff）的分支，tip 也会与主线/集成分支同点，
 * 不能因为「同点」就当成尚无提交。M1 对账层（分支视角的三档）不改，只在承诺层（待办/sync）上叠加判定。
 *
 * 判定顺序（全部只读）：
 * A. 知道分支的来源分支（git-worktrees.json / 会话 JSON 的 sourceBranch）时，以它为主判据：
 *    rev-list --count <来源>..<分支> > 0 → 有独有提交；== 0 → 再看 reflog：出现过提交类条目
 *    （commit / cherry-pick / revert / 真正的 merge 提交）= 有过提交、已被并回来源 → 不是尚无提交；否则尚无提交。
 * B. 不知道来源分支：读 reflog（git log -g，只读）。出现过提交类条目 → 有过提交（已被包含则为已进主线/集成）；
 *    只有「branch: Created from …」、快进、reset 之类 → 尚无提交。
 * C. reflog 也读不到（过期/超时）：结构兜底——
 *    1) tip == 主线 tip → 尚无提交；
 *    2) tip == 集成 tip（≠ 主线 tip）→ rev-list --count 主线..分支 > 0 → 已进集成分支；== 0 → 尚无提交；
 *    3) 被主线/集成分支包含但不同点 → 已进主线 / 已进集成分支。
 * 未被主线或集成分支包含（独立未合并）的分支一律视为有独有提交。
 */
import type { FeatureView, ReconcileReport, RepoReport } from "../types.ts";
import { lines, runGit } from "./git.ts";
import { canonicalPath, isUnder, type HeliuPaths } from "./paths.ts";
import { loadDesktopSessions, loadDesktopWorktrees } from "./sessions.ts";

export const bindingKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;

function tips(repo: RepoReport): { main: string | null; integ: string | null } {
  return {
    main: repo.branches.find((b) => b.role === "main")?.sha ?? null,
    integ: repo.branches.find((b) => b.role === "integration")?.sha ?? null,
  };
}

/**
 * 纯事实兜底（无 git 调用、无 reflog，测试与缺省用）：
 * tip == 主线 tip，或 tip == 集成 tip 且相对主线领先 0 → 尚无提交；其余被包含的分支算有提交。
 */
export function zeroCommitByFacts(repo: RepoReport, fv: FeatureView): boolean {
  if (fv.role !== "feature" || fv.mergedState === "unmerged") return false;
  const t = tips(repo);
  if (t.main && fv.sha === t.main) return true;
  if (t.integ && fv.sha === t.integ) return (fv.vsMain?.ahead ?? 1) === 0;
  return false;
}

/** reflog 条目是否表示「在这个分支上做了提交」 */
export function isCommitEntry(subject: string): boolean {
  return /^(commit|cherry-pick|revert)\b/.test(subject) || /^merge .*: Merge made by/.test(subject);
}

/** 读 reflog：返回是否出现过提交类条目；读不到返回 null */
async function reflogHasCommits(root: string, fv: FeatureView, timeoutMs: number): Promise<boolean | null> {
  const r = await runGit(root, ["log", "-g", "--format=%H%x1f%gs", fv.ref, "--"], { timeoutMs, limitKey: root, protect: [root] });
  if (!r.ok) return null;
  const entries = lines(r.stdout)
    .map((l) => l.split("\x1f"))
    .filter((p) => p[0]);
  if (!entries.length) return null;
  return entries.some((p) => isCommitEntry(p[1] ?? ""));
}

/** rev-list --count base..ref；base 不存在或出错返回 null */
async function countBetween(root: string, base: string, ref: string, timeoutMs: number): Promise<number | null> {
  if (!/^[\w][\w./@+-]*$/.test(base)) return null; // 防止把奇怪的值当选项/表达式传给 git
  const r = await runGit(root, ["rev-list", "--count", `${base}..${ref}`, "--"], { timeoutMs, limitKey: root, protect: [root] });
  const n = Number(lines(r.stdout)[0]);
  return r.ok && Number.isFinite(n) ? n : null;
}

export type SourceOf = (repoId: string, branch: string) => string | null;

/**
 * 分支的来源分支索引：git-worktrees.json（桌面端建 worktree 时记录）优先，其次会话 JSON 的 sourceBranch。
 * 只读这两个文件；按 仓库 + 分支名 匹配。
 */
export function sourceBranchIndex(paths: HeliuPaths, report: ReconcileReport): SourceOf {
  const map = new Map<string, string>();
  const repos = report.repos.filter((r) => r.reachable).map((r) => ({ r, root: canonicalPath(r.path) }));
  const repoOfPath = (p: string | null | undefined): RepoReport | null => {
    if (!p) return null;
    const real = canonicalPath(p);
    for (const { r, root } of repos) {
      if (isUnder(real, root)) return r;
      if (r.worktrees.some((w) => isUnder(real, canonicalPath(w.path)))) return r;
    }
    return null;
  };
  for (const w of loadDesktopWorktrees(paths)) {
    if (!w.branch || !w.sourceBranch) continue;
    const r = repoOfPath(w.baseRepo) ?? repoOfPath(w.path);
    if (r && !map.has(bindingKey(r.id, w.branch))) map.set(bindingKey(r.id, w.branch), w.sourceBranch);
  }
  for (const s of loadDesktopSessions(paths).sessions) {
    if (!s.branch || !s.sourceBranch) continue;
    const r = repoOfPath(s.worktreePath) ?? repoOfPath(s.cwd) ?? repoOfPath(s.originCwd);
    if (r && !map.has(bindingKey(r.id, s.branch))) map.set(bindingKey(r.id, s.branch), s.sourceBranch);
  }
  return (repoId, branch) => map.get(bindingKey(repoId, branch)) ?? null;
}

/** 单个分支是否尚无独有提交（按文件头 A → B → C 的顺序） */
export async function isZeroCommit(repo: RepoReport, fv: FeatureView, source: string | null, timeoutMs = 4000): Promise<boolean> {
  if (fv.role !== "feature" || fv.mergedState === "unmerged") return false;
  const root = canonicalPath(repo.path);
  if (source && source !== fv.branch) {
    const c = await countBetween(root, source, fv.ref, timeoutMs);
    if (c !== null) {
      if (c > 0) return false;
      return (await reflogHasCommits(root, fv, timeoutMs)) !== true;
    }
  }
  const had = await reflogHasCommits(root, fv, timeoutMs);
  if (had !== null) return !had;
  const t = tips(repo);
  if (t.main && fv.sha === t.main) return true;
  if (t.integ && fv.sha === t.integ) {
    const c = await countBetween(root, repo.main, fv.ref, timeoutMs);
    return c === 0;
  }
  return false;
}

/**
 * 给定一批 (仓库, 分支)，返回其中「尚无独有提交」的集合（key = bindingKey）。
 */
export async function zeroCommitBranches(
  report: ReconcileReport,
  candidates: Array<{ repo: string; branch: string }>,
  opts: { timeoutMs?: number; sourceOf?: SourceOf } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const seen = new Set<string>();
  await Promise.all(
    candidates.map(async (c) => {
      const key = bindingKey(c.repo, c.branch);
      if (seen.has(key)) return;
      seen.add(key);
      const repo = report.repos.find((r) => r.id === c.repo);
      if (!repo?.reachable) return;
      const fv = repo.branches.find((b) => b.branch === c.branch);
      if (!fv) return;
      if (await isZeroCommit(repo, fv, opts.sourceOf?.(c.repo, c.branch) ?? null, opts.timeoutMs)) out.add(key);
    }),
  );
  return out;
}
