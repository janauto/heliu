/**
 * M9：会话入口 · 跨仓配对 · 三仓名实相符
 * - 提取器：路径边界（esp_claw 不误中 esp_claw-aios）、~/ 写法、写入 / 提交 / 查看分类、只存次数
 * - 增量：文件没变跳过、变了重提、目标集合变了重提、--重新分析 全量
 * - 建议分档：强 / 中 / 弱；仓库主目录只算弱；已绑别的卡只提示（弱的不提示）；fork 跟原会话的卡；开在集成分支上的会话不出建议；
 *   在集成分支 worktree 里改动 → 事实说明；很多会话都指向同一条分支 → 降为中档
 * - 写入：绑到已有卡 / 建卡同时绑两仓 / 已绑别的卡跳过
 * - 会话入口：/api/status 的 sessionEntry（尚无提交 = 是；有过提交已合入 = 否；独立未合并 = 否）
 * - 星图 / 结构页同口径：入口不算「还没建卡」，在等你的入口算「等你回答」，入口行不随「显示已进主线」隐藏
 * - 改名：只替换 project.yaml 那一行 label，注释保留；找不到就报错
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoardCard, FeaturesData, PairingsData } from "../src/board/api-types.ts";
import { createBoardApp } from "../src/board/server.ts";
import { Ledger } from "../src/core/ledger.ts";
import { analyzeTranscripts, applyPairings, loadEvidence, selectPairings, suggestPairings, type PairInput } from "../src/core/pairing.ts";
import { heliuPaths, type HeliuPaths } from "../src/core/paths.ts";
import { addRepoToProject, loadProject, projectFile, setRepoLabel, stringifyProject, type ProjectConfig } from "../src/core/project.ts";
import { buildMatcher, extractEvidence, indexTranscripts, matchSuffix } from "../src/core/transcripts.ts";
import { whereamiContext } from "../src/core/whereami.ts";
import type { FeatureView, LedgerFeature, ReconcileReport, SessionView, WhereAmI } from "../src/types.ts";
import { buildGalaxy, hitTarget, matesOf } from "../web/galaxy-model.ts";
import { buildStructure } from "../web/structure-model.ts";
import { B, buildFixture, type Fixture } from "./helpers/fixture.ts";

const H = "/Users/tester";
const FW = `${H}/.cache/web/esp_claw`;

/* ───────────── 伪造的两仓对账结果（只给配对用到的字段） ───────────── */

function fv(branch: string, role: FeatureView["role"], mergedState: FeatureView["mergedState"] = "unmerged", extra: Partial<FeatureView> = {}): FeatureView {
  return { branch, ref: `refs/heads/${branch}`, sha: branch, role, mergedState, label: branch, labelSource: "branch", randomName: false, lastCommitAt: "2026-10-20T00:00:00Z", lastCommitSubject: "", vsMain: null, vsIntegration: null, upstream: null, pushed: false, worktree: null, sessions: [], precheck: null, ...extra } as FeatureView;
}
function wt(path: string, branch: string | null, isMain = false) {
  return { path, dirName: path.split("/").pop()!, branch, head: null, isMain, detached: branch === null, locked: false, prunable: false, managedByDesktop: false, leasedBy: null, dirty: "unknown", dirtyCount: null };
}
function fakeReport(): ReconcileReport {
  return {
    repos: [
      {
        id: "docs",
        label: "文档仓",
        reachable: true,
        path: `${H}/docs`,
        main: "main",
        integration: "integ",
        worktrees: [wt(`${H}/docs`, "main", true), ...["a", "b", "c", "d", "e"].map((n) => wt(`${H}/docs/.claude/worktrees/${n}`, `claude/${n}`))],
        branches: [fv("main", "main"), fv("integ", "integration"), ...["a", "b", "c", "d", "e"].map((n) => fv(`claude/${n}`, "feature", "in_main", { sessionEntry: true }))],
      },
      {
        id: "fw",
        label: "固件仓",
        reachable: true,
        path: FW,
        main: "release",
        integration: "feat/entry",
        worktrees: [wt(FW, "feat/x", true), wt(`${FW}-aios`, "feat/aios"), wt(`${FW}-entry`, "feat/entry"), wt(`${FW}-old`, null), wt(`${FW}-shared`, "release/1.0"), wt(`${FW}-read`, "feat/read")],
        branches: [fv("release", "main"), fv("feat/entry", "integration"), fv("feat/x", "feature"), fv("feat/aios", "feature"), fv("release/1.0", "feature"), fv("feat/read", "feature")],
      },
    ],
  } as unknown as ReconcileReport;
}
function sess(id: string, branch: string, extra: Partial<SessionView> = {}): SessionView {
  return { sessionId: id, cliSessionId: `cli-${id}`, title: `会话 ${id}`, repo: "docs", branch, worktreeName: null, worktreePath: null, cwd: null, status: "online", statusCategory: null, statusDetail: null, needsAction: null, isArchived: false, running: null, createdAt: null, lastActivityAt: "2026-10-28T00:00:00Z", completedTurns: null, model: null, spawnedFrom: null, prs: [], ...extra } as SessionView;
}
function card(id: string, bindings: Array<{ repo: string; branch: string; session?: string | null }>): LedgerFeature {
  return { id, title: `卡 ${id}`, status: "开发中", bindings: bindings.map((b) => ({ repo: b.repo, branch: b.branch, worktree: null, session: b.session ?? null, pr: null })) } as unknown as LedgerFeature;
}
const ev = (cli: string, worktree: string, reads: number, writes = 0, commits = 0) => ({ cliSessionId: `cli-${cli}`, worktree, reads, writes, commits, lastSeenAt: "2026-10-25T10:00:00Z" });

