/**
 * 台账：frontmatter 读写（保留正文与未知字段）、编号与 slug、「下一版」别名、预约/冻结/改名、绑定去重，
 * 以及 CLI 流程（init → 新点子 → 待办 下一版 → 预约 → 待办 v1.2 → 我在哪）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendChangeLog,
  featureSlug,
  Ledger,
  ledgerDir,
  LedgerError,
  normalizeFeatureId,
  parseFeature,
  serializeFeature,
  splitFrontmatter,
} from "../src/core/ledger.ts";
import { parseProjectYaml, stringifyProject } from "../src/core/project.ts";
import { buildFixture, gitSnapshot, type Fixture } from "./helpers/fixture.ts";

const NOW = new Date("2026-10-26T10:00:00+08:00");
let dir: string;
let ledger: Ledger;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "heliu-ledger-"));
  ledger = new Ledger(join(dir, "台账 目录"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("编号与文件名", () => {
  test("F 编号规范化", () => {
    expect(normalizeFeatureId("3")).toBe("F-0003");
    expect(normalizeFeatureId("f12")).toBe("F-0012");
    expect(normalizeFeatureId("F-0007")).toBe("F-0007");
    expect(normalizeFeatureId("F-7")).toBe("F-0007");
  });
  test("slug：前 24 个字符、允许中文、空白与 / 换成 -", () => {
    expect(featureSlug("让背夹支持 闹钟/提醒")).toBe("让背夹支持-闹钟-提醒");
    const long = "一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十";
    expect(Array.from(featureSlug(long)).length).toBe(24);
    expect(featureSlug("  a  b  ")).toBe("a-b");
    expect(featureSlug("///")).toBe("未命名");
  });
});

describe("frontmatter 读写", () => {
  test("往返保留正文与未知字段", () => {
    const text = `---\nid: F-0009\ntitle: 测试卡\nstatus: 开发中\nmilestone: v1.2\nacceptance: 未\nbindings:\n  - repo: docs\n    branch: claude/x-123456\n    pr: 3\nrolled_from: [v1.1]\nsource: cli\ncreated: 2026-10-01\nupdated: 2026-10-02\nowner: 我\n---\n\n正文第一行\n\n- 列表\n`;
    const f = parseFeature(text, "/x/F-0009-测试卡.md")!;
    expect(f.id).toBe("F-0009");
    expect(f.bindings).toEqual([{ repo: "docs", branch: "claude/x-123456", worktree: null, session: null, pr: 3 }]);
    expect(f.rolled_from).toEqual(["v1.1"]);
    expect(f.created).toBe("2026-10-01");
    const out = serializeFeature(f);
    expect(out).toContain("owner: 我");
    expect(out.endsWith("\n正文第一行\n\n- 列表\n")).toBe(true);
    const again = parseFeature(out, f.file)!;
    expect(again.body).toBe(f.body);
    expect(again.milestone).toBe("v1.2");
  });
  test("数字样式的里程碑也读成字符串；没有 frontmatter 返回 null", () => {
    const f = parseFeature("---\nid: F-0001\ntitle: x\nmilestone: 1.2\n---\n", "/x.md")!;
    expect(f.milestone).toBe("1.2");
    expect(parseFeature("没有 frontmatter", "/y.md")).toBeNull();
    expect(splitFrontmatter("---\na: 1\n---")?.data).toEqual({ a: 1 });
  });
  test("变更记录追加到同一节", () => {
    const a = appendChangeLog("正文\n", "2026-10-26 预约：vNext → v1.2");
    const b = appendChangeLog(a, "2026-10-27 状态：开发中 → 待合并");
    expect(b).toBe("正文\n\n## 变更记录\n- 2026-10-26 预约：vNext → v1.2\n- 2026-10-27 状态：开发中 → 待合并\n");
  });
});

describe("里程碑与功能卡", () => {
  test("新点子：没有规划中的版本时自动建 vNext，编号从 F-0001 递增", () => {
    const a = ledger.addFeature({ title: "让背夹支持闹钟", now: NOW });
    expect(a.feature.id).toBe("F-0001");
    expect(a.feature.milestone).toBe("vNext");
    expect(a.feature.status).toBe("想法");
    expect(a.milestoneCreated?.id).toBe("vNext");
    expect(a.feature.file.endsWith("features/F-0001-让背夹支持闹钟.md")).toBe(true);
    const b = ledger.addFeature({ title: "第二个", now: NOW });
    expect(b.feature.id).toBe("F-0002");
    expect(b.milestoneCreated).toBeNull();
    expect(ledger.listMilestones().map((m) => m.id)).toEqual(["vNext"]);
  });

  test("预约到不存在的版本：新建为规划中，插在 vNext 之前，「下一版」随之变成它", () => {
    const r = ledger.reserve("1", "1.2", NOW);
    expect(r.from).toBe("vNext");
    expect(r.feature.milestone).toBe("v1.2");
    expect(r.milestoneCreated?.id).toBe("v1.2");
    expect(ledger.listMilestones().map((m) => m.id)).toEqual(["v1.2", "vNext"]);
    expect(ledger.findMilestone("下一版")?.id).toBe("v1.2");
    expect(readFileSync(r.feature.file, "utf8")).toContain("预约：vNext → v1.2");
  });

  test("按里程碑列卡：next 别名按当前下一版解析", () => {
    expect(ledger.listFeatures({ milestone: "下一版" }).map((f) => f.id)).toEqual(["F-0001"]);
    expect(ledger.listFeatures({ milestone: "vNext" }).map((f) => f.id)).toEqual(["F-0002"]);
  });

  test("冻结后不接新预约，下一版跳到后一个规划中", () => {
    ledger.freezeMilestone("v1.2");
    expect(ledger.findMilestone("next")?.id).toBe("vNext");
    expect(() => ledger.reserve("F-0002", "v1.2", NOW)).toThrow(LedgerError);
    const c = ledger.addFeature({ title: "冻结后的新点子", now: NOW });
    expect(c.feature.milestone).toBe("vNext");
  });

  test("绑定去重：同仓库同分支只留一条，并把想法推进到开发中", () => {
    const b1 = ledger.bind("F-0002", { repo: "docs", branch: "claude/a-111111", worktree: null, session: null, pr: null }, NOW);
    expect(b1.added).toBe(true);
    expect(b1.feature.status).toBe("开发中");
    const b2 = ledger.bind("F-0002", { repo: "docs", branch: "claude/a-111111", worktree: "/w", session: "local_x", pr: 5 }, NOW);
    expect(b2.added).toBe(false);
    expect(b2.feature.bindings).toEqual([{ repo: "docs", branch: "claude/a-111111", worktree: "/w", session: "local_x", pr: 5 }]);
    expect(ledger.findByBinding("docs", "claude/a-111111")?.id).toBe("F-0002");
  });

  test("状态/验收档位校验；改名", () => {
    expect(ledger.setStatus("F-0002", "待合并", NOW).status).toBe("待合并");
    expect(() => ledger.setStatus("F-0002", "随便" as never, NOW)).toThrow(LedgerError);
    expect(ledger.setAcceptance("F-0002", "实机通过", NOW).acceptance).toBe("实机通过");
    expect(ledger.rename("F-0002", "新名字", NOW).title).toBe("新名字");
    expect(() => ledger.getFeature("F-0999")).toThrow(LedgerError);
  });

  test("里程碑改名：同步改所有功能卡", () => {
    const r = ledger.renameMilestone("vNext", "v1.3", NOW);
    expect(r.milestone.id).toBe("v1.3");
    expect(r.features).toBe(2);
    expect(ledger.listFeatures({ milestone: "v1.3" }).map((f) => f.id)).toEqual(["F-0002", "F-0003"]);
  });

  test("坏卡片不影响其他卡，也不占编号", () => {
    writeFileSync(join(ledger.featuresDir, "F-0010-坏的.md"), "不是 frontmatter");
    const l = ledger.load();
    expect(l.broken.length).toBe(1);
    expect(l.features.length).toBe(3);
    expect(ledger.addFeature({ title: "在坏卡之后", now: NOW }).feature.id).toBe("F-0011");
  });
});

describe("project.yaml 扩展与台账位置", () => {
  const base = "name: 演示\nrepos:\n  - id: a\n    path: /r/a\n  - id: b\n    path: /r/b\n";
  test("默认 <主仓库>/.heliu；primary 指定主仓库", () => {
    expect(ledgerDir(parseProjectYaml(base, "/reg/演示/project.yaml"))).toBe("/r/a/.heliu");
    expect(ledgerDir(parseProjectYaml(base + "primary: b\n", "/reg/演示/project.yaml"))).toBe("/r/b/.heliu");
    expect(() => parseProjectYaml(base + "primary: c\n", "/reg/演示/project.yaml")).toThrow();
  });
  test("ledger 覆盖：支持 ~ 与相对路径；union_files/checks 只解析", () => {
    const p = parseProjectYaml(base + "ledger: ~/Library/Application Support/heliu/projects/演示/ledger\nunion_files: [README.md]\nchecks: [make test]\n", "/reg/演示/project.yaml");
    expect(p.ledger).toBe(join(homedir(), "Library/Application Support/heliu/projects/演示/ledger"));
    expect(p.unionFiles).toEqual(["README.md"]);
    expect(p.checks).toEqual(["make test"]);
    expect(parseProjectYaml(base + "ledger: ./ledger\n", "/reg/演示/project.yaml").ledger).toBe("/reg/演示/ledger");
  });
  test("重写 project.yaml 时保留 ledger 原文", () => {
    const p = parseProjectYaml(base, "/x");
    const text = stringifyProject("演示", p.repos, { ledger: "~/x/ledger" });
    expect(text).toContain("ledger: ~/x/ledger");
    expect(parseProjectYaml(text, "/reg/p.yaml").ledger).toBe(join(homedir(), "x/ledger"));
  });
});

/* ───────────── CLI 流程（fixture 仓库） ───────────── */

