/** @jsxImportSource preact */
/**
 * 应用状态（M10）：当前项目、页签、刷新计数、冲突检查、全局搜索、集中加载的 status / overview / features / milestones、
 * toast（带撤销）与右侧详情的选中项。所有视图通过 useApp() 拿，不再层层传 props。
 */
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { BoardCard, BoardMeta, FeaturesData, OverviewData, ProjectsData } from "../src/board/api-types.ts";
import type { FeatureView, LedgerMilestone, ReconcileReport } from "../src/types.ts";
import type { IconName } from "./ui.tsx";

export type Tab = "home" | "kanban" | "timeline" | "assembly" | "structure" | "sessions" | "hygiene" | "start" | "galaxy";

export interface TabDef {
  key: Tab;
  title: string;
  icon: IconName;
  group: "work" | "know" | "more";
  desc: string;
}
export const TABS: TabDef[] = [
  { key: "home", title: "今天", icon: "home", group: "work", desc: "下一版还欠什么、现在最该做什么" },
  { key: "kanban", title: "看板", icon: "kanban", group: "work", desc: "按版本分列的方块，拖一下就是预约" },
  { key: "timeline", title: "时间线", icon: "timeline", group: "work", desc: "每一块什么时候在动、里程碑在哪" },
  { key: "assembly", title: "合流装配", icon: "assembly", group: "work", desc: "把这一版的方块按顺序摆上轨道，看能不能拼上" },
  { key: "structure", title: "结构", icon: "structure", group: "know", desc: "整机由哪些模块组成、每块在修还是在做" },
  { key: "sessions", title: "会话", icon: "sessions", group: "know", desc: "桌面会话：等你 / 运行中 / 已完成" },
  { key: "hygiene", title: "卫生", icon: "hygiene", group: "know", desc: "该清理的 worktree 与分支（只建议，不动手）" },
  { key: "start", title: "开始 / 接入", icon: "start", group: "more", desc: "检查环境、接入项目、五步上手" },
  { key: "galaxy", title: "星图", icon: "galaxy", group: "more", desc: "旧版宇宙视图：分支按时间与仓库泳道散布" },
];
export const tabDef = (t: Tab): TabDef => TABS.find((x) => x.key === t)!;

/** 旧地址兼容：#/overview → home、#/board → kanban、#/release → assembly */
const LEGACY: Record<string, Tab> = { overview: "home", board: "kanban", release: "assembly" };
export function tabFromHash(fallback: Tab): { tab: Tab; sub: string | null } {
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const raw = parts[0] ?? "";
  const key = (LEGACY[raw] ?? raw) as Tab;
  const tab = TABS.some((t) => t.key === key) ? key : fallback;
  return { tab, sub: parts[1] ? decodeURIComponent(parts[1]) : null };
}

export type Selection =
  | { kind: "card"; card: BoardCard }
  | { kind: "branch"; repo: string; repoLabel: string; branch: FeatureView; main: string; integration: string | null };

export interface PcState {
  state: "off" | "checking" | "on";
  at: string | null;
  error: string | null;
}
export interface ToastOpts {
  kind?: "ok" | "err" | "info";
  /** 5 秒内可撤销 */
  undo?: () => void | Promise<void>;
  ms?: number;
}

export interface AppState {
  project: string | null;
  projects: ProjectsData;
  reloadProjects(): void;
  tab: Tab;
  sub: string | null;
  go(tab: Tab, sub?: string | null): void;
  /** 刷新计数：变了就重拉 */
  tick: number;
  refresh(): void;
  /** 冲突检查（试合）是否已有结果 */
  precheck: boolean;
  pc: PcState;
  check(fresh: boolean): void;
  query: string;
  setQuery(q: string): void;
  status: ReconcileReport | null;
  statusError: string | null;
  statusLoading: boolean;
  meta: BoardMeta | null;
  overview: OverviewData | null;
  features: FeaturesData | null;
  featuresError: string | null;
  featuresLoading: boolean;
  reloadFeatures(): void;
  milestones: LedgerMilestone[];
  /** 下一版 id（第一个规划中的里程碑） */
  next: string | null;
  toast(text: string, opts?: ToastOpts): void;
  selected: Selection | null;
  select(sel: Selection | null): void;
  theme: "auto" | "light" | "dark";
  setTheme(t: "auto" | "light" | "dark"): void;
}

export const AppCtx = createContext<AppState | null>(null);
export function useApp(): AppState {
  const s = useContext(AppCtx);
  if (!s) throw new Error("AppCtx 未就绪：视图必须渲染在 <AppCtx.Provider> 里");
  return s;
}

/** 里程碑显示名：id（title 与 id 不同才加）；「next」字面量 → 下一版 */
export function milestoneLabel(id: string | null, milestones: LedgerMilestone[], next: string | null): string {
  if (!id) return "未预约";
  if (id === "next") return next ?? "下一版";
  const m = milestones.find((x) => x.id === id);
  return m && m.title && m.title !== m.id ? `${m.id} ${m.title}` : id;
}
