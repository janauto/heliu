/**
 * 方块模型（M10，纯函数、不依赖 DOM / preact，可单测）：
 * 功能卡 / 没卡的分支 → 方块的人话、事实、芯片；待办分组 → 人话 / 颜色；全局搜索匹配。
 * 人话只从服务端的 light / group / variant / done 推，前端不自己判断 git 事实。
 */
import type { BoardCard, CardBinding, Light } from "../src/board/api-types.ts";
import { inferModule, inferType, TYPE_GLYPH, type FeatureType } from "../src/core/classify.ts";
import type { FeatureView, TodoGroupKey } from "../src/types.ts";

/* ───────────── 语义 ───────────── */

export type Tone = "green" | "yellow" | "red" | "purple" | "gray" | "blue" | "accent";

/** 状态灯 → 人话 */
export const HUMAN: Record<Light | "blue", string> = {
  green: "能拼上",
  yellow: "要先对齐",
  red: "撞了",
  purple: "等你拍板",
  gray: "还在做",
  blue: "还没登记",
};
/** 待办分组 → 人话 / 颜色（顺序 = 处理优先级） */
export const GROUPS: Array<{ key: TodoGroupKey; human: string; tone: Tone; hint: string }> = [
  { key: "blocked", human: "等你拍板", tone: "purple", hint: "会话停下来等你回答" },
  { key: "conflict", human: "撞了", tone: "red", hint: "试合有冲突文件，合并前要先解" },
  { key: "mergeable", human: "能拼上", tone: "green", hint: "试合无冲突，或已进集成分支" },
  { key: "behind", human: "要先对齐", tone: "yellow", hint: "分支落后基线，先同步再合" },
  { key: "active", human: "还在做", tone: "gray", hint: "开发中，或尚无提交" },
  { key: "stale", human: "没动静", tone: "gray", hint: "很久没有活动" },
  { key: "unbound", human: "还没绑分支", tone: "gray", hint: "卡片还没有绑定任何分支" },
];
export const toneOfGroup = (g: TodoGroupKey | null): Tone => GROUPS.find((x) => x.key === g)?.tone ?? "gray";
export const humanOfGroup = (g: TodoGroupKey | null): string => GROUPS.find((x) => x.key === g)?.human ?? "还在做";

export const MILESTONE_TONE: Record<string, Tone> = { 规划中: "accent", 冻结: "yellow", 合并中: "purple", 已发布: "green" };

/* ───────────── 方块数据模型 ───────────── */

export interface BlockChip {
  text: string;
  tone: Tone;
  title?: string;
}
export interface BlockModel {
  /** 唯一键：卡号，或「repo|branch」 */
  key: string;
  /** 卡号；没卡的分支为 null */
  id: string | null;
  title: string;
  type: string;
  typeGuess: boolean;
  module: string;
  light: Light | "blue";
  /** 人话 */
  human: string;
  /** 人话后面的小字事实 */
  fact: string | null;
  repoLabel: string | null;
  branch: string | null;
  /** 显示用的预约名；null = 未预约 */
  milestone: string | null;
  lastActivityAt: string | null;
  chips: BlockChip[];
  variant: "normal" | "merged-pending" | "done";
  needsAction: string | null;
}

const sumConflicts = (bs: CardBinding[]): number => bs.reduce((a, b) => a + (b.conflictFiles ?? 0), 0);
const maxBehind = (bs: CardBinding[]): { n: number; of: string } | null => {
  let best: { n: number; of: string } | null = null;
  for (const b of bs) {
    const vi = b.vsIntegration?.behind ?? null;
    const vm = b.vsMain?.behind ?? null;
    const n = vi ?? vm ?? 0;
    const of = vi !== null ? "集成分支" : "主线";
    if (n > 0 && (!best || n > best.n)) best = { n, of };
  }
  return best;
};