const BIN = join(import.meta.dir, "..", "bin", "heliu");
let fx: Fixture;
function heliu(args: string[], cwd?: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync({ cmd: [process.execPath, "run", BIN, ...args], cwd: cwd ?? fx.repo, env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("CLI：init → 新点子 → 待办 → 预约 → 我在哪", () => {
  let snap: string;
  beforeAll(() => {
    fx = buildFixture();
    expect(heliu(["project", "add", fx.repo, "--name", "演示", "--integration", "integ"]).code).toBe(0);
    snap = gitSnapshot(fx.repo);
  });
  afterAll(() => fx.cleanup());

  test("init 建台账（默认 <主仓库>/.heliu）", () => {
    const r = heliu(["init"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已建立");
    expect(existsSync(join(fx.repo, ".heliu", "milestones.yaml"))).toBe(true);
  });

  test("新点子（在 worktree 里）：预约下一版并自动绑定当前分支与会话", () => {
    const r = heliu(["新点子", "让背夹支持闹钟"], fx.wt.standalone);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("已登记 F-0001「让背夹支持闹钟」");
    expect(r.stdout).toContain("预约 vNext");
    expect(r.stdout).toContain("claude/bold-shaw-cccccc");
    const card = readdirSync(join(fx.repo, ".heliu", "features"))[0]!;
    const text = readFileSync(join(fx.repo, ".heliu", "features", card), "utf8");
    expect(text).toContain("session: local_full"); // ~/.claude/sessions 里按 cwd 匹配到运行中会话
    expect(text).toContain("source: cli");
  });

  test("同一分支再登记：不重复绑定", () => {
    const r = heliu(["feature", "add", "另一个想法", "--json"], fx.wt.standalone);
    const j = JSON.parse(r.stdout);
    expect(j.command).toBe("feature.add");
    expect(j.data.boundHere).toBe(false);
    expect(j.data.note).toContain("F-0001");
  });

  test("待办 下一版 列出新点子", () => {
    const r = heliu(["待办", "下一版"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("待办 vNext（下一版 · 规划中）");
    expect(r.stdout).toContain("让背夹支持闹钟");
    expect(r.stdout).toContain("另一个想法");
    const j = JSON.parse(heliu(["待办", "--json"]).stdout);
    expect(j.data.total).toBe(2);
  });

  test("预约 F-0001 v1.2 → 待办 v1.2", () => {
    const r = heliu(["预约", "F-0001", "v1.2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("vNext → v1.2");
    const t = heliu(["待办", "v1.2"]);
    expect(t.stdout).toContain("让背夹支持闹钟");
    expect(t.stdout).not.toContain("另一个想法");
    expect(heliu(["milestone", "list"]).stdout).toContain("v1.2 ←下一版");
  });

  test("我在哪：worktree 里显示功能卡与预约", () => {
    const r = heliu(["我在哪"], fx.wt.standalone);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("功能卡：F-0001「让背夹支持闹钟」");
    expect(r.stdout).toContain("预约：v1.2");
    expect(r.stdout).toContain("集成分支 3 提交");
    const j = JSON.parse(heliu(["whereami", "--json", "--cwd", fx.wt.standalone!]).stdout);
    expect(j.data.feature.id).toBe("F-0001");
    expect(j.data.behindIntegration).toBe(3);
  });

  test("错误给中文提示，退出码 2", () => {
    const r = heliu(["预约", "F-0099", "v1.2"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("没有功能卡 F-0099");
    const s = heliu(["feature", "status", "F-0001", "乱写"]);
    expect(s.code).toBe(2);
    expect(s.stderr).toContain("功能状态只能是");
  });

  test("被管理仓库 .git 零写入（台账只写在 .heliu/）", () => {
    expect(gitSnapshot(fx.repo)).toBe(snap);
  });
});

