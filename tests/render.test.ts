/**
 * 渲染层测试：用手工构造的对账结果，断言行动摘要的分组、全文折行、措辞与图例。
 */
import { describe, expect, test } from "bun:test";
import { FULL_HINT, LEGEND, REMOTE_NOTE, renderSessions, renderStatusFull, renderStatusSummary, topActions } from "../src/cli/render.ts";
import { hangingWrap, width, wrapText } from "../src/cli/table.ts";
import type { FeatureView, ReconcileReport, RepoReport, SessionRef, SessionView } from "../src/types.ts";

const LONG_NEED =
  "确认：是否配置远端并合并 claude/live2d-interactive-character-98f128 到 main；以及“兼容MUSE”是要真接入Muse服务（走不通），还是搬进ESP-Claw固件（建议）。另外请确认是否需要把方案文档推送到私有仓库，并告诉我优先级排序。";

let seq = 0;
function fv(p: Partial<FeatureView> & { branch: string }): FeatureView {
  seq++;
  return {
    ref: `refs/heads/${p.branch}`,
    sha: String(seq).padStart(40, "0"),
    role: "feature",
    mergedState: "unmerged",
    label: p.branch,
    labelSource: "first_commit",
    randomName: false,
    lastCommitAt: new Date(Date.UTC(2026, 9, 26 - seq)).toISOString(),
    lastCommitSubject: "x",
    vsMain: { ahead: 1, behind: 0 },
    vsIntegration: { ahead: 1, behind: seq },
    upstream: null,
    pushed: false,
    worktree: null,
    sessions: [],
    precheck: null,
    ...p,
  };
}
const blocked = (id: string, title: string, needsAction: string | null): SessionRef => ({
  sessionId: id,
  title,
  status: "blocked",
  statusCategory: "blocked",
  needsAction,
  isArchived: false,
  lastActivityAt: "2026-10-25T10:00:00.000Z",
  link: "branch",
  prs: [],
});

function repo(p: Partial<RepoReport>): RepoReport {
  return {
    id: "docs",
    label: "文档仓",
    path: "/tmp/docs",
    icloud: false,
    main: "main",
    integration: "integ",
    remote: "origin",
    reachable: true,
    error: null,
    warnings: [],
    counts: { branches: 0, worktrees: 2, mergedIntoMain: 1, unmergedIntoMain: 0, inIntegration: 0, independent: 0, neverPushed: 7 },
    health: {
      mainVsRemote: { remoteRef: "refs/remotes/origin/main", ahead: 7, behind: 5, note: null },
      integration: { branch: "integ", exists: true, mergedIntoMain: false, aheadOfMain: 102, behindMain: 0, since: null, unmergedDays: 3 },
      worktreeDirty: { clean: 3, dirty: 0, unknown: 0, skipped: 0 },
      hygieneWarnings: 0,
      hygieneInfos: 0,
    },
    branches: [],
    worktrees: [],
    hygiene: [],
    elapsedMs: 1,
    gitCalls: 1,
    gitTimeouts: 0,
    ...p,
  };
}

function report(repos: RepoReport[]): ReconcileReport {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-26T02:00:00.000Z",
    elapsedMs: 800,
    project: { name: "演示", source: "(内存)" },
    options: { precheck: false, dirty: false, timeoutMs: 8000 },
    repos,
    sessions: { total: 0, parseErrors: 0 },
  };
}

