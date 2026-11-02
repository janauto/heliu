/**
 * M10：方块语言的纯函数——功能卡 / 没卡的分支 → 方块模型（人话、事实、芯片），以及全局搜索匹配。
 * 人话只从服务端的 light / group / variant / done 推，这里锁定映射，防止前端自己「判断 git 事实」。
 */
import { describe, expect, test } from "bun:test";
import type { BoardCard, CardBinding } from "../src/board/api-types.ts";
import type { FeatureView } from "../src/types.ts";
import { matchQuery, modelOfBranch, modelOfCard } from "../web/block-model.ts";

function binding(o: Partial<CardBinding> = {}): CardBinding {
  return {
    repo: "docs",
    repoLabel: "文档仓",
    branch: "claude/foo-123",
    label: "来电路由",
    randomName: true,
    exists: true,
    role: "feature",
    mergedState: "unmerged",
    vsMain: { ahead: 3, behind: 0 },
    vsIntegration: { ahead: 3, behind: 0 },
    integration: "integ",
    main: "main",
    precheckTarget: "integ",
    conflictFiles: 0,
    conflicts: [],
    precheckError: null,
    precheckState: "checked",
    lastCommitAt: "2026-10-30T10:00:00.000Z",
    worktree: "/tmp/wt",
    session: null,
    sessionEntry: false,
    ...o,
  };
}

function card(o: Partial<BoardCard> = {}): BoardCard {
  return {
    id: "F-0041",
    title: "AI 电话助手来电路由",
    status: "开发中",
    acceptance: "未",
    milestone: "next",
    column: "vNext",
    rolledFrom: [],
    source: "session",
    group: "active",
    light: "gray",
    lightText: "开发中",
    needsAction: null,
    note: null,
    suggestion: null,
    suggestStatus: null,
    variant: "normal",
    nextStep: "",
    tags: [],
    lastActivityAt: "2026-10-31T08:00:00.000Z",
    idleDays: 1,
    done: false,
    doneNote: null,
    bindings: [binding()],
    file: "/ledger/features/F-0041.md",
    type: "功能",
    typeSource: "guess",
    module: "通话与秘书",
    moduleSource: "guess",
    mergedTo: null,
    ...o,
  };
}

describe("modelOfCard：人话与事实", () => {
  test("能拼上：事实用服务端的 note", () => {
    const m = modelOfCard(card({ light: "green", group: "mergeable", note: "已进集成分支" }), { next: "vNext" });
    expect(m.human).toBe("能拼上");
    expect(m.fact).toBe("已进集成分支");
    expect(m.light).toBe("green");
    expect(m.milestone).toBe("vNext"); // 卡里写的 next 字面量显示成下一版 id
    expect(m.chips.map((c) => c.text)).toEqual([]);
  });

  test("要先对齐：落后取各绑定里最大的，优先集成分支", () => {
    const m = modelOfCard(
      card({
        light: "yellow",
        group: "behind",
        bindings: [binding({ vsIntegration: { ahead: 1, behind: 12 }, vsMain: { ahead: 1, behind: 40 } }), binding({ repo: "fw", repoLabel: "固件仓", vsIntegration: null, vsMain: { ahead: 0, behind: 5 } })],
      }),
    );
    expect(m.human).toBe("要先对齐");
    expect(m.fact).toContain("集成分支 12");
    expect(m.chips.map((c) => c.text)).toContain("落后 12");
    expect(m.repoLabel).toBe("文档仓 · 固件仓");
  });

  test("撞了：冲突文件数是各绑定之和，没试出来单独标", () => {
    const m = modelOfCard(
      card({
        light: "red",
        group: "conflict",
        bindings: [binding({ conflictFiles: 2, conflicts: ["a", "b"] }), binding({ repo: "fw", repoLabel: "固件仓", conflictFiles: 3, conflicts: ["x", "y", "z"], precheckState: "checked" }), binding({ repo: "app", repoLabel: "App 仓", conflictFiles: null, precheckState: "failed", precheckError: "超时" })],
      }),
    );
    expect(m.human).toBe("撞了");
    expect(m.fact).toBe("合并前要先解 5 个文件");
    const texts = m.chips.map((c) => c.text);
    expect(texts).toContain("5 个文件撞了");
    expect(texts).toContain("没试出来");
  });

  test("等你拍板：事实只取 needsAction 第一行", () => {
    const m = modelOfCard(card({ light: "purple", group: "blocked", needsAction: "要不要保留旧的按键路由？\n第二行细节" }));
    expect(m.human).toBe("等你拍板");
    expect(m.fact).toBe("要不要保留旧的按键路由？");
    expect(m.needsAction).toContain("第二行细节");
  });

  test("灰色按分组细分：还没绑分支 / 没动静 N 天 / 还在做", () => {
    expect(modelOfCard(card({ light: "gray", group: "unbound", bindings: [] })).human).toBe("还没绑分支");
    expect(modelOfCard(card({ light: "gray", group: "unbound", bindings: [] })).chips.map((c) => c.text)).toContain("没绑分支");
    expect(modelOfCard(card({ light: "gray", group: "stale", idleDays: 9 })).human).toBe("没动静 9 天");
    const active = modelOfCard(card({ light: "gray", group: "active", note: "尚无提交" }));
    expect(active.human).toBe("还在做");
    expect(active.fact).toBe("尚无提交");
  });

  test("已合入待确认：虚线方块，事实写出台账还是旧状态", () => {
    const m = modelOfCard(card({ light: "green", group: "mergeable", variant: "merged-pending", mergedTo: "已合入", status: "开发中" }));
    expect(m.human).toBe("已合入 · 等你确认台账");
    expect(m.fact).toContain("「开发中」");
    expect(m.variant).toBe("merged-pending");
  });

  test("已完成的卡：不再出落后 / 冲突芯片，人话写台账状态", () => {
    const m = modelOfCard(card({ done: true, status: "已发布", column: "__released", doneNote: "v1.1 发布", variant: "done", group: null, bindings: [binding({ vsMain: { ahead: 0, behind: 99 }, conflictFiles: 4, conflicts: ["a", "b", "c", "d"] })] }));
    expect(m.human).toBe("已发布");
    expect(m.fact).toBe("v1.1 发布");
    expect(m.chips.map((c) => c.text)).toEqual([]);
  });

  test("顺延与验收档位出芯片；未预约列的卡 milestone 为 null", () => {
    const m = modelOfCard(card({ column: "__unreserved", milestone: null, rolledFrom: ["v1.1", "v1.2"], acceptance: "已构建" }));
    expect(m.milestone).toBeNull();
    const texts = m.chips.map((c) => c.text);
    expect(texts).toContain("从 v1.2 顺延");
    expect(texts).toContain("验收 已构建");
  });
});

