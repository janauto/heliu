/**
 * M3 看板 API：用 Hono 的 app.request() 直接打 fixture 项目（不监听端口）。
 * 覆盖：status 缓存 / todo 分组 / features 列与卡片（灯色、下一步、多标签、已合入待确认）/ 新点子 /
 * PATCH 改预约（断言台账文件变化）/ 合并预演顺序 / 合并单草稿写入 / 同步基线预演 / 卫生建议命令 /
 * 安全（Host、Content-Type）/ 前端打包与首页 / 被管理仓库零写入（整棵目录 stat 快照）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BaselineData, BoardCard, FeaturesData, HygieneData, OverviewData, ReleasePlanResult, ReleasePreview } from "../src/board/api-types.ts";
import { ensureWebBuild } from "../src/board/build.ts";
import { createBoardApp, debugLogger } from "../src/board/server.ts";
import { summarizePrecheck } from "../src/core/todo.ts";
import { claudePrompt } from "../web/prompt.ts";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths, type HeliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, loadProject, projectFile, stringifyProject, type ProjectConfig } from "../src/core/project.ts";
import { buildReleasePlan, setPlanDecision } from "../src/core/release.ts";
import { ACTION_TEXT, loadPlan, TIER_OF } from "../src/core/release-plan.ts";
import type { ReconcileReport, TodoBinding, TodoItem, TodoReport } from "../src/types.ts";
import { B, buildFixture, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let ledgerDir: string;
let dist: string;
let app: ReturnType<typeof createBoardApp>["app"];
let before: string;
let paths: HeliuPaths;
let project: ProjectConfig;

/** 被管理仓库整棵目录（含 .git、.claude/worktrees 下的各 worktree）的 stat 快照 */
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

