import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { width } from "../src/cli/table.ts";
import { buildFixture, gitSnapshot, type Fixture } from "./helpers/fixture.ts";

const BIN = join(import.meta.dir, "..", "bin", "heliu");
let fx: Fixture;

function heliu(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, "run", BIN, ...args],
    cwd: cwd ?? fx.root,
    env: { ...process.env, ...fx.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

beforeAll(() => {
  fx = buildFixture();
});
afterAll(() => fx.cleanup());

describe("CLI", () => {
  test("project add 只写 heliu 注册表", () => {
    const before = gitSnapshot(fx.repo);
    const r = heliu(["project", "add", fx.repo, "--name", "演示", "--integration", "integ", "--label", "主仓"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已创建项目「演示」");
    const f = join(fx.heliuHome, "projects", "演示", "project.yaml");
    expect(existsSync(f)).toBe(true);
    const yaml = readFileSync(f, "utf8");
    expect(yaml).toContain("main: main");
    expect(yaml).toContain("integration: integ");
    expect(yaml).toContain("remote: origin"); // 只有 origin 这个远端名（来自 refs/remotes）
    expect(gitSnapshot(fx.repo)).toBe(before);
  });

  test("project list", () => {
    const r = heliu(["project", "list", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.command).toBe("project.list");
    expect(j.data.projects[0].name).toBe("演示");
  });

  test("status --json 可解析、带外壳", () => {
    const r = heliu(["status", "--project", "演示", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.schemaVersion).toBe(1);
    expect(j.command).toBe("status");
    expect(j.project.name).toBe("演示");
    expect(j.data.repos[0].counts.branches).toBe(8);
  });

  test("在仓库的 worktree 里运行时自动识别项目", () => {
    const r = heliu(["branches", "--json"], fx.wt.standalone);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).project.name).toBe("演示");
  });

  test("status 中文表格按显示宽度对齐", () => {
    const r = heliu(["status", "--project", "演示"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("健康条");
    const lines = r.stdout.split("\n");
    const header = lines.findIndex((l) => l.includes("标签") && l.includes("合并状态"));
    expect(header).toBeGreaterThan(0);
    // 分隔线下的每一行：「最后提交」列（日期，固定 10 宽）的起始显示列一致
    const sep = lines[header + 1]!;
    const lastCol = sep.lastIndexOf(" ") + 1;
    for (let i = header + 2; i < lines.length && lines[i]!.trim(); i++) {
      const line = lines[i]!;
      const m = /\d{4}-\d{2}-\d{2}$/.exec(line);
      expect(m).not.toBeNull();
      expect(width(line.slice(0, m!.index))).toBe(lastCol);
    }
  });

  test("hygiene / sessions / doctor 正常退出", () => {
    const h = heliu(["hygiene", "--project", "演示"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("孤儿 .git/worktrees 条目");
    const s = heliu(["sessions", "--project", "演示", "--all"]);
    expect(s.code).toBe(0);
    expect(s.stdout).toContain("实现 EPP 网关 v0");
    expect(s.stdout).toContain("运行中");
    const d = heliu(["doctor", "--json"]);
    expect(d.code).toBe(0);
    const checks = JSON.parse(d.stdout).data.checks as Array<{ id: string; level: string }>;
    expect(checks.find((c) => c.id === "git")?.level).toBe("ok");
  });

  test("未知项目给出可读错误，退出码 2", () => {
    const r = heliu(["status", "--project", "不存在"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("未找到项目「不存在」");
  });
});
