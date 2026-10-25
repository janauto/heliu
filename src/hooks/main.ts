#!/usr/bin/env bun
// heliu Claude Code hook 入口（plugin hooks/hooks.json 调用）。
// 硬约束：<300ms 返回；任何错误静默 exit 0（stderr 至多一行），绝不阻塞会话。
// 看门狗：从进程启动算起 270ms 仍未完成就直接 exit 0（不输出），宁可少注入一次上下文也不拖慢会话。
import { writeSync } from "node:fs";

const BUDGET_MS = 270;
const watchdog = setTimeout(() => process.exit(0), Math.max(30, BUDGET_MS - performance.now()));

function oneLine(msg: string): void {
  try {
    writeSync(2, `heliu-hook：${msg.split("\n")[0]}\n`);
  } catch {
    /* stderr 不可写也忽略 */
  }
}

try {
  const text = await Bun.stdin.text();
  const { handleHook, parseHookInput } = await import("../src/hooks/handler.ts");
  const input = parseHookInput(text);
  if (input) {
    const r = await handleHook(input);
    if (r.stdout) writeSync(1, `${r.stdout}\n`);
    if (process.env.HELIU_HOOK_DEBUG === "1" && r.debug.length) oneLine(`${r.debug.join("；")}；总 ${Math.round(performance.now())}ms`);
  }
} catch (e) {
  oneLine((e as Error)?.message ?? String(e));
}
clearTimeout(watchdog);
process.exit(0);
