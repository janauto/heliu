/**
 * 合流 App（macOS 外壳，app/macos）依赖的看板行为：
 * - watchParent：父进程还在时不动，父进程没了（ESRCH）才回调；停止监视后不再回调
 * - heliu board 带 HELIU_BOARD_PARENT_PID 启动：父进程被强退后，看板几秒内自己退出，不留孤儿占端口
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchParent } from "../src/board/server.ts";
import { HELIU_ROOT } from "../src/board/root.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = mkdtempSync(join(tmpdir(), "heliu-app-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function deadPid(): Promise<number> {
  const p = Bun.spawn({ cmd: ["/usr/bin/true"] });
  await p.exited;
  return p.pid;
}

describe("watchParent", () => {
  test("父进程不在了才回调，且只回调一次", async () => {
    let n = 0;
    watchParent(await deadPid(), () => n++, 20);
    await sleep(150);
    expect(n).toBe(1);
  });

  test("父进程还在时不回调；停止监视后也不回调", async () => {
    let n = 0;
    const stop = watchParent(process.pid, () => n++, 20);
    await sleep(120);
    expect(n).toBe(0);
    stop();
    const stop2 = watchParent(await deadPid(), () => n++, 50);
    stop2();
    await sleep(150);
    expect(n).toBe(0);
  });
});

describe("heliu board 跟随父进程退出", () => {
  test("父进程被强退后看板自己退出", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port;
    probe.stop(true);
    const parent = Bun.spawn({ cmd: ["/bin/sleep", "60"] });
    const board = Bun.spawn({
      cmd: [join(HELIU_ROOT, "bin", "heliu"), "board", "--port", String(port), "--no-open"],
      cwd: tmp,
      env: { ...process.env, HELIU_HOME: join(tmp, "home"), HELIU_BOARD_PARENT_PID: String(parent.pid) },
      stdout: "ignore",
      stderr: "ignore",
    });
    try {
      let up = false;
      for (let i = 0; i < 150 && !up; i++) {
        try {
          const r = await fetch(`http://127.0.0.1:${port}/api/projects`, { signal: AbortSignal.timeout(500) });
          up = r.ok;
        } catch {
          await sleep(200);
        }
      }
      expect(up).toBe(true);
      parent.kill("SIGKILL");
      await parent.exited;
      const code = await Promise.race([board.exited, sleep(8000).then(() => "仍在运行")]);
      expect(code).toBe(0);
    } finally {
      parent.kill("SIGKILL");
      board.kill("SIGKILL");
    }
  }, 40_000);
});
