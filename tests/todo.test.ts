/**
 * milestone.todo 分组优先级：等你回答 > 有冲突（仅 --precheck）> 可合并 > 落后需同步 > 停滞 > 开发中 > 无绑定。
 * 用手工构造的对账结果，逐条钉住「同时满足多个条件时进哪一组」。
 */
import { describe, expect, test } from "bun:test";
import { renderTodo } from "../src/cli/render-ledger.ts";
import { groupTodo, TODO_GROUP_DEFS } from "../src/core/todo.ts";
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
const docsBranches = [
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
    expect(TODO_GROUP_DEFS.map((g) => g.title)).toEqual(["等你回答", "有冲突", "可合并", "落后需同步", "停滞", "开发中", "无绑定"]);
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

  test("已合入/已放弃不计入；分支已全部进主线单列", () => {
    expect(groupOf(withPre, "已合入的不算")).toBeNull();
    expect(groupOf(withPre, "已放弃的不算")).toBeNull();
    expect(groupOf(withPre, "进主线了")).toBe("done");
    expect(withPre.total).toBe(features.length - 3);
  });

  test("计数、needs_action 原文、落后数与顺延置顶", () => {
    const counts = Object.fromEntries(withPre.groups.map((g) => [g.key, g.count]));
    expect(counts).toEqual({ blocked: 1, conflict: 1, mergeable: 2, behind: 3, stale: 1, active: 1, unbound: 2 });
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
    const text = renderTodo("演示", noPre, { width: 100 });
    expect(text).toContain("待办 v1.2 收口（规划中）· 未合入 11 条");
    expect(text).toContain("等你回答 1 > 有冲突 未检查 > 可合并 1");
    expect(text).toContain("需要你：确认是否推送");
    expect(text).toContain("■ 有冲突：未检查（加 --precheck");
    expect(text).toContain("从 v1.1 顺延");
    expect(text).toContain("另有 1 条的绑定分支已全部进主线");
    const pre = renderTodo("演示", withPre, { width: 100 });
    expect(pre).toContain("冲突 3 个文件");
    expect(pre).toContain("试合无冲突");
  });
});
