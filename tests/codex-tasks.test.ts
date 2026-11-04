/** Codex 本机任务投影：只读、项目隔离、生命周期准确与不泄漏正文。 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBoardApp } from "../src/board/server.ts";
import { readCodexTasks } from "../src/core/codex-tasks.ts";
import { heliuPaths } from "../src/core/paths.ts";
import type { ProjectConfig } from "../src/core/project.ts";
import { gitW } from "./helpers/fixture.ts";

const NOW = Date.parse("2026-11-04T09:30:00.000Z");
const iso = (delta: number) => new Date(NOW + delta).toISOString();
let root: string;
let repo: string;
let home: string;
let dbFile: string;
let db: Database;
let project: ProjectConfig;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "heliu-codex-tasks-")));
  repo = join(root, "开发 仓库");
  home = join(root, "codex");
  mkdirSync(repo);
  mkdirSync(join(home, "sessions"), { recursive: true });
  gitW(repo, "init", "-q", "-b", "main");
  gitW(repo, "config", "commit.gpgsign", "false");
  gitW(repo, "commit", "-q", "--allow-empty", "-m", "fixture");
  dbFile = join(home, "state_5.sqlite");
  db = new Database(dbFile);
  db.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, cwd TEXT, rollout_path TEXT, archived INTEGER DEFAULT 0,
    name TEXT, title TEXT, updated_at_ms INTEGER, updated_at INTEGER,
    thread_source TEXT, source TEXT
  )`);
  project = {
    name: "测试项目", source: join(root, "project.yaml"), ledger: join(root, "ledger"),
    repos: [{ id: "dev", label: "开发仓库", path: repo, main: "main", integration: null, remote: null, icloud: false }],
  };
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function event(type: string, delta: number, turn = "turn-1", extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ timestamp: iso(delta), type: "event_msg", payload: { type, turn_id: turn, ...extra } }) + "\n";
}

function add(id: string, overrides: { cwd?: string; path?: string; name?: string | null; title?: string; archived?: number; threadSource?: string; source?: string; updated?: number; log?: string } = {}): string {
  const file = overrides.path ?? join(home, "sessions", `${id}.jsonl`);
  if (overrides.log !== undefined) writeFileSync(file, overrides.log);
  db.query("INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id, overrides.cwd ?? repo, file, overrides.archived ?? 0,
    overrides.name === undefined ? `任务 ${id}` : overrides.name, overrides.title ?? "初始请求",
    overrides.updated ?? NOW, Math.floor((overrides.updated ?? NOW) / 1000), overrides.threadSource ?? "user", overrides.source ?? "vscode",
  );
  return file;
}

const read = (extra: { now?: number; staleMs?: number; limit?: number } = {}) => readCodexTasks(project, { codexHome: home, now: NOW, ...extra });

function snapshot(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const file = join(d, name);
      const s = statSync(file);
      if (s.isDirectory()) walk(file);
      else rows.push(`${file}|${s.size}|${s.mtimeMs}|${Bun.hash(readFileSync(file))}`);
    }
  };
  walk(dir);
  return rows.sort().join("\n");
}

describe("Codex 项目范围与隐私", () => {
  test("只包含本项目，支持主目录多任务及子目录，排除相似路径、归档和子代理", async () => {
    mkdirSync(join(repo, "components"));
    add("first", { log: event("task_started", -1000) });
    add("second", { log: event("task_complete", -2000) });
    add("nested", { cwd: join(repo, "components"), log: event("task_complete", -3000) });
    add("other", { cwd: join(root, "别的项目"), log: event("task_started", -1000) });
    add("prefix", { cwd: `${repo}-other`, log: event("task_started", -1000) });
    add("archived", { archived: 1, log: event("task_started", -1000) });
    add("child", { threadSource: "subagent", log: event("task_started", -1000) });
    add("legacy-child", { source: JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: "first" } } }), log: event("task_started", -1000) });
    const result = await read();
    expect(result.available).toBe(true);
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["first", "nested", "second"]);
    expect(result.tasks.every((t) => t.repoId === "dev" && t.repoLabel === "开发仓库")).toBe(true);
  });

  test("仓库下未登记的独立 Git 仓库，不因路径前缀相同而被纳入", async () => {
    const nestedRepo = join(repo, "examples", "独立仓库");
    mkdirSync(nestedRepo, { recursive: true });
    gitW(nestedRepo, "init", "-q", "-b", "main");
    const nestedSubdir = join(nestedRepo, "src");
    mkdirSync(nestedSubdir);
    add("parent", { cwd: repo, log: event("task_started", -1000) });
    add("unregistered-nested", { cwd: nestedRepo, log: event("task_started", -1000) });
    add("unregistered-nested-child", { cwd: nestedSubdir, log: event("task_started", -1000) });
    const result = await read();
    expect(result.tasks.map((t) => t.id)).toEqual(["parent"]);
  });

  test("真实 Git 外部 worktree 的任务归属主仓库，目录别名也可匹配", async () => {
    const wt = join(root, "外部工作树");
    gitW(repo, "worktree", "add", "-q", "-b", "feature/task", wt);
    const alias = join(root, "repo-alias");
    symlinkSync(repo, alias);
    add("external", { cwd: wt, log: event("task_started", -1000) });
    add("alias", { cwd: alias, log: event("task_complete", -2000) });
    const result = await read();
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["alias", "external"]);
    expect(result.tasks.find((t) => t.id === "external")?.repoId).toBe("dev");
  });

  test("展示名称优先，不把原始附件提示或日志正文透传到接口", async () => {
    const privateBody = "PRIVATE_MESSAGE_BODY_123";
    const shortPrivateRequest = "PRIVATE_SECRET_IN_SHORT_FIRST_REQUEST";
    const log = event("task_started", -3000) + event("user_message", -2000, "turn-1", { message: privateBody })
      + event("task_complete", -1000, "turn-1", { last_agent_message: privateBody });
    add("named", { name: "修复默认勾选", title: "# Files mentioned by the user:\n" + privateBody, log });
    add("fallback", { name: null, title: "# Files mentioned by the user:\n" + privateBody, log });
    add("short-title", { name: null, title: shortPrivateRequest, log });
    const result = await read();
    expect(result.tasks.find((t) => t.id === "named")?.title).toBe("修复默认勾选");
    expect(result.tasks.find((t) => t.id === "short-title")?.title).toContain("Codex 任务");
    expect(result.tasks.find((t) => t.id === "fallback")?.title).toContain("Codex 任务");
    expect(JSON.stringify(result)).not.toContain(privateBody);
    expect(JSON.stringify(result)).not.toContain(shortPrivateRequest);
    expect(JSON.stringify(result)).not.toContain("last_agent_message");
    expect(JSON.stringify(result)).not.toContain("rollout_path");
  });

  test("不读取 sessions 目录外的路径、相似前缀或逃逸的符号链接", async () => {
    const outside = join(root, "outside.jsonl");
    const sibling = join(home, "sessions-other");
    mkdirSync(sibling);
    writeFileSync(outside, event("task_started", -1000));
    const link = join(home, "sessions", "escape.jsonl");
    symlinkSync(outside, link);
    add("outside", { path: outside });
    add("sibling", { path: join(sibling, "sibling.jsonl"), log: event("task_started", -1000) });
    add("symlink", { path: link });
    add("relative", { path: "sessions/relative.jsonl" });
    const result = await read();
    expect(result.tasks).toHaveLength(4);
    expect(result.tasks.every((t) => t.status === "unknown" && t.lastActivityAt === null)).toBe(true);
    expect(result.warning).toBeTruthy();
  });

  test("读取任务不会修改 SQLite、rollout 或业务仓库", async () => {
    add("readonly", { log: event("task_complete", -1000) });
    const beforeHome = snapshot(home);
    const beforeRepo = snapshot(repo);
    const result = await read();
    expect(result.tasks).toHaveLength(1);
    expect(snapshot(home)).toBe(beforeHome);
    expect(snapshot(repo)).toBe(beforeRepo);
  });
});

describe("Codex 生命周期", () => {
  test("刷新读取 start → complete → 新 start → aborted；结束不等同功能已发布", async () => {
    const file = add("lifecycle", { log: event("task_started", -4000) });
    expect((await read()).tasks[0]?.status).toBe("running");
    expect((await read()).tasks[0]?.turnStartedAt).toBe(iso(-4000));
    appendFileSync(file, event("task_complete", -3000));
    expect((await read()).tasks[0]?.status).toBe("idle");
    appendFileSync(file, event("task_started", -2000, "turn-2"));
    expect((await read()).tasks[0]?.status).toBe("running");
    appendFileSync(file, event("turn_aborted", -1000, "turn-2"));
    const last = (await read()).tasks[0]!;
    expect(last.status).toBe("interrupted");
    expect(last.lastActivityAt).toBe(iso(-1000));
    expect(last.turnStartedAt).toBe(iso(-2000));
  });

  test("迟到的旧轮结束事件不能结束正在运行的新一轮", async () => {
    add("late", { log: event("task_started", -3000, "turn-new") + event("task_complete", -2000, "turn-old") });
    expect((await read()).tasks[0]?.status).toBe("running");
  });

  test("只按生命周期和事件时间判断，文件 mtime 或数据库更新不伪造正在运行", async () => {
    const file = add("stale", { updated: NOW, log: event("task_started", -600_000) });
    utimesSync(file, new Date(NOW), new Date(NOW));
    add("unknown", { log: event("user_message", -1000, "turn-x", { message: "任务正文" }) });
    add("missing");
    add("future", { log: event("task_started", 120_000) });
    const result = await read();
    expect(result.tasks.find((t) => t.id === "stale")?.status).toBe("stale");
    expect(result.tasks.find((t) => t.id === "unknown")?.status).toBe("unknown");
    expect(result.tasks.find((t) => t.id === "missing")?.status).toBe("unknown");
    expect(result.tasks.find((t) => t.id === "future")?.status).toBe("stale");
    expect(result.warning).toBeTruthy();
  });

  test("忽略正在写入的半行，补齐后读取；截断重写日志不能沿用旧状态", async () => {
    const file = add("partial", { log: event("task_started", -4000) });
    expect((await read()).tasks[0]?.status).toBe("running");
    const end = event("task_complete", -3000);
    appendFileSync(file, end.slice(0, Math.floor(end.length / 2)));
    expect((await read()).tasks[0]?.status).toBe("running");
    appendFileSync(file, end.slice(Math.floor(end.length / 2)));
    expect((await read()).tasks[0]?.status).toBe("idle");
    writeFileSync(file, event("task_started", -1000, "new-file-turn"));
    expect((await read()).tasks[0]?.status).toBe("running");
  });

  test("损坏的 JSON 行不会掩盖随后有效的生命周期记录", async () => {
    const invalidLines = ["{not json}", "null", "42", "[]", JSON.stringify({ timestamp: 1e30 }), JSON.stringify({ timestamp: -1e30 })];
    for (const [i, line] of invalidLines.entries()) add(`bad-line-${i}`, { log: line + "\n" + event("task_started", -1000) });
    const result = await read();
    expect(result.tasks).toHaveLength(invalidLines.length);
    expect(result.tasks.every((task) => task.status === "running")).toBe(true);
  });

  test("大日志读取窗口恰好落在开始事件行首时，不应丢失整个开始事件", async () => {
    const windowBytes = 4 * 1024 * 1024;
    const start = event("task_started", -1000);
    const emptyTail = event("token_count", -500, "turn-1", { padding: "" });
    const padding = "x".repeat(windowBytes - Buffer.byteLength(start) - Buffer.byteLength(emptyTail));
    const tail = start + event("token_count", -500, "turn-1", { padding });
    expect(Buffer.byteLength(tail)).toBe(windowBytes);
    const prefix = event("task_complete", -10_000, "old-turn");
    add("window-boundary", { log: prefix + tail });
    const task = (await read()).tasks[0]!;
    expect(task.status).toBe("running");
    expect(task.turnStartedAt).toBe(iso(-1000));
  });
});

describe("缺数据、读取上限和接口", () => {
  test("缺库与损坏数据库明确降级，不生成伪状态或创建数据库", async () => {
    const missingHome = join(root, "absent-home");
    const unavailable = await readCodexTasks(project, { codexHome: missingHome, now: NOW });
    expect(unavailable.available).toBe(false);
    expect(unavailable.tasks).toEqual([]);
    expect(unavailable.warning).toBeTruthy();
    expect(existsSync(missingHome)).toBe(false);
    const brokenHome = join(root, "broken-codex");
    mkdirSync(brokenHome);
    const brokenFile = join(brokenHome, "state_5.sqlite");
    writeFileSync(brokenFile, "not a database");
    const before = readFileSync(brokenFile);
    const broken = await readCodexTasks(project, { codexHome: brokenHome, now: NOW });
    expect(broken.available).toBe(false);
    expect(broken.tasks).toEqual([]);
    expect(readFileSync(brokenFile)).toEqual(before);
  });

  test("读取上限应用到项目内任务，其他项目新任务不挤掉本项目", async () => {
    for (let i = 0; i < 5; i++) add(`mine-${i}`, { updated: NOW - i, log: event("task_complete", -i * 1000) });
    for (let i = 0; i < 6; i++) add(`other-${i}`, { cwd: join(root, "other"), updated: NOW + i + 100, log: event("task_started", -1000) });
    const result = await read({ limit: 2 });
    expect(result.tasks.map((t) => t.id).sort()).toEqual(["mine-0", "mine-1"]);
  });

  test("数据库更新时间较旧的进行中任务，不能被显示上限排除", async () => {
    add("old-db-active", { updated: NOW - 1_000_000, log: event("task_started", -100) });
    add("idle-newest", { updated: NOW, log: event("task_complete", -1000) });
    add("idle-older", { updated: NOW - 1, log: event("task_complete", -2000) });
    add("idle-oldest", { updated: NOW - 2, log: event("task_complete", -3000) });
    const result = await read({ limit: 2 });
    expect(result.tasks.map((t) => t.id)).toEqual(["old-db-active", "idle-newest"]);
    expect(result.tasks[0]?.status).toBe("running");
  });

  test("接口沿用项目作用域及 Host 防护，返回标准 envelope", async () => {
    add("endpoint", { log: event("task_started", -1000) });
    const paths = heliuPaths({
      HELIU_HOME: join(root, "heliu"), HELIU_CLAUDE_APP_DIR: join(root, "claude-app"), HELIU_CLAUDE_HOME: join(root, "claude-home"),
    });
    const { app } = createBoardApp({ paths, project, codex: { codexHome: home, now: NOW } });
    const response = await app.request("/api/codex-tasks");
    expect(response.status).toBe(200);
    const body = await response.json() as { command: string; project: { name: string }; data: { tasks: Array<{ id: string }> } };
    expect(body.project.name).toBe(project.name);
    expect(body.data.tasks.map((t) => t.id)).toEqual(["endpoint"]);
    expect((await app.request("/api/codex-tasks?project=不存在")).status).toBe(400);
    expect((await app.request("/api/codex-tasks", { headers: { Host: "evil.example" } })).status).toBe(403);
    const withoutProject = createBoardApp({ paths, project: null, codex: { codexHome: home, now: NOW } });
    expect((await withoutProject.app.request("/api/codex-tasks")).status).toBe(400);
  });
});
