/**
 * 「尚无独有提交」判定（M2 第 2 轮，Codex 第 1 轮反馈）。
 *
 * 问题：刚从主线切出、还没提交的分支，tip 就是主线上的某个提交，git 祖先判断恒为「已进主线」，
 * 但并没有任何工作被合入。M1 对账层（分支视角的三档）不改，只在承诺层（待办/sync）上叠加这个判定。
 *
 * 判定（只读）：
 * 1. 分支 tip 与主线顶端或集成分支顶端同点 → 尚无提交；
 * 2. 否则若分支已被主线/集成分支包含：读该分支的 reflog（git log -g，只读），全部条目都指向当前 tip
 *    = 自创建后从未移动 → 尚无提交；reflog 里出现过别的提交 = 有过提交、已被合入；
 * 3. reflog 读不到（过期/超时）时按事实兜底：相对主线与集成分支都领先 0（无集成分支时只看主线）→ 尚无提交。
 */
import type { FeatureView, ReconcileReport, RepoReport } from "../types.ts";
import { lines, runGit } from "./git.ts";
import { canonicalPath } from "./paths.ts";

export const bindingKey = (repo: string, branch: string) => `${repo}\u0000${branch}`;

function tips(repo: RepoReport): { main: string | null; integ: string | null } {
  return {
    main: repo.branches.find((b) => b.role === "main")?.sha ?? null,
    integ: repo.branches.find((b) => b.role === "integration")?.sha ?? null,
  };
}

/** 纯事实判定（无 git 调用）：同点，或相对主线/集成分支都领先 0 */
export function zeroCommitByFacts(repo: RepoReport, fv: FeatureView): boolean {
  if (fv.role !== "feature" || fv.mergedState === "unmerged") return false;
  const t = tips(repo);
  if (fv.sha === t.main || fv.sha === t.integ) return true;
  const aheadMain = fv.vsMain?.ahead ?? null;
  const aheadInteg = fv.vsIntegration?.ahead ?? null;
  return aheadMain === 0 && (repo.integration ? aheadInteg === 0 || aheadInteg === null : true);
}

/** 读 reflog：分支自创建后是否从未移动；读不到返回 null */
async function neverMoved(root: string, fv: FeatureView, timeoutMs: number): Promise<boolean | null> {
  const r = await runGit(root, ["log", "-g", "--format=%H", fv.ref, "--"], { timeoutMs, limitKey: root, protect: [root] });
  if (!r.ok) return null;
  const shas = lines(r.stdout).map((x) => x.trim()).filter(Boolean);
  if (!shas.length) return null;
  return shas.every((x) => x === fv.sha);
}

/**
 * 给定一批 (仓库, 分支)，返回其中「尚无独有提交」的集合（key = bindingKey）。
 * 只对已被主线/集成分支包含的功能分支做判定；未合并的分支一定有独有提交。
 */
export async function zeroCommitBranches(
  report: ReconcileReport,
  candidates: Array<{ repo: string; branch: string }>,
  opts: { timeoutMs?: number } = {},
): Promise<Set<string>> {
  const out = new Set<string>();
  const timeoutMs = opts.timeoutMs ?? 4000;
  const seen = new Set<string>();
  await Promise.all(
    candidates.map(async (c) => {
      const key = bindingKey(c.repo, c.branch);
      if (seen.has(key)) return;
      seen.add(key);
      const repo = report.repos.find((r) => r.id === c.repo);
      if (!repo?.reachable) return;
      const fv = repo.branches.find((b) => b.branch === c.branch);
      if (!fv || fv.role !== "feature" || fv.mergedState === "unmerged") return;
      const t = tips(repo);
      if (fv.sha === t.main || fv.sha === t.integ) {
        out.add(key);
        return;
      }
      const moved = await neverMoved(canonicalPath(repo.path), fv, timeoutMs);
      if (moved === true) out.add(key);
      else if (moved === null && zeroCommitByFacts(repo, fv)) out.add(key);
    }),
  );
  return out;
}
