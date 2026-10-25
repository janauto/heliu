#!/usr/bin/env bun
/**
 * MCP 冒烟：在临时 fixture 上起 `bin/heliu mcp` 子进程，按 JSON-RPC 依次发
 *   initialize → notifications/initialized → tools/list → tools/call heliu_feature_add → tools/call heliu_milestone_todo
 * 打印每一步的结果。不碰任何真实项目：HELIU_HOME / 桌面会话目录全部指向临时目录。
 *
 * 用法：bun run scripts/mcp-smoke.ts        （--keep 保留临时目录便于查看台账文件）
 */
import { join } from "node:path";
import { buildFixture } from "../tests/helpers/fixture.ts";

const BIN = join(import.meta.dir, "..", "bin", "heliu");
const keep = process.argv.includes("--keep");
const fx = buildFixture();
const env = { ...process.env, ...fx.env };

// 1) 注册项目（只写临时 HELIU_HOME）
const reg = Bun.spawnSync({ cmd: [process.execPath, "run", BIN, "project", "add", fx.repo, "--name", "演示", "--integration", "integ"], env, stdout: "pipe", stderr: "pipe" });
if (reg.exitCode !== 0) {
  console.error("注册 fixture 项目失败：", reg.stderr.toString());
  process.exit(1);
}

// 2) 起 MCP 子进程
const child = Bun.spawn({ cmd: [process.execPath, "run", BIN, "mcp"], cwd: fx.repo, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
const killer = setTimeout(() => {
  console.error("超时：MCP 30 秒内没有完成全部请求");
  child.kill();
  process.exit(1);
}, 30_000);

const pending = new Map<number, (v: unknown) => void>();
let buf = "";
(async () => {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as { id?: number };
      if (typeof msg.id === "number") pending.get(msg.id)?.(msg);
    }
  }
})();

let seq = 0;
function send(method: string, params?: unknown, notify = false): Promise<unknown> {
  const msg: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) msg.params = params;
  if (notify) {
    child.stdin.write(JSON.stringify(msg) + "\n");
    child.stdin.flush();
    return Promise.resolve(null);
  }
  const id = ++seq;
  msg.id = id;
  const p = new Promise((resolve) => pending.set(id, resolve));
  child.stdin.write(JSON.stringify(msg) + "\n");
  child.stdin.flush();
  return p;
}

type CallResult = { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
const textOf = (r: unknown) => ((r as CallResult).result?.content ?? []).map((c) => c.text ?? "").join("\n");

let failed = false;
try {
  const init = (await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "heliu-smoke", version: "1" } })) as {
    result?: { serverInfo?: { name: string; version: string }; instructions?: string };
  };
  console.log("① initialize →", JSON.stringify(init.result?.serverInfo));
  await send("notifications/initialized", undefined, true);

  const list = (await send("tools/list")) as { result?: { tools?: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }> } };
  const tools = list.result?.tools ?? [];
  console.log(`② tools/list → ${tools.length} 个工具`);
  for (const t of tools) console.log(`   - ${t.name}：${t.description.slice(0, 60)}…（参数：${Object.keys(t.inputSchema.properties ?? {}).join(", ")}）`);

  const add = await send("tools/call", { name: "heliu_feature_add", arguments: { title: "让背夹支持闹钟", cwd: fx.wt.standalone } });
  console.log("③ tools/call heliu_feature_add →");
  console.log(textOf(add).replace(/^/gm, "   "));
  if ((add as CallResult).result?.isError || !textOf(add).includes("已登记 F-0001")) failed = true;

  const todo = await send("tools/call", { name: "heliu_milestone_todo", arguments: { milestone: "下一版", cwd: fx.wt.standalone } });
  console.log("④ tools/call heliu_milestone_todo（下一版）→");
  console.log(textOf(todo).replace(/^/gm, "   "));
  if (!textOf(todo).includes("让背夹支持闹钟")) failed = true;
} catch (e) {
  console.error("冒烟失败：", e);
  failed = true;
} finally {
  clearTimeout(killer);
  child.stdin.end();
  await Promise.race([child.exited, Bun.sleep(2000)]);
  child.kill();
  if (keep) console.log(`临时目录保留：${fx.root}`);
  else fx.cleanup();
}
console.log(failed ? "结论：失败" : "结论：通过");
process.exit(failed ? 1 : 0);
