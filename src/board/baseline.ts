/**
 * 「同步基线（预演）」：把主线 / 集成分支合入某个功能分支会冲突哪些文件——只试合、不执行。
 * 复用 M1 的只读层：runGit 白名单 + precheckMerge（merge-tree --write-tree，对象隔离区 + 沙箱）。
 * merge-tree 的冲突文件集合与合并方向无关，所以「主线合入本分支」与「本分支合入主线」冲突文件相同。
 */
import type { LedgerFeature } from "../types.ts";
import { aheadBehind, precheckMerge, refExists } from "../core/branches.ts";
import { createObjectQuarantine, lines, runGit, type RunGitOptions } from "../core/git.ts";
import { canonicalPath } from "../core/paths.ts";
import type { ProjectConfig } from "../core/project.ts";
import type { BaselineBinding, BaselineCheck, BaselineData } from "./api-types.ts";

export async function baselinePreview(project: ProjectConfig, feature: LedgerFeature, timeoutMs = 8000): Promise<BaselineData> {
  const started = performance.now();
  const bindings: BaselineBinding[] = [];
  for (const b of feature.bindings) {
    const cfg = project.repos.find((r) => r.id === b.repo);
    const out: BaselineBinding = { repo: b.repo, repoLabel: cfg?.label ?? b.repo, branch: b.branch, exists: false, checks: [] };
    bindings.push(out);
    if (!cfg) continue;
    const root = canonicalPath(cfg.path);
    const opts: RunGitOptions = { timeoutMs, limitKey: root, protect: [root] };
    const rp = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], opts);
    if (!rp.ok) continue;
    const common = canonicalPath(lines(rp.stdout)[0] ?? `${root}/.git`);
    opts.protect = [root, common];
    const ref = `refs/heads/${b.branch}`;
    out.exists = await refExists(root, ref, opts);
    if (!out.exists) continue;
    const bases: Array<{ base: BaselineCheck["base"]; branch: string }> = [{ base: "main", branch: cfg.main }];
    if (cfg.integration && cfg.integration !== b.branch) bases.push({ base: "integration", branch: cfg.integration });
    const quarantine = createObjectQuarantine(common);
    try {
      for (const base of bases) {
        if (base.branch === b.branch) continue;
        const baseRef = `refs/heads/${base.branch}`;
        if (!(await refExists(root, baseRef, opts))) {
          out.checks.push({ base: base.base, baseBranch: base.branch, behind: null, conflictFiles: null, conflicts: [], error: "该分支在本地不存在" });
          continue;
        }
        const [ab, pc] = await Promise.all([aheadBehind(root, baseRef, ref, opts), precheckMerge(root, base.branch, baseRef, null, ref, quarantine, opts)]);
        out.checks.push({
          base: base.base,
          baseBranch: base.branch,
          behind: ab?.behind ?? null,
          conflictFiles: pc.conflictFiles,
          conflicts: pc.conflicts,
          error: pc.timedOut ? "试合超时" : pc.error,
        });
      }
    } finally {
      quarantine.dispose();
    }
  }
  return { id: feature.id, title: feature.title, bindings, elapsedMs: Math.round(performance.now() - started) };
}
