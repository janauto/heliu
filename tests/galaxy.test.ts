/**
 * M7：星图。
 * - 布局（web/galaxy-model.ts，纯函数）：横轴越新越靠右、已进主线默认隐藏、最新前三名、常显标签互不重叠、拖拽落点判定
 * - 拖拽接口：从分支建卡、重复建卡拒绝、主线不能建卡、绑定分支、排进合并单并入；被管理仓库零写入
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FeaturesData, ReleaseDecisionResult } from "../src/board/api-types.ts";
import { createBoardApp } from "../src/board/server.ts";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths, type HeliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, loadProject, projectFile, stringifyProject, type ProjectConfig } from "../src/core/project.ts";
import type { ReconcileReport } from "../src/types.ts";
import { buildGalaxy, hitConfluence, hitTarget, textWidth, xOfAge, type GBranch } from "../web/galaxy-model.ts";
import { buildStructure, STATES } from "../web/structure-model.ts";
import { B, buildFixture, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let paths: HeliuPaths;
let project: ProjectConfig;
let ledgerDir: string;
let dist: string;
let app: ReturnType<typeof createBoardApp>["app"];
let before: string;
let repoId: string;
let unboundId: string;

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

async function get<T>(path: string): Promise<T> {
  const r = await app.request(path);
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: T }).data;
}
async function post<T>(path: string, body: unknown): Promise<{ status: number; data: T; error?: string }> {
  const r = await app.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json()) as { data: T; error?: string };
  return { status: r.status, data: j.data, error: j.error };
}

beforeAll(async () => {
  fx = buildFixture();
  paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "星图演示", integration: B.integ });
  repoId = reg.repo.id;
  ledgerDir = join(fx.root, "星图台账");
  writeFileSync(projectFile(paths, "星图演示"), stringifyProject("星图演示", reg.project.repos, { ledger: ledgerDir }));
  project = loadProject(paths, "星图演示");
  const L = Ledger.of(project);
  L.addFeature({ title: "已进集成的功能", bindings: [{ repo: repoId, branch: B.inInteg, worktree: null, session: null, pr: null }], status: "开发中" });
  unboundId = L.addFeature({ title: "只是个想法" }).feature.id;
  dist = mkdtempSync(join(tmpdir(), "heliu-dist-"));
  ({ app } = createBoardApp({ paths, project, distDir: dist }));
  before = treeSnapshot(fx.repo);
});
afterAll(() => {
  fx.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

describe("星图布局", () => {
  test("平方根时间轴：今天在最右，越老越靠左，超出范围的压在左端", () => {
    expect(xOfAge(0, 30, 100, 900)).toBe(900);
    expect(xOfAge(30, 30, 100, 900)).toBe(100);
    expect(xOfAge(999, 30, 100, 900)).toBe(100);
    expect(xOfAge(3, 30, 100, 900)).toBeGreaterThan(xOfAge(7, 30, 100, 900));
  });

  test("用真实对账结果建模：已进主线默认隐藏、最新前三、标签不重叠、行星在右侧", async () => {
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const m = buildGalaxy(report, features, { width: 1200, now: Date.now(), showMerged: false, collapsed: new Set(), expanded: new Set(), expandAll: true });
    const branches = m.nodes.filter((n): n is GBranch => n.kind === "branch");
    expect(branches.length).toBeGreaterThan(2);
    expect(branches.some((b) => b.merged === "in_main")).toBe(false);
    expect(branches.every((b) => b.x >= m.xL && b.x <= m.xR)).toBe(true);
    // 已进集成且有卡的分支：卡片灯色
    const integ = branches.find((b) => b.branch === B.inInteg)!;
    expect(integ.card?.title).toBe("已进集成的功能");
    // 没卡的分支是蓝色流浪星
    expect(branches.filter((b) => !b.card).every((b) => b.color === "blue" || b.merged !== "unmerged")).toBe(true);
    // 最新前三：按最后提交倒序
    expect(m.latest.length).toBeLessThanOrEqual(3);
    const times = m.latest.map((k) => Date.parse(branches.find((b) => b.key === k)!.lastAt!));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    // 没绑分支的卡：作为小星点绕在它的行星边上
    expect(m.nodes.some((n) => n.kind === "card" && n.card.id === unboundId)).toBe(true);
    // 行星在时间轴右边
    expect(m.planets.length).toBeGreaterThan(0);
    expect(m.planets.every((p) => p.x > m.xR)).toBe(true);
    // 常显标签两两不重叠（与 placeLabels 同样的近似框）
    const boxes = branches
      .filter((b) => b.labelSide)
      .map((b) => {
        const w = textWidth(b.labelText);
        if (b.labelSide === "r") return [b.x + b.r + 4, b.x + b.r + 6 + w, b.y - 9, b.y + 7];
        if (b.labelSide === "l") return [b.x - b.r - 6 - w, b.x - b.r - 4, b.y - 9, b.y + 7];
        if (b.labelSide === "t") return [b.x - w / 2, b.x + w / 2, b.y - b.r - 20, b.y - b.r - 4];
        return [b.x - w / 2, b.x + w / 2, b.y + b.r + 4, b.y + b.r + 20];
      });
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const [a0, a1, a2, a3] = boxes[i]!;
        const [b0, b1, b2, b3] = boxes[j]!;
        expect(a0! < b1! && b0! < a1! && a2! < b3! && b2! < a3!).toBe(false);
      }
    // 显示已进主线：星点变多
    const m2 = buildGalaxy(report, features, { width: 1200, now: Date.now(), showMerged: true, collapsed: new Set(), expanded: new Set(), expandAll: true });
    expect(m2.nodes.filter((n) => n.kind === "branch").length).toBeGreaterThan(branches.length);
    // 折叠泳道：该仓库不出星点
    const m3 = buildGalaxy(report, features, { width: 1200, now: Date.now(), showMerged: false, collapsed: new Set([repoId]), expanded: new Set(), expandAll: true });
    expect(m3.nodes.filter((n) => n.kind === "branch").length).toBe(0);
  });

  test("拖拽落点：行星 / 合流点 / 小卡星按吸附半径判定，空白处没有目标", async () => {
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const m = buildGalaxy(report, features, { width: 1200, now: Date.now(), showMerged: false, collapsed: new Set(), expanded: new Set(), expandAll: true });
    const star = m.nodes.find((n): n is GBranch => n.kind === "branch" && n.merged === "unmerged")!;
    const planet = m.planets.find((p) => p.droppable)!;
    expect(hitTarget(m, planet.x + 3, planet.y - 3, star)?.kind).toBe("planet");
    const conf = m.confluences[0]!;
    expect(hitTarget(m, conf.x, conf.y, star)?.kind).toBe("confluence");
    const cardStar = m.nodes.find((n) => n.kind === "card")!;
    const t = hitTarget(m, cardStar.x, cardStar.y, star);
    expect(t?.kind === "card" || t?.kind === "planet").toBe(true);
    expect(hitTarget(m, m.xL + 2, 2, star)).toBeNull();
  });
});

describe("M8 星团：按类型分行、默认收起", () => {
  const opts = (expanded: Set<string> = new Set()) => ({ width: 1200, now: Date.now(), showMerged: false, collapsed: new Set<string>(), expanded });

  test("默认每个类型行收成星团：不画分支星点，条数加起来 = 显示范围内的全部分支；行之间不重叠", async () => {
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const m = buildGalaxy(report, features, opts());
    expect(m.nodes.some((n) => n.kind === "branch")).toBe(false);
    expect(m.all.length).toBeGreaterThan(2);
    expect(m.rows.length).toBeGreaterThan(0);
    expect(m.rows.reduce((n, r) => n + r.count, 0)).toBe(m.all.length);
    for (const r of m.rows) {
      expect(r.expanded).toBe(false);
      expect(r.cluster).not.toBeNull();
      expect(r.cluster!.x0).toBeLessThanOrEqual(r.cluster!.x1);
      expect(r.cluster!.x0).toBeGreaterThanOrEqual(m.xL);
      expect(r.cluster!.x1).toBeLessThanOrEqual(m.xR);
      expect(r.cluster!.labelText).toContain(`${r.count} 条`);
      expect(r.members.every((k) => m.all.find((b) => b.key === k)!.row === r.key)).toBe(true);
    }
    const sorted = [...m.rows].sort((a, b) => a.y0 - b.y0);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i]!.y0).toBeGreaterThanOrEqual(sorted[i - 1]!.y1);
    // 每个星团一条汇流线（不再每颗星一条）
    expect(m.flows.length).toBe(m.rows.length);
    // 收起的星团连到行星：合成一条，count = 这一行里预约到该版本的卡星数
    for (const l of m.links) {
      const row = m.rows.find((r) => r.key === l.from)!;
      expect(row).toBeDefined();
      const n = m.all.filter((b) => b.row === row.key && b.card && !b.card.done && b.card.column === l.to).length;
      expect(l.count).toBe(n);
    }
  });

  test("展开一行：只有这一行的分支变成星点，其余仍是星团；全部展开 = M7 的样子", async () => {
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const first = buildGalaxy(report, features, opts()).rows[0]!;
    const m = buildGalaxy(report, features, opts(new Set([first.key])));
    const stars = m.nodes.filter((n): n is GBranch => n.kind === "branch");
    expect(stars.length).toBe(first.count);
    expect(stars.every((b) => b.row === first.key && b.y > m.rows.find((r) => r.key === first.key)!.y0)).toBe(true);
    expect(m.rows.filter((r) => r.key !== first.key).every((r) => r.cluster !== null)).toBe(true);
    const full = buildGalaxy(report, features, { ...opts(), expandAll: true });
    expect(full.nodes.filter((n) => n.kind === "branch").length).toBe(full.all.length);
  });

  test("卡片上写了类型就进那一行（推测不覆盖）；拖到别的类型行头 = 改类型；拖行星只认合流点", async () => {
    const L = Ledger.of(project);
    const f = L.findByBinding(repoId, B.inInteg)!;
    L.classify(f.id, { type: "修复" }, new Date());
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const m = buildGalaxy(report, features, { ...opts(), expandAll: true });
    const star = m.nodes.find((n): n is GBranch => n.kind === "branch" && n.branch === B.inInteg)!;
    expect(star.type).toBe("修复");
    expect(star.row).toBe(`${repoId}|修复`);
    const other = m.rows.find((r) => r.type !== "修复")!;
    expect(hitTarget(m, 40, other.y, star)).toEqual({ kind: "row", row: other });
    const same = m.rows.find((r) => r.key === star.row)!;
    expect(hitTarget(m, 40, same.y, star)).toBeNull();
    const conf = m.confluences[0]!;
    expect(hitConfluence(m, conf.x + 4, conf.y - 4)?.key).toBe(conf.key);
    expect(hitConfluence(m, m.planets[0]!.x, m.planets[0]!.y)).toBeNull();
    L.classify(f.id, { type: null }, new Date());
  });

  test("结构页模型：卡片 + 没卡的未合并分支按模块汇总，矩阵合计 = 总数，该决定的按优先级排", async () => {
    const report = await get<ReconcileReport>("/api/status");
    const features = await get<FeaturesData>("/api/features?precheck=0");
    const s = buildStructure(report, features);
    const cards = features.columns.reduce((n, c) => n + c.cards.length, 0);
    expect(s.total).toBeGreaterThanOrEqual(cards);
    expect(s.modules.reduce((n, m) => n + m.items.length, 0)).toBe(s.total);
    let cells = 0;
    for (const m of s.modules) for (const t of s.types) cells += s.matrix[m.name]?.[t]?.n ?? 0;
    expect(cells).toBe(s.total);
    // 只挑"该决定"的状态；每个模块最多三项，且按优先级
    const order = STATES.map((x) => x.key);
    for (const m of s.modules) {
      expect(m.top.length).toBeLessThanOrEqual(3);
      const idx = m.top.map((i) => order.indexOf(i.state));
      expect([...idx].sort((a, b) => a - b)).toEqual(idx);
      expect(m.top.every((i) => STATES.find((x) => x.key === i.state)!.decide)).toBe(true);
    }
    // 没卡的分支：只算还没进主线的（与星图同口径），带着建卡所需的仓库 / 分支
    for (const it of s.decisions.stray ?? []) {
      expect(it.cardId).toBeNull();
      expect(it.bind).not.toBeNull();
    }
  });
});

describe("星图拖拽接口", () => {
  test("从分支建卡：绑定该分支、预约到指定版本（不存在就新建）；同一分支再建 → 400", async () => {
    const r = await post<{ feature: { id: string; title: string; milestone: string; bindings: Array<{ repo: string; branch: string }> }; milestoneCreated: string | null }>("/api/features", {
      bind: { repo: repoId, branch: B.standalone },
      milestone: "v1.2",
    });
    expect(r.status).toBe(201);
    expect(r.data.feature.milestone).toBe("v1.2");
    expect(r.data.milestoneCreated).toBe("v1.2");
    expect(r.data.feature.bindings[0]!.branch).toBe(B.standalone);
    expect(r.data.feature.title.length).toBeGreaterThan(0);
    const again = await post<unknown>("/api/features", { bind: { repo: repoId, branch: B.standalone } });
    expect(again.status).toBe(400);
    expect(again.error).toContain("已经有卡");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("主线 / 集成分支 / 不存在的分支不能建卡", async () => {
    for (const branch of [B.main, B.integ, "没有这个分支"]) {
      const r = await post<unknown>("/api/features", { bind: { repo: repoId, branch } });
      expect(r.status).toBe(400);
    }
  });

  test("把分支绑到一张还没分支的卡；已被别的卡占用的分支 → 400", async () => {
    const ok = await post<{ feature: { bindings: Array<{ branch: string }>; status: string } }>(`/api/features/${unboundId}/bind`, { repo: repoId, branch: B.behind });
    expect(ok.status).toBe(200);
    expect(ok.data.feature.bindings.map((b) => b.branch)).toContain(B.behind);
    expect(ok.data.feature.status).toBe("开发中");
    const taken = await post<unknown>(`/api/features/${unboundId}/bind`, { repo: repoId, branch: B.standalone });
    expect(taken.status).toBe(400);
    expect(taken.error).toContain("已经绑在");
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("拖到合流点：排进合并单、决定 = 并入，返回试合结果；只写台账里的合并单", async () => {
    const id = Ledger.of(project).findByBinding(repoId, B.standalone)!.id;
    const r = await post<ReleaseDecisionResult>("/api/release/decision", { feature: id });
    expect(r.status).toBe(200);
    expect(r.data.milestone).toBe("v1.2");
    expect(r.data.items.length).toBeGreaterThan(0);
    expect(r.data.items.every((i) => i.decision === "并入")).toBe(true);
    // 接口自己说清楚：没有执行合并，真正合并的终端命令是什么
    expect(r.data.executed).toBe(false);
    expect(r.data.message).toContain("没有执行 git 合并");
    expect(r.data.command).toContain("bin/heliu\" 合并 v1.2 --project 星图演示");
    expect(r.data.file.startsWith(ledgerDir)).toBe(true);
    expect(existsSync(r.data.file)).toBe(true);
    expect(treeSnapshot(fx.repo)).toBe(before);
  });

  test("没预约的卡拖到合流点：先预约到下一版再排进合并单", async () => {
    const L = Ledger.of(project);
    const f = L.addFeature({ title: "冲突分支", milestone: null, bindings: [{ repo: repoId, branch: B.conflict, worktree: null, session: null, pr: null }], status: "待合并" }).feature;
    const r = await post<ReleaseDecisionResult>("/api/release/decision", { feature: f.id });
    expect(r.status).toBe(200);
    expect(r.data.reservedTo).not.toBeNull();
    expect(Ledger.of(project).getFeature(f.id).milestone).not.toBeNull();
    expect(treeSnapshot(fx.repo)).toBe(before);
  });
});