/** 功能卡 → 方块。next = 当前下一版的 id（卡里写的 next 字面量显示成它） */
export function modelOfCard(card: BoardCard, opts: { next?: string | null; milestoneTitle?: string | null } = {}): BlockModel {
  const chips: BlockChip[] = [];
  const behind = maxBehind(card.bindings);
  const conflicts = sumConflicts(card.bindings);
  const failed = card.bindings.some((b) => b.precheckState === "failed");
  if (!card.done) {
    if (behind) chips.push({ text: `落后 ${behind.n}`, tone: "yellow", title: `落后${behind.of} ${behind.n} 个提交，合并前要先同步` });
    if (conflicts > 0) chips.push({ text: `${conflicts} 个文件撞了`, tone: "red", title: "试合（merge-tree）发现的冲突文件数" });
    if (failed) chips.push({ text: "没试出来", tone: "yellow", title: "请求了试合但没得到结果：不算无冲突" });
    if (!card.bindings.length) chips.push({ text: "没绑分支", tone: "gray" });
    if (card.bindings.length && card.bindings.every((b) => !b.exists)) chips.push({ text: "分支不在本地", tone: "gray" });
  }
  if (card.rolledFrom.length) chips.push({ text: `从 ${card.rolledFrom[card.rolledFrom.length - 1]} 顺延`, tone: "gray" });
  if (card.acceptance !== "未") chips.push({ text: `验收 ${card.acceptance}`, tone: "green" });

  let human: string;
  let fact: string | null = null;
  if (card.done) {
    human = card.status === "已发布" ? "已发布" : card.status === "已进主线" ? "已进主线" : "已合入";
    fact = card.doneNote;
  } else if (card.variant === "merged-pending") {
    human = "已合入 · 等你确认台账";
    fact = card.mergedTo ? `分支已被${card.mergedTo === "已进主线" ? "主线" : "集成分支"}包含，台账还是「${card.status}」` : card.lightText;
  } else if (card.light === "purple") {
    human = "等你拍板";
    fact = card.needsAction?.trim() ? card.needsAction.trim().split("\n")[0]! : card.lightText;
  } else if (card.light === "gray") {
    if (card.group === "unbound") human = "还没绑分支";
    else if (card.group === "stale") {
      human = `没动静 ${card.idleDays ?? "?"} 天`;
    } else {
      human = "还在做";
      fact = card.note ?? (card.status === "想法" ? "还是个想法" : null);
    }
  } else {
    human = HUMAN[card.light];
    if (card.light === "green") fact = card.note ?? "试合无冲突";
    else if (card.light === "yellow") fact = behind ? `落后${behind.of} ${behind.n} 个提交，先同步再合` : card.lightText;
    else if (card.light === "red") fact = conflicts ? `合并前要先解 ${conflicts} 个文件` : card.lightText;
  }
  const repos = [...new Set(card.bindings.map((b) => b.repoLabel))];
  const first = card.bindings[0] ?? null;
  const ms = card.column === "__unreserved" ? null : card.milestone === "next" ? (opts.next ?? "下一版") : (opts.milestoneTitle ?? card.milestone);
  return {
    key: card.id,
    id: card.id,
    title: card.title,
    type: card.type,
    typeGuess: card.typeSource === "guess",
    module: card.module,
    light: card.light,
    human,
    fact,
    repoLabel: repos.length ? repos.join(" · ") : null,
    branch: first ? (first.label ?? first.branch) : null,
    milestone: ms,
    lastActivityAt: card.lastActivityAt,
    chips,
    variant: card.variant,
    needsAction: card.needsAction,
  };
}

/** 没卡的分支（/api/status 里的 FeatureView）→ 蓝色「还没登记」方块 */
export function modelOfBranch(f: FeatureView, repo: { id: string; label: string }, modules?: Array<{ name: string; keywords: string[] }>): BlockModel {
  const text = [f.label, f.branch, f.lastCommitSubject].filter(Boolean).join(" ");
  const chips: BlockChip[] = [];
  const vi = f.vsIntegration?.behind ?? null;
  const behind = vi ?? f.vsMain?.behind ?? 0;
  if (behind > 0) chips.push({ text: `落后 ${behind}`, tone: "yellow", title: `落后${vi !== null ? "集成分支" : "主线"} ${behind} 个提交` });
  const conflicts = f.precheck?.conflictFiles ?? 0;
  if (conflicts > 0) chips.push({ text: `${conflicts} 个文件撞了`, tone: "red" });
  if (f.sessionEntry) chips.push({ text: "会话入口 · 尚无提交", tone: "gray", title: "这条分支没有自己的提交，多半只是桌面会话的入口" });
  if (!f.pushed) chips.push({ text: "本地无远端引用", tone: "gray", title: "本地没有同名远端分支引用（heliu 从不 fetch，不等于远端一定没有）" });
  const s = f.sessions[0] ?? null;
  const fact =
    s?.status === "blocked" ? "会话等你拍板" : f.mergedState === "in_integration" ? "分支已进集成分支" : f.mergedState === "in_main" ? "分支已进主线" : s ? `会话：${s.title ?? s.sessionId.slice(0, 8)}` : null;
  const type: FeatureType = inferType(text);
  return {
    key: `${repo.id}|${f.branch}`,
    id: null,
    title: f.label || f.branch,
    type,
    typeGuess: true,
    module: inferModule(text, modules as never),
    light: "blue",
    human: "还没登记",
    fact,
    repoLabel: repo.label,
    branch: f.branch,
    milestone: null,
    lastActivityAt: s?.lastActivityAt && (!f.lastCommitAt || s.lastActivityAt > f.lastCommitAt) ? s.lastActivityAt : f.lastCommitAt,
    chips,
    variant: "normal",
    needsAction: s?.needsAction ?? null,
  };
}

export const glyphOf = (type: string): string => TYPE_GLYPH[type as FeatureType] ?? "○";

/** 搜索匹配：空关键词全部命中；否则任一字段包含（不分大小写） */
export function matchQuery(q: string, ...fields: Array<string | null | undefined>): boolean {
  const k = q.trim().toLowerCase();
  if (!k) return true;
  return fields.some((f) => !!f && f.toLowerCase().includes(k));
}