async function get<T>(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: { data: T; meta: { cached: boolean; scanMs: number; precheck: boolean } | null; error?: string } }> {
  const r = await app.request(path, { headers });
  return { status: r.status, body: (await r.json()) as never };
}
async function send<T>(method: string, path: string, body: unknown, ct = "application/json"): Promise<{ status: number; body: { data: T; error?: string } }> {
  const r = await app.request(path, { method, headers: { "Content-Type": ct }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as never };
}
const cards = (d: FeaturesData): BoardCard[] => d.columns.flatMap((c) => c.cards);
const card = (d: FeaturesData, id: string) => cards(d).find((c) => c.id === id)!;
const cardFile = (id: string) => {
  const f = readdirSync(join(ledgerDir, "features")).find((n) => n.startsWith(id));
  return readFileSync(join(ledgerDir, "features", f!), "utf8");
};

beforeAll(async () => {
  fx = buildFixture();
  paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "演示", integration: "integ" });
  // 台账放在仓库外（真实项目也是这样配置），这样「被管理仓库零写入」可以对整棵目录做快照
  ledgerDir = join(fx.root, "台账 目录");
  writeFileSync(projectFile(paths, "演示"), stringifyProject("演示", reg.project.repos, { ledger: ledgerDir }));
  project = loadProject(paths, "演示");
  const L = Ledger.of(project);
  const bind = (branch: string) => [{ repo: reg.repo.id, branch, worktree: null, session: null, pr: null }];
  L.addFeature({ title: "已进集成的功能", bindings: bind(B.inInteg), status: "开发中" }); // F-0001
  L.addFeature({ title: "EPP 网关", bindings: bind(B.standalone), status: "待合并" }); // F-0002
  L.addFeature({ title: "冲突地改 README", bindings: bind(B.conflict), status: "待合并" }); // F-0003
  L.addFeature({ title: "只是个想法" }); // F-0004
  L.addFeature({ title: "老分支调研", bindings: bind(B.behind), status: "待合并" }); // F-0005
  dist = mkdtempSync(join(tmpdir(), "heliu-dist-"));
  ({ app } = createBoardApp({ paths, project, distDir: dist }));
  before = treeSnapshot(fx.repo);
});
afterAll(() => {
  fx.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

describe("只读接口", () => {
  test("status：ReconcileReport + 20 秒缓存；precheck=1 是另一份结果", async () => {
    const a = await get<ReconcileReport>("/api/status");
    expect(a.status).toBe(200);
    expect(a.body.data.repos[0]!.reachable).toBe(true);
    expect(a.body.data.options.precheck).toBe(false);
    expect(typeof a.body.meta!.scanMs).toBe("number");
    const b = await get<ReconcileReport>("/api/status");
    expect(b.body.meta!.cached).toBe(true);
    const p = await get<ReconcileReport>("/api/status?precheck=1");
    expect(p.body.data.options.precheck).toBe(true);
    expect(p.body.meta!.precheck).toBe(true);
  }, 30_000);

  test("todo：M2 分组（--precheck）", async () => {
    const r = await get<TodoReport>("/api/todo?milestone=下一版&precheck=1");
    expect(r.status).toBe(200);
    const ids = (k: string) => r.body.data.groups.find((g) => g.key === k)!.items.map((i) => i.id);
    expect(ids("conflict")).toEqual(["F-0003"]);
    expect(ids("mergeable").sort()).toEqual(["F-0001", "F-0002", "F-0005"]);
    expect(ids("unbound")).toEqual(["F-0004"]);
    const plain = await get<TodoReport>("/api/todo");
    expect(plain.body.data.groups.find((g) => g.key === "conflict")!.count).toBeNull(); // 未检查
  }, 30_000);

  test("features：列 = 里程碑 + 未预约 + 已发布；灯色/下一步/多标签/已合入待确认", async () => {
    const r = await get<FeaturesData>("/api/features");
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.columns.map((c) => c.key)).toEqual(["vNext", "__unreserved", "__released"]);
    const v = d.columns[0]!;
    expect(v.isNext).toBe(true);
    expect([v.owed, v.mergeable, v.conflict, v.precheckFailed, v.waiting]).toEqual([5, 3, 1, 0, 0]);
    expect(d.precheckSummary).toEqual({ requested: true, status: "checked", conflicts: 1, failed: 0, unchecked: 0, firstError: null });
    expect(card(d, "F-0002").bindings[0]!.precheckState).toBe("checked");
    expect(card(d, "F-0001").bindings[0]!.precheckState).toBeNull(); // 已进集成分支：不需要试合
    // 组名来自 M2 分组函数
    expect(d.groups.map((g) => g.title)).toContain("尚未关联开发分支");
    const f1 = card(d, "F-0001");
    expect(f1.light).toBe("green");
    expect(f1.variant).toBe("merged-pending");
    expect(f1.suggestStatus).toBe("已合入");
    expect(f1.nextStep).toContain("已合入 · 待确认台账");
    const f2 = card(d, "F-0002");
    expect(f2.variant).toBe("normal");
    expect(f2.nextStep).toMatch(/^可合并：试合到 integ 无冲突（试合无冲突 ≠ 已验收）；落后 ↓\d+，建议先同步基线$/);
    const f3 = card(d, "F-0003");
    expect(f3.light).toBe("red");
    expect(f3.lightText).toBe("有冲突 · 1 个文件");
    expect(f3.nextStep).toContain("需解冲突");
    // 主分组已由灯色表达，次要标签只列另外成立的事实
    expect(f3.tags.map((t) => t.kind)).not.toContain("conflict");
    expect(f3.bindings[0]!.conflicts).toEqual(["README.md"]);
    // 「复制给 Claude 会话」：只生成文本
    expect(claudePrompt("conflict", f3.bindings[0]!)).toBe(
      `请在分支 ${B.conflict} 的 worktree（目录未知，请先打开该分支的会话）里，把 integ 合并进来并解决冲突文件：README.md；两边功能都保留，解完 git add，不要 push。`,
    );
    const p5 = claudePrompt("sync", card(d, "F-0005").bindings[0]!);
    expect(p5).toContain(`的 worktree（${fx.wt.reused}）里，把 integ 同步基线并解决冲突文件：（试合没有冲突文件）`);
    const f5 = card(d, "F-0005");
    expect(f5.light).toBe("green");
    expect(f5.tags.find((t) => t.kind === "behind")?.text).toMatch(/^落后 ↓\d+$/);
    expect(card(d, "F-0004").nextStep).toBe("尚未关联开发分支");
    // 不试合时冲突「未检查」
    const plain = await get<FeaturesData>("/api/features?precheck=0");
    expect(plain.body.data.columns[0]!.conflict).toBeNull();
    expect(plain.body.data.precheck).toBe(false);
    expect(plain.body.data.precheckSummary.status).toBe("skipped");
    expect(plain.body.data.precheckSummary.unchecked).toBe(3); // F-0002/3/5 的分支需要试合但没请求
  }, 30_000);

  test("overview：现在最该做的 + 下一版 + 一眼条数字", async () => {
    const r = await get<OverviewData>("/api/overview?precheck=1");
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.data.actions)).toBe(true);
    expect(r.body.data.next).toEqual({ id: "vNext", status: "规划中" });
    expect(r.body.data.columns.find((c) => c.key === "vNext")!.conflict).toBe(1);
    expect(typeof r.body.data.neverPushed).toBe("number");
    for (const a of r.body.data.actions) expect(a).not.toContain("heliu sessions");
  }, 30_000);

  test("hygiene：四类 + 建议命令（只显示）", async () => {
    const r = await get<HygieneData>("/api/hygiene");
    const cats = r.body.data.repos[0]!.categories;
    expect(cats.map((c) => c.key)).toEqual(["cleanup", "mismatch", "orphan", "copies"]);
    const orphan = cats.find((c) => c.key === "orphan")!;
    expect(orphan.items.some((i) => i.kind === "index_lock" && i.suggestion?.includes("pgrep"))).toBe(true);
    expect(orphan.items.some((i) => i.kind === "orphan_admin_dir" && i.suggestion?.includes("--dry-run"))).toBe(true);
  }, 30_000);

  test("同步基线（预演）：集成分支合入冲突分支 → README.md", async () => {
    const r = await get<BaselineData>("/api/features/F-0003/baseline");
    expect(r.status).toBe(200);
    const checks = r.body.data.bindings[0]!.checks;
    expect(checks.find((c) => c.base === "integration")!.conflicts).toEqual(["README.md"]);
    expect(checks.find((c) => c.base === "main")!.conflictFiles).toBe(0);
  }, 30_000);

  test("sessions / milestones", async () => {
    const s = await get<{ total: number; sessions: unknown[] }>("/api/sessions");
    expect(s.body.data.total).toBe(s.body.data.sessions.length);
    const m = await get<{ milestones: Array<{ id: string }>; next: string }>("/api/milestones");
    expect(m.body.data.next).toBe("vNext");
  });
});

