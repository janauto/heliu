/**
 * milestone.todo 分组优先级：等你回答 > 有冲突（仅 --precheck）> 可合并 > 落后需同步 > 停滞 > 开发中 > 尚未关联开发分支。
 * 用手工构造的对账结果，逐条钉住「同时满足多个条件时进哪一组」；
 * 另有 Codex 第 1 轮反馈的回归：零提交分支不能被当成「已进主线」，台账状态决定是否计入待办。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTodo } from "../src/cli/render-ledger.ts";
import { bindingKey } from "../src/core/owncommits.ts";
import { countsTowardTodo, groupTodo, TODO_GROUP_DEFS } from "../src/core/todo.ts";
import { buildFixture, gitW, type Fixture } from "./helpers/fixture.ts";
import type { FeatureView, LedgerFeature, LedgerMilestone, PrecheckResult, ReconcileReport, RepoReport, SessionRef, SessionView, TodoGroupKey } from "../src/types.ts";

const NOW = new Date("2026-10-26T12:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const MS: LedgerMilestone = { id: "v1.2", title: "收口", status: "规划中", target_date: null, integration_branch: null, notes: "" };

function fv(branch: string, p: Partial<FeatureView> = {}): FeatureView {
  return {
    branch,
    ref: `refs/heads/${branch}`,
    sha: "0".repeat(40),
    role: "feature",
    mergedState: "unmerged",
    label: branch,
    labelSource: "branch_name",
    randomName: false,
    lastCommitAt: daysAgo(1),
    lastCommitSubject: "x",
    vsMain: { ahead: 1, behind: 0 },
    vsIntegration: { ahead: 1, behind: 0 },
    upstream: null,
    pushed: false,
    worktree: null,
    sessions: [],
    precheck: null,
    ...p,
  };
}
const pc = (conflictFiles: number): PrecheckResult => ({ target: "integ", conflictFiles, conflicts: [], contentEquivalent: false, timedOut: false, error: null });
const sref = (id: string, status: SessionRef["status"], needs: string | null, at = daysAgo(0)): SessionRef => ({
  sessionId: id,
  title: id,
  status,
  statusCategory: status === "blocked" ? "blocked" : null,
  needsAction: needs,
  isArchived: false,
  lastActivityAt: at,
  link: "branch",
  prs: [],
});

function repo(id: string, integration: string | null, branches: FeatureView[]): RepoReport {
  return {
    id,
    label: id === "docs" ? "文档仓" : "App 仓",
    path: `/tmp/${id}`,
    icloud: false,
    main: "main",
    integration,
    remote: null,
    reachable: true,
    error: null,
    warnings: [],
    counts: null,
    health: null,
    branches,
    worktrees: [],
    hygiene: [],
    elapsedMs: 0,
    gitCalls: 0,
    gitTimeouts: 0,
  };
}

function report(precheck: boolean, docs: FeatureView[], app: FeatureView[] = []): ReconcileReport {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    elapsedMs: 1,
    project: { name: "演示", source: "(内存)" },
    options: { precheck, dirty: false, timeoutMs: 8000 },
    repos: [repo("docs", "integ", docs), repo("app", null, app)],
    sessions: { total: 0, parseErrors: 0 },
  };
}

let n = 0;
function card(title: string, bindings: Array<[string, string]>, p: Partial<LedgerFeature> = {}): LedgerFeature {
  n++;
  const id = `F-${String(n).padStart(4, "0")}`;
  return {
    id,
    title,
    status: bindings.length ? "开发中" : "想法",
    milestone: "v1.2",
    acceptance: "未",
    type: null,
    module: null,
    bindings: bindings.map(([r, b]) => ({ repo: r, branch: b, worktree: null, session: null, pr: null })),
    rolled_from: [],
    source: "cli",
    created: "2026-10-01",
    updated: "2026-10-01",
    body: "",
    file: `/x/${id}.md`,
    ...p,
  };
}

const sv = (id: string, statusDetail: string | null): SessionView => ({
  sessionId: id, cliSessionId: null, title: id, repo: "docs", branch: null, worktreeName: null, worktreePath: null, cwd: null,
  status: "blocked", statusCategory: "blocked", statusDetail, needsAction: null, isArchived: false, running: null,
  createdAt: null, lastActivityAt: daysAgo(0), completedTurns: 1, model: null, spawnedFrom: null, prs: [],
});

// 每条分支都「同时满足」比它低的条件，用来钉住优先级
const MAIN_SHA = "a".repeat(40);
const docsBranches = [
  fv("main", { role: "main", mergedState: "in_main", sha: MAIN_SHA, vsMain: null }),
  // 刚从主线切出、还没提交：tip == 主线顶端，祖先判断恒为「已进主线」→ 必须算「尚无提交」
  fv("b/zero", { mergedState: "in_main", sha: MAIN_SHA, vsMain: { ahead: 0, behind: 0 }, vsIntegration: { ahead: 0, behind: 3 }, lastCommitAt: daysAgo(30) }),
  // 等你 + 冲突 + 落后 + 停滞 → 等你回答
  fv("b/blocked", { vsIntegration: { ahead: 1, behind: 9 }, lastCommitAt: daysAgo(30), precheck: pc(2), sessions: [sref("s-blocked", "blocked", "确认是否推送", daysAgo(20))] }),
  // 冲突 + 落后 → 有冲突（仅 precheck）；不 precheck 时 → 落后需同步
  fv("b/conflict", { vsIntegration: { ahead: 1, behind: 4 }, precheck: pc(3) }),
  // 已进集成分支 + 停滞 → 可合并
  fv("b/in-integ", { mergedState: "in_integration", vsIntegration: { ahead: 0, behind: 2 }, lastCommitAt: daysAgo(40) }),
  // 试合无冲突 + 落后 → 可合并（仅 precheck）；不 precheck 时 → 落后需同步
  fv("b/clean", { vsIntegration: { ahead: 1, behind: 5 }, precheck: pc(0) }),
  // 落后 + 停滞 → 落后需同步
  fv("b/behind", { vsIntegration: { ahead: 1, behind: 7 }, lastCommitAt: daysAgo(15) }),
  // 只停滞
  fv("b/stale", { lastCommitAt: daysAgo(8) }),
  // 新鲜的独立分支 → 开发中
  fv("b/active", { lastCommitAt: daysAgo(1) }),
  // 已进主线 → 不计入待办
  fv("b/in-main", { mergedState: "in_main", vsIntegration: { ahead: 0, behind: 3 } }),
];
// App 仓无集成分支：落后看主线
const appBranches = [fv("a/behind-main", { vsIntegration: null, vsMain: { ahead: 1, behind: 6 } })];

const features = [
  card("等你", [["docs", "b/blocked"]]),
  card("冲突", [["docs", "b/conflict"]]),
  card("已进集成", [["docs", "b/in-integ"]]),
  card("试合干净", [["docs", "b/clean"]]),
  card("落后", [["docs", "b/behind"]]),
  card("停滞", [["docs", "b/stale"]]),
  card("开发中", [["docs", "b/active"]]),
  card("想法", []),
  card("分支没了", [["docs", "b/gone"]]),
  card("进主线了", [["docs", "b/in-main"]]),
  card("App 落后主线", [["app", "a/behind-main"]]),
  card("零提交的新功能", [["docs", "b/zero"]]),
  card("已合入的不算", [["docs", "b/active"]], { status: "已合入" }),
  card("已放弃的不算", [], { status: "已放弃" }),
  card("顺延来的", [["docs", "b/behind"]], { rolled_from: ["v1.1"] }),
];

const groupOf = (t: ReturnType<typeof groupTodo>, title: string): TodoGroupKey | "done" | null => {
  for (const g of t.groups) if (g.items.some((i) => i.title === title)) return g.key;
  if (t.doneByGit.some((i) => i.title === title)) return "done";
  return null;
};

describe("待办分组优先级", () => {
  const withPre = groupTodo({ milestone: MS, requested: "v1.2", features, report: report(true, docsBranches, appBranches), sessions: [], now: NOW });
  const noPre = groupTodo({ milestone: MS, requested: "v1.2", features, report: report(false, docsBranches, appBranches), sessions: [], now: NOW });

  test("组的顺序固定", () => {
    expect(withPre.groups.map((g) => g.key)).toEqual(["blocked", "conflict", "mergeable", "behind", "stale", "active", "unbound"]);
    expect(TODO_GROUP_DEFS.map((g) => g.title)).toEqual(["等你回答", "有冲突", "可合并", "落后需同步", "停滞", "开发中", "尚未关联开发分支"]);
  });

  test("--precheck：每张卡进优先级最高的一组", () => {
    expect(groupOf(withPre, "等你")).toBe("blocked");
    expect(groupOf(withPre, "冲突")).toBe("conflict");
    expect(groupOf(withPre, "已进集成")).toBe("mergeable");
    expect(groupOf(withPre, "试合干净")).toBe("mergeable");
    expect(groupOf(withPre, "落后")).toBe("behind");
    expect(groupOf(withPre, "App 落后主线")).toBe("behind");
    expect(groupOf(withPre, "停滞")).toBe("stale");
    expect(groupOf(withPre, "开发中")).toBe("active");
    expect(groupOf(withPre, "想法")).toBe("unbound");
    expect(groupOf(withPre, "分支没了")).toBe("unbound");
  });

  test("不 precheck：「有冲突」为未检查（null），冲突/试合干净的卡退到落后需同步", () => {
    const conflict = noPre.groups.find((g) => g.key === "conflict")!;
    expect(conflict.count).toBeNull();
    expect(conflict.items).toEqual([]);
    expect(groupOf(noPre, "冲突")).toBe("behind");
    expect(groupOf(noPre, "试合干净")).toBe("behind");
    expect(groupOf(noPre, "已进集成")).toBe("mergeable");
  });

  test("零提交分支的开发中卡计入待办：进「开发中」组、标「尚无提交」，不算已进主线、不算停滞", () => {
    for (const t of [withPre, noPre]) {
      const it = t.groups.find((g) => g.key === "active")!.items.find((i) => i.title === "零提交的新功能")!;
      expect(it).toBeDefined();
      expect(it.note).toBe("尚无提交");
      expect(it.bindings[0]!.noCommits).toBe(true);
      expect(it.suggestion).toBeNull();
    }
    expect(withPre.doneByGit).toEqual([]);
  });

  test("status 已合入（及已放弃）的卡不计入；已进主线的开发中卡仍计入，只给建议不改状态", () => {
    expect(groupOf(withPre, "已合入的不算")).toBeNull();
    expect(groupOf(withPre, "已放弃的不算")).toBeNull();
    expect(countsTowardTodo({ ...features[0]!, status: "已合入" })).toBe(false);
    expect(countsTowardTodo({ ...features[0]!, status: "待合并" })).toBe(true);
    const inMain = withPre.groups.find((g) => g.key === "mergeable")!.items.find((i) => i.title === "进主线了")!;
    expect(inMain.note).toBe("已进主线");
    expect(inMain.status).toBe("开发中");
    expect(inMain.suggestion).toContain("是否把 F-0010 标为已进主线");
    const inInteg = withPre.groups.find((g) => g.key === "mergeable")!.items.find((i) => i.title === "已进集成")!;
    expect(inInteg.note).toBe("已进集成分支");
    expect(inInteg.suggestion).toContain("已被集成分支包含，是否把 F-0003 标为已合入");
    expect(withPre.total).toBe(features.length - 2);
  });

  test("ops 传入的 zeroCommit 集合优先于纯事实判定（reflog 显示移动过 = 有过提交、已合入）", () => {
    const f = card("合入后领先 0", [["docs", "b/zero"]]);
    const t = groupTodo({ milestone: MS, requested: "v1.2", features: [f], report: report(false, docsBranches), sessions: [], zeroCommit: new Set(), now: NOW });
    expect(groupOf(t, "合入后领先 0")).toBe("mergeable");
    const z = groupTodo({ milestone: MS, requested: "v1.2", features: [f], report: report(false, docsBranches), sessions: [], zeroCommit: new Set([bindingKey("docs", "b/zero")]), now: NOW });
    expect(groupOf(z, "合入后领先 0")).toBe("active");
  });

  test("计数、needs_action 原文、落后数与顺延置顶", () => {
    const counts = Object.fromEntries(withPre.groups.map((g) => [g.key, g.count]));
    expect(counts).toEqual({ blocked: 1, conflict: 1, mergeable: 3, behind: 3, stale: 1, active: 2, unbound: 2 });
    const blocked = withPre.groups[0]!.items[0]!;
    expect(blocked.needsAction).toBe("确认是否推送");
    expect(blocked.bindings[0]!.behindIntegration).toBe(9);
    const behind = withPre.groups.find((g) => g.key === "behind")!;
    expect(behind.items[0]!.title).toBe("顺延来的");
    const app = behind.items.find((i) => i.title === "App 落后主线")!;
    expect(app.bindings[0]!.behindIntegration).toBeNull();
    expect(app.bindings[0]!.behindMain).toBe(6);
  });

  test("卡片上写明的会话也算：等你回答，缺 needs_action 用 status_detail", () => {
    const f = card("绑了会话", [["docs", "b/active"]]);
    f.bindings[0]!.session = "s-card";
    const t = groupTodo({ milestone: MS, requested: "v1.2", features: [f], report: report(false, docsBranches), sessions: [sv("s-card", "等你确认方案")], now: NOW });
    expect(t.groups[0]!.items[0]!.needsAction).toBe("等你确认方案");
  });

  test("Stop hook 记录的活动能把「停滞」拉回「开发中」", () => {
    const f = card("hook 有活动", [["docs", "b/stale"]]);
    f.bindings[0]!.worktree = "/tmp/wt-stale";
    const t = groupTodo({
      milestone: MS,
      requested: "v1.2",
      features: [f],
      report: report(false, docsBranches),
      sessions: [],
      stops: [{ sessionId: "cli-x", cwd: "/tmp/wt-stale/sub", at: NOW.getTime() - 3_600_000, stops: 1 }],
      now: NOW,
    });
    expect(groupOf(t, "hook 有活动")).toBe("active");
  });

  test("渲染：概览按优先级、空组合并一行、等你回答带需要你、未检查给出提示", () => {
    const text = renderTodo("演示", { ...noPre, nextMilestone: { id: "v1.2", status: "规划中" } }, { width: 100 });
    expect(text).toContain("待办 v1.2 收口（规划中）· 未合入 13 条");
    expect(text.split("\n")[1]).toBe("下一版 = v1.2（规划中）");
    expect(text).toContain("等你回答 1 > 有冲突 未检查 > 可合并 2");
    expect(text).toContain("  可合并 · 已进主线（1）");
    expect(text).toContain("  可合并 · 已进集成分支（1）");
    expect(text).toContain("- F-0012 零提交的新功能 · 开发中 · 尚无提交");
    expect(text).toContain("b/zero · 尚无提交（与主线同点或自创建后未提交）\n"); // 主线上的提交时间不算本功能的最后活动
    expect(text).toContain("■ 尚未关联开发分支（2）");
    expect(text).toContain("建议：以上 1 张卡的分支已被集成分支包含，是否标为已合入？");
    expect(text).toContain("需要你：确认是否推送");
    expect(text).toContain("■ 有冲突：未检查（加 --precheck");
    expect(text).toContain("从 v1.1 顺延");
    expect(text).not.toContain("不计入待办）");
    const pre = renderTodo("演示", withPre, { width: 100 });
    expect(pre).toContain("冲突 3 个文件");
    expect(pre).toContain("  可合并 · 试合无冲突（1）");
  });
});

/* ───────────── 端到端：Codex 第 1 轮复现步骤 ───────────── */

