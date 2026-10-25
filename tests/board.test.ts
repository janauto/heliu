/**
 * M3 看板 API：用 Hono 的 app.request() 直接打 fixture 项目（不监听端口）。
 * 覆盖：status 缓存 / todo 分组 / features 列与卡片（灯色、下一步、多标签、已合入待确认）/ 新点子 /
 * PATCH 改预约（断言台账文件变化）/ 合并预演顺序 / 合并单草稿写入 / 同步基线预演 / 卫生建议命令 /
 * 安全（Host、Content-Type）/ 前端打包与首页 / 被管理仓库零写入（整棵目录 stat 快照）。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import type { BaselineData, BoardCard, FeaturesData, HygieneData, OverviewData, ReleasePlanResult, ReleasePreview } from "../src/board/api-types.ts";
import { ensureWebBuild } from "../src/board/build.ts";
import { createBoardApp } from "../src/board/server.ts";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, loadProject, projectFile, stringifyProject } from "../src/core/project.ts";
import type { ReconcileReport, TodoReport } from "../src/types.ts";
import { B, buildFixture, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let ledgerDir: string;
let dist: string;
let app: ReturnType<typeof createBoardApp>["app"];
let before: string;

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
  const paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "演示", integration: "integ" });
  // 台账放在仓库外（真实项目也是这样配置），这样「被管理仓库零写入」可以对整棵目录做快照
  ledgerDir = join(fx.root, "台账 目录");
  writeFileSync(projectFile(paths, "演示"), stringifyProject("演示", reg.project.repos, { ledger: ledgerDir }));
  const project = loadProject(paths, "演示");
  const L = Ledger.of(project);
  const bind = (branch: string) => [{ repo: reg.repo.id, branch, worktree: null, session: null, pr: null }];
  L.addFeature({ title: "已进集成的功能", bindings: bind(B.inInteg), status: "开发中" }); // F-0001
  L.addFeature({ title: "EPP 网关", bindings: bind(B.standalone), status: "待合并" }); // F-0002
  L.addFeature({ title: "冲突地改 README", bindings: bind(B.conflict) }); // F-0003
  L.addFeature({ title: "只是个想法" }); // F-0004
  L.addFeature({ title: "老分支调研", bindings: bind(B.behind) }); // F-0005
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
    expect([v.owed, v.mergeable, v.conflict, v.waiting]).toEqual([5, 3, 1, 0]);
    // 组名来自 M2 分组函数
    expect(d.groups.map((g) => g.title)).toContain("尚未关联开发分支");
    const f1 = card(d, "F-0001");
    expect(f1.light).toBe("green");
    expect(f1.variant).toBe("merged-pending");
    expect(f1.suggestStatus).toBe("已合入");
    expect(f1.nextStep).toContain("已合入 · 待确认台账");
    const f2 = card(d, "F-0002");
    expect(f2.variant).toBe("normal");
    expect(f2.nextStep).toBe("可合并：试合到 integ 无冲突，合并时可直接合入");
    const f3 = card(d, "F-0003");
    expect(f3.light).toBe("red");
    expect(f3.lightText).toBe("有冲突 · 1 个文件");
    expect(f3.nextStep).toContain("需解冲突");
    // 主分组已由灯色表达，次要标签只列另外成立的事实
    expect(f3.tags.map((t) => t.kind)).not.toContain("conflict");
    expect(f3.bindings[0]!.conflicts).toEqual(["README.md"]);
    const f5 = card(d, "F-0005");
    expect(f5.light).toBe("green");
    expect(f5.tags.find((t) => t.kind === "behind")?.text).toMatch(/^落后 ↓\d+$/);
    expect(card(d, "F-0004").nextStep).toBe("尚未关联开发分支");
    // 不试合时冲突「未检查」
    const plain = await get<FeaturesData>("/api/features?precheck=0");
    expect(plain.body.data.columns[0]!.conflict).toBeNull();
    expect(plain.body.data.precheck).toBe(false);
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

describe("合并预演与合并单草稿", () => {
  test("preview 顺序：已进集成 → 无冲突 → 有冲突 → 未完成", async () => {
    const r = await get<ReleasePreview>("/api/release/preview?milestone=vNext");
    expect(r.status).toBe(200);
    const items = r.body.data.items;
    const rank = { in_integration: 0, clean: 1, conflict: 2, unfinished: 3 } as const;
    for (let i = 1; i < items.length; i++) expect(rank[items[i]!.tier]).toBeGreaterThanOrEqual(rank[items[i - 1]!.tier]);
    expect(items.map((x) => x.order)).toEqual(items.map((_, i) => i + 1));
    const tierOf = (id: string) => items.find((x) => x.id === id)!.tier;
    expect(tierOf("F-0001")).toBe("in_integration");
    expect(tierOf("F-0002")).toBe("clean");
    expect(tierOf("F-0003")).toBe("conflict");
    expect(tierOf("F-0004")).toBe("unfinished");
    expect(items.find((x) => x.id === "F-0003")!.actionText).toBe("需解冲突");
    expect(r.body.data.deferred).toContain("F-0004");
    expect(r.body.data.repos[0]!.integrationSha).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);

  test("plan：写 releases/vNext.md（frontmatter + 人读表，未执行合并）；再写一次备份旧稿", async () => {
    const r = await send<ReleasePlanResult>("POST", "/api/release/plan", { milestone: "vNext" });
    expect(r.status).toBe(201);
    expect(r.body.data.file).toBe(join(ledgerDir, "releases", "vNext.md"));
    const text = readFileSync(r.body.data.file, "utf8");
    expect(text).toContain("仅预演，未执行任何合并");
    const fm = YAML.parse(text.split("\n---\n")[0]!.replace(/^---\n/, "")) as { status: string; items: Array<{ feature: string; decision: string; tier: string }>; repos: Array<{ integration_sha: string }> };
    expect(fm.status).toBe("草稿");
    expect(fm.items[0]!.tier).toBe("in_integration");
    expect(fm.items.find((x) => x.feature === "F-0002")!.decision).toBe("并入"); // 无冲突 + 台账待合并
    expect(fm.items.find((x) => x.feature === "F-0003")!.decision).toBe("待定");
    expect(fm.items.find((x) => x.feature === "F-0004")!.decision).toBe("顺延");
    expect(fm.repos[0]!.integration_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(text).not.toMatch(/^- \[ \]/m); // 不写 Obsidian 复选框
    const again = await send<ReleasePlanResult>("POST", "/api/release/plan", { milestone: "vNext" });
    expect(again.body.data.backup).not.toBeNull();
    expect(existsSync(again.body.data.backup!)).toBe(true);
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

describe("只读纪律", () => {
  test("全部接口跑完后，被管理仓库整棵目录（含 .git 与各 worktree）stat 完全一致", () => {
    expect(treeSnapshot(fx.repo)).toBe(before);
  });
});
