/**
 * 只读解析 Claude 桌面应用的会话数据（ADR-3）：
 * - claude-code-sessions/<账号>/<组织>/local_*.json：桌面会话
 * - git-worktrees.json：桌面端创建的 worktree 登记
 * - ~/.claude/sessions/<pid>.json：运行中的 CLI 会话（hostSessionId 指回桌面会话）
 *
 * 字段无官方文档：zod 宽松解析，每个字段类型不符即视为缺失，不因单个字段丢整条记录。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { PrRef, SessionStatus } from "../types.ts";
import type { HeliuPaths } from "./paths.ts";

/** 字段宽松：缺失、null、类型不符都变成 undefined */
const loose = <T extends z.ZodType>(s: T) => s.nullish().catch(undefined);

const PrSchema = z.looseObject({
  prNumber: loose(z.number()),
  repo: loose(z.string()),
  url: loose(z.string()),
  branch: loose(z.string()),
  state: loose(z.string()),
});

export const DesktopSessionSchema = z.looseObject({
  sessionId: loose(z.string()),
  cliSessionId: loose(z.string()),
  title: loose(z.string()),
  cwd: loose(z.string()),
  originCwd: loose(z.string()),
  worktreeName: loose(z.string()),
  worktreePath: loose(z.string()),
  branch: loose(z.string()),
  sourceBranch: loose(z.string()),
  writtenBranches: loose(z.array(z.string().catch(""))),
  prs: loose(z.array(PrSchema.catch({}))),
  postTurnSummary: loose(
    z.looseObject({
      status_category: loose(z.string()),
      status_detail: loose(z.string()),
      needs_action: loose(z.string()),
    }),
  ),
  isArchived: loose(z.boolean()),
  createdAt: loose(z.number()),
  lastActivityAt: loose(z.number()),
  completedTurns: loose(z.number()),
  spawnedFrom: loose(
    z.looseObject({
      sessionId: loose(z.string()),
      title: loose(z.string()),
    }),
  ),
  model: loose(z.string()),
});

export interface WrittenBranch {
  /** 写入时所在目录（桌面端以「路径\0分支」记录），旧格式只有分支名时为 null */
  path: string | null;
  branch: string;
}

export interface DesktopSession {
  sessionId: string;
  cliSessionId: string | null;
  title: string | null;
  cwd: string | null;
  originCwd: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  branch: string | null;
  sourceBranch: string | null;
  writtenBranches: WrittenBranch[];
  prs: PrRef[];
  statusCategory: string | null;
  statusDetail: string | null;
  needsAction: string | null;
  isArchived: boolean;
  createdAt: number | null;
  lastActivityAt: number | null;
  completedTurns: number | null;
  spawnedFrom: { sessionId: string | null; title: string | null } | null;
  model: string | null;
  file: string;
}

const nn = <T>(v: T | null | undefined): T | null => (v === undefined || v === null ? null : v);

/** 「路径\0分支」或「分支」 */
export function parseWrittenBranch(entry: string): WrittenBranch | null {
  if (!entry) return null;
  const parts = entry.split("\0");
  const branch = parts[parts.length - 1]?.trim();
  if (!branch) return null;
  const path = parts.length > 1 ? (parts[0] ?? "").trim() || null : null;
  return { path, branch };
}

/** 解析单个会话 JSON；不是对象则返回 null */
export function parseDesktopSession(raw: unknown, file: string): DesktopSession | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = DesktopSessionSchema.safeParse(raw);
  if (!r.success) return null;
  const d = r.data;
  const fallbackId = file.split("/").pop()?.replace(/\.json$/, "") ?? file;
  const pts = d.postTurnSummary ?? null;
  return {
    sessionId: d.sessionId ?? fallbackId,
    cliSessionId: nn(d.cliSessionId),
    title: d.title?.trim() || null,
    cwd: nn(d.cwd),
    originCwd: nn(d.originCwd),
    worktreeName: nn(d.worktreeName),
    worktreePath: nn(d.worktreePath),
    branch: d.branch?.trim() || null,
    sourceBranch: nn(d.sourceBranch),
    writtenBranches: (d.writtenBranches ?? []).map(parseWrittenBranch).filter((x): x is WrittenBranch => x !== null),
    prs: (d.prs ?? []).map((p) => ({
      number: nn(p.prNumber),
      repo: nn(p.repo),
      url: nn(p.url),
      branch: nn(p.branch),
      state: nn(p.state),
    })),
    statusCategory: pts?.status_category ?? null,
    statusDetail: pts?.status_detail || null,
    needsAction: pts?.needs_action || null,
    isArchived: d.isArchived ?? false,
    createdAt: nn(d.createdAt),
    lastActivityAt: nn(d.lastActivityAt),
    completedTurns: nn(d.completedTurns),
    spawnedFrom: d.spawnedFrom ? { sessionId: nn(d.spawnedFrom.sessionId), title: nn(d.spawnedFrom.title) } : null,
    model: nn(d.model),
    file,
  };
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export interface DesktopSessionsLoad {
  sessions: DesktopSession[];
  files: number;
  parseErrors: number;
  dirExists: boolean;
}