const BIN = join(import.meta.dir, "..", "bin", "heliu");
describe("回归：从主线新建 worktree、不提交就登记新点子", () => {
  let fx: Fixture;
  let wt: string;
  const heliu = (args: string[], cwd: string) => {
    const r = Bun.spawnSync({ cmd: [BIN, ...args], cwd, env: { ...process.env, ...fx.env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  beforeAll(() => {
    fx = buildFixture();
    expect(heliu(["project", "add", fx.repo, "--name", "演示", "--integration", "integ"], fx.repo).code).toBe(0);
    wt = join(fx.repo, ".claude", "worktrees", "alarm-000001");
    gitW(fx.repo, "worktree", "add", "-q", "-b", "feat/alarm", wt, "main");
  });
  afterAll(() => fx.cleanup());

  test("待办 下一版：计入 1 条，在「开发中 · 尚无提交」，milestone list 计数一致", () => {
    const add = heliu(["新点子", "让背夹支持闹钟"], wt);
    expect(add.stdout).toContain("开发中");
    expect(add.stdout).toContain("feat/alarm");
    const t = heliu(["待办", "下一版"], wt);
    expect(t.code).toBe(0);
    expect(t.stdout).toContain("未合入 1 条");
    expect(t.stdout).toContain("下一版 = vNext（规划中）");
    expect(t.stdout).toContain("■ 开发中（1）");
    expect(t.stdout).toContain("F-0001 让背夹支持闹钟 · 开发中 · 尚无提交");
    expect(t.stdout).not.toContain("已进主线");
    const j = JSON.parse(heliu(["待办", "下一版", "--json"], wt).stdout);
    const ml = JSON.parse(heliu(["milestone", "list", "--json"], wt).stdout);
    expect(ml.data.counts.find((c: { id: string }) => c.id === "vNext").todo).toBe(j.data.total);
    expect(heliu(["milestone", "list"], wt).stdout).toContain("1/1");
  }, 60_000);

  test("首次提交后仍在待办（独立未合并 → 开发中，不再标尚无提交）", () => {
    Bun.write(join(wt, "alarm.txt"), "闹钟\n");
    gitW(wt, "add", "alarm.txt");
    gitW(wt, "commit", "-q", "-m", "feat: 闹钟");
    const j = JSON.parse(heliu(["待办", "下一版", "--json"], wt).stdout);
    expect(j.data.total).toBe(1);
    const it = j.data.groups.flatMap((g: { items: Array<{ id: string; note: string | null; group: string }> }) => g.items)[0];
    expect(it.id).toBe("F-0001");
    expect(it.note).toBeNull();
  }, 60_000);
});

/* ───────────── Codex 第 2 轮：同点规则收紧与 sourceBranch 优先 ───────────── */

describe("回归：提交后被快进合并的分支不是「尚无提交」；从集成分支开出的零提交分支是", () => {
  let root: string;
  let repo: string;
  let env: Record<string, string>;
  const wt = (name: string) => join(root, "wt", name);
  const heliu = (args: string[], cwd: string) => {
    const r = Bun.spawnSync({ cmd: [BIN, ...args], cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
    return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  type Item = { id: string; title: string; group: string; note: string | null; suggestion: string | null };
  const items = (cwd: string, ms: string): Item[] => {
    const j = JSON.parse(heliu(["待办", ms, "--json"], cwd).stdout);
    return j.data.groups.flatMap((g: { items: Item[] }) => g.items);
  };
  const commitIn = (dir: string, file: string) => {
    writeFileSync(join(dir, file), `${file}\n`);
    gitW(dir, "add", file);
    gitW(dir, "commit", "-q", "-m", `feat: ${file}`);
  };

  beforeAll(() => {
    // Codex 的复现：从 main 建 integ（与 main 同点）
    root = realpathSync(mkdtempSync(join(tmpdir(), "heliu-ff-")));
    repo = join(root, "仓 库");
    mkdirSync(repo);
    for (const d of ["home", "app", "claude"]) mkdirSync(join(root, d));
    env = { HELIU_HOME: join(root, "home"), HELIU_CLAUDE_APP_DIR: join(root, "app"), HELIU_CLAUDE_HOME: join(root, "claude") };
    gitW(repo, "init", "-q", "-b", "main");
    gitW(repo, "config", "commit.gpgsign", "false");
    commitIn(repo, "README.md");
    gitW(repo, "branch", "integ");
    expect(heliu(["project", "add", repo, "--name", "闹钟", "--integration", "integ"], repo).code).toBe(0);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test("Codex 复现：feat/alarm 提交后被 integ 快进合并 → 可合并 · 已进集成分支，并建议标为已合入", () => {
    gitW(repo, "worktree", "add", "-q", "-b", "feat/alarm", wt("alarm"), "main");
    expect(heliu(["新点子", "让背夹支持闹钟"], wt("alarm")).code).toBe(0);
    expect(heliu(["预约", "F-0001", "v1.2"], wt("alarm")).code).toBe(0);
    commitIn(wt("alarm"), "alarm.txt");
    gitW(repo, "checkout", "-q", "integ");
    gitW(repo, "merge", "-q", "--ff-only", "feat/alarm");
    const it = items(wt("alarm"), "v1.2").find((i) => i.id === "F-0001")!;
    expect(it.group).toBe("mergeable");
    expect(it.note).toBe("已进集成分支");
    expect(it.suggestion).toContain("是否把 F-0001 标为已合入");
    const text = heliu(["待办", "v1.2"], wt("alarm")).stdout;
    expect(text).toContain("可合并 · 已进集成分支（1）");
    expect(text).toContain("是否标为已合入");
    expect(text).not.toContain("尚无提交");
  }, 60_000);

  test("从集成分支 tip 开出的零提交分支 → 开发中 · 尚无提交（tip == 集成 tip 且相对主线领先 >0，靠 reflog 判定）", () => {
    gitW(repo, "worktree", "add", "-q", "-b", "feat/from-integ", wt("from-integ"), "integ");
    expect(heliu(["新点子", "从集成分支开出的功能"], wt("from-integ")).code).toBe(0);
    const it = items(wt("from-integ"), "下一版").find((i) => i.title === "从集成分支开出的功能")!;
    expect(it.group).toBe("active");
    expect(it.note).toBe("尚无提交");
  }, 60_000);

  test("reflog 缺失时，git-worktrees.json 的 sourceBranch 作主判据：integ..分支 == 0 → 尚无提交", () => {
    gitW(repo, "worktree", "add", "-q", "-b", "feat/no-reflog", wt("no-reflog"), "integ");
    expect(heliu(["新点子", "没有 reflog 的功能"], wt("no-reflog")).code).toBe(0);
    rmSync(join(repo, ".git", "logs", "refs", "heads", "feat", "no-reflog"));
    // 没有来源分支、也没有 reflog：结构兜底（tip == 集成 tip、主线..分支 >0）→ 判为已进集成分支
    const before = items(wt("no-reflog"), "下一版").find((i) => i.title === "没有 reflog 的功能")!;
    expect(before.note).toBe("已进集成分支");
    writeFileSync(
      join(root, "app", "git-worktrees.json"),
      JSON.stringify({ worktrees: { "no-reflog": { name: "no-reflog", path: wt("no-reflog"), branch: "feat/no-reflog", sourceBranch: "integ", baseRepo: repo } } }),
    );
    const after = items(wt("no-reflog"), "下一版").find((i) => i.title === "没有 reflog 的功能")!;
    expect(after.group).toBe("active");
    expect(after.note).toBe("尚无提交");
  }, 60_000);

  test("提交后被主线快进合并（tip == 主线 tip）→ 可合并 · 已进主线，不是尚无提交", () => {
    gitW(repo, "checkout", "-q", "main");
    gitW(repo, "worktree", "add", "-q", "-b", "feat/ff-main", wt("ff-main"), "main");
    expect(heliu(["新点子", "快进进主线的功能"], wt("ff-main")).code).toBe(0);
    commitIn(wt("ff-main"), "ff.txt");
    gitW(repo, "merge", "-q", "--ff-only", "feat/ff-main");
    const it = items(wt("ff-main"), "下一版").find((i) => i.title === "快进进主线的功能")!;
    expect(it.group).toBe("mergeable");
    expect(it.note).toBe("已进主线");
    expect(it.suggestion).toContain("标为已进主线");
  }, 60_000);
});
