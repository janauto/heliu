/**
 * M10：时间线模型（web/timeline-model.ts，纯函数）。
 * 手工构造最小的 ReconcileReport / FeaturesData：时间窗与刻度、xOf 单调、条的起止规则（created / approx / none）、
 * 会话入口折叠计数、已进主线且没卡的分支被过滤、里程碑日期线只含有 target_date 的、窗外截断、折叠与筛选。
 */
import { describe, expect, test } from "bun:test";
import type { BoardCard, BoardColumn, CardBinding, FeaturesData } from "../src/board/api-types.ts";
import type { FeatureView, LedgerMilestone, ReconcileReport, RepoReport, SessionRef } from "../src/types.ts";
import {
  DAY,
  GROUP_H,
  NOBIND_REPO,
  ROW_H,
  axisWidth,
  buildTimeline,
  cardSpan,
  countByTone,
  entriesKey,
  flattenRows,
  moduleKey,
  rangeTicks,
  repoKey,
  tickUnit,
  timeWindow,
  todayScrollLeft,
  withCardPatch,
  xOf,
} from "../web/timeline-model.ts";

// 2026-11-01（周日）中午，本地时区：标签按本地日期算，构造时也用本地时间，换时区也稳定
const NOW = new Date(2026, 10, 1, 12, 0, 0);
const at = (daysAgo: number, hour = 12) => {
  const d = new Date(NOW);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

function session(lastActivityAt: string | null, status: SessionRef["status"] = "running"): SessionRef {
  return { sessionId: `s-${Math.random().toString(16).slice(2, 8)}`, title: "会话", status, statusCategory: null, needsAction: null, isArchived: false, lastActivityAt, link: "branch", prs: [] };
}

function branch(name: string, o: Partial<FeatureView> = {}): FeatureView {
  return {
    branch: name,
    ref: `refs/heads/${name}`,
    sha: "0".repeat(40),
    role: "feature",
    mergedState: "unmerged",
    label: name,
    labelSource: "branch_name",
    randomName: false,
    lastCommitAt: null,
    lastCommitSubject: "",
    vsMain: { ahead: 1, behind: 0 },
    vsIntegration: null,
    upstream: null,
    pushed: false,
    worktree: null,
    sessions: [],
    precheck: null,
    sessionEntry: false,
    ...o,
  };
}

function repo(id: string, branches: FeatureView[], o: Partial<RepoReport> = {}): RepoReport {
  return {
    id,
    label: `${id} 仓`,
    path: `/tmp/${id}`,
    icloud: false,
    main: "main",
    integration: "integ",
    remote: null,
    reachable: true,
    error: null,
    warnings: [],
    counts: null,
    health: null,
    branches: [branch("main", { role: "main" }), ...branches],
    worktrees: [],
    hygiene: [],
    elapsedMs: 1,
    gitCalls: 1,
    gitTimeouts: 0,
    ...o,
  };
}

function report(repos: RepoReport[]): ReconcileReport {
  return {
    schemaVersion: 1,
    generatedAt: NOW.toISOString(),
    elapsedMs: 1,
    project: { name: "演示", source: "/tmp/project.yaml" },
    options: { precheck: false, dirty: false, timeoutMs: 1000 },
    repos,
    sessions: { total: 0, parseErrors: 0 },
  };
}

function binding(repoId: string, br: string, o: Partial<CardBinding> = {}): CardBinding {
  return {
    repo: repoId,
    repoLabel: `${repoId} 仓`,
    branch: br,
    label: null,
    randomName: false,
    exists: true,
    role: "feature",
    mergedState: "unmerged",
    vsMain: null,
    vsIntegration: null,
    integration: "integ",
    main: "main",
    precheckTarget: null,
    conflictFiles: null,
    conflicts: [],
    precheckError: null,
    precheckState: null,
    lastCommitAt: null,
    worktree: null,
    session: null,
    sessionEntry: false,
    ...o,
  };
}

function card(id: string, o: Partial<BoardCard> = {}): BoardCard {
  return {
    id,
    title: `卡 ${id}`,
    status: "开发中",
    acceptance: "未",
    milestone: "v1.2",
    column: "v1.2",
    rolledFrom: [],
    source: "board",
    group: "active",
    light: "gray",
    lightText: "",
    needsAction: null,
    note: null,
    suggestion: null,
    suggestStatus: null,
    variant: "normal",
    nextStep: "",
    tags: [],
    lastActivityAt: null,
    idleDays: null,
    done: false,
    doneNote: null,
    bindings: [],
    file: `/tmp/${id}.md`,
    type: "功能",
    typeSource: "card",
    module: "界面与交互",
    moduleSource: "card",
    mergedTo: null,
    ...o,
  };
}

function ms(id: string, target_date: string | null, status: LedgerMilestone["status"] = "规划中"): LedgerMilestone {
  return { id, title: id, status, target_date, integration_branch: null, notes: "" };
}

function features(cards: BoardCard[], milestones: LedgerMilestone[] = [ms("v1.2", null)]): FeaturesData {
  const columns: BoardColumn[] = milestones.map((m) => ({
    key: m.id,
    kind: "milestone",
    title: m.id,
    milestone: m,
    droppable: true,
    dropHint: null,
    isNext: false,
    owed: 0,
    mergeable: 0,
    conflict: null,
    precheckFailed: 0,
    waiting: 0,
    precheckSummary: null,
    cards: cards.filter((c) => c.column === m.id),
  }));
  columns.push({ key: "__unreserved", kind: "unreserved", title: "未预约", milestone: null, droppable: true, dropHint: null, isNext: false, owed: 0, mergeable: 0, conflict: null, precheckFailed: 0, waiting: 0, precheckSummary: null, cards: cards.filter((c) => c.column === "__unreserved") });
  return {
    columns,
    groups: [],
    abandoned: 0,
    next: milestones[0]?.id ?? null,
    nextStatus: "规划中",
    precheck: false,
    precheckSummary: { requested: false, status: "skipped", conflicts: null, failed: 0, unchecked: 0, firstError: null },
    broken: [],
    ledgerDir: "/tmp/ledger",
    modules: [
      { name: "界面与交互", keywords: ["界面", "ui"] },
      { name: "平台与接口", keywords: ["api", "网关"] },
    ],
    modulesSource: "default",
    types: [],
  };
}

describe("时间窗与刻度", () => {
  test("to = 现在 + 2 天，from = 范围天数前那天 0 点", () => {
    for (const [range, n] of [["2w", 14], ["1m", 30], ["3m", 90]] as const) {
      const { from, to } = timeWindow(NOW, range);
      expect(to.getTime() - NOW.getTime()).toBe(2 * DAY);
      const f = new Date(NOW);
      f.setDate(f.getDate() - n);
      f.setHours(0, 0, 0, 0);
      expect(from.getTime()).toBe(f.getTime());
      expect(from.getHours()).toBe(0);
    }
  });

  test("刻度粒度跟每天宽度走：2 周按天、1 月按周（每周一）、3 月按月", () => {
    expect(tickUnit(64)).toBe("day");
    expect(tickUnit(30)).toBe("week");
    expect(tickUnit(10)).toBe("month");

    const countDays = (from: Date, to: Date, pick: (d: Date) => boolean) => {
      let n = 0;
      const d = new Date(from);
      for (; d.getTime() <= to.getTime(); d.setDate(d.getDate() + 1)) if (pick(d)) n++;
      return n;
    };

    // 2 周：10-18 0 点 … 11-03 中午 → 17 个日刻度 + 1 个「今天」
    const w2 = timeWindow(NOW, "2w");
    const t2 = rangeTicks(w2.from, w2.to, axisWidth("2w", 600, NOW), NOW);
    expect(t2.filter((t) => t.kind === "day").length).toBe(17);
    expect(t2.filter((t) => t.kind === "today").map((t) => t.label)).toEqual(["今天"]);
    expect(t2.some((t) => t.label === "10-28")).toBe(true);
    // 「11-01」和「今天」只隔半天，让给「今天」
    expect(t2.find((t) => t.kind === "day" && t.label === null && new Date(t.t).getDate() === 1)).toBeTruthy();

    // 1 月：每周一一个刻度
    const w1 = timeWindow(NOW, "1m");
    const t1 = rangeTicks(w1.from, w1.to, 1000, NOW);
    expect(t1.every((t) => t.kind === "week" || t.kind === "today")).toBe(true);
    expect(t1.filter((t) => t.kind === "week").length).toBe(countDays(w1.from, w1.to, (d) => d.getDay() === 1));
    expect(t1.filter((t) => t.kind === "week").every((t) => new Date(t.t).getDay() === 1)).toBe(true);

    // 3 月：月初是主刻度（「9月」「10月」…），周一是小刻度
    const w3 = timeWindow(NOW, "3m");
    const t3 = rangeTicks(w3.from, w3.to, 1000, NOW);
    const months = t3.filter((t) => t.kind === "month");
    expect(months.length).toBe(countDays(w3.from, w3.to, (d) => d.getDate() === 1));
    expect(months.map((t) => t.label)).toContain("10月");
    expect(months.every((t) => t.major)).toBe(true);

    // 标签两两至少隔 44px（今天优先）
    for (const ticks of [t1, t2, t3]) {
      const xs = ticks.filter((t) => t.label !== null).map((t) => t.x).sort((p, q) => p - q);
      for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeGreaterThanOrEqual(44);
    }
  });

  test("xOf 线性单调；窗口两端 = 0 与 width；轴宽至少铺满可视区", () => {
    const { from, to } = timeWindow(NOW, "1m");
    expect(xOf(from, from, to, 900)).toBe(0);
    expect(xOf(to, from, to, 900)).toBe(900);
    let last = -Infinity;
    for (let t = from.getTime() - 3 * DAY; t <= to.getTime() + 3 * DAY; t += DAY / 3) {
      const x = xOf(t, from, to, 900);
      expect(x).toBeGreaterThan(last);
      last = x;
    }
    expect(axisWidth("1m", 2000, NOW)).toBe(2000);
    expect(axisWidth("2w", 300, NOW)).toBeGreaterThanOrEqual(Math.ceil(16 * 64));
    // 今天落在可视时间轴 80% 处
    expect(todayScrollLeft(1000, 760, 260)).toBe(600);
    expect(todayScrollLeft(100, 760, 260)).toBe(0);
  });
});

describe("条的起止规则", () => {
  test("有卡：BoardCard 没有 created → 最早可见活动（近似）；会话入口的最后提交不算；终点 = lastActivityAt", () => {
    const c = card("F-0001", {
      lastActivityAt: at(1),
      bindings: [
        binding("app", "claude/a", { lastCommitAt: at(6), session: { id: "s1", title: null, status: "running", needsAction: null, lastActivityAt: at(2), link: null } }),
        // 会话入口：lastCommitAt 是出发点（主线上的老提交），不是这张卡的活动
        binding("docs", "claude/entry", { sessionEntry: true, lastCommitAt: at(80), session: { id: "s2", title: null, status: "running", needsAction: null, lastActivityAt: at(3), link: null } }),
      ],
    });
    const s = cardSpan(c, NOW.getTime());
    expect(s.startKind).toBe("approx");
    expect(s.start).toBe(Date.parse(at(6)));
    expect(s.end).toBe(Date.parse(at(1)));
    expect(s.endKind).toBe("activity");
  });

  test("有卡且服务端给了 created → startKind = created", () => {
    const c = { ...card("F-0002", { lastActivityAt: at(1), bindings: [binding("app", "claude/b", { lastCommitAt: at(3) })] }), created: at(9) } as BoardCard;
    const s = cardSpan(c, NOW.getTime());
    expect(s.startKind).toBe("created");
    expect(s.start).toBe(Date.parse(at(9)));
  });

  test("没有任何时间：起点 none、终点画在现在（空心点）", () => {
    const s = cardSpan(card("F-0003"), NOW.getTime());
    expect(s).toEqual({ start: null, end: NOW.getTime(), startKind: "none", endKind: "none" });
  });

  test("buildTimeline：条 / 点 / 窗外截断 / 整条在窗外", () => {
    const rep = report([
      repo("app", [
        branch("claude/two-times", { lastCommitAt: at(5), sessions: [session(at(1))] }),
        branch("claude/one-time", { lastCommitAt: at(4) }),
        branch("claude/old-start", { lastCommitAt: at(50), sessions: [session(at(2))] }),
        branch("claude/very-old", { lastCommitAt: at(70) }),
      ]),
    ]);
    const m = buildTimeline(rep, features([card("F-0010", { lastActivityAt: at(0), bindings: [binding("app", "claude/carded", { lastCommitAt: at(3) })] })]), { now: NOW, range: "1m", width: 1000 });
    const it = (k: string) => m.items.find((x) => x.key === k)!;

    const two = it("app|claude/two-times");
    expect(two.kind).toBe("branch");
    expect(two.tone).toBe("blue");
    expect(two.shape).toBe("bar");
    expect(two.startKind).toBe("approx");
    expect(two.start!.getTime()).toBe(Date.parse(at(5)));
    expect(two.end.getTime()).toBe(Date.parse(at(1)));
    expect(two.x1).toBeGreaterThan(two.x0);
    expect(two.x0).toBeCloseTo(xOf(Date.parse(at(5)), m.from, m.to, 1000), 6);

    const one = it("app|claude/one-time");
    expect(one.shape).toBe("dot");
    expect(one.x0).toBe(one.x1);

    const old = it("app|claude/old-start");
    expect(old.clippedLeft).toBe(true);
    expect(old.x0).toBe(0);
    expect(old.outside).toBe(false);

    const gone = it("app|claude/very-old");
    expect(gone.outside).toBe(true);
    expect(gone.x0).toBe(0);
    expect(gone.x1).toBe(0);

    const c = it("F-0010");
    expect(c.kind).toBe("card");
    expect(c.tone).toBe("gray");
    expect(c.startKind).toBe("approx");
    expect(c.repo).toBe("app");
    expect(c.main).toBe("main");
    // 今天线
    expect(m.todayX).toBeCloseTo(xOf(NOW, m.from, m.to, 1000), 6);
    expect(m.todayX).toBeLessThan(1000);
  });
});

describe("过滤与折叠", () => {
  const rep = report([
    repo("app", [
      branch("claude/live", { lastCommitAt: at(2), label: "网关 api 重写" }),
      branch("claude/in-main", { lastCommitAt: at(3), mergedState: "in_main" }),
      branch("claude/in-integ", { lastCommitAt: at(3), mergedState: "in_integration" }),
      branch("claude/entry-1", { sessionEntry: true, mergedState: "in_main", sessions: [session(at(1), "blocked")] }),
      branch("claude/entry-2", { sessionEntry: true, mergedState: "in_main", sessions: [session(at(1))] }),
      branch("claude/carded-entry", { sessionEntry: true, mergedState: "in_main" }),
      branch("integ", { role: "integration" }),
    ]),
    repo("fw", [], { reachable: false, error: "路径不存在", branches: [] }),
  ]);
  const cards = [
    card("F-0001", { light: "purple", group: "blocked", lastActivityAt: at(1), bindings: [binding("app", "claude/carded-entry", { sessionEntry: true })] }),
    card("F-0002", { light: "red", group: "conflict", module: "平台与接口", lastActivityAt: at(2), bindings: [binding("app", "claude/x", { lastCommitAt: at(4) })] }),
    card("F-0003", { light: "gray", group: "unbound", column: "__unreserved", milestone: null, bindings: [] }),
    card("F-0004", { done: true, status: "已进主线", bindings: [binding("app", "claude/in-main")] }),
  ];
  const m = buildTimeline(rep, features(cards), { now: NOW, range: "1m", width: 1000, modules: features([]).modules });

  test("已进主线且没卡的分支不画；有卡的会话入口画成卡；没卡的会话入口折叠成「会话入口 N」", () => {
    const keys = m.items.map((i) => i.key);
    expect(keys).toContain("app|claude/live");
    expect(keys).toContain("app|claude/in-integ");
    expect(keys).not.toContain("app|claude/in-main");
    expect(keys.some((k) => k.includes("entry"))).toBe(false);
    expect(keys).toContain("F-0001");
    // 已完成的卡不画（它的分支也不会变成没卡的分支）
    expect(keys).not.toContain("F-0004");
    const app = m.tree.find((n) => n.repo === "app")!;
    expect(app.entries).toBe(2);
    expect(app.entriesWaiting).toBe(1);
    expect(m.counts.entries).toBe(2);
    const row = m.rows.find((r) => r.key === entriesKey("app"));
    expect(row?.kind === "entries" && row.count).toBe(2);
  });

  test("树：仓库 → 模块（定义顺序，「其他」最后）→ 条目；没绑分支的卡进伪仓库；不可达仓库只留一行", () => {
    const app = m.tree.find((n) => n.repo === "app")!;
    const names = app.modules.map((x) => x.module);
    expect(names.indexOf("界面与交互")).toBeLessThan(names.indexOf("平台与接口"));
    if (names.includes("其他")) expect(names[names.length - 1]).toBe("其他");
    // 没卡的分支按 modelOfBranch 同一段文字推测模块：「网关 api 重写」→ 平台与接口
    expect(m.items.find((i) => i.key === "app|claude/live")!.module).toBe("平台与接口");
    const nob = m.tree.find((n) => n.repo === NOBIND_REPO)!;
    expect(nob.pseudo).toBe(true);
    expect(nob.modules.flatMap((x) => x.items).map((i) => i.key)).toEqual(["F-0003"]);
    expect(m.tree[m.tree.length - 1]!.repo).toBe(NOBIND_REPO);
    const fw = m.tree.find((n) => n.repo === "fw")!;
    expect(fw.error).toBe("路径不存在");
    expect(m.rows.filter((r) => r.key === repoKey("fw")).length).toBe(1);
    // 行高：组 36、条目 40，y 连续
    let y = 0;
    for (const r of m.rows) {
      expect(r.y).toBe(y);
      expect(r.h).toBe(r.kind === "item" ? ROW_H : GROUP_H);
      y += r.h;
    }
    expect(m.height).toBe(y);
  });

  test("折叠与筛选：收起的组不出子行；筛选时空组与会话入口行不出现；按颜色计数", () => {
    const folded = flattenRows(m.tree, { collapsed: new Set([repoKey("app")]) });
    expect(folded.rows.some((r) => r.kind === "item" && r.item.repo === "app")).toBe(false);
    expect(folded.rows.find((r) => r.key === repoKey("app"))?.kind).toBe("repo");
    const modFold = flattenRows(m.tree, { collapsed: new Set([moduleKey("app", "平台与接口")]) });
    expect(modFold.rows.some((r) => r.kind === "item" && r.item.module === "平台与接口" && r.item.repo === "app")).toBe(false);

    const red = flattenRows(m.tree, { keep: (i) => i.tone === "red" });
    expect(red.rows.filter((r) => r.kind === "item").map((r) => r.key)).toEqual(["F-0002"]);
    expect(red.rows.some((r) => r.kind === "entries")).toBe(false);
    expect(red.rows.some((r) => r.key === repoKey("fw"))).toBe(false);
    expect(red.shown).toBe(1);

    const tones = countByTone(m.items);
    expect(tones.blue).toBe(2);
    expect(tones.purple).toBe(1);
    expect(tones.red).toBe(1);
  });

  test("乐观更新：只改那一张卡，其余引用不变", () => {
    const f = features(cards);
    const g = withCardPatch(f, "F-0002", { module: "界面与交互", moduleSource: "card" })!;
    expect(g).not.toBe(f);
    expect(g.columns.flatMap((c) => c.cards).find((c) => c.id === "F-0002")!.module).toBe("界面与交互");
    expect(g.columns.find((c) => c.key === "__unreserved")).toBe(f.columns.find((c) => c.key === "__unreserved")!);
    expect(withCardPatch(f, "F-9999", { module: "x" })).toBe(f);
  });
});

describe("里程碑日期线", () => {
  test("只含有 target_date 的；纯日期按本地 0 点；窗外的标 inWindow=false", () => {
    const list = [ms("v1.1", "2026-10-20", "已发布"), ms("v1.2", "2026-11-02"), ms("v1.3", null), ms("v2.0", "2027-01-15")];
    const m = buildTimeline(null, features([], list), { now: NOW, range: "1m", width: 1000, milestones: list });
    expect(m.milestones.map((x) => x.id)).toEqual(["v1.1", "v1.2", "v2.0"]);
    const v12 = m.milestones.find((x) => x.id === "v1.2")!;
    expect(v12.date.getTime()).toBe(new Date(2026, 10, 2).getTime());
    expect(v12.inWindow).toBe(true);
    expect(v12.x).toBeGreaterThan(m.todayX);
    expect(m.milestones.find((x) => x.id === "v2.0")!.inWindow).toBe(false);
    // 不传 milestones 时从 features 的列里取
    const m2 = buildTimeline(null, features([], list), { now: NOW, range: "1m", width: 1000 });
    expect(m2.milestones.map((x) => x.id)).toEqual(["v1.1", "v1.2", "v2.0"]);
  });

  test("没有对账结果（status 还没到）也能先画卡", () => {
    const m = buildTimeline(null, features([card("F-0001", { lastActivityAt: at(2), bindings: [binding("app", "claude/a", { lastCommitAt: at(5) })] })]), { now: NOW, range: "2w", width: 800 });
    expect(m.items.map((i) => i.key)).toEqual(["F-0001"]);
    expect(m.tree[0]!.label).toBe("app 仓");
    expect(buildTimeline(null, null, { now: NOW, range: "2w", width: 800 }).items).toEqual([]);
  });
});
