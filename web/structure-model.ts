/**
 * 结构页模型（M8，纯函数，便于测试）：把功能卡与"还没建卡的分支"按「模块 × 类型」汇总，挑出现在该决定的。
 * - 卡片的类型 / 模块来自 /api/features（卡片上写的 > 服务端推测）；没卡的分支用同一套规则在这里推测。
 * - 状态口径与版本列一致：等你 / 冲突 / 已合入待确认 / 可合并 / 落后 / 开发中 / 想法 / 已完成；没卡的分支 = 还没建卡。
 * 结构页只是汇总 + 下钻，不另起一套状态。
 */
import type { BoardCard, FeaturesData } from "../src/board/api-types.ts";
import { FEATURE_TYPES, OTHER_MODULE, inferModule, inferType, isFeatureType, type FeatureType, type ModuleDef } from "../src/core/classify.ts";
import type { ReconcileReport } from "../src/types.ts";
import { branchText } from "./galaxy-model.ts";

export type SState = "waiting" | "conflict" | "merged" | "mergeable" | "behind" | "stray" | "dev" | "idea" | "done";

/** 状态定义：顺序即"该决定"的优先级 */
export const STATES: Array<{ key: SState; title: string; tone: "purple" | "red" | "green" | "yellow" | "blue" | "gray"; hint: string; decide: boolean }> = [
  { key: "waiting", title: "等你回答", tone: "purple", hint: "绑定的会话停下来等你拍板", decide: true },
  { key: "conflict", title: "有冲突", tone: "red", hint: "试合有冲突文件，合并前要解", decide: true },
  { key: "merged", title: "已合入待确认", tone: "green", hint: "分支已被集成分支 / 主线包含，台账还是旧状态：点「同步一下」", decide: true },
  { key: "mergeable", title: "可合并", tone: "green", hint: "已进集成分支或试合无冲突，可以排进合并单", decide: true },
  { key: "behind", title: "落后需同步", tone: "yellow", hint: "落后基线，合并前先评估是否同步", decide: true },
  { key: "stray", title: "还没建卡", tone: "blue", hint: "有分支（还没进主线）没有功能卡，不知道它要进哪一版", decide: true },
  { key: "dev", title: "开发中", tone: "gray", hint: "正在推进（含停滞）", decide: false },
  { key: "idea", title: "想法", tone: "gray", hint: "还没关联开发分支", decide: false },
  { key: "done", title: "已完成", tone: "gray", hint: "已合入 / 已进主线 / 已发布", decide: false },
];
const ORDER = new Map(STATES.map((s, i) => [s.key, i]));
export const stateMeta = (k: SState) => STATES[ORDER.get(k)!]!;

export interface SItem {
  /** 星图里的 key（b:仓库:分支 / k:卡号），用于"星图里看" */
  key: string;
  cardId: string | null;
  title: string;
  type: FeatureType;
  typeSource: "card" | "guess";
  module: string;
  moduleSource: "card" | "guess";
  state: SState;
  nextStep: string;
  /** 预约的版本（列标题）；没卡的分支为 null */
  milestone: string | null;
  lastAt: string | null;
  repos: string[];
  /** 没卡的分支：改类型 / 模块时据此建卡 */
  bind: { repo: string; branch: string } | null;
  /** 主状态不是「已合入待确认」（例如还在等你），但分支其实已经合进去了：也列进「已合入待确认」，与「同步一下」一致 */
  alsoMerged: boolean;
}

export interface SModule {
  name: string;
  items: SItem[];
  open: number;
  done: number;
  byType: Partial<Record<FeatureType, number>>;
  byState: Partial<Record<SState, number>>;
  /** 最需要决定的前三项 */
  top: SItem[];
}

export interface StructureModel {
  modules: SModule[];
  /** 出现过的类型（矩阵的列） */
  types: FeatureType[];
  /** 模块 → 类型 → 数量 / 其中"等你或有冲突"（矩阵上的小红点只标最急的） */
  matrix: Record<string, Partial<Record<FeatureType, { n: number; hot: number }>>>;
  /** 每种"该决定"状态下的全部条目（跨模块） */
  decisions: Partial<Record<SState, SItem[]>>;
  total: number;
}

function cardState(c: BoardCard): SState {
  if (c.done) return "done";
  if (c.variant === "merged-pending") return "merged";
  switch (c.group) {
    case "blocked":
      return "waiting";
    case "conflict":
      return "conflict";
    case "mergeable":
      return "mergeable";
    case "behind":
      return "behind";
    case "unbound":
      return "idea";
    default:
      return "dev";
  }
}

