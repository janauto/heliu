/**
 * 渲染层测试：用手工构造的对账结果，断言行动摘要的分组、全文折行、措辞与图例。
 */
import { describe, expect, test } from "bun:test";
import { FULL_HINT, LEGEND, REMOTE_NOTE, renderSessions, renderStatusFull, renderStatusSummary } from "../src/cli/render.ts";
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

const branches: FeatureView[] = [
  fv({ branch: "main", role: "main", mergedState: "in_main", label: "主线", vsMain: null }),
  fv({ branch: "integ", role: "integration", vsIntegration: null, vsMain: { ahead: 102, behind: 0 } }),
  fv({ branch: "claude/live2d-98f128", label: "Live2D 交互角色可行性评估", sessions: [blocked("s1", "Live2D 交互角色可行性评估", LONG_NEED)] }),
  fv({ branch: "claude/no-need-111111", label: "没写待办的会话", sessions: [blocked("s2", "没写待办的会话", null)] }),
  fv({ branch: "claude/merged-222222", mergedState: "in_main", label: "已进主线的也照样提醒", vsIntegration: { ahead: 0, behind: 50 }, sessions: [blocked("s3", "已进主线的也照样提醒", "拔掉 USB 再插回")] }),
  ...Array.from({ length: 7 }, (_, i) => fv({ branch: `claude/old-${i}-abcdef`, label: `老分支 ${i}` })),
  ...Array.from({ length: 3 }, (_, i) => fv({ branch: `claude/in-integ-${i}`, mergedState: "in_integration", vsIntegration: { ahead: 0, behind: 9 } })),
];
const sessions: SessionView[] = [
  {
    sessionId: "s2", cliSessionId: null, title: "没写待办的会话", repo: "docs", branch: "claude/no-need-111111", worktreeName: null, worktreePath: null,
    cwd: null, status: "blocked", statusCategory: "blocked", statusDetail: "等你确认是否继续", needsAction: null, isArchived: false, running: null,
    createdAt: null, lastActivityAt: "2026-10-25T10:00:00.000Z", completedTurns: 1, model: null, spawnedFrom: null, prs: [],
  },
];
const WIDTH = 80;
const rep = report([
  repo({ branches }),
  repo({ id: "app", label: "App 仓", integration: null, health: { ...repo({}).health!, integration: null }, branches: [fv({ branch: "feat/x", label: "X", vsIntegration: null, vsMain: { ahead: 2, behind: 47 } })] }),
  repo({ id: "gone", label: "缺失仓", reachable: false, error: "路径不存在", counts: null, health: null }),
]);
const text = renderStatusSummary(rep, { width: WIDTH, sessions });
const lines = text.split("\n");

describe("status 默认：行动摘要", () => {
  test("图例在健康条上方，健康条末尾有远端口径括注，措辞改为「本地无远端引用」", () => {
    expect(lines[1]).toBe(LEGEND);
    expect(lines.indexOf("健康条")).toBeGreaterThan(1);
    expect(text).toContain(`  ${REMOTE_NOTE}`);
    expect(text).toContain("本地无远端引用 7");
    expect(text).not.toContain("从未推送");
    expect(lines[lines.length - 1]).toBe(FULL_HINT);
  });

  test("四组按顺序出现", () => {
    const docsStart = lines.findIndex((l) => l.startsWith("■ 文档仓"));
    const idx = ["① 等你处理", "② 独立未合并", "③ 已进集成分支待回主线", "④ 落后需同步"].map((k) => lines.findIndex((l, i) => i > docsStart && l.includes(k)));
    expect(idx.every((i) => i > docsStart)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("① 等你处理：needs_action 全文、不截断、按宽度折行；缺文案时用 status_detail", () => {
    expect(text).toContain("① 等你处理（3）");
    const start = lines.findIndex((l) => l.includes("需要你：确认："));
    const block: string[] = [];
    for (let i = start; i < lines.length && (i === start || lines[i]!.startsWith("              ")); i++) block.push(lines[i]!);
    expect(block.length).toBeGreaterThan(1); // 确实折行了
    const joined = block.map((l, i) => (i === 0 ? l.replace(/^\s*需要你：/, "") : l.trim())).join("");
    expect(joined.replace(/\s/g, "")).toBe(LONG_NEED.replace(/\s/g, ""));
    expect(text).not.toContain("…" + "（建议）");
    expect(text).toContain("需要你：等你确认是否继续");
    expect(text).toContain("需要你：拔掉 USB 再插回"); // 已进主线的分支也提醒
  });

  test("① 与 ④ 的条目行都不超过输出宽度（折行/截断生效；② 是表格、健康条是单行，不在此列）", () => {
    let inBlock = false;
    let checked = 0;
    for (const l of lines) {
      if (l.includes("① 等你处理") || l.includes("④ 落后需同步")) inBlock = true;
      else if (l.includes("② 独立未合并") || l.startsWith("■ ") || l === "") inBlock = false;
      else if (inBlock) {
        expect(width(l)).toBeLessThanOrEqual(WIDTH);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  test("② 独立未合并：只含未进主线也未进集成的功能分支，列出标签/分支/领先落后/最后提交", () => {
    expect(text).toContain("② 独立未合并（9）");
    const hdr = lines.find((l) => l.includes("标签") && l.includes("最后提交"))!;
    expect(hdr).toContain("主线↑/↓");
    expect(hdr).toContain("集成↑/↓");
    expect(text).not.toContain("claude/in-integ-0  "); // 已进集成的不进 ②
  });

  test("③ 只给计数 + 一句话；未配置集成分支时说明", () => {
    expect(text).toContain("③ 已进集成分支待回主线：3 条 · 集成分支领先主线 102，3 天未并回");
    expect(text).toContain("③ 已进集成分支待回主线：未配置集成分支");
  });

  test("④ 落后需同步：计数 + 前 5 条，按落后数倒序；无集成分支时相对主线", () => {
    expect(text).toContain("④ 落后需同步（相对集成分支，9 条），落后最多的 5 条：");
    const start = lines.findIndex((l) => l.includes("④ 落后需同步（相对集成分支"));
    const items = lines.slice(start + 1, start + 7).filter((l) => l.startsWith("    - "));
    expect(items.length).toBe(5);
    const nums = items.map((l) => Number(/↓(\d+)$/.exec(l)?.[1]));
    expect([...nums].sort((a, b) => b - a)).toEqual(nums);
    expect(text).toContain("④ 落后需同步（相对主线，1 条）：");
    expect(text).toContain("X · feat/x · ↓47");
  });

  test("App 仓无集成分支时不显示集成列；不可达仓库给原因", () => {
    const appStart = lines.findIndex((l) => l.startsWith("■ App 仓"));
    const hdr = lines.slice(appStart).find((l) => l.includes("标签") && l.includes("最后提交"))!;
    expect(hdr).not.toContain("集成↑/↓");
    expect(text).toContain("✗ 路径不存在，已跳过");
  });

  test("--full 仍是全部分支长表", () => {
    const full = renderStatusFull(rep);
    expect(full.split("\n")[1]).toBe(LEGEND);
    expect(full).toContain("会话（状态·标题）");
    expect(full).toContain("claude/in-integ-0");
    expect(full).toContain("合并状态");
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
