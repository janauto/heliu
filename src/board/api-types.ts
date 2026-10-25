/**
 * 看板（M3）API 的响应结构：服务端（src/board/*）与前端（web/*）共用，只含类型。
 * 复用 src/types.ts 的 M1/M2 结构；这里只追加看板派生出来的视图。
 */
import type {
  AcceptanceLevel,
  AheadBehind,
  BranchRole,
  FeatureSource,
  FeatureStatus,
  HygieneIssue,
  HygieneKind,
  JsonEnvelope,
  LedgerMilestone,
  MergedState,
  PrecheckState,
  PrecheckSummary,
  SessionStatus,
  TodoGroupKey,
} from "../types.ts";

/** 扫描元信息：数据时间与用时（右上角「数据时间 HH:MM:SS · 用时 0.7s」） */
export interface BoardMeta {
  scannedAt: string;
  scanMs: number;
  /** 是否命中 20 秒缓存 */
  cached: boolean;
  precheck: boolean;
}

/** 所有 /api/* 的外壳：JsonEnvelope + meta（不涉及扫描的接口 meta 为 null） */
export interface BoardEnvelope<T> extends JsonEnvelope<T> {
  meta: BoardMeta | null;
}

export interface BoardError {
  error: string;
}

/* ───────────── 版本列 / 功能卡 ───────────── */

/** 五色灯：绿=可合并、黄=落后需同步、红=有冲突、紫=等你回答、灰=停滞/无绑定/开发中 */
export type Light = "green" | "yellow" | "red" | "purple" | "gray";

export interface CardSession {
  id: string;
  title: string | null;
  status: SessionStatus | null;
  needsAction: string | null;
  lastActivityAt: string | null;
  /** 会话 JSON 里出现的 claude:// 链接；没有就是 null（不自造链接） */
  link: string | null;
}

export interface CardBinding {
  repo: string;
  repoLabel: string;
  branch: string;
  /** M1 标签（会话标题 > 首条独有提交 > …） */
  label: string | null;
  randomName: boolean;
  /** 分支在本地是否存在 */
  exists: boolean;
  role: BranchRole | null;
  mergedState: MergedState | null;
  vsMain: AheadBehind | null;
  /** 仓库无集成分支时为 null */
  vsIntegration: AheadBehind | null;
  integration: string | null;
  main: string;
  /** 试合目标（集成分支优先，否则主线）；冲突文件数 null = 未试合/出错 */
  precheckTarget: string | null;
  conflictFiles: number | null;
  conflicts: string[];
  precheckError: string | null;
  /** 试合三态（checked / failed / skipped）；不需要试合为 null。failed 绝不当成无冲突 */
  precheckState: PrecheckState | null;
  lastCommitAt: string | null;
  worktree: string | null;
  session: CardSession | null;
}

export type ColumnKind = "milestone" | "unreserved" | "released";

export interface CardTag {
  kind: "waiting" | "conflict" | "behind" | "stale" | "nocommit" | "precheck_failed";
  text: string;
}

export interface BoardCard {
  id: string;
  title: string;
  status: FeatureStatus;
  acceptance: AcceptanceLevel;
  /** 卡片 frontmatter 里写的预约（可能是 next） */
  milestone: string | null;
  /** 所在列 key（里程碑 id / __unreserved / __released） */
  column: string;
  rolledFrom: string[];
  source: FeatureSource;
  /** M2 待办分组（--precheck）；已完成/已发布的卡为 null */
  group: TodoGroupKey | null;
  light: Light;
  /** 灯旁的中文说明，如「有冲突 · 9 个文件」 */
  lightText: string;
  /** 等你回答时的 needs_action 原文 */
  needsAction: string | null;
  /** M2 组内细分：已进主线 / 已进集成分支 / 试合无冲突 / 尚无提交 */
  note: string | null;
  /** M2 给的台账状态建议（只建议，不自动改） */
  suggestion: string | null;
  /** 建议改成的状态（看板上可一键改；仍由用户点） */
  suggestStatus: FeatureStatus | null;
  /** 卡片样式：merged-pending =「已合入 · 待确认台账」（与「可合并 · 试合无冲突」区分） */
  variant: "normal" | "merged-pending" | "done";
  /** 卡片默认态只突出的一句话下一步，如「等你回答：…」「可合并（试合无冲突）」「需同步基线 ↓102」 */
  nextStep: string;
  /** 次要标签（一卡多标签） */
  tags: CardTag[];
  lastActivityAt: string | null;
  idleDays: number | null;
  /** 不计入「还欠」：台账状态已是 已合入/已进主线/已发布（口径同 M2 countsTowardTodo） */
  done: boolean;
  doneNote: string | null;
  bindings: CardBinding[];
  file: string;
}

export interface BoardColumn {
  key: string;
  kind: ColumnKind;
  title: string;
  milestone: LedgerMilestone | null;
  /** 是否可拖入（规划中的里程碑、未预约） */
  droppable: boolean;
  dropHint: string | null;
  /** 是否为「下一版」 */
  isNext: boolean;
  owed: number;
  mergeable: number;
  /** 未试合（precheck=false）时为 null =「未检查」 */
  conflict: number | null;
  /** 请求了试合但没得到结果的卡数（「未能试合 M」） */
  precheckFailed: number;
  waiting: number;
  /** 本列试合汇总（summarizePrecheck，与 heliu 待办 --precheck 同一个函数）；已发布列为 null */
  precheckSummary: PrecheckSummary | null;
  cards: BoardCard[];
}

