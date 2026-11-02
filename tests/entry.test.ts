/**
 * 入口包装：bin/heliu、bin/heliu-hook 既是 POSIX sh 脚本（自寻 bun，不依赖 PATH），也能被 `bun run` 当 JS 跑。
 * 找 bun 顺序：command -v bun → ~/.bun/bin/bun → /opt/homebrew/bin/bun → /usr/local/bin/bun → $BUN_BIN。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "heliu");
const HOOK = join(ROOT, "bin", "heliu-hook");
let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "heliu-entry-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(cmd: string[], env: Record<string, string | undefined>, stdin = ""): { code: number; out: string; err: string; ms: number } {
  const t0 = performance.now();
  const r = Bun.spawnSync({ cmd, env: env as Record<string, string>, stdin: Buffer.from(stdin), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString(), ms: performance.now() - t0 };
}
/** 没有 bun 的环境：PATH 只有系统目录，HOME 指向空目录 */
const noBunEnv = () => ({ PATH: "/usr/bin:/bin", HOME: join(tmp, "empty-home") });
const systemBun = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some((p) => existsSync(p));

describe("bin/heliu 与 bin/heliu-hook 包装", () => {
  test("直接执行（sh）与 bun run（JS）都能跑", () => {
    expect(run([BIN, "--version"], process.env).out.trim()).toBe("0.5.0");
    expect(run([process.execPath, "run", BIN, "--version"], process.env).out.trim()).toBe("0.5.0");
    for (const cmd of [[HOOK], [process.execPath, "run", HOOK]]) {
      const r = run(cmd, process.env, "");
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    }
  });

  test("经软链调用时按真实位置找包根", () => {
    const link = join(tmp, "heliu-link");
    symlinkSync(BIN, link);
    expect(run([link, "--version"], process.env).out.trim()).toBe("0.5.0");
  });

  test.skipIf(systemBun)("PATH 与 ~/.bun 里都没有 bun：heliu 打印一行中文错误退出 1，hook 静默 exit 0", () => {
    const h = run([BIN, "--version"], noBunEnv());
    expect(h.code).toBe(1);
    expect(h.err).toContain("heliu：找不到 bun");
    expect(h.err.trim().split("\n").length).toBe(1);
    const k = run([HOOK], noBunEnv(), '{"hook_event_name":"SessionStart","cwd":"/tmp"}');
    expect(k.code).toBe(0);
    expect(k.out).toBe("");
    expect(k.err).toBe("");
  });

  test("BUN_BIN 兜底：其余位置都找不到时用它", () => {
    const r = run([BIN, "--version"], { ...noBunEnv(), BUN_BIN: process.execPath });
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe("0.5.0");
  });

  test("sh 包装开销 <30ms（与直接 bun 跑 src/hooks/main.ts 比较中位数）", () => {
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const direct = [process.execPath, join(ROOT, "src", "hooks", "main.ts")];
    run(direct, process.env); // 预热
    run([HOOK], process.env);
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 5; i++) {
      a.push(run(direct, process.env).ms);
      b.push(run([HOOK], process.env).ms);
    }
    expect(median(b) - median(a)).toBeLessThan(30);
  });
});
