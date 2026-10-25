/**
 * 卫生页：把 M1 hygiene 的 9 种问题归成四类（产品定义第 5 节：待清理 worktree、目录名≠分支名、孤儿条目、疑似拷贝），
 * 每条附「建议命令」——只显示给人看，heliu 绝不执行（ADR-4：不删分支、不删 worktree）。
 */
import type { HygieneIssue, HygieneKind, ReconcileReport } from "../types.ts";
import type { HygieneCategory, HygieneCategoryKey, HygieneData, HygieneItem } from "./api-types.ts";

export const HYGIENE_CATEGORIES: Array<{ key: HygieneCategoryKey; title: string; hint: string; kinds: HygieneKind[] }> = [
  {
    key: "cleanup",
    title: "待清理的 worktree",
    hint: "分支已进主线或停在主线顶端、目录已不存在、分离 HEAD。清理前请确认目录里没有未提交的改动。",
    kinds: ["merged_worktree_remains", "worktree_no_commits", "prunable_worktree", "detached_worktree"],
  },
  {
    key: "mismatch",
    title: "目录名 ≠ 分支名",
    hint: "桌面应用复用了 worktree 目录，目录名已不代表它现在的分支；一般无需处理，看分支时以分支名为准。",
    kinds: ["dir_branch_mismatch"],
  },
  {
    key: "orphan",
    title: "孤儿条目与锁文件",
    hint: ".git/worktrees 下缺 gitdir 的登记、残留的 index.lock（也可能有 git 进程正在运行）。",
    kinds: ["orphan_admin_dir", "index_lock"],
  },
  {
    key: "copies",
    title: "iCloud 冲突副本与主目录改动",
    hint: "「index 2」这类 iCloud 冲突副本疑似手工拷贝/同步残留；主目录有已跟踪文件改动未提交。",
    kinds: ["icloud_conflict_copy", "main_dirty"],
  },
];

/** shell 单引号转义 */
export function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/** 建议命令：只读命令优先；会改东西的命令都写明「确认后」，并且不带 --force */
export function suggestionFor(h: HygieneIssue, repoPath: string): string | null {
  const repo = shq(repoPath);
  const path = h.path ? shq(h.path) : null;
  switch (h.kind) {
    case "merged_worktree_remains":
    case "worktree_no_commits":
      return path ? `git -C ${path} status --short   # 先确认没有未提交改动\ngit -C ${repo} worktree remove ${path}   # 确认后再执行（不加 --force）` : null;
    case "prunable_worktree":
    case "orphan_admin_dir":
      return `git -C ${repo} worktree prune --dry-run --verbose   # 先看会清掉哪些登记，确认后去掉 --dry-run`;
    case "detached_worktree":
      return path ? `git -C ${path} log -1 --oneline   # 看停在哪个提交，再决定建分支还是移除目录` : null;
    case "dir_branch_mismatch":
      return path ? `git -C ${path} branch --show-current   # 核对目录现在的分支` : null;
    case "index_lock":
      return path ? `pgrep -fl git   # 确认没有 git 进程在跑\nrm ${path}   # 确认是残留后再删` : null;
    case "icloud_conflict_copy":
      return path ? `find ${path} -maxdepth 3 -name '* [0-9]*'   # 列出冲突副本，逐个核对后再处理` : null;
    case "main_dirty":
      return h.severity === "warn" && path ? `git -C ${path} status --short   # 看主目录改了哪些文件` : null;
    default:
      return null;
  }
}

export function buildHygiene(report: ReconcileReport): HygieneData {
  return {
    repos: report.repos.map((r) => {
      const categories: HygieneCategory[] = HYGIENE_CATEGORIES.map((c) => ({
        ...c,
        items: r.hygiene.filter((h) => c.kinds.includes(h.kind)).map((h): HygieneItem => ({ ...h, suggestion: suggestionFor(h, r.path) })),
      }));
      return {
        id: r.id,
        label: r.label,
        reachable: r.reachable,
        error: r.error,
        warnings: r.hygiene.filter((h) => h.severity === "warn").length,
        infos: r.hygiene.filter((h) => h.severity === "info").length,
        categories,
      };
    }),
  };
}
