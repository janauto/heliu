/**
 * MCP：跑 scripts/mcp-smoke.ts（临时 fixture 上 initialize → tools/list → tools/call），断言 11 个工具与登记成功。
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { MCP_TOOL_NAMES } from "../src/mcp/server.ts";
import { clampText } from "../src/cli/render-ledger.ts";

describe("MCP server", () => {
  test(`冒烟脚本通过：${MCP_TOOL_NAMES.length} 个中文工具（M4 起含 2 个合并单工具，M8 起含合并后同步）、heliu_feature_add 登记成功、待办里能看到`, () => {
    const r = Bun.spawnSync({ cmd: [process.execPath, "run", join(import.meta.dir, "..", "scripts", "mcp-smoke.ts")], stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain(`② tools/list → ${MCP_TOOL_NAMES.length} 个工具`);
    expect(MCP_TOOL_NAMES.length).toBe(14); // M8 起含 heliu_after_merge
    expect(MCP_TOOL_NAMES).toContain("heliu_after_merge");
    // 不提供执行合并的工具：执行只能由用户在 CLI 确认
    expect(MCP_TOOL_NAMES.some((n) => /release_(run|execute|merge|rollback)/.test(n))).toBe(false);
    for (const name of MCP_TOOL_NAMES) expect(out).toContain(`- ${name}：`);
    expect(out).toContain("已登记 F-0001「让背夹支持闹钟」");
    expect(out).toContain("结论：通过");
  }, 60_000);

  test("返回文本超过 8000 字符时截断并提示用 CLI --json", () => {
    const long = Array.from({ length: 2000 }, (_, i) => `第 ${i} 行`).join("\n");
    const c = clampText(long, "heliu 待办 v1.2");
    expect(c.length).toBeLessThanOrEqual(8000);
    expect(c).toContain("`heliu 待办 v1.2 --json`");
    expect(clampText("短", "x")).toBe("短");
  });
});