/** 扫描 claude-code-sessions/<账号>/<组织>/local_*.json */
export function loadDesktopSessions(paths: HeliuPaths): DesktopSessionsLoad {
  const root = paths.desktopSessionsDir;
  const out: DesktopSession[] = [];
  let files = 0;
  let parseErrors = 0;
  if (!existsSync(root)) return { sessions: out, files, parseErrors, dirExists: false };
  for (const account of safeReaddir(root)) {
    for (const org of safeReaddir(join(root, account))) {
      const dir = join(root, account, org);
      for (const f of safeReaddir(dir)) {
        if (!f.startsWith("local_") || !f.endsWith(".json")) continue;
        files++;
        const file = join(dir, f);
        try {
          const s = parseDesktopSession(JSON.parse(readFileSync(file, "utf8")), file);
          if (s) out.push(s);
          else parseErrors++;
        } catch {
          parseErrors++;
        }
      }
    }
  }
  return { sessions: out, files, parseErrors, dirExists: true };
}

const GitWorktreeEntrySchema = z.looseObject({
  name: loose(z.string()),
  path: loose(z.string()),
  branch: loose(z.string()),
  sourceBranch: loose(z.string()),
  baseRepo: loose(z.string()),
  leasedBy: loose(z.string()),
  createdAt: loose(z.number()),
  uncleanSince: loose(z.number()),
});
const GitWorktreesFileSchema = z.looseObject({
  worktrees: loose(z.record(z.string(), GitWorktreeEntrySchema.catch({}))),
});

export interface DesktopWorktree {
  name: string;
  path: string;
  branch: string | null;
  sourceBranch: string | null;
  baseRepo: string | null;
  leasedBy: string | null;
  createdAt: number | null;
  uncleanSince: number | null;
}

export function parseGitWorktreesJson(raw: unknown): DesktopWorktree[] {
  const r = GitWorktreesFileSchema.safeParse(raw);
  if (!r.success || !r.data.worktrees) return [];
  const out: DesktopWorktree[] = [];
  for (const [key, w] of Object.entries(r.data.worktrees)) {
    if (!w.path) continue;
    out.push({
      name: w.name ?? key,
      path: w.path,
      branch: nn(w.branch),
      sourceBranch: nn(w.sourceBranch),
      baseRepo: nn(w.baseRepo),
      leasedBy: nn(w.leasedBy),
      createdAt: nn(w.createdAt),
      uncleanSince: nn(w.uncleanSince),
    });
  }
  return out;
}

export function loadDesktopWorktrees(paths: HeliuPaths): DesktopWorktree[] {
  if (!existsSync(paths.gitWorktreesJson)) return [];
  try {
    return parseGitWorktreesJson(JSON.parse(readFileSync(paths.gitWorktreesJson, "utf8")));
  } catch {
    return [];
  }
}

const RunningSchema = z.looseObject({
  pid: loose(z.number()),
  hostSessionId: loose(z.string()),
  sessionId: loose(z.string()),
  name: loose(z.string()),
  status: loose(z.string()),
  cwd: loose(z.string()),
});

export interface RunningSession {
  pid: number;
  hostSessionId: string | null;
  cliSessionId: string | null;
  name: string | null;
  status: "busy" | "idle";
  cwd: string | null;
  alive: boolean;
}

/** 只用 signal 0 探测进程是否存在（不发送任何信号） */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** ~/.claude/sessions/<pid>.json；只读 .json，忽略同目录的 .key 等文件 */
export function loadRunningSessions(paths: HeliuPaths, checkAlive = true): RunningSession[] {
  const out: RunningSession[] = [];
  for (const f of safeReaddir(paths.runningSessionsDir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    try {
      const r = RunningSchema.safeParse(JSON.parse(readFileSync(join(paths.runningSessionsDir, f), "utf8")));
      if (!r.success) continue;
      const pid = r.data.pid ?? Number(f.replace(/\.json$/, ""));
      const alive = checkAlive ? pidAlive(pid) : true;
      out.push({
        pid,
        hostSessionId: nn(r.data.hostSessionId),
        cliSessionId: nn(r.data.sessionId),
        name: nn(r.data.name),
        status: r.data.status === "busy" ? "busy" : "idle",
        cwd: nn(r.data.cwd),
        alive,
      });
    } catch {
      /* 跳过坏文件 */
    }
  }
  return out;
}

/** 运行态索引：桌面会话 id / CLI 会话 id → busy|idle（仅存活进程） */
export function runningIndex(running: RunningSession[]): Map<string, "busy" | "idle"> {
  const m = new Map<string, "busy" | "idle">();
  for (const r of running) {
    if (!r.alive) continue;
    if (r.hostSessionId) m.set(r.hostSessionId, r.status);
    if (r.cliSessionId) m.set(r.cliSessionId, r.status);
  }
  return m;
}

export function sessionStatus(s: DesktopSession, running: "busy" | "idle" | null): SessionStatus {
  if (running === "busy") return "running";
  if (s.isArchived) return "archived";
  if (s.statusCategory === "blocked") return "blocked";
  if (s.statusCategory === "review_ready") return "review_ready";
  if (running === "idle") return "online";
  if (s.statusCategory === "completed") return "completed";
  return "unknown";
}

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  running: "运行中",
  online: "在线",
  blocked: "等你",
  review_ready: "待验收",
  completed: "已完成",
  archived: "已归档",
  unknown: "—",
};

export function runningFor(s: DesktopSession, idx: Map<string, "busy" | "idle">): "busy" | "idle" | null {
  return idx.get(s.sessionId) ?? (s.cliSessionId ? idx.get(s.cliSessionId) : undefined) ?? null;
}
