import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { heliuPaths } from "../src/core/paths.ts";
import {
  loadDesktopSessions,
  loadDesktopWorktrees,
  loadRunningSessions,
  parseDesktopSession,
  parseWrittenBranch,
  runningIndex,
  sessionStatus,
} from "../src/core/sessions.ts";
import { buildFixture, type Fixture } from "./helpers/fixture.ts";

const FIX = join(import.meta.dir, "fixtures", "sessions");
const read = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8").replaceAll("__REPO__", "/r"));

describe("会话 JSON 宽松解析", () => {
  test("完整字段", () => {
    const s = parseDesktopSession(read("local_full.json"), "local_full.json");
    expect(s).not.toBeNull();
    expect(s!.sessionId).toBe("local_full");
    expect(s!.title).toBe("实现 EPP 网关 v0（代调 MCP / CLI）");
    expect(s!.branch).toBe("claude/bold-shaw-cccccc");
    expect(s!.statusCategory).toBe("blocked");
    expect(s!.needsAction).toBe("确认是否推送到远端");
    expect(s!.prs).toEqual([
      { number: 3, repo: "acme/demo", url: "https://github.com/acme/demo/pull/3", branch: "claude/bold-shaw-cccccc", state: "OPEN" },
    ]);
    expect(s!.writtenBranches).toEqual([{ path: "/r/.claude/worktrees/bold-shaw-cccccc", branch: "claude/bold-shaw-cccccc" }]);
    expect(s!.spawnedFrom).toEqual({ sessionId: "local_parent", title: "父会话" });
    expect(s!.lastActivityAt).toBe(1792900000000);
  });

  test("缺字段：只有 sessionId 和 cwd 也能解析", () => {
    const s = parseDesktopSession(read("local_minimal.json"), "local_minimal.json")!;
    expect(s.title).toBeNull();
    expect(s.branch).toBeNull();
    expect(s.prs).toEqual([]);
    expect(s.writtenBranches).toEqual([]);
    expect(s.statusCategory).toBeNull();
    expect(s.isArchived).toBe(false);
    expect(s.lastActivityAt).toBeNull();
  });

  test("字段类型不符：逐字段丢弃，不丢整条记录", () => {
    const s = parseDesktopSession(read("local_weird_types.json"), "local_weird_types.json")!;
    expect(s.sessionId).toBe("local_weird");
    expect(s.title).toBeNull(); // 数字标题被丢弃
    expect(s.isArchived).toBe(false); // "yes" 不是布尔
    expect(s.prs).toEqual([]); // 字符串不是数组
    expect(s.lastActivityAt).toBeNull();
    expect(s.createdAt).toBe(1791000000000);
    expect(s.writtenBranches).toEqual([{ path: "/r/.claude/worktrees/reused-dir-eeeeee", branch: "claude/behind-dddddd" }]);
  });

  test("非对象 JSON 返回 null", () => {
    expect(parseDesktopSession([1, 2, 3], "x")).toBeNull();
    expect(parseDesktopSession(null, "x")).toBeNull();
  });

  test("writtenBranches 两种格式", () => {
    expect(parseWrittenBranch("claude/x")).toEqual({ path: null, branch: "claude/x" });
    expect(parseWrittenBranch("/a/b\u0000feat/y")).toEqual({ path: "/a/b", branch: "feat/y" });
    expect(parseWrittenBranch("")).toBeNull();
  });

  test("状态归一", () => {
    const base = parseDesktopSession(read("local_full.json"), "f")!;
    expect(sessionStatus(base, "busy")).toBe("running");
    expect(sessionStatus(base, null)).toBe("blocked");
    expect(sessionStatus({ ...base, statusCategory: "completed" }, "idle")).toBe("online");
    expect(sessionStatus({ ...base, statusCategory: "completed" }, null)).toBe("completed");
    expect(sessionStatus({ ...base, isArchived: true }, null)).toBe("archived");
    expect(sessionStatus({ ...base, statusCategory: null }, null)).toBe("unknown");
  });
});

describe("目录扫描", () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = buildFixture();
  });
  afterAll(() => fx.cleanup());

  test("claude-code-sessions/<账号>/<组织>/local_*.json：坏文件计数、非 local_ 忽略", () => {
    const d = loadDesktopSessions(heliuPaths(fx.env));
    expect(d.dirExists).toBe(true);
    expect(d.files).toBe(7); // 7 个 local_*.json，ignored.json 不算
    expect(d.parseErrors).toBe(2); // 截断的 JSON + 数组
    expect(d.sessions.map((s) => s.sessionId).sort()).toEqual(["local_archived", "local_full", "local_minimal", "local_other", "local_weird"]);
  });

  test("git-worktrees.json 与运行中会话", () => {
    const p = heliuPaths(fx.env);
    const w = loadDesktopWorktrees(p);
    expect(w.length).toBe(2);
    expect(w.find((x) => x.name === "bold-shaw-cccccc")?.leasedBy).toBe("local_full");
    const r = loadRunningSessions(p);
    expect(r.length).toBe(1); // .key 文件被忽略
    expect(r[0]?.alive).toBe(true);
    expect(runningIndex(r).get("local_full")).toBe("busy");
  });

  test("数据目录不存在时返回空而不是抛错", () => {
    const p = heliuPaths({ HELIU_CLAUDE_APP_DIR: "/nonexistent/claude", HELIU_CLAUDE_HOME: "/nonexistent/home" });
    expect(loadDesktopSessions(p).dirExists).toBe(false);
    expect(loadDesktopWorktrees(p)).toEqual([]);
    expect(loadRunningSessions(p)).toEqual([]);
  });
});
