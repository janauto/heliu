/**
 * 本机 Codex 任务的只读投影：只向看板返回标题、cwd 和生命周期元数据。
 * 不读取认证配置，不启动/恢复 Codex 会话，不写 Codex 数据或合流台账。
 * 本地 SQLite/rollout 是版本相关格式；缺失、损坏或状态不明时明确降级。
 */
import { Database } from "bun:sqlite";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CodexTask, CodexTasksData } from "../board/api-types.ts";
import { runGit } from "./git.ts";
import { canonicalPath, isUnder } from "./paths.ts";
import type { ProjectConfig, RepoConfig } from "./project.ts";
import { parseWorktreePorcelain } from "./worktrees.ts";

export interface CodexTaskOptions {
  codexHome?: string;
  now?: number;
  staleMs?: number;
  limit?: number;
}

type Life = {
  status: CodexTask["status"];
  lastActivityAt: string | null;
  turnStartedAt: string | null;
  turnId: string | null;
};
type LogCache = { ino: number; size: number; mtime: number; offset: number; life: Life };
const logs = new Map<string, LogCache>();
const MAX_READ = 4 * 1024 * 1024;
const MAX_LOG_CACHE = 200;
const emptyLife = (): Life => ({ status: "unknown", lastActivityAt: null, turnStartedAt: null, turnId: null });
const iso = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const n = typeof v === "number" ? v : Date.parse(v);
  const date = new Date(n);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
};

/** 仅提取生命周期与时间，消息正文/工具参数/推理内容都不会被保留或返回。 */
function consume(line: string, life: Life): void {
  let row: { timestamp?: unknown; type?: string; payload?: Record<string, unknown> };
  try { row = JSON.parse(line); } catch { return; }
  if (!row || typeof row !== "object" || Array.isArray(row)) return;
  const at = iso(row.timestamp);
  if (!at) return;
  if (!life.lastActivityAt || at > life.lastActivityAt) life.lastActivityAt = at;
  if (row.type !== "event_msg" || !row.payload) return;
  const p = row.payload;
  const turn = typeof p.turn_id === "string" ? p.turn_id : null;
  if (p.type === "task_started") {
    life.status = "running";
    life.turnId = turn;
    life.turnStartedAt = iso(p.started_at) ?? at;
  } else if (p.type === "task_complete" || p.type === "turn_aborted") {
    // 已知新一轮开始后，旧轮次迟到的结束事件不能关闭新任务。
    if (life.turnId && turn && life.turnId !== turn) return;
    life.status = p.type === "task_complete" ? "idle" : "interrupted";
    life.turnId = turn;
    life.turnStartedAt = iso(p.started_at) ?? life.turnStartedAt;
  }
}

async function lifecycle(file: string, home: string): Promise<Life | null> {
  // 不信任数据库内的任意文件路径；只允许实际位于本机 sessions 目录内的 JSONL。
  if (!isAbsolute(file) || !file.endsWith(".jsonl")) return null;
  let real: string;
  try {
    real = realpathSync(file);
    const sessions = realpathSync(join(home, "sessions"));
    if (!isUnder(real, sessions)) return null;
  } catch { return null; }
  try {
    const info = await stat(real);
    if (!info.isFile()) return null;
    const old = logs.get(real);
    if (old && old.ino === info.ino && old.size === info.size && old.mtime === info.mtimeMs) return { ...old.life };
    const continuing = !!old && old.ino === info.ino && info.size > old.size && info.size - old.offset <= MAX_READ;
    const life = continuing ? { ...old.life } : emptyLife();
    const start = continuing ? old.offset : Math.max(0, info.size - MAX_READ);
    const f = await open(real, "r");
    let bytes: Buffer;
    let startsAtLine = start === 0 || continuing;
    try {
      if (!startsAtLine) {
        const preceding = Buffer.alloc(1);
        await f.read(preceding, 0, 1, start - 1);
        startsAtLine = preceding[0] === 10;
      }
      const buf = Buffer.alloc(Math.min(MAX_READ, info.size - start));
      const result = await f.read(buf, 0, buf.length, start);
      bytes = buf.subarray(0, result.bytesRead);
    } finally { await f.close(); }
    // 记录可能正写到一半：只消费完整行，下次从最后一个换行处续读。
    const end = bytes.lastIndexOf(10);
    const first = startsAtLine ? 0 : bytes.indexOf(10) + 1;
    if (end >= first && (first > 0 || startsAtLine)) {
      for (const line of bytes.subarray(first, end).toString("utf8").split("\n")) consume(line, life);
    }
    const offset = end >= 0 ? start + end + 1 : start;
    logs.delete(real);
    logs.set(real, { ino: info.ino, size: info.size, mtime: info.mtimeMs, offset, life });
    if (logs.size > MAX_LOG_CACHE) logs.delete(logs.keys().next().value!);
    return { ...life };
  } catch { return null; }
}

async function scopes(project: ProjectConfig): Promise<Array<{ path: string; repo: RepoConfig }>> {
  const groups = await Promise.all(project.repos.map(async (repo) => {
    const paths = [{ path: canonicalPath(repo.path), repo }];
    const r = await runGit(repo.path, ["worktree", "list", "--porcelain"], { timeoutMs: 3000, protect: [repo.path] });
    if (r.ok) for (const w of parseWorktreePorcelain(r.stdout)) paths.push({ path: canonicalPath(w.path), repo });
    return paths;
  }));
  // 嵌套仓库或外部 worktree 优先匹配更精确的根，避免归到外层开发目录。
  return groups.flat().sort((a, b) => b.path.length - a.path.length);
}