describe("对话记录提取", () => {
  const m = buildMatcher([FW, `${FW}-aios`, `${FW}-entry`], H)!;
  test("路径边界：esp_claw 不误中 esp_claw-aios；~/ 写法也认；家目录之后那一段做匹配", () => {
    expect(matchSuffix(`${FW}-aios`, H)).toBe("/.cache/web/esp_claw-aios");
    const text = [
      JSON.stringify({ timestamp: "2026-10-25T09:00:00Z", message: { content: [{ type: "tool_result", content: `ls ${FW}-aios/src ${FW}/README.md` }] } }),
      JSON.stringify({ timestamp: "2026-10-25T09:05:00Z", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "cd ~/.cache/web/esp_claw-aios && git add -A && git commit -m 修" } }] } }),
      JSON.stringify({ timestamp: "2026-10-25T09:06:00Z", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: `${FW}-aios/src/a.c`, old_string: "x", new_string: "y" } }] } }),
      JSON.stringify({ timestamp: "2026-10-25T09:07:00Z", message: { content: [{ type: "text", text: "和固件无关的一行" }] } }),
      "这一行不是 JSON 但提到 $HOME/.cache/web/esp_claw-entry/x",
    ].join("\n");
    const rows = new Map(extractEvidence(text, m).map((r) => [r.worktree, r]));
    expect(rows.get(`${FW}-aios`)).toEqual({ worktree: `${FW}-aios`, reads: 1, writes: 1, commits: 1, lastSeenAt: "2026-10-25T09:06:00Z" });
    expect(rows.get(FW)).toMatchObject({ reads: 1, writes: 0, commits: 0 });
    expect(rows.get(`${FW}-entry`)).toMatchObject({ reads: 1, lastSeenAt: null });
    // 只有路径、次数、时间：没有任何对话文字
    expect(JSON.stringify([...rows.values()])).not.toContain("修");
  });

  test("增量：没变跳过；追加内容重提；目标集合变了重提；强制全量；缓存可读回", async () => {
    const root = mkdtempSync(join(tmpdir(), "heliu-transcripts-"));
    const home = mkdtempSync(join(tmpdir(), "heliu-home-"));
    try {
      mkdirSync(join(root, "-docs-a"));
      const file = join(root, "-docs-a", "cli-s1.jsonl");
      writeFileSync(file, `${JSON.stringify({ timestamp: "2026-10-25T09:00:00Z", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: `${FW}-aios/b.c`, content: "x" } }] } })}\n`);
      expect(indexTranscripts(root).get("cli-s1")).toBe(file);
      const paths: HeliuPaths = heliuPaths({ HELIU_HOME: home });
      const report = fakeReport();
      const sessions = [sess("s1", "claude/a")];
      const a1 = await analyzeTranscripts(paths, "演示", report, sessions, { root, home: H });
      expect([a1.extracted, a1.skipped]).toEqual([1, 0]);
      const a2 = await analyzeTranscripts(paths, "演示", report, sessions, { root, home: H });
      expect([a2.extracted, a2.skipped]).toEqual([0, 1]);
      appendFileSync(file, `${JSON.stringify({ message: { content: [{ type: "text", text: `${FW}-aios` }] } })}\n`);
      expect((await analyzeTranscripts(paths, "演示", report, sessions, { root, home: H })).extracted).toBe(1);
      (report.repos[1]!.worktrees as unknown[]).push(wt(`${FW}-new`, "feat/new"));
      expect((await analyzeTranscripts(paths, "演示", report, sessions, { root, home: H })).extracted).toBe(1);
      expect((await analyzeTranscripts(paths, "演示", report, sessions, { root, home: H, force: true })).extracted).toBe(1);
      const ev1 = loadEvidence(paths, "演示");
      expect(ev1.analyzedAt).not.toBeNull();
      expect(ev1.rows.find((r) => r.worktree === `${FW}-aios`)).toMatchObject({ writes: 1, reads: 1 });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("配对建议", () => {
  const base = (over: Partial<PairInput> = {}): PairInput => ({
    report: fakeReport(),
    sessions: [sess("s1", "claude/a"), sess("s2", "claude/b"), sess("s3", "claude/c", { spawnedFrom: { sessionId: "s1", title: null } }), sess("s4", "integ"), sess("s5", "claude/d")],
    features: [card("F-0001", [{ repo: "docs", branch: "claude/a", session: "s1" }]), card("F-0009", [{ repo: "fw", branch: "feat/read" }])],
    evidence: [
      ev("s1", `${FW}-aios`, 600, 90, 9), // 强：写入 + 提交，分支有自己的提交
      ev("s1", FW, 50, 3, 1), // 仓库主目录：只算弱
      ev("s2", `${FW}-read`, 40), // 已绑在 F-0009，且只读：中档 → 提示
      ev("s2", `${FW}-aios`, 2), // 弱
      ev("s3", `${FW}-aios`, 120, 5), // fork：跟原会话 s1 的卡
      ev("s4", `${FW}-aios`, 999, 50, 9), // 开在集成分支上的会话：不出建议
      ev("s5", `${FW}-entry`, 300, 20, 4), // 在集成分支 worktree 里改：事实说明
      ev("s5", `${FW}-old`, 80, 2), // 分离 HEAD：事实说明
    ],
    hasOwnCommits: () => true,
    ...over,
  });

  test("分档、目标卡、fork、跳过集成会话、事实说明", () => {
    const r = suggestPairings(base());
    const g1 = r.groups.find((g) => g.sessionId === "s1")!;
    expect(g1.card?.id).toBe("F-0001");
    const aios = g1.items.find((i) => i.branch === "feat/aios")!;
    expect(aios.tier).toBe("strong");
    expect(aios.checked).toBe(true);
    expect(aios.target).toEqual({ kind: "card", id: "F-0001", title: "卡 F-0001" });
    expect(aios.evidence).toContain("esp_claw-aios：出现 699 次");
    expect(aios.evidence).toContain("改文件 90 次");
    expect(g1.items.find((i) => i.branch === "feat/x")!.tier).toBe("weak"); // 主目录
    const g2 = r.groups.find((g) => g.sessionId === "s2")!;
    expect(g2.items.map((i) => [i.branch, i.tier, i.target.kind])).toEqual([
      ["feat/read", "medium", "other"],
      ["feat/aios", "weak", "new"],
    ]);
    expect(g2.items[0]!.checked).toBe(false);
    expect(r.groups.find((g) => g.sessionId === "s3")!.card?.id).toBe("F-0001"); // fork 跟原会话
    expect(r.groups.some((g) => g.sessionId === "s4")).toBe(false);
    expect(r.notes.map((n) => n.sessionId).sort()).toEqual(["s5", "s5"]);
    expect(r.notes.find((n) => n.text.includes("集成分支 feat/entry"))).toBeDefined();
    expect(r.notes.find((n) => n.text.includes("分离 HEAD"))).toBeDefined();
    expect(r.counts.other).toBe(1);
  });

  test("已绑在别的卡上、证据又弱：不打扰；已经配好的计入 paired", () => {
    const r = suggestPairings(base({ evidence: [ev("s2", `${FW}-read`, 3)], features: [card("F-0009", [{ repo: "fw", branch: "feat/read" }]), card("F-0002", [{ repo: "docs", branch: "claude/b" }, { repo: "fw", branch: "feat/aios" }])] }));
    expect(r.groups).toEqual([]);
    const r2 = suggestPairings(base({ evidence: [ev("s2", `${FW}-aios`, 30, 2)], features: [card("F-0002", [{ repo: "docs", branch: "claude/b" }, { repo: "fw", branch: "feat/aios" }])] }));
    expect(r2.counts.paired).toBe(1);
    expect(r2.groups).toEqual([]);
  });

  test("分支没有自己的提交：有写入也只算中档；很多会话都指向同一条分支：降为中档", () => {
    const r = suggestPairings(base({ hasOwnCommits: (_repo, b) => b !== "feat/aios", evidence: [ev("s1", `${FW}-aios`, 100, 5)] }));
    expect(r.groups[0]!.items[0]!.tier).toBe("medium");
    const sessions = ["a", "b", "c"].map((n, i) => sess(`m${i}`, `claude/${n}`));
    const r2 = suggestPairings(base({ sessions, features: [], evidence: sessions.map((s) => ({ ...ev(s.sessionId, `${FW}-shared`, 100, 5, 2), cliSessionId: s.cliSessionId! })) }));
    for (const g of r2.groups) {
      expect(g.items[0]!.tier).toBe("medium");
      expect(g.items[0]!.evidence).toContain("可能是发布 / 共用分支");
    }
  });

  test("写入：绑到已有卡；没卡的会话建卡并同时绑两仓；已绑别的卡跳过；all = 全部强档", () => {
    const dir = mkdtempSync(join(tmpdir(), "heliu-pair-ledger-"));
    try {
      const ledger = Ledger.of({ name: "演示", source: "x", repos: [], ledger: dir } as unknown as ProjectConfig);
      ledger.init();
      const f1 = ledger.addFeature({ title: "卡一", bindings: [{ repo: "docs", branch: "claude/a", worktree: null, session: "s1", pr: null }] }).feature;
      ledger.addFeature({ title: "固件卡", bindings: [{ repo: "fw", branch: "feat/read", worktree: null, session: null, pr: null }] });
      const input = base({ features: ledger.load().features, sessions: [sess("s1", "claude/a"), sess("s2", "claude/b")], evidence: [ev("s1", `${FW}-aios`, 100, 5, 1), ev("s2", `${FW}-shared`, 100, 5, 1), ev("s2", `${FW}-read`, 50, 1)] });
      const rep = suggestPairings(input);
      const { chosen, unknown } = selectPairings(rep, ["all", "#99"]);
      expect(chosen.map((c) => c.branch).sort()).toEqual(["feat/aios", "release/1.0"]);
      expect(unknown).toEqual(["#99"]);
      const other = rep.groups.flatMap((g) => g.items).find((i) => i.target.kind === "other")!;
      const r = applyPairings(ledger, rep, input.report, [...chosen, other], { source: "cli" });
      expect(r.bound.find((b) => b.branch === "feat/aios")?.card).toBe(f1.id);
      expect(r.created).toHaveLength(1);
      expect(r.created[0]!.branches).toEqual(["docs/claude/b", "fw/release/1.0"]);
      expect(r.skipped.map((s) => s.key)).toEqual([other.key]);
      expect(ledger.getFeature(f1.id).bindings.map((b) => `${b.repo}/${b.branch}`)).toEqual(["docs/claude/a", "fw/feat/aios"]);
      expect(ledger.findByBinding("fw", "feat/aios")?.bindings.find((b) => b.repo === "fw")?.session).toBe("s1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ───────────── 看板：会话入口与各页同口径 ───────────── */

let fx: Fixture;
let paths: HeliuPaths;
let project: ProjectConfig;
let app: ReturnType<typeof createBoardApp>["app"];
let dist: string;
let repoId: string;

beforeAll(async () => {
  fx = buildFixture();
  paths = heliuPaths({ ...process.env, ...fx.env });
  const reg = await addRepoToProject(paths, { path: fx.repo, name: "入口演示", integration: B.integ });
  repoId = reg.repo.id;
  writeFileSync(projectFile(paths, "入口演示"), stringifyProject("入口演示", reg.project.repos, { ledger: join(fx.root, "入口台账") }));
  project = loadProject(paths, "入口演示");
  Ledger.of(project).addFeature({ title: "已进主线的修复", bindings: [{ repo: repoId, branch: B.mergedMain, worktree: null, session: null, pr: null }] });
  process.env.HELIU_TRANSCRIPTS_DIR = join(fx.root, "没有对话记录");
  dist = mkdtempSync(join(tmpdir(), "heliu-dist-"));
  ({ app } = createBoardApp({ paths, project, distDir: dist }));
});
afterAll(() => {
  delete process.env.HELIU_TRANSCRIPTS_DIR;
  fx.cleanup();
  rmSync(dist, { recursive: true, force: true });
});

async function get<T>(url: string): Promise<T> {
  const r = await app.request(url);
  return ((await r.json()) as { data: T }).data;
}

describe("会话入口（看板）", () => {
  test("/api/status：尚无提交 = 会话入口；有过提交已合入 / 独立未合并 = 不是", async () => {
    const st = await get<ReconcileReport>("/api/status");
    const b = (name: string) => st.repos[0]!.branches.find((x) => x.branch === name)!;
    expect(b(B.atTip).sessionEntry).toBe(true);
    expect(b(B.mergedMain).sessionEntry).toBe(false);
    expect(b(B.standalone).sessionEntry).toBe(false);
    const fe = await get<FeaturesData>("/api/features");
    const c = fe.columns.flatMap((x) => x.cards).find((x) => x.title === "已进主线的修复")!;
    expect(c.bindings[0]!.sessionEntry).toBe(false);
  }, 60_000);

  test("星图：入口进「会话入口」行、不随「显示已进主线」隐藏、不算没卡、不接改类型；结构页同口径", async () => {
    const st = await get<ReconcileReport>("/api/status");
    const fe = await get<FeaturesData>("/api/features");
    const m = buildGalaxy(st, fe, { width: 1400, now: Date.parse("2026-10-28T00:00:00Z"), showMerged: false, collapsed: new Set(), expanded: new Set(), expandAll: true });
    const entry = m.all.find((n) => n.branch === B.atTip)!;
    expect(entry.entry).toBe(true);
    expect(entry.row).toBe(`${repoId}|会话入口`);
    const row = m.rows.find((r) => r.key === entry.row)!;
    expect(row.entry).toBe(true);
    expect(m.counts.unbound).toBe(m.all.filter((n) => !n.card && !n.entry).length);
    expect(m.counts.entries).toBeGreaterThan(0);
    expect(m.lanes[0]!.entries).toBe(m.counts.entries);
    expect(hitTarget(m, 30, row.y, m.all.find((n) => !n.entry)!)).toBeNull();
    const s = buildStructure(st, fe);
    expect(s.decisions.stray?.some((i) => i.key === entry.key) ?? false).toBe(false);
    expect(s.entries[0]!.count).toBe(m.counts.entries);
  }, 60_000);

  test("还没分析过对话记录：/api/pairings 给出隐私说明，report 为空；分析完成后有分析时间", async () => {
    const before = await get<PairingsData>("/api/pairings");
    expect(before.analyzedAt).toBeNull();
    expect(before.report).toBeNull();
    expect(before.privacy.join("")).toContain("不存对话文字");
    await app.request("/api/pairings/analyze", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
    let after = await get<PairingsData>("/api/pairings");
    for (let i = 0; i < 50 && after.job?.running; i++) {
      await Bun.sleep(100);
      after = await get<PairingsData>("/api/pairings");
    }
    expect(after.job?.error ?? null).toBeNull();
    expect(after.analyzedAt).not.toBeNull();
    expect(after.report?.groups).toEqual([]);
  }, 60_000);
});

describe("同卡高亮与入口时间", () => {
  test("matesOf：同一张卡在别处的星", () => {
    const report = fakeReport();
    (report.repos[1]!.branches.find((b) => b.branch === "feat/aios") as FeatureView).sessionEntry = false;
    const c = { id: "F-0001", title: "卡", done: false, light: "purple", column: "x", needsAction: "等你", type: "功能", bindings: [
      { repo: "docs", branch: "claude/a", exists: true, sessionEntry: true, repoLabel: "文档仓", session: { title: "会话 s1" } },
      { repo: "fw", branch: "feat/aios", exists: true, sessionEntry: false, repoLabel: "固件仓", session: null },
    ] } as unknown as BoardCard;
    const fe = { columns: [{ key: "x", kind: "milestone", title: "x", cards: [c], owed: 1, waiting: 1, conflict: 0, droppable: true, isNext: true }] } as unknown as FeaturesData;
    const m = buildGalaxy(report, fe, { width: 1400, now: Date.parse("2026-10-28T00:00:00Z"), showMerged: false, collapsed: new Set(), expanded: new Set(), expandAll: true });
    const fwStar = m.all.find((n) => n.branch === "feat/aios")!;
    expect(fwStar.color).toBe("purple");
    expect(fwStar.sessionTitle).toBe("会话 s1"); // 固件星自己没有会话：用同卡入口上的会话（知道去哪回答）
    expect(fwStar.mates).toEqual(["文档仓 claude/a · 会话入口"]);
    expect(matesOf(m, fwStar.key).map((n) => n.branch)).toEqual(["claude/a"]);
    expect(m.rows.find((r) => r.entry)!.paired).toBe(1);
  });
});

describe("改名与提示", () => {
  test("只替换那一行 label，注释保留；读回来的名字正确；找不到报错", () => {
    const home = mkdtempSync(join(tmpdir(), "heliu-label-"));
    try {
      const p = heliuPaths({ HELIU_HOME: home });
      mkdirSync(join(p.projectsDir, "演示"), { recursive: true });
      const yaml = "# 手写注释\nname: 演示\nrepos:\n  - id: docs\n    label: 文档仓 # 原名\n    path: /tmp/docs\n    main: main\n  - id: fw\n    label: 固件仓\n    path: /tmp/fw\n    main: main\n";
      writeFileSync(projectFile(p, "演示"), yaml);
      const r = setRepoLabel(p, "演示", "docs", "总仓（会话入口 + 文档）");
      expect(r).toMatchObject({ from: "文档仓", to: "总仓（会话入口 + 文档）" });
      const after = readFileSync(projectFile(p, "演示"), "utf8");
      expect(after).toBe(yaml.replace("label: 文档仓 # 原名", "label: 总仓（会话入口 + 文档） # 原名"));
      expect(loadProject(p, "演示").repos.map((x) => x.label)).toEqual(["总仓（会话入口 + 文档）", "固件仓"]);
      setRepoLabel(p, "演示", "fw", "固件: 主力");
      expect(loadProject(p, "演示").repos[1]!.label).toBe("固件: 主力");
      expect(() => setRepoLabel(p, "演示", "app", "x")).toThrow("没找到仓库 app");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("【合流】提示提醒把别的仓库的分支绑回同一张卡", () => {
    const w = { cwd: "/x", project: { name: "p", source: "s" }, repo: { id: "docs", label: "文档仓" }, worktree: "/x", isMainCheckout: false, branch: "claude/a", detached: false, role: "feature", feature: null, milestone: null, behindMain: null, behindIntegration: null, session: null, ledgerDir: null, notes: [], elapsedMs: 1 } as unknown as WhereAmI;
    expect(whereamiContext(w)).toContain("heliu_feature_bind（cwd 传那个 worktree）绑到同一张卡");
  });
});
