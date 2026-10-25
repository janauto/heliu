/**
 * 真仓库零写入证据：对仓库 .git 元数据与工作目录顶层做 stat 快照（只 stat / readdir，不读文件内容，不触发 iCloud 下载）。
 * 沿用 M1/M2 的方法：HEAD/index/config/packed-refs、logs、refs、objects/pack、objects/info、objects/xx（目录 mtime + 条目数 + 最新 mtime）、
 * worktrees/*（各 worktree 的 HEAD/index 等）、仓库根目录与顶层条目。
 */
import { existsSync, lstatSync, readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

export type Snapshot = Map<string, string>;

function st(p: string): string | null {
  try {
    const s = lstatSync(p);
    return `${s.mtimeMs}|${s.size}`;
  } catch {
    return null;
  }
}

function walk(dir: string, rel: string, out: Snapshot, depth = 0): void {
  if (depth > 12 || !existsSync(dir)) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      out.set(`${r}/`, st(p) ?? "missing");
      walk(p, r, out, depth + 1);
    } else out.set(r, st(p) ?? "missing");
  }
}

/** 一个仓库的快照；commonDir 缺省 <root>/.git */
export function snapshotRepo(root: string, commonDir = join(root, ".git")): Snapshot {
  const out: Snapshot = new Map();
  const g = commonDir;
  out.set("<root>/", st(root) ?? "missing");
  try {
    for (const e of readdirSync(root)) out.set(`<root>/${e}`, st(join(root, e)) ?? "missing");
  } catch {
    /* 不可读就只记根目录 */
  }
  for (const f of ["HEAD", "index", "config", "packed-refs", "FETCH_HEAD", "ORIG_HEAD", "MERGE_HEAD", "shallow", "description", "COMMIT_EDITMSG"]) {
    out.set(f, st(join(g, f)) ?? "missing");
  }
  walk(join(g, "refs"), "refs", out);
  walk(join(g, "logs"), "logs", out);
  walk(join(g, "objects", "pack"), "objects/pack", out);
  walk(join(g, "objects", "info"), "objects/info", out);
  walk(join(g, "worktrees"), "worktrees", out, 10);
  // 松散对象：每个 xx 目录记 mtime、条目数、最新 mtime
  const od = join(g, "objects");
  try {
    for (const d of readdirSync(od)) {
      if (!/^[0-9a-f]{2}$/.test(d)) continue;
      const p = join(od, d);
      let n = 0;
      let newest = 0;
      for (const f of readdirSync(p)) {
        n++;
        try {
          newest = Math.max(newest, statSync(join(p, f)).mtimeMs);
        } catch {
          /* 并发删除 */
        }
      }
      out.set(`objects/${d}/`, `${st(p)}|n=${n}|newest=${newest}`);
    }
  } catch {
    /* 没有 objects 目录 */
  }
  return out;
}

export interface SnapshotDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

export function diffSnapshots(a: Snapshot, b: Snapshot): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [k, v] of b) {
    if (!a.has(k)) added.push(k);
    else if (a.get(k) !== v) changed.push(k);
  }
  for (const k of a.keys()) if (!b.has(k)) removed.push(k);
  return { added, removed, changed };
}

export function diffCount(d: SnapshotDiff): number {
  return d.added.length + d.removed.length + d.changed.length;
}
