/**
 * M5-A：heliu project add 向导（只读猜主线/远端/集成分支候选/iCloud → 摘要 → --yes 写注册表并建台账）、
 * 安装/卸载脚本 --dry-run、看板启动诊断行。全部在临时 fixture 上跑，不碰真实注册表与 Claude 配置。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { detectRepo } from "../src/core/onboard.ts";
import { B, buildFixture, gitSnapshot, gitW, type Fixture } from "./helpers/fixture.ts";

const ROOT = join(import.meta.dir, "..");
const BIN = join(ROOT, "bin", "heliu");
let fx: Fixture;

function heliu(args: string[]): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: [BIN, ...args], cwd: fx.repo, env: { ...process.env, ...fx.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

beforeAll(() => {
  fx = buildFixture();
});
afterAll(() => fx.cleanup());

describe("project add 向导：只读猜测", () => {
  test("没有候选时不设集成分支；主线按本地 main、远端按 origin", async () => {
    const d = await detectRepo(fx.repo);
    expect(d.root).toBe(fx.repo);
    expect([d.main, d.mainWhy]).toEqual(["main", "本地有 main"]);
    expect([d.remote, d.remoteWhy]).toEqual(["origin", "有 origin 就用 origin"]);
    expect(d.icloud).toBe(false);
    expect(d.worktrees).toBe(4);
    // integ 只包含 1 条未进主线的分支、名字也不像 → 不算候选
    expect(d.candidates).toEqual([]);
    expect(d.integration).toBeNull();
  });

  test("包含 ≥2 条未进主线分支的当候选；叠在它之上的功能分支排后面；名字含 merge/release 的最优先", async () => {
    // trunk = integ + 合入 standalone（包含 integ、in-integ、standalone 3 条）；feat-on-trunk 从 trunk 切出再加一个提交
    gitW(fx.repo, "checkout", "-q", "-b", "trunk", B.integ);
    gitW(fx.repo, "merge", "-q", "--no-ff", "-m", "merge: standalone 进 trunk", B.standalone);
    gitW(fx.repo, "checkout", "-q", "-b", "feat-on-trunk");
    writeFileSync(join(fx.repo, "t.txt"), "t\n");
    gitW(fx.repo, "add", "t.txt");
    gitW(fx.repo, "commit", "-q", "-m", "feat: 叠在 trunk 上");
    gitW(fx.repo, "checkout", "-q", "main");
    const d = await detectRepo(fx.repo);
    expect(d.candidates.map((c) => [c.branch, c.contains, c.onTopOf])).toEqual([
      ["trunk", 3, null],
      ["feat-on-trunk", 4, "trunk"],
    ]);
    expect(d.integration).toBe("trunk");
    expect(d.integrationWhy).toContain("包含 3 条未进主线的分支");

    gitW(fx.repo, "branch", "release/merge-train", B.integ);
    const e = await detectRepo(fx.repo);
    expect(e.candidates[0]!.branch).toBe("release/merge-train");
    expect(e.candidates[0]!.byName).toBe(true);
    expect(e.integration).toBe("release/merge-train");
    // 参数优先
    const f = await detectRepo(fx.repo, { integration: "integ", main: "main" });
    expect([f.integration, f.integrationWhy, f.mainWhy]).toEqual(["integ", "参数指定", "参数指定"]);
    gitW(fx.repo, "branch", "-q", "-D", "release/merge-train", "feat-on-trunk", "trunk");
  });
});

describe("project add 向导：写入", () => {
  test("--yes：摘要 + 写注册表 + 建台账（默认在 heliu 数据目录，不写进仓库）", () => {
    const before = gitSnapshot(fx.repo);
    const r = heliu(["project", "add", fx.repo, "--name", "向导", "--integration", "integ", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`合流 · 接入仓库：${fx.repo}`);
    expect(r.stdout).toContain("主线：main（本地有 main）");
    expect(r.stdout).toContain("集成分支：integ（参数指定）");
    expect(r.stdout).toContain("以上全部来自 git 只读命令，没有改动仓库。");
    expect(r.stdout).toContain("已创建项目「向导」");
    const ledger = join(fx.heliuHome, "projects", "向导", "ledger");
    expect(r.stdout).toContain(`台账：已建立 ${ledger}`);
    expect(existsSync(join(ledger, "milestones.yaml"))).toBe(true);
    const yaml = readFileSync(join(fx.heliuHome, "projects", "向导", "project.yaml"), "utf8");
    expect(yaml).toContain("integration: integ");
    expect(yaml).toContain(`ledger: ${ledger}`);
    expect(existsSync(join(fx.repo, ".heliu"))).toBe(false);
    expect(gitSnapshot(fx.repo)).toBe(before);
    // 已建台账的项目能直接用
    const t = heliu(["待办", "--project", "向导"]);
    expect(t.code).toBe(0);
  });

  test("没有终端也没加 --yes：只登记注册表、不建台账（M1 行为）", () => {
    const r = heliu(["project", "add", fx.repo, "--name", "只登记"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已创建项目「只登记」");
    expect(r.stdout).toContain("没建台账");
    expect(existsSync(join(fx.heliuHome, "projects", "只登记", "ledger"))).toBe(false);
    expect(readFileSync(join(fx.heliuHome, "projects", "只登记", "project.yaml"), "utf8")).not.toContain("ledger:");
  });

  test("--json --yes：返回探测结果与台账", () => {
    const r = heliu(["project", "add", fx.repo, "--name", "机读", "--yes", "--json"]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.command).toBe("project.add");
    expect(j.data.detection.main).toBe("main");
    expect(j.data.detection.remote).toBe("origin");
    expect(j.data.ledger.created).toBe(true);
  });
});

describe("安装 / 卸载脚本（只跑 --dry-run）", () => {
  test("install.sh --dry-run --with-mcp：打印 bun install、user 级 MCP、本地 marketplace 与插件安装命令", () => {
    const r = Bun.spawnSync({ cmd: ["bash", join(ROOT, "scripts", "install.sh"), "--dry-run", "--with-mcp"], stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain("演练模式（--dry-run）");
    expect(out).toContain(" install --cwd ");
    expect(out).toMatch(/ mcp add -s user heliu -- "?[^\n]*\/bin\/heliu"? mcp/);
    expect(out).toContain(" plugin marketplace add ");
    expect(out).toContain(" plugin install heliu@heliu-local");
    expect(out).toContain("完成（演练，未执行）");
  });

  test("uninstall.sh --dry-run：反向三步，不删台账", () => {
    const r = Bun.spawnSync({ cmd: ["bash", join(ROOT, "scripts", "uninstall.sh"), "--dry-run"], stdout: "pipe", stderr: "pipe" });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain(" plugin uninstall heliu@heliu-local");
    expect(out).toContain(" plugin marketplace remove heliu-local");
    expect(out).toContain(" mcp remove -s user heliu");
    expect(out).toContain("台账、注册表与缓存都保留");
  });

  test("marketplace.json：名字 heliu-local，插件 source 是仓库根 ./（官方格式不允许 ..）", () => {
    const m = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "marketplace.json"), "utf8"));
    expect(m.name).toBe("heliu-local");
    expect(m.owner.name).toBeTruthy();
    expect(m.plugins[0].name).toBe("heliu");
    expect(m.plugins[0].source).toBe("./");
  });
});

describe("看板启动诊断", () => {
  test("不管 HELIU_DEBUG，先往 stderr 打一行「启动中」", () => {
    const r = heliu(["board", "--project", "不存在的项目", "--no-open"]);
    expect(r.code).toBe(2);
    expect(r.stderr.split("\n")[0]).toBe("合流看板启动中…（HELIU_DEBUG=1 可看详细阶段）");
    expect(r.stderr).toContain("未找到项目「不存在的项目」");
  });
});