export interface FeaturesData {
  columns: BoardColumn[];
  /** M2 待办分组定义（组名/说明以 src/core/todo.ts 为准）+ 对应灯色，前端图例直接用 */
  groups: Array<{ key: TodoGroupKey; title: string; hint: string; light: Light }>;
  /** 已放弃的卡数（不显示在列里） */
  abandoned: number;
  next: string | null;
  nextStatus: LedgerMilestone["status"] | null;
  /** 本次是否请求了试合 */
  precheck: boolean;
  /** 全部列合起来的试合汇总：已检查 / 部分完成 / 未完成 / 未检查 */
  precheckSummary: PrecheckSummary;
  /** 台账里无法解析的卡片文件 */
  broken: string[];
  ledgerDir: string;
}

/* ───────────── 总览 ───────────── */

export interface OverviewData {
  /** 「现在最该做的」（复用 M1 摘要逻辑，最多 3 句） */
  actions: string[];
  /** 等你处理的会话数 */
  waiting: number;
  /** 本地无远端引用合计 */
  neverPushed: number;
  /** 集成分支未并回（每仓库一条） */
  integrations: Array<{ repo: string; repoLabel: string; branch: string; ahead: number | null; days: number | null }>;
  hygieneWarnings: number;
  /** 各版本列的计数（与版本列列头一致） */
  columns: Array<{ key: string; title: string; kind: ColumnKind; isNext: boolean; owed: number; mergeable: number; conflict: number | null; precheckFailed: number; waiting: number }>;
  /** 当前下一版 */
  next: { id: string; status: LedgerMilestone["status"] } | null;
  precheck: boolean;
  /** 冲突计数所用试合扫描的时间（precheck=false 时为 null） */
  precheckAt: string | null;
  /** 试合汇总（顶部固定行用：已检查 / 部分完成 / 未检查） */
  precheckSummary: PrecheckSummary;
}

/* ───────────── 卫生 ───────────── */

export type HygieneCategoryKey = "cleanup" | "mismatch" | "orphan" | "copies";

export interface HygieneItem extends HygieneIssue {
  /** 建议命令（只显示，heliu 不执行）；没有合适命令为 null */
  suggestion: string | null;
}

export interface HygieneCategory {
  key: HygieneCategoryKey;
  title: string;
  hint: string;
  kinds: HygieneKind[];
  items: HygieneItem[];
}

export interface HygieneRepo {
  id: string;
  label: string;
  reachable: boolean;
  error: string | null;
  warnings: number;
  infos: number;
  categories: HygieneCategory[];
}

export interface HygieneData {
  repos: HygieneRepo[];
}

/* ───────────── 同步基线（预演） ───────────── */

export interface BaselineCheck {
  /** main = 主线合入本分支；integration = 集成分支合入本分支 */
  base: "main" | "integration";
  baseBranch: string;
  /** 本分支落后该基线的提交数 */
  behind: number | null;
  conflictFiles: number | null;
  conflicts: string[];
  error: string | null;
}

export interface BaselineBinding {
  repo: string;
  repoLabel: string;
  branch: string;
  exists: boolean;
  checks: BaselineCheck[];
}

export interface BaselineData {
  id: string;
  title: string;
  bindings: BaselineBinding[];
  elapsedMs: number;
}

/* ───────────── 合并预演 ───────────── */

/** 建议顺序：已进集成 → 无冲突 → 有冲突 → 未能试合 → 未完成 */
export type ReleaseTier = "in_integration" | "clean" | "conflict" | "precheck_failed" | "unfinished";
/** 建议动作：跳过（已在集成分支）/ 合入 / 需解冲突 / 重新试合或人工确认 / 顺延 */
export type ReleaseAction = "skip" | "merge" | "resolve" | "recheck" | "defer";

export interface ReleaseBinding {
  repo: string;
  repoLabel: string;
  branch: string;
  exists: boolean;
  sha: string | null;
  mergedState: MergedState | null;
  precheckTarget: string | null;
  conflictFiles: number | null;
  conflicts: string[];
  precheckError: string | null;
  precheckState: PrecheckState | null;
  behindIntegration: number | null;
  behindMain: number | null;
}

export interface ReleaseItem {
  order: number;
  id: string;
  title: string;
  status: FeatureStatus;
  tier: ReleaseTier;
  tierText: string;
  action: ReleaseAction;
  actionText: string;
  /** 为什么进这一档（事实） */
  reason: string;
  needsAction: string | null;
  todoGroup: TodoGroupKey;
  bindings: ReleaseBinding[];
}

export interface ReleaseRepoRef {
  repo: string;
  repoLabel: string;
  main: string;
  mainSha: string | null;
  integration: string | null;
  /** 预演时集成分支所在提交（M4 执行前校验 old_sha） */
  integrationSha: string | null;
}

export interface ReleasePreview {
  milestone: LedgerMilestone;
  generatedAt: string;
  scanMs: number;
  repos: ReleaseRepoRef[];
  items: ReleaseItem[];
  counts: Record<ReleaseTier, number>;
  /** 预计顺延（未完成档）的卡号 */
  deferred: string[];
  /** M2 的台账状态建议（如「是否把 F-0003 标为已合入？」），只展示 */
  suggestions: Array<{ id: string; text: string }>;
}

export interface ReleasePlanResult {
  file: string;
  /** 覆盖前的旧草稿备份位置 */
  backup: string | null;
  items: number;
  deferred: number;
}

/* ───────────── sync（POST /api/sync，结构同 src/core/sync.ts 的 SyncResult，前端只用这些字段） ───────────── */

export interface SyncView {
  dryRun: boolean;
  ledgerDir: string;
  milestone: string | null;
  milestoneWillBeCreated: boolean;
  drafts: Array<{ repo: string; repoLabel: string; branch: string; title: string; status: FeatureStatus; id: string | null; noCommits?: boolean }>;
  skipped: { hasCard: number; inMain: number; noWorktree: number; notFeature: number };
  created: Array<{ id: string; title: string }>;
}
