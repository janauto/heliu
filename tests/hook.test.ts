/**
 * bin/heliu-hook：输出格式（hookSpecificOutput.additionalContext 中文）、<300ms、任何错误静默 exit 0、
 * Stop 写缓存不写台账；plugin 的 hooks.json 不注册 WorktreeCreate（会替换默认 worktree 创建）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Cache } from "../src/core/cache.ts";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths } from "../src/core/paths.ts";
import { buildFixture, gitSnapshot, type Fixture } from "./helpers/fixture.ts";

const ROOT = join(import.meta.dir, "..");
const HOOK = join(ROOT, "bin", "heliu-hook");
const BIN = join(ROOT, "bin", "heliu");
let fx: Fixture;

function hook(input: string): { code: number; stdout: string; stderr: string; ms: number } {
  const t0 = performance.now();
  // 直接执行 sh 包装（与 Claude Code 调 hooks.json 的方式一致），计时含 sh 找 bun + bun 启动
  const r = Bun.spawnSync({ cmd: [HOOK], stdin: Buffer.from(input), env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
  const ms = performance.now() - t0;
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString(), ms };
}
const ev = (event: string, cwd: string, extra: Record<string, unknown> = {}) => JSON.stringify({ session_id: "cli-test", cwd, hook_event_name: event, ...extra });

beforeAll(() => {
  fx = buildFixture();
  const reg = Bun.spawnSync({ cmd: [process.execPath, "run", BIN, "project", "add", fx.repo, "--name", "演示", "--integration", "integ"], env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
  expect(reg.exitCode).toBe(0);
  // 给 standalone 分支建一张卡（预约 v1.2）
  const l = new Ledger(join(fx.repo, ".heliu"));
  l.addFeature({ title: "实现 EPP 网关", milestone: "v1.2", bindings: [{ repo: "磁吸-仓库", branch: "claude/bold-shaw-cccccc", worktree: fx.wt.standalone!, session: null, pr: null }] });
});
afterAll(() => fx.cleanup());

describe("SessionStart", () => {
  test("有功能卡：输出 hookSpecificOutput.additionalContext（中文，含卡号/预约/落后数）", () => {
    const r = hook(ev("SessionStart", fx.wt.standalone!, { source: "startup" }));
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(Object.keys(j)).toEqual(["hookSpecificOutput"]);
    expect(j.hookSpecificOutput.hookEventName).toBe("SessionStart");
    const ctx: string = j.hookSpecificOutput.additionalContext;
    expect(ctx.startsWith("【合流】你在 磁吸 仓库/claude/bold-shaw-cccccc")).toBe(true);
    expect(ctx).toContain("功能卡 F-0001『实现 EPP 网关』");
    expect(ctx).toContain("预约 v1.2");
    expect(ctx).toContain("落后主线 0 提交、落后集成分支 3");
    expect(ctx).toContain(`cwd="${fx.wt.standalone!}"`);
    expect(ctx.length).toBeLessThan(10_000);
  });

  test("无功能卡：提示在明确需求后调用 heliu_feature_add", () => {
    const r = hook(ev("SessionStart", fx.wt.reused!));
    const ctx: string = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    expect(ctx).toContain("本分支暂无功能卡；若本会话在做新功能，请在明确需求后调用 heliu_feature_add 登记（标题用用户的一句话），否则忽略。");
  });

  test("耗时 <300ms（三次都满足，含 bun 启动）", () => {
    hook(ev("SessionStart", fx.wt.standalone!)); // 预热磁盘缓存
    const times = [0, 1, 2].map(() => hook(ev("SessionStart", fx.wt.standalone!)).ms);
    for (const t of times) expect(t).toBeLessThan(300);
  });

  test("首次见到的 worktree 记进缓存（替代 WorktreeCreate）", () => {
    const c = Cache.open(heliuPaths(fx.env), "演示", { readonly: true })!;
    const seen = c.worktrees().map((w) => w.path);
    c.close();
    expect(seen).toContain(fx.wt.standalone!);
  });
});

describe("Stop 与容错", () => {
  test("Stop：会话最后活动写入缓存 sqlite，不写台账、不输出", () => {
    const ledgerFile = join(fx.repo, ".heliu", "features");
    const before = readFileSync(join(ledgerFile, "F-0001-实现-EPP-网关.md"), "utf8");
    const r = hook(ev("Stop", fx.wt.standalone!, { stop_hook_active: false }));
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    const c = Cache.open(heliuPaths(fx.env), "演示", { readonly: true })!;
    const stops = c.stops();
    c.close();
    expect(stops.find((s) => s.sessionId === "cli-test")?.cwd).toBe(fx.wt.standalone!);
    expect(readFileSync(join(ledgerFile, "F-0001-实现-EPP-网关.md"), "utf8")).toBe(before);
    expect(existsSync(join(fx.heliuHome, "cache", "演示.sqlite"))).toBe(true);
  });

  test("坏输入 / 空输入 / 项目外目录 / 未知事件：静默 exit 0、无输出", () => {
    for (const input of ["", "不是 JSON", "[1,2]", ev("SessionStart", "/nonexistent/dir"), ev("SessionStart", fx.root), ev("PreToolUse", fx.wt.standalone!)]) {
      const r = hook(input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  test("hook 不写被管理仓库的 .git", () => {
    const before = gitSnapshot(fx.repo);
    hook(ev("SessionStart", fx.wt.standalone!));
    hook(ev("Stop", fx.wt.standalone!));
    expect(gitSnapshot(fx.repo)).toBe(before);
  });
});

describe("plugin 骨架", () => {
  test("hooks.json：SessionStart/Stop 直接调 sh 包装（exec 形式、args 为空，路径含空格也安全），timeout 5，不注册 WorktreeCreate", () => {
    const h = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
    expect(Object.keys(h.hooks).sort()).toEqual(["SessionStart", "Stop"]);
    for (const k of ["SessionStart", "Stop"]) {
      const c = h.hooks[k][0].hooks[0];
      expect(c).toEqual({ type: "command", command: "${CLAUDE_PLUGIN_ROOT}/bin/heliu-hook", args: [], timeout: 5 });
    }
  });
  test(".mcp.json 与 plugin.json", () => {
    const m = JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8"));
    expect(m).toEqual({ mcpServers: { heliu: { command: "${CLAUDE_PLUGIN_ROOT}/bin/heliu", args: ["mcp"] } } });
    const p = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
    expect(p.name).toBe("heliu");
    expect(p.description).toMatch(/[一-龥]/);
    const skill = readFileSync(join(ROOT, "skills", "heliu", "SKILL.md"), "utf8");
    for (const k of ["name: heliu", "description:", "when_to_use:", "## ① 查待办", "## ② 为某个功能开新会话", "## ③ `heliu_sync` 之后", "## ④ 合并一版", "## ⑤ 跨仓库工作", "## ⑥ 禁止事项"]) expect(skill).toContain(k);
  });
});