function displayTitle(row: Record<string, unknown>): string {
  const name = typeof row.name === "string" ? row.name.trim() : "";
  if (name) return name.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);
  // title 可能就是首条用户请求，即使只有一行也不读取；仅使用侧栏明确的任务名称。
  return `Codex 任务 ${String(row.id).slice(0, 8)}`;
}

export async function readCodexTasks(project: ProjectConfig, opts: CodexTaskOptions = {}): Promise<CodexTasksData> {
  const home = opts.codexHome ?? process.env.HELIU_CODEX_HOME ?? process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const unavailable = (warning: string): CodexTasksData => ({ tasks: [], available: false, warning });
  let file: string | undefined;
  try {
    file = readdirSync(home).filter((n) => /^state_\d+\.sqlite$/.test(n)).sort((a, b) => Number(b.match(/\d+/)![0]) - Number(a.match(/\d+/)![0]))[0];
  } catch { return unavailable("没有找到可读取的本机 Codex 任务数据。"); }
  if (!file || !existsSync(join(home, file))) return unavailable("没有找到本机 Codex 任务数据库。");
  const roots = await scopes(project);
  let db: Database | undefined;
  let rows: Array<Record<string, unknown>>;
  const repoById = new Map<string, RepoConfig>();
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  try {
    db = new Database(join(home, file), { readonly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 100;");
    const fields = new Set((db.query("PRAGMA table_info(threads)").all() as Array<{ name: string }>).map((r) => r.name));
    if (!["id", "cwd", "rollout_path", "archived"].every((f) => fields.has(f))) return unavailable("当前 Codex 本地数据格式暂不兼容，未读取任务状态。");
    // 先只取目录和标识做范围筛选；不读取其他项目的标题、对话或 rollout。
    const sourceCols = ["thread_source", "source"].filter((f) => fields.has(f));
    const candidates = db.query(`SELECT id, cwd${sourceCols.map((f) => `, ${f}`).join("")} FROM threads WHERE archived = 0`).all() as Array<Record<string, unknown>>;
    const owners = new Map<string, Promise<RepoConfig | undefined>>();
    await Promise.all(candidates.map(async (row) => {
      if (typeof row.id !== "string" || typeof row.cwd !== "string" || !isAbsolute(row.cwd)) return;
      if (row.thread_source === "subagent" || (typeof row.source === "string" && row.source.includes('"subagent"'))) return;
      const cwd = canonicalPath(row.cwd);
      const match = roots.find((r) => isUnder(cwd, r.path));
      if (!match) return;
      let owner = owners.get(cwd);
      if (!owner) {
        owner = (async () => {
          if (cwd === match.path) return match.repo;
          // 目录内部可能另有独立仓库。验证最近 Git 根，不能只凭前缀混入其他项目。
          const top = await runGit(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: 3000, protect: [match.path] });
          return top.ok && canonicalPath(top.stdout.trim()) === match.path ? match.repo : undefined;
        })();
        owners.set(cwd, owner);
      }
      const repo = await owner;
      if (repo) repoById.set(row.id, repo);
    }));
    if (!repoById.size) return { tasks: [], available: true, warning: null };
    const columns = ["id", "cwd", "rollout_path", "name", "updated_at_ms", "updated_at"].filter((f) => fields.has(f));
    const stamp = fields.has("updated_at_ms") ? "COALESCE(updated_at_ms, 0)" : fields.has("updated_at") ? "updated_at" : "id";
    const ids = [...repoById.keys()];
    // 先看生命周期再限制条数，避免 resumed 的旧任务被数据库更新时间挤掉。
    rows = db.query(`SELECT ${columns.join(", ")} FROM threads WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY ${stamp} DESC`).all(...ids) as Array<Record<string, unknown>>;
  } catch { return unavailable("Codex 本地任务数据暂时无法读取，将在下次刷新重试。"); }
  finally { db?.close(); }

  const now = opts.now ?? Date.now();
  const staleMs = opts.staleMs ?? 5 * 60_000;
  const tasks: CodexTask[] = [];
  for (const row of rows) {
    const id = String(row.id);
    const repo = repoById.get(id)!;
    const life = typeof row.rollout_path === "string" ? await lifecycle(row.rollout_path, home) : null;
    let status = life?.status ?? "unknown";
    if (status === "running") {
      const last = life?.lastActivityAt ? Date.parse(life.lastActivityAt) : NaN;
      if (!Number.isFinite(last) || now - last > staleMs || last - now > 60_000) status = "stale";
    }
    tasks.push({ id, title: displayTitle(row), cwd: String(row.cwd), repoId: repo.id, repoLabel: repo.label, status,
      lastActivityAt: life?.lastActivityAt ?? null, turnStartedAt: life?.turnStartedAt ?? null });
  }
  // 进行中的置顶；其余按最近活动排列，旧任务的中断/未知不应挡住刚完成的任务。
  tasks.sort((a, b) => Number(b.status === "running") - Number(a.status === "running") || (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));
  const visible = tasks.slice(0, limit);
  const missing = visible.filter((t) => t.status === "unknown").length;
  const warnings: string[] = [];
  if (missing) warnings.push(`${missing} 个任务缺少可确认的生命周期记录，已标记为状态未知。`);
  if (tasks.length > limit) warnings.push(`显示最近 ${limit} 个任务，进行中的优先；本项目共 ${tasks.length} 个未归档任务。`);
  return { tasks: visible, available: true, warning: warnings.join(" ") || null };
}