describe("写台账", () => {
  test("新点子：POST /api/features → 卡片文件，默认预约下一版，来源 board", async () => {
    const r = await send<{ feature: { id: string; milestone: string; file: string } }>("POST", "/api/features", { title: "让背夹支持闹钟" });
    expect(r.status).toBe(201);
    expect(r.body.data.feature.milestone).toBe("vNext");
    const text = readFileSync(r.body.data.feature.file, "utf8");
    expect(text).toContain("title: 让背夹支持闹钟");
    expect(text).toContain("source: board");
    expect((await send("POST", "/api/features", { title: "  " })).status).toBe(400);
  });

  test("PATCH 改预约：台账文件与 milestones.yaml 都变；再改回；看板列跟着变", async () => {
    const r = await send<{ feature: { milestone: string }; from: string; milestoneCreated: string }>("PATCH", "/api/features/F-0002", { milestone: "v1.2-试" });
    expect(r.status).toBe(200);
    expect(r.body.data.from).toBe("vNext");
    expect(r.body.data.milestoneCreated).toBe("v1.2-试");
    expect(cardFile("F-0002")).toContain("milestone: v1.2-试");
    expect(cardFile("F-0002")).toContain("预约：vNext → v1.2-试");
    expect(readFileSync(join(ledgerDir, "milestones.yaml"), "utf8")).toContain("id: v1.2-试");
    const f = await get<FeaturesData>("/api/features");
    expect(card(f.body.data, "F-0002").column).toBe("v1.2-试");
    const back = await send<{ feature: { milestone: string } }>("PATCH", "/api/features/F-0002", { milestone: "vNext" });
    expect(back.body.data.feature.milestone).toBe("vNext");
    expect(cardFile("F-0002")).toContain("milestone: vNext");
    // 改成未预约 → 「未预约」列
    await send("PATCH", "/api/features/F-0004", { milestone: null });
    const g = await get<FeaturesData>("/api/features");
    expect(card(g.body.data, "F-0004").column).toBe("__unreserved");
    await send("PATCH", "/api/features/F-0004", { milestone: "vNext" });
  });

  test("PATCH 改名 / 状态；非法值给中文错误", async () => {
    const r = await send<{ feature: { title: string } }>("PATCH", "/api/features/F-0005", { title: "老分支调研（改名）" });
    expect(r.body.data.feature.title).toBe("老分支调研（改名）");
    const bad = await send("PATCH", "/api/features/F-0005", { status: "乱写" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("功能状态只能是");
    expect((await send("PATCH", "/api/features/F-0099", { title: "x" })).status).toBe(400);
  });

  test("sync dry_run 不写台账", async () => {
    const n = readdirSync(join(ledgerDir, "features")).length;
    const r = await send<{ dryRun: boolean }>("POST", "/api/sync", { dry_run: true });
    expect(r.status).toBe(200);
    expect(r.body.data.dryRun).toBe(true);
    expect(readdirSync(join(ledgerDir, "features")).length).toBe(n);
  });
});

describe("合并预演与合并单（M4 合并单构建器，看板与 CLI 同一套规则）", () => {
  const RANK = { in_integration: 0, clean: 1, conflict: 2, precheck_failed: 3, unfinished: 4, unmergeable: 5 } as const;

  test("preview：档位/动作/决定取自 M4 合并单，顺序 已进集成 → 无冲突 → 有冲突 → 未能试合 → 未完成 → 无法合并", async () => {
    const r = await get<ReleasePreview>("/api/release/preview?milestone=vNext");
    expect(r.status).toBe(200);
    const d = r.body.data;
    const items = d.items;
    for (let i = 1; i < items.length; i++) expect(RANK[items[i]!.tier]).toBeGreaterThanOrEqual(RANK[items[i - 1]!.tier]);
    expect(items.map((x) => x.order)).toEqual(items.map((_, i) => i + 1));
    const it = (id: string) => items.find((x) => x.id === id)!;
    expect([it("F-0001").tier, it("F-0001").action]).toEqual(["in_integration", "skip"]);
    expect([it("F-0005").tier, it("F-0005").decision]).toEqual(["clean", "并入"]); // 待合并 + 试合无冲突
    expect([it("F-0003").tier, it("F-0003").action, it("F-0003").actionText]).toEqual(["conflict", "resolve", "合入（需解冲突）"]);
    expect(it("F-0003").bindings[0]!.conflicts).toEqual(["README.md"]);
    expect([it("F-0002").tier, it("F-0002").reason]).toEqual(["unfinished", "会话正在运行"]); // M4：绑定会话在跑 → 未完成
    expect([it("F-0004").tier, it("F-0004").decision, it("F-0004").reason]).toEqual(["unmergeable", "顺延", "没有绑定分支"]);
    expect(d.deferred).toEqual(expect.arrayContaining(["F-0002", "F-0004"]));
    expect(d.repos[0]!.integrationSha).toMatch(/^[0-9a-f]{40}$/);
    expect(d.warnings).toEqual([]);
    expect(d.plan.exists).toBe(false); // 预演不写文件
    expect(existsSync(join(ledgerDir, "releases", "vNext.md"))).toBe(false);
  }, 30_000);

  test("与 buildReleasePlan（heliu 合并 --预演 用的同一个函数）逐项一致", async () => {
    const r = await get<ReleasePreview>("/api/release/preview?milestone=vNext");
    const built = await buildReleasePlan(project, paths, "vNext");
    const mine = r.body.data.items.map((x) => [x.id, x.bindings[0]?.branch ?? null, x.tierText, x.tier, x.actionText, x.decision]);
    const m4 = built.plan.items.map((i) => [i.feature, i.branch, i.state, TIER_OF[i.state], ACTION_TEXT[i.state], i.decision]);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine).toEqual(m4);
  }, 30_000);

  test("未配置集成分支的仓库：M4 口径「无法合并 → 顺延」，预演页顶部给补救提示", async () => {
    // 同一仓库、同一台账，另登记一个没配 integration 的项目（只读预演，不写文件）
    mkdirSync(join(paths.projectsDir, "无集成"), { recursive: true });
    writeFileSync(projectFile(paths, "无集成"), stringifyProject("无集成", project.repos.map((x) => ({ ...x, integration: null })), { ledger: ledgerDir }));
    const { app: app2 } = createBoardApp({ paths, project: loadProject(paths, "无集成"), distDir: dist });
    const r = await app2.request("/api/release/preview?milestone=vNext");
    const d = ((await r.json()) as { data: ReleasePreview }).data;
    const f3 = d.items.find((x) => x.id === "F-0003")!;
    expect([f3.tier, f3.tierText, f3.decision, f3.reason]).toEqual(["unmergeable", "无法合并", "顺延", "仓库未配置集成分支（project.yaml integration）"]);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toContain(`${project.repos[0]!.label}未配置集成分支`);
    expect(d.warnings[0]).toContain("--integration");
    expect(d.deferred).toContain("F-0003");
  }, 30_000);

  test("plan：写 M4 合并单（schema 2，与 CLI 同一个文件）；改过的决定刷新后保留，看板预演也显示", async () => {
    const r = await send<ReleasePlanResult>("POST", "/api/release/plan", { milestone: "vNext" });
    expect(r.status).toBe(201);
    expect(r.body.data.file).toBe(join(ledgerDir, "releases", "vNext.md"));
    expect(r.body.data.status).toBe("草稿");
    expect(r.body.data.backup).toBeNull();
    const plan = loadPlan(ledgerDir, "vNext")!;
    expect(plan.format).toBe("m4");
    expect(plan.items.find((i) => i.feature === "F-0003")!.decision).toBe("并入");
    expect(plan.repos[0]!.base_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(r.body.data.file, "utf8")).not.toMatch(/^- \[ \]/m); // 不写 Obsidian 复选框
    // CLI 那边改决定（heliu release set）→ 看板预演与再次生成都保留
    setPlanDecision(project, "vNext", "F-0003", "顺延");
    const p = await get<ReleasePreview>("/api/release/preview?milestone=vNext");
    const f3 = p.body.data.items.find((x) => x.id === "F-0003")!;
    expect([f3.decision, f3.defaultDecision]).toEqual(["顺延", "并入"]);
    expect(p.body.data.plan).toMatchObject({ exists: true, format: "m4", status: "草稿", kept: 1 });
    const again = await send<ReleasePlanResult>("POST", "/api/release/plan", { milestone: "vNext" });
    expect(again.body.data.kept).toBe(1);
    expect(loadPlan(ledgerDir, "vNext")!.items.find((i) => i.feature === "F-0003")!.decision).toBe("顺延");
  }, 30_000);
});

describe("安全与前端", () => {
  test("Host 不是本机 → 403；写接口不是 JSON → 415；未知接口 → 404", async () => {
    expect((await get("/api/status", { host: "evil.example.com" })).status).toBe(403);
    expect((await get("/api/milestones", { host: "127.0.0.1:7788" })).status).toBe(200);
    expect((await send("POST", "/api/features", { title: "x" }, "text/plain")).status).toBe(415);
    expect((await get("/api/nope")).status).toBe(404);
  });

  test("前端打包到 dist，首页与 app.js 可取（不引用任何 CDN）", async () => {
    const b = await ensureWebBuild({ distDir: dist, force: true });
    expect(b.built).toBe(true);
    expect(b.sizes["app.js"]).toBeGreaterThan(1000);
    const again = await ensureWebBuild({ distDir: dist });
    expect(again.built).toBe(false); // 源码没变：沿用
    const html = await (await app.request("/")).text();
    expect(html).toContain("合流看板");
    expect(html).not.toMatch(/https?:\/\//);
    const js = await app.request("/app.js");
    expect(js.headers.get("content-type")).toContain("javascript");
    const code = await js.text();
    expect(code).toContain("仅预演，不会执行合并（M4）");
    expect(code).not.toMatch(/https?:\/\/(cdn|unpkg|esm\.sh)/);
  }, 30_000);
});

/* ───────────── 试合三态（M3 第 2 轮，Codex 第 1 轮反馈） ───────────── */

const tb = (p: Partial<TodoBinding>): TodoBinding => ({
  repo: "docs",
  repoLabel: "文档仓",
  branch: "b",
  exists: true,
  mergedState: "unmerged",
  behindMain: 0,
  behindIntegration: 5,
  conflictFiles: null,
  sessionId: null,
  sessionStatus: null,
  lastCommitAt: null,
  ...p,
});
const ti = (id: string, group: TodoItem["group"], bindings: TodoBinding[]): TodoItem => ({
  id,
  title: id,
  status: "开发中",
  acceptance: "未",
  rolledFrom: [],
  group,
  bindings,
  needsAction: group === "blocked" ? "确认一下" : null,
  lastActivityAt: null,
  idleDays: 0,
  file: "/x",
});

describe("试合三态汇总", () => {
  test("summarizePrecheck：已检查 / 部分完成 / 未完成 / 未检查", () => {
    const ok = ti("A", "mergeable", [tb({ precheck: "checked", conflictFiles: 0 })]);
    const cf = ti("B", "conflict", [tb({ precheck: "checked", conflictFiles: 2 })]);
    const bad = ti("C", "behind", [tb({ precheck: "failed", precheckError: "无法建立写保护沙箱" })]);
    const merged = ti("D", "mergeable", [tb({ mergedState: "in_integration", precheck: null })]);
    const groups = (items: TodoItem[]) => [
      { key: "conflict" as const, items: items.filter((i) => i.group === "conflict") },
      { key: "mergeable" as const, items: items.filter((i) => i.group === "mergeable") },
      { key: "behind" as const, items: items.filter((i) => i.group === "behind") },
    ];
    expect(summarizePrecheck({ precheck: true, groups: groups([ok, cf, merged]) })).toEqual({ requested: true, status: "checked", conflicts: 1, failed: 0, unchecked: 0, firstError: null });
    const partial = summarizePrecheck({ precheck: true, groups: groups([ok, cf, bad]) });
    expect([partial.status, partial.conflicts, partial.failed, partial.firstError]).toEqual(["partial", 1, 1, "无法建立写保护沙箱"]);
    expect(summarizePrecheck({ precheck: true, groups: groups([bad, merged]) }).status).toBe("failed");
    const skipped = summarizePrecheck({ precheck: false, groups: groups([ti("E", "behind", [tb({ precheck: "skipped" })]), merged]) });
    expect([skipped.status, skipped.conflicts, skipped.unchecked]).toEqual(["skipped", null, 1]);
  });
});

describe("建不了写保护沙箱时（HELIU_NO_SANDBOX=1，Codex 第 1 轮场景）", () => {
  let probe: Record<string, { data: unknown }>;
  beforeAll(() => {
    const env = { ...process.env, ...fx.env, HELIU_NO_SANDBOX: "1" };
    const r = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "helpers", "board-probe.ts"), "演示", "/api/features", "/api/release/preview?milestone=vNext", "/api/overview?precheck=1"],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    probe = JSON.parse(r.stdout.toString());
  });

  test("版本列：冲突 0 · 未能试合 3，汇总不是「已检查」；卡片标「未能试合」、不是绿灯", () => {
    const d = probe["/api/features"]!.data as FeaturesData;
    const v = d.columns.find((c) => c.key === "vNext")!;
    expect(v.conflict).toBe(0);
    expect(v.precheckFailed).toBe(3);
    expect(d.precheckSummary.status).toBe("failed");
    expect(d.precheckSummary.firstError).toContain("沙箱");
    for (const id of ["F-0002", "F-0003", "F-0005"]) {
      const c = card(d, id);
      expect(c.light).not.toBe("green");
      expect(c.tags.map((t) => t.kind)).toContain("precheck_failed");
      expect(c.nextStep).toStartWith("未能试合");
      expect(c.nextStep).not.toContain("无冲突");
      expect(c.bindings[0]!.precheckState).toBe("failed");
    }
    const ov = probe["/api/overview?precheck=1"]!.data as OverviewData;
    expect(ov.precheckSummary.failed).toBe(3);
    expect(ov.columns.find((c) => c.key === "vNext")!.precheckFailed).toBe(3);
  });

  test("合并预演（M4 口径）：试合没结果的进「未能试合」档、默认待定不顺延；会话在跑的仍是未完成", () => {
    const p = probe["/api/release/preview?milestone=vNext"]!.data as ReleasePreview;
    const item = (id: string) => p.items.find((x) => x.id === id)!;
    expect(["F-0003", "F-0005"].map((id) => [item(id).tier, item(id).action, item(id).defaultDecision])).toEqual([
      ["precheck_failed", "recheck", "待定"],
      ["precheck_failed", "recheck", "待定"],
    ]);
    expect(item("F-0005").bindings[0]!.precheckError).toContain("沙箱");
    expect(item("F-0002").tier).toBe("unfinished");
    expect(item("F-0001").tier).toBe("in_integration");
    expect(p.counts.precheck_failed).toBe(2);
    expect(p.deferred).not.toContain("F-0005");
    const tiers = p.items.map((x) => x.tier);
    expect(tiers.lastIndexOf("precheck_failed")).toBeLessThan(tiers.indexOf("unfinished"));
  });

  test("CLI heliu 待办 --precheck 同样显示「未能试合」（同一个汇总函数）", () => {
    const r = Bun.spawnSync({
      cmd: [join(import.meta.dir, "..", "bin", "heliu"), "待办", "vNext", "--precheck", "--project", "演示", "--wide"],
      cwd: fx.repo,
      env: { ...process.env, ...fx.env, HELIU_NO_SANDBOX: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = r.stdout.toString();
    expect(r.exitCode).toBe(0);
    expect(out).toContain("试合：未完成 · 冲突 0 张 · 未能试合 3 张");
    expect(out).toContain("未能试合（无法建立写保护沙箱");
    // 三张卡的分支行不能出现「试合无冲突」（组说明文字里的「或试合无冲突」不算）
    expect(out).not.toMatch(/claude\/(bold-shaw|conflict|behind)[^\n]*试合无冲突/);
  }, 30_000);
});

describe("HELIU_DEBUG", () => {
  test("HELIU_DEBUG=1 才往 stderr 打点（同步写），否则静默", () => {
    const code = `import { debugLogger } from ${JSON.stringify(join(import.meta.dir, "..", "src", "board", "server.ts"))}; debugLogger()("加载项目…"); debugLogger({})("不该出现");`;
    const on = Bun.spawnSync({ cmd: [process.execPath, "-e", code], env: { ...process.env, HELIU_DEBUG: "1" }, stdout: "pipe", stderr: "pipe" });
    expect(on.stderr.toString()).toMatch(/^\[heliu board \+\d+ms\] 加载项目…\n$/);
    const off = Bun.spawnSync({ cmd: [process.execPath, "-e", code], env: { ...process.env, HELIU_DEBUG: "" }, stdout: "pipe", stderr: "pipe" });
    expect(off.stderr.toString()).toBe("");
  });
});

describe("只读纪律", () => {
  test("全部接口跑完后，被管理仓库整棵目录（含 .git 与各 worktree）stat 完全一致", () => {
    expect(treeSnapshot(fx.repo)).toBe(before);
  });
});