describe("modelOfBranch：没卡的分支", () => {
  const fv = (o: Partial<FeatureView> = {}): FeatureView => ({
    branch: "feat/aios-callsec",
    ref: "refs/heads/feat/aios-callsec",
    sha: "abc",
    role: "feature",
    mergedState: "unmerged",
    label: "通话安全 fix",
    labelSource: "session",
    randomName: false,
    lastCommitAt: "2026-10-29T00:00:00.000Z",
    lastCommitSubject: "fix: 修复通话掉线",
    vsMain: { ahead: 4, behind: 20 },
    vsIntegration: { ahead: 4, behind: 7 },
    upstream: null,
    pushed: false,
    worktree: null,
    sessions: [],
    precheck: null,
    ...o,
  });

  test("固定蓝色「还没登记」，类型按关键词推测，落后取集成分支", () => {
    const m = modelOfBranch(fv(), { id: "fw", label: "固件仓" });
    expect(m.light).toBe("blue");
    expect(m.human).toBe("还没登记");
    expect(m.id).toBeNull();
    expect(m.key).toBe("fw|feat/aios-callsec");
    expect(m.type).toBe("修复");
    expect(m.typeGuess).toBe(true);
    const texts = m.chips.map((c) => c.text);
    expect(texts).toContain("落后 7");
    expect(texts).toContain("本地无远端引用");
  });

  test("会话入口出芯片；会话等你时事实写出来；最后活动取会话与提交里更晚的", () => {
    const m = modelOfBranch(
      fv({
        sessionEntry: true,
        pushed: true,
        sessions: [{ sessionId: "s1", title: "会话甲", status: "blocked", statusCategory: null, needsAction: "要不要继续？", isArchived: false, lastActivityAt: "2026-10-31T00:00:00.000Z", link: "branch", prs: [] }],
      }),
      { id: "docs", label: "文档仓" },
    );
    expect(m.chips.map((c) => c.text)).toContain("会话入口 · 尚无提交");
    expect(m.fact).toBe("会话等你拍板");
    expect(m.lastActivityAt).toBe("2026-10-31T00:00:00.000Z");
    expect(m.needsAction).toBe("要不要继续？");
  });
});

describe("matchQuery", () => {
  test("空关键词全部命中；否则任一字段包含，不分大小写", () => {
    expect(matchQuery("", "a")).toBe(true);
    expect(matchQuery("  ", null)).toBe(true);
    expect(matchQuery("F-00", "F-0041", "标题")).toBe(true);
    expect(matchQuery("CALLSEC", "feat/aios-callsec")).toBe(true);
    expect(matchQuery("x", "abc", null, undefined)).toBe(false);
  });
});