// 文档仓：12 个等你（超过 8 条上限）、11 条独立未合并全部落后集成分支（④ 应只给一句话）、3 条已进集成
const docsBranches: FeatureView[] = [
  fv({ branch: "main", role: "main", mergedState: "in_main", label: "主线", vsMain: null }),
  fv({ branch: "integ", role: "integration", vsIntegration: null, vsMain: { ahead: 102, behind: 0 } }),
  fv({ branch: "claude/live2d-98f128", label: "Live2D 交互角色可行性评估", sessions: [blocked("s0", "Live2D 交互角色可行性评估", LONG_NEED)] }),
  fv({ branch: "claude/merged-222222", mergedState: "in_main", label: "已进主线的也照样提醒", vsIntegration: { ahead: 0, behind: 50 }, sessions: [blocked("s1", "已进主线的也照样提醒", "拔掉 USB 再插回")] }),
  ...Array.from({ length: 10 }, (_, i) => fv({ branch: `claude/old-${i}-abcdef`, label: `老分支 ${i}`, sessions: [blocked(`w${i}`, `老分支 ${i}`, `第 ${i} 件要你定的事`)] })),
  ...Array.from({ length: 3 }, (_, i) => fv({ branch: `claude/in-integ-${i}`, mergedState: "in_integration", vsIntegration: { ahead: 0, behind: 9 } })),
];
// App 仓：无集成分支；8 条独立未合并，其中 6 条落后主线（不是全集 → 列前 5 条）
const appBranches: FeatureView[] = Array.from({ length: 8 }, (_, i) =>
  fv({ branch: `feat/app-${i}`, label: `App 功能 ${i}`, vsIntegration: null, vsMain: { ahead: 1, behind: i < 6 ? 40 + i : 0 } }),
);
const docs = repo({ branches: docsBranches, hygiene: [{ kind: "orphan_admin_dir", severity: "warn", message: "x", path: "/x", branch: null, count: null }] });
const app = repo({ id: "app", label: "App 仓", integration: null, health: { ...repo({}).health!, integration: null, mainVsRemote: { remoteRef: "refs/remotes/github/rel", ahead: 34, behind: 0, note: null } }, branches: appBranches });
const gone = repo({ id: "gone", label: "缺失仓", reachable: false, error: "路径不存在", counts: null, health: null });
const WIDTH = 80;
const rep = report([docs, app, gone]);
const text = renderStatusSummary(rep, { width: WIDTH });
const lines = text.split("\n");
const section = (from: string, to: string) => {
  const a = lines.findIndex((l) => l.startsWith(from));
  const b = lines.findIndex((l, i) => i > a && l.startsWith(to));
  return lines.slice(a + 1, b);
};

