/**
 * M8：分类收纳 · 合并闭环
 * - 分类推测（类型 / 模块）、别名、卡片写了就用卡片的
 * - frontmatter 往返：type / module 只在设过时写；手写的 type 不会被 extras 盖掉
 * - 合并后同步：已进集成 → 已合入、已进主线 → 已进主线、尚无提交 / 未合并不算、从不降级、只写选中的卡
 * - 合并 Prompt 不含 --yes；看板接口：/api/release/prompt、/api/merged、PATCH type/module
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeaturesData, MergedData, MergePromptData } from "../src/board/api-types.ts";
import { createBoardApp } from "../src/board/server.ts";
import { afterMerge } from "../src/core/after-merge.ts";
import { classify, DEFAULT_MODULES, inferModule, inferType, parseFeatureType } from "../src/core/classify.ts";
import { Ledger, parseFeature, serializeFeature } from "../src/core/ledger.ts";
import { buildMergePrompt } from "../src/core/merge-prompt.ts";
import { loadModules } from "../src/core/modules.ts";
import { heliuPaths, type HeliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, loadProject, projectFile, stringifyProject, type ProjectConfig } from "../src/core/project.ts";
import { B, buildFixture, type Fixture } from "./helpers/fixture.ts";

describe("分类推测", () => {
  test("类型：修复优先，其次工程 / 调研 / 文档，其余算功能", () => {
    expect(inferType("fix/ble-stop-teardown")).toBe("修复");
    expect(inferType("磁吸背夹竖版触屏焦点错误")).toBe("修复");
    expect(inferType("合并语音应用三档模式分支到 release")).toBe("工程");
    expect(inferType("同步本地 main 与 GitHub main")).toBe("工程");
    expect(inferType("Live2D 交互角色可行性评估")).toBe("调研");
    expect(inferType("磁吸背夹产品说明书")).toBe("文档");
    expect(inferType("让背夹支持闹钟")).toBe("功能");
    expect(inferType("")).toBe("其他");
  });
  test("模块：命中关键词最多的模块；都不中算其他", () => {
    expect(inferModule("ASR语音功能集成")).toBe("语音与对话");
    expect(inferModule("AI电话助手来电路由与语气定制")).toBe("通话与秘书");
    expect(inferModule("首页设计与交互原型")).toBe("界面与交互");
    expect(inferModule("实现 EPP 网关 v0（代调 MCP / CLI）")).toBe("平台与接口");
    expect(inferModule("app: 对话模型可选 OpenAI / DeepSeek")).toBe("手机 App");
    expect(inferModule("随便起的名字")).toBe("其他");
  });
  test("类型别名；不认识的类型报中文错误", () => {
    expect(parseFeatureType("bug")).toBe("修复");
    expect(parseFeatureType("feature")).toBe("功能");
    expect(parseFeatureType("功能迭代")).toBe("功能");
    expect(() => parseFeatureType("随便")).toThrow("不认识的类型");
  });
  test("卡片写了就用卡片的（来源 card），没写才推测（来源 guess）", () => {
    const g = classify(null, "fix: 蓝牙断连");
    expect(g).toEqual({ type: "修复", typeSource: "guess", module: "固件与连接", moduleSource: "guess" });
    const c = classify({ type: "功能", module: "自定义模块" }, "fix: 蓝牙断连");
    expect(c).toEqual({ type: "功能", typeSource: "card", module: "自定义模块", moduleSource: "card" });
  });
});

describe("合并 Prompt", () => {
  test("含预演命令、终端合并命令、同步命令；绝不含 --yes", () => {
    const p = buildMergePrompt({ project: "磁吸 背夹", milestone: "vNext", bin: "/x/heliu/bin/heliu", counts: { newMerge: 3, inIntegration: 2, conflict: 1, precheckFailed: 0, unchecked: 0, deferred: 4, waiting: 1, dropped: 0, otherPending: 0 } });
    expect(p.prompt).toContain(p.previewCommand);
    expect(p.prompt).toContain(p.command);
    expect(p.prompt).toContain(p.syncCommand);
    expect(p.prompt).toContain("不要替我执行合并");
    expect(p.prompt).toContain("新增待合 3 项");
    expect(p.command).toBe('"/x/heliu/bin/heliu" 合并 vNext --project "磁吸 背夹"');
    for (const t of [p.prompt, p.command, p.previewCommand, p.syncCommand]) expect(t).not.toContain("--yes");
  });
});

let fx: Fixture;
let paths: HeliuPaths;
let project: ProjectConfig;
let ledgerDir: string;
let dist: string;
let app: ReturnType<typeof createBoardApp>["app"];
let repoId: string;
let before: string;
const ids = { integ: "", main: "", open: "", zero: "", done: "" };

function treeSnapshot(root: string): string {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      const s = statSync(p);
      if (e.isDirectory()) {
        out.push(`${r}/|${s.mtimeMs}`);
        walk(p, r);
      } else out.push(`${r}|${s.mtimeMs}|${s.size}`);
    }
  };
  walk(root, "");
  return out.sort().join("\n");
}

beforeAll(async () => {
  fx = buildFixture();
  paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "分类演示", integration: B.integ });
  repoId = reg.repo.id;
  ledgerDir = join(fx.root, "分类台账");
  writeFileSync(projectFile(paths, "分类演示"), stringifyProject("分类演示", reg.project.repos, { ledger: ledgerDir }));
  project = loadProject(paths, "分类演示");
  const L = Ledger.of(project);
  const bind = (branch: string) => [{ repo: repoId, branch, worktree: null, session: null, pr: null }];
  ids.integ = L.addFeature({ title: "已进集成的功能", bindings: bind(B.inInteg), status: "开发中" }).feature.id;
  ids.main = L.addFeature({ title: "已进主线的修复", bindings: bind(B.mergedMain), status: "待合并" }).feature.id;
  ids.open = L.addFeature({ title: "还没合的功能", bindings: bind(B.standalone), status: "开发中" }).feature.id;
  ids.zero = L.addFeature({ title: "尚无提交的分支", bindings: bind(B.atTip), status: "开发中" }).feature.id;
  ids.done = L.addFeature({ title: "已进主线还想降级？", bindings: bind(B.inInteg), status: "已进主线" }).feature.id;
  dist = mkdtempSync(join(tmpdir(), "heliu-dist-"));
  ({ app } = createBoardApp({ paths, project, distDir: dist }));
  before = treeSnapshot(fx.repo);
});
afterAll(() => {
  fx.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

describe("frontmatter 往返", () => {
  test("type / module 只在设过时写；清掉后回到推测；手写的 type 不被 extras 覆盖", () => {
    const L = Ledger.of(project);
    const f0 = L.getFeature(ids.open);
    expect(readFileSync(f0.file, "utf8")).not.toContain("type:");
    const f1 = L.classify(ids.open, { type: "bug", module: "语音与对话" });
    expect(f1.type).toBe("修复");
    const text = readFileSync(f1.file, "utf8");
    expect(text).toContain("type: 修复");
    expect(text).toContain("module: 语音与对话");
    expect(text).toContain("类型：（推测） → 修复");
    // 手写一个 type 进文件，再走一次程序写入：值以程序设的为准，且只有一个 type 字段
    const hand = text.replace("type: 修复", "type: 文档");
    writeFileSync(f1.file, hand);
    const parsed = parseFeature(hand, f1.file)!;
    expect(parsed.type).toBe("文档");
    parsed.type = "调研";
    const out = serializeFeature(parsed);
    expect(out.match(/^type:/gm)?.length).toBe(1);
    expect(out).toContain("type: 调研");
    const cleared = L.classify(ids.open, { type: null, module: null });
    expect(cleared.type).toBeNull();
    expect(readFileSync(cleared.file, "utf8")).not.toMatch(/^type:/m);
    expect(() => L.classify(ids.open, { type: "随便" })).toThrow("不认识的类型");
  });

  test("modules.yaml 覆盖内置词典；写错时退回内置并给出说明", () => {
    expect(loadModules(ledgerDir).source).toBe("default");
    writeFileSync(join(ledgerDir, "modules.yaml"), "modules:\n  - name: 动力系统\n    keywords: [电机, 电池]\n");
    const m = loadModules(ledgerDir);
    expect(m.source).toBe("file");
    expect(m.modules.map((x) => x.name)).toEqual(["动力系统"]);
    writeFileSync(join(ledgerDir, "modules.yaml"), "modules: 不是列表\n");
    const bad = loadModules(ledgerDir);
    expect(bad.modules).toBe(DEFAULT_MODULES);
    expect(bad.warning).toContain("没有 modules 列表");
    rmSync(join(ledgerDir, "modules.yaml"));
  });
});

describe("合并后同步", () => {
  test("预览：已进集成 → 已合入；已进主线 → 已进主线；未合并 / 尚无提交 / 已是更高状态都不建议", async () => {
    const r = await afterMerge(project, paths, { dryRun: true });
    const by = new Map(r.suggestions.map((s) => [s.id, s]));
    expect(by.get(ids.integ)?.to).toBe("已合入");
    expect(by.get(ids.main)?.to).toBe("已进主线");
    expect(by.has(ids.open)).toBe(false);
    expect(by.has(ids.zero)).toBe(false);
    expect(by.has(ids.done)).toBe(false);
    expect(r.changed).toEqual([]);
    expect(Ledger.of(project).getFeature(ids.integ).status).toBe("开发中");
  });

  test("只写选中的卡；被管理仓库零写入", async () => {
    const r = await afterMerge(project, paths, { dryRun: false, ids: [ids.integ] });
    expect(r.changed.map((c) => c.id)).toEqual([ids.integ]);
    expect(Ledger.of(project).getFeature(ids.integ).status).toBe("已合入");
    expect(Ledger.of(project).getFeature(ids.main).status).toBe("待合并");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });
});

describe("看板接口", () => {
  test("/api/features：每张卡带类型 / 模块与来源，并返回模块定义", async () => {
    const r = await app.request("/api/features?precheck=0");
    const d = ((await r.json()) as { data: FeaturesData }).data;
    const cards = d.columns.flatMap((c) => c.cards);
    const fix = cards.find((c) => c.title === "已进主线的修复")!;
    expect(fix.type).toBe("修复");
    expect(fix.typeSource).toBe("guess");
    expect(d.types).toContain("调研");
    expect(d.modules.length).toBeGreaterThan(3);
  });

  test("PATCH type / module 写进卡片，来源变成 card；null 回到推测", async () => {
    const send = (body: unknown) => app.request(`/api/features/${ids.zero}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await send({ type: "文档", module: "产品与资料" })).status).toBe(200);
    const f = Ledger.of(project).getFeature(ids.zero);
    expect([f.type, f.module]).toEqual(["文档", "产品与资料"]);
    expect((await send({ type: null })).status).toBe(200);
    expect(Ledger.of(project).getFeature(ids.zero).type).toBeNull();
    expect((await send({ type: "随便" })).status).toBe(400);
  });

  test("/api/release/prompt：刷新合并单并返回 Prompt（不含 --yes）", async () => {
    const r = await app.request("/api/release/prompt", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ milestone: "下一版" }) });
    expect(r.status).toBe(200);
    const d = ((await r.json()) as { data: MergePromptData }).data;
    expect(d.prompt).toContain(d.command);
    expect(d.prompt).not.toContain("--yes");
    expect(d.file.startsWith(ledgerDir)).toBe(true);
    expect(typeof d.counts.deferred).toBe("number");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("/api/merged：GET 只列出；POST 必须给卡号，只写选中的", async () => {
    const g = await app.request("/api/merged");
    const list = ((await g.json()) as { data: MergedData }).data;
    expect(list.dryRun).toBe(true);
    expect(list.suggestions.map((s) => s.id)).toContain(ids.main);
    const bad = await app.request("/api/merged", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    expect(bad.status).toBe(400);
    const p = await app.request("/api/merged", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: [ids.main] }) });
    const done = ((await p.json()) as { data: MergedData }).data;
    expect(done.changed.map((c) => c.id)).toEqual([ids.main]);
    expect(Ledger.of(project).getFeature(ids.main).status).toBe("已进主线");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });
});