const byUrgency = (a: SItem, b: SItem) => ORDER.get(a.state)! - ORDER.get(b.state)! || Date.parse(b.lastAt ?? "1970") - Date.parse(a.lastAt ?? "1970");

export function buildStructure(report: ReconcileReport, features: FeaturesData): StructureModel {
  const defs: ModuleDef[] = features.modules.length ? features.modules : [];
  const items: SItem[] = [];
  const bound = new Set<string>();
  const titleOf = new Map(features.columns.map((c) => [c.key, c.title]));
  for (const col of features.columns)
    for (const c of col.cards) {
      for (const b of c.bindings) if (b.exists) bound.add(`${b.repo}|${b.branch}`);
      const live = c.bindings.find((b) => b.exists);
      items.push({
        key: live ? `b:${live.repo}:${live.branch}` : `k:${c.id}`,
        cardId: c.id,
        title: c.title,
        type: isFeatureType(c.type) ? c.type : "其他",
        typeSource: c.typeSource,
        module: c.module || OTHER_MODULE,
        moduleSource: c.moduleSource,
        state: cardState(c),
        nextStep: c.nextStep,
        milestone: c.column === "__unreserved" ? null : (titleOf.get(c.column) ?? c.column),
        lastAt: c.lastActivityAt,
        repos: [...new Set(c.bindings.map((b) => b.repoLabel))],
        bind: null,
        alsoMerged: false,
      });
      const it = items[items.length - 1]!;
      if (c.mergedTo && it.state !== "done" && it.state !== "merged") it.alsoMerged = true;
    }
  // 还没建卡、也还没进主线的分支（与星图"还没建卡"同一口径）
  for (const r of report.repos) {
    if (!r.reachable) continue;
    for (const b of r.branches) {
      if (b.role !== "feature" || b.mergedState === "in_main" || bound.has(`${r.id}|${b.branch}`)) continue;
      const text = branchText(b);
      items.push({
        key: `b:${r.id}:${b.branch}`,
        cardId: null,
        title: b.label,
        type: inferType(text),
        typeSource: "guess",
        module: inferModule(text, defs.length ? defs : undefined),
        moduleSource: "guess",
        state: "stray",
        nextStep: b.mergedState === "in_integration" ? "已进集成分支，但没有功能卡：要记进某一版，就在星图里拖到版本行星" : "还没有功能卡：在星图里拖到版本行星即可建卡并预约",
        milestone: null,
        lastAt: b.lastCommitAt,
        repos: [r.label],
        bind: { repo: r.id, branch: b.branch },
        alsoMerged: false,
      });
    }
  }

  // 模块顺序：模块定义的顺序（空间位置稳定，方便记）→ 卡片上手写的其他模块 →「其他」最后
  const names: string[] = [];
  for (const d of defs) names.push(d.name);
  for (const it of items) if (!names.includes(it.module) && it.module !== OTHER_MODULE) names.push(it.module);
  names.push(OTHER_MODULE);

  const modules: SModule[] = [];
  const matrix: StructureModel["matrix"] = {};
  for (const name of names) {
    const mine = items.filter((i) => i.module === name).sort(byUrgency);
    if (!mine.length) continue;
    const byType: SModule["byType"] = {};
    const byState: SModule["byState"] = {};
    const row: Partial<Record<FeatureType, { n: number; hot: number }>> = {};
    for (const i of mine) {
      byType[i.type] = (byType[i.type] ?? 0) + 1;
      byState[i.state] = (byState[i.state] ?? 0) + 1;
      const cell = row[i.type] ?? (row[i.type] = { n: 0, hot: 0 });
      cell.n += 1;
      if (i.state === "waiting" || i.state === "conflict") cell.hot += 1;
    }
    matrix[name] = row;
    const done = mine.filter((i) => i.state === "done").length;
    modules.push({ name, items: mine, open: mine.length - done, done, byType, byState, top: mine.filter((i) => stateMeta(i.state).decide).slice(0, 3) });
  }
  const decisions: StructureModel["decisions"] = {};
  for (const s of STATES) if (s.decide) {
    const list = items.filter((i) => i.state === s.key || (s.key === "merged" && i.alsoMerged)).sort(byUrgency);
    if (list.length) decisions[s.key] = list;
  }
  const types = FEATURE_TYPES.filter((t) => items.some((i) => i.type === t));
  return { modules, types, matrix, decisions, total: items.length };
}
