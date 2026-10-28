/**
 * 回归：CLI 输出缓冲在下游不读也不关时不能永远挂着（曾有一个 `heliu sessions --json` 进程挂了 2 天多）。
 * 用一个 FIFO：读端被一个只 sleep 不读的进程占着；子进程往里写 400KB。应在卡顿上限后放弃剩余输出、在 stderr 说明并退出。
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("flushOut：下游不读时超过卡顿上限就放弃并退出", async () => {
  const dir = mkdtempSync(join(tmpdir(), "heliu-flush-"));
  try {
    const fifo = join(dir, "out.fifo");
    const mod = JSON.stringify(join(import.meta.dir, "..", "src", "cli", "index.ts"));
    const code = `const m = await import(${mod}); m.bufferOut("x".repeat(400_000)); await m.flushOut(1, 800); process.exit(0);`;
    // 只杀自己起的那个 sleep（记下 PID），不用 pkill 以免误伤
    const script = `mkfifo "$F" || exit 9; sleep 20 < "$F" & SP=$!; "$BUN" -e "$CODE" > "$F"; echo "exit=$?"; kill $SP 2>/dev/null; true`;
    const t0 = performance.now();
    const p = Bun.spawn({ cmd: ["sh", "-c", script], env: { ...process.env, F: fifo, BUN: process.execPath, CODE: code }, stdout: "pipe", stderr: "pipe" });
    const done = await Promise.race([p.exited.then(() => "ok" as const), Bun.sleep(15_000).then(() => "timeout" as const)]);
    if (done === "timeout") p.kill();
    expect(done).toBe("ok");
    expect(performance.now() - t0).toBeLessThan(12_000);
    expect(await new Response(p.stdout).text()).toContain("exit=0");
    expect(await new Response(p.stderr).text()).toContain("没有读取输出");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 20_000);