describe("status 默认：一屏行动摘要", () => {
  test("一屏：100 列下，3 个仓库、12 个等你（含一条长文案）、19 条独立分支也不超过 45 行", () => {
    // 行数随待办文案长度与终端宽度变化，无法对任意输入保证；这里固定 100 列（非 TTY 默认宽度）
    expect(renderStatusSummary(rep, { width: 100 }).split("\n").length).toBeLessThanOrEqual(45);
  });

  test("图例在健康条上方，健康条末尾有远端口径括注，措辞改为「本地无远端引用」", () => {
    expect(lines[1]).toBe(LEGEND);
    expect(lines[2]).toBe("健康条");
    expect(text).toContain(`  ${REMOTE_NOTE}`);
    expect(text).toContain("本地无远端引用 7");
    expect(text).not.toContain("从未推送");
    expect(text).toContain("✗ 路径不存在");
    expect(lines[lines.length - 1]).toBe(FULL_HINT);
  });

  test("现在最该做的：按严重度取前 3 句", () => {
    const acts = section("现在最该做的", "①");
    expect(acts.length).toBe(3);
    expect(acts[0]).toContain("文档仓集成分支领先主线 102 提交、3 天未并回 → 先把它并回 main");
    expect(acts[1]).toContain("12 个会话在等你拍板");
    expect(acts[2]).toContain("19 条独立分支未进任何版本（文档仓 11 / App 仓 8），M2 起可预约");
    expect(text).not.toContain("孤儿"); // 第 5 条规则被前 3 条挤掉
    const quiet = repo({ branches: [], hygiene: docs.hygiene });
    quiet.health = { ...quiet.health!, integration: null };
    const t = topActions(report([quiet]), 0);
    expect(t).toEqual(["文档仓主线与 origin/main 分叉（↑7 ↓5）→ 先对齐远端", "文档仓有 1 个孤儿 worktree 条目（heliu hygiene 查看，人工确认后清理）"]);
  });

  test("四组按顺序出现", () => {
    const idx = ["① 等你处理", "② 独立未合并", "③ 已进集成分支待回主线", "④ 落后需同步"].map((k) => lines.findIndex((l) => l.startsWith(k)));
    expect(idx.every((i) => i > 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("① 最多 8 条、全文折行不截断，超出给一行提示", () => {
    const block = section("① 等你处理", "② 独立未合并");
    expect(lines.find((l) => l.startsWith("① 等你处理"))).toBe("① 等你处理（12，均在文档仓）");
    expect(block.filter((l) => l.startsWith("  - ")).length).toBe(8);
    expect(block[block.length - 1]).toBe("  …还有 4 条，`heliu sessions` 查看");
    const start = block.findIndex((l) => l.includes("Live2D"));
    const wrapped = [block[start]!];
    for (let i = start + 1; block[i]!.startsWith("    "); i++) wrapped.push(block[i]!);
    expect(wrapped.length).toBeGreaterThan(1);
    expect(wrapped.join("").replace(/\s/g, "")).toContain(LONG_NEED.replace(/\s/g, ""));
    for (const l of block) expect(width(l)).toBeLessThanOrEqual(WIDTH);
  });

  test("② 最多 8 条、按最后提交倒序、跨仓库带仓库列，超出给一行提示", () => {
    const block = section("② 独立未合并", "③");
    expect(lines.find((l) => l.startsWith("② 独立未合并"))).toBe("② 独立未合并（19：文档仓 11 · App 仓 8）");
    expect(block[0]).toContain("仓库");
    const rows = block.slice(2, -1);
    expect(rows.length).toBe(8);
    const dates = rows.map((l) => /\d{4}-\d{2}-\d{2}$/.exec(l)?.[0] ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(block[block.length - 1]).toBe("  …还有 11 条，`--full` 查看");
    expect(text).not.toContain("claude/in-integ-0"); // 已进集成的不进 ②
  });

  test("③ 只给计数 + 一句话", () => {
    expect(text).toContain("③ 已进集成分支待回主线：文档仓 3 条（集成分支领先主线 102，3 天未并回）");
  });

  test("④ 全部落后时只给一句话；否则最多 5 条", () => {
    const block = section("④ 落后需同步", "提示：");
    expect(block[0]).toBe("  文档仓 11 条独立分支全部落后集成分支（最少 ↓3），合并前需同步基线");
    expect(block[1]).toBe("  App 仓 6 条落后主线，落后最多的 5 条：");
    const items = block.slice(2);
    expect(items.length).toBe(5);
    expect(items[0]).toContain("feat/app-5 · ↓45");
    expect(text).not.toContain("feat/app-0 · ↓40"); // 第 6 条不列
  });

  test("--full 仍是全部分支长表", () => {
    const full = renderStatusFull(rep);
    expect(full.split("\n")[1]).toBe(LEGEND);
    expect(full).toContain("会话（状态·标题）");
    expect(full).toContain("claude/in-integ-0");
    expect(full).toContain("合并状态");
  });

  test("有会话明细时 ① 按会话列，缺 needs_action 时用 status_detail", () => {
    const sv: SessionView = {
      sessionId: "x", cliSessionId: null, title: "没写待办的会话", repo: "docs", branch: null, worktreeName: null, worktreePath: null,
      cwd: null, status: "blocked", statusCategory: "blocked", statusDetail: "等你确认是否继续", needsAction: null, isArchived: false, running: null,
      createdAt: null, lastActivityAt: "2026-10-25T10:00:00.000Z", completedTurns: 1, model: null, spawnedFrom: null, prs: [],
    };
    const t = renderStatusSummary(rep, { width: WIDTH, sessions: [sv] });
    expect(t).toContain("① 等你处理（1，均在文档仓）");
    expect(t).toContain("  - 没写待办的会话：等你确认是否继续");
  });
});

describe("sessions 默认只列等你 + 运行中", () => {
  const mk = (id: string, status: SessionView["status"], extra: Partial<SessionView> = {}): SessionView => ({
    sessionId: id, cliSessionId: null, title: `会话 ${id}`, repo: "docs", branch: `claude/${id}`, worktreeName: id, worktreePath: null, cwd: null,
    status, statusCategory: status === "blocked" ? "blocked" : null, statusDetail: null, needsAction: null, isArchived: status === "archived",
    running: status === "running" ? "busy" : null, createdAt: null, lastActivityAt: "2026-10-25T10:00:00.000Z", completedTurns: 1, model: null,
    spawnedFrom: null, prs: [], ...extra,
  });
  const list = [
    mk("a", "blocked", { needsAction: LONG_NEED, prs: [{ number: 4, repo: null, url: null, branch: null, state: "OPEN" }] }),
    mk("b", "running"),
    mk("c", "online"),
    mk("d", "completed"),
    mk("e", "archived"),
    mk("f", "review_ready"),
  ];

  test("默认：两组 + 全文；已完成/已归档不显示，只给计数", () => {
    const t = renderSessions("演示", list, { width: WIDTH });
    expect(t).toContain("■ 等你处理（1）");
    expect(t).toContain("■ 运行中（2，含在线空闲）");
    expect(t).toContain("PR #4 open");
    expect(t.replace(/\s/g, "")).toContain(LONG_NEED.replace(/\s/g, ""));
    expect(t).not.toContain("会话 d");
    expect(t).not.toContain("会话 e");
    expect(t).toContain("--all 显示其余 3 条（待验收 1 · 已完成 1 · 已归档 1）");
    for (const l of t.split("\n")) expect(width(l)).toBeLessThanOrEqual(WIDTH);
  });

  test("默认最多 8 条等你，其余提示 --all；--all 全列", () => {
    const many = Array.from({ length: 11 }, (_, i) => mk(`w${i}`, "blocked", { needsAction: `事 ${i}` }));
    const t = renderSessions("演示", [...many, mk("r", "running")], { width: WIDTH });
    expect(t).toContain("■ 等你处理（11）");
    expect(t.split("\n").filter((l) => l.startsWith("    需要你：")).length).toBe(8);
    expect(t).toContain("…还有 3 条等你，`heliu sessions --all` 查看");
    expect(t).toContain("■ 运行中（1，含在线空闲）");
    const all = renderSessions("演示", many, { width: WIDTH, all: true });
    expect(all.split("\n").filter((l) => l.startsWith("    需要你：")).length).toBe(11);
  });

  test("--all：追加其余会话表", () => {
    const t = renderSessions("演示", list, { width: WIDTH, all: true });
    expect(t).toContain("■ 其余会话（3）");
    expect(t).toContain("会话 d");
    expect(t).toContain("会话 e");
  });
});

describe("折行工具", () => {
  test("中文逐字断、英文按空格断、不丢字", () => {
    const s = "complete `/mcp` → `qwennote` → \"Authenticate\" in terminal; authorize in browser; 然后回来告诉我已经完成了授权";
    const w = wrapText(s, 30);
    for (const l of w) expect(width(l)).toBeLessThanOrEqual(30);
    expect(w.join(" ").replace(/\s+/g, "")).toBe(s.replace(/\s+/g, ""));
    expect(w[0]).toBe("complete `/mcp` → `qwennote` →"); // 在空格处断，不切开单词
  });
  test("悬挂缩进与原文换行", () => {
    const out = hangingWrap("需要你：", "第一行\n第二行很长很长很长很长很长很长", 20);
    expect(out[0]).toBe("需要你：第一行");
    expect(out.slice(1).every((l) => l.startsWith("        "))).toBe(true);
  });
});
