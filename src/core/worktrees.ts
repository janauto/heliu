/**
 * worktree 事实采集：
 * - `git worktree list --porcelain`（路径、HEAD、分支、locked、prunable）
 * - `.git/worktrees/*` 管理目录：只做 readdir/stat，不读文件内容（iCloud 空壳 stat 不触发下载）
 * - 工作区脏检查：`status --porcelain -uno`，带超时；超时记 unknown
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { DirtyState, WorktreeInfo } from "../types.ts";
import { runGit, type RunGitOptions } from "./git.ts";

export interface PorcelainWorktree {
  path: string;
  head: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** 解析 `git worktree list --porcelain` */
export function parseWorktreePorcelain(stdout: string): PorcelainWorktree[] {
  const out: PorcelainWorktree[] = [];
  let cur: PorcelainWorktree | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), head: null, branch: null, detached: false, bare: false, locked: false, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (line.startsWith("HEAD ")) cur.head = line.slice(5);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "detached") cur.detached = true;
    else if (line === "bare") cur.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) cur.locked = true;
    else if (line === "prunable" || line.startsWith("prunable ")) cur.prunable = true;
  }
  if (cur) out.push(cur);
  return out;
}

export interface AdminDirScan {
  /** .git/worktrees/<id> 缺 gitdir 文件 */
  orphans: string[];
  /** 残留 index.lock（含主 .git） */
  locks: string[];
  /** iCloud 冲突副本，如「index 2」「HEAD 2」 */
  conflictCopies: string[];
  /** 管理目录条目总数 */
  entries: number;
}

const CONFLICT_COPY = /^(index|HEAD|ORIG_HEAD|FETCH_HEAD|config|packed-refs|gitdir|commondir) \d+$/;

/** 只做 readdir / existsSync，不读取任何文件内容 */
export function scanAdminDirs(commonDir: string, icloud: boolean): AdminDirScan {
  const res: AdminDirScan = { orphans: [], locks: [], conflictCopies: [], entries: 0 };
  const mainLock = join(commonDir, "index.lock");
  if (existsSync(mainLock)) res.locks.push(mainLock);
  if (icloud) {
    for (const f of safeReaddir(commonDir)) if (CONFLICT_COPY.test(f)) res.conflictCopies.push(join(commonDir, f));
  }
  const wtRoot = join(commonDir, "worktrees");
  for (const id of safeReaddir(wtRoot)) {
    const d = join(wtRoot, id);
    if (!isDir(d)) continue;
    res.entries++;
    if (!existsSync(join(d, "gitdir"))) res.orphans.push(d);
    if (existsSync(join(d, "index.lock"))) res.locks.push(join(d, "index.lock"));
    if (icloud) {
      for (const f of safeReaddir(d)) if (CONFLICT_COPY.test(f)) res.conflictCopies.push(join(d, f));
    }
  }
  return res;
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface DirtyResult {
  state: DirtyState;
  count: number | null;
  reason: string | null;
}

/** 工作区脏检查：只数已跟踪文件改动（-uno），iCloud 下超时记 unknown */
export async function checkDirty(path: string, opts: RunGitOptions): Promise<DirtyResult> {
  if (!existsSync(path)) return { state: "unknown", count: null, reason: "目录不存在" };
  const r = await runGit(path, ["status", "--porcelain=v1", "-uno"], opts);
  if (r.timedOut) return { state: "unknown", count: null, reason: "超时（可能是 iCloud 空壳需下载）" };
  if (!r.ok) return { state: "unknown", count: null, reason: r.stderr.trim().split("\n")[0] || `退出码 ${r.code}` };
  const n = r.stdout.split("\n").filter((l) => l.length > 0).length;
  return { state: n > 0 ? "dirty" : "clean", count: n, reason: null };
}

/** 构造 WorktreeInfo（脏检查结果稍后填入） */
export function toWorktreeInfo(
  w: PorcelainWorktree,
  isMain: boolean,
  managedByDesktop: boolean,
  leasedBy: string | null,
): WorktreeInfo {
  return {
    path: w.path,
    dirName: basename(w.path),
    branch: w.branch,
    head: w.head,
    isMain,
    detached: w.detached,
    locked: w.locked,
    prunable: w.prunable,
    managedByDesktop,
    leasedBy,
    dirty: "skipped",
    dirtyCount: null,
    dirtyReason: null,
  };
}

/** 分支名最后一段（claude/foo-123abc → foo-123abc） */
export function branchSlug(branch: string): string {
  return branch.split("/").pop() ?? branch;
}
