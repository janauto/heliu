/**
 * 看板（M3）API 的响应结构：服务端（src/board/*）与前端（web/*）共用，只含类型。
 * 复用 src/types.ts 的 M1/M2 结构；这里只追加看板派生出来的视图。
 */
import type { AnalyzeResult, PairReport } from "../core/pairing-types.ts";
import type {
  AcceptanceLevel,
  AheadBehind,
  BranchRole,
  DoctorCheck,
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
  /** M9：这条绑定是「会话入口」（分支没有自己的提交）；null = 未判定 */
  sessionEntry: boolean | null;
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
  /** M8：类型（修复 / 功能 / 调研 / 文档 / 工程 / 其他）与来源（card = 用户定的，guess = 推测） */
  type: string;
  typeSource: "card" | "guess";
  /** M8：所属模块（整机的组成部分） */
  module: string;
  moduleSource: "card" | "guess";
  /** M8：分支已被集成分支 / 主线包含、台账还没改——「同步一下」会把它改成的状态（与 /api/merged 同一规则）；已完成的卡为 null */
  mergedTo: "已合入" | "已进主线" | null;
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
  /** M8：模块定义（内置或台账目录 modules.yaml）与类型列表；前端用同一套规则给没卡的分支归类 */
  modules: Array<{ name: string; keywords: string[] }>;
  modulesSource: "default" | "file";
  types: string[];
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

/* ───────────── 合并预演（M5 起直接映射 M4 合并单，规则只有一套） ───────────── */

/** 档位 = M4 合并单的 PlanTier：已进集成 → 无冲突 → 有冲突 → 未能试合 → 未完成 → 无法合并 */
export type ReleaseTier = "in_integration" | "clean" | "conflict" | "precheck_failed" | "unfinished" | "unmergeable";
/** 建议动作：跳过（已在集成分支）/ 合入 / 合入需解冲突 / 重新试合或人工确认 / 顺延 / 先补分支或配置 */
export type ReleaseAction = "skip" | "merge" | "resolve" | "recheck" | "defer" | "fix";

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

/** 合并单的一项（M4 按「功能卡 × 绑定分支」一项） */
export interface ReleaseItem {
  order: number;
  id: string;
  title: string;
  /** 台账状态（卡片已删时为 null） */
  status: FeatureStatus | null;
  tier: ReleaseTier;
  /** M4 的状态名：已进集成 / 无冲突 / 有冲突 / 未能试合 / 未完成 / 无法合并 */
  tierText: string;
  action: ReleaseAction;
  actionText: string;
  /** 合并单里的决定（并入 / 顺延 / 等它 / 不并 / 待定），已保留你上次改过的 */
  decision: string;
  defaultDecision: string;
  /** 为什么是这一档（事实，取自合并单 detail） */
  reason: string;
  bindings: ReleaseBinding[];
}

export interface ReleaseRepoRef {
  repo: string;
  repoLabel: string;
  main: string;
  mainSha: string | null;
  /** null = 未配置集成分支或本地不存在 */
  integration: string | null;
  /** 预演时集成分支所在提交（M4 执行前校验 base_sha） */
  integrationSha: string | null;
}

export interface ReleasePreview {
  milestone: LedgerMilestone;
  generatedAt: string;
  scanMs: number;
  repos: ReleaseRepoRef[];
  items: ReleaseItem[];
  counts: Record<ReleaseTier, number>;
  /** 决定为「顺延」的卡号 */
  deferred: string[];
  /** 页面顶部提示，如「App 仓未配置集成分支：…」 */
  warnings: string[];
  /** 磁盘上的合并单（<台账>/releases/<里程碑>.md）；看板预演本身不写它 */
  plan: { file: string; exists: boolean; format: "m4" | "board" | null; status: string | null; kept: number };
}

export interface ReleasePlanResult {
  file: string;
  /** 旧的看板草稿（schema 1）备份位置 */
  backup: string | null;
  items: number;
  deferred: number;
  /** 刷新时保留了几项你改过的决定 */
  kept: number;
  status: string;
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

/* ───────────── M6：上手入口（项目中枢 / 环境检查 / 接入向导） ───────────── */

/** 注册表里一个项目的摘要（只读文件，不扫 git；扫 git 的健康数字请用 /api/overview?project=） */
export interface ProjectSummary {
  name: string;
  /** project.yaml 路径 */
  source: string;
  /** project.yaml 读不出来时的中文原因；此时 repos 为空 */
  error: string | null;
  repos: Array<{ id: string; label: string; path: string; main: string; integration: string | null; remote: string | null; icloud: boolean; exists: boolean }>;
  ledgerDir: string | null;
  /** 功能卡总数；台账还没建或读不出来时为 null */
  features: number | null;
  /** 台账状态为 想法 / 开发中 / 待合并 的卡数（还欠的） */
  open: number | null;
  /** 下一版（第一个「规划中」的里程碑） */
  next: string | null;
}

export interface ProjectsData {
  /** 注册表目录 */
  registry: string;
  /** 合流自己的安装目录（页面里生成可复制的终端命令用） */
  heliuRoot: string;
  /** 这个看板进程的合流版本（package.json）；加上版本上报之前的看板不返回这个字段 */
  version: string;
  /** 看板启动时指定或识别出的项目；识别不出时为 null（页面里自己选） */
  default: string | null;
  projects: ProjectSummary[];
}

export interface DoctorData {
  checks: DoctorCheck[];
  /** 是否做了无头 claude 探测（完整检查） */
  full: boolean;
  ms: number;
  counts: { ok: number; warn: number; fail: number };
}

/** 与 src/core/onboard.ts 的 RepoDetection 同构（这里重复声明，保持本文件不依赖 node 模块，前端可直接引用） */
export interface DetectedCandidate {
  branch: string;
  ahead: number;
  behind: number;
  contains: number;
  byName: boolean;
  lastCommitAt: string | null;
  checkedOut: boolean;
  onTopOf: string | null;
}
export interface DetectedRepo {
  root: string;
  icloud: boolean;
  remotes: string[];
  remote: string | null;
  remoteWhy: string;
  main: string;
  mainWhy: string;
  mainExists: boolean;
  head: string | null;
  branches: number;
  worktrees: number | null;
  candidates: DetectedCandidate[];
  integration: string | null;
  integrationWhy: string;
  warnings: string[];
}
/** 与 src/core/project.ts 的 RepoConfig 同构 */
export interface OnboardedRepo {
  id: string;
  label: string;
  path: string;
  main: string;
  integration: string | null;
  remote: string | null;
  icloud: boolean;
}

/** 接入向导第一步：只读检测一个仓库 */
export interface DetectData {
  detection: DetectedRepo;
  /** 建议的项目名（仓库目录名） */
  suggestedName: string;
  existingProjects: string[];
  /** 建议名对应的项目已存在（接入 = 往这个项目里再加一个仓库） */
  registryExists: boolean;
  /** 全部本地分支（最后提交倒序），向导里「其他分支」下拉用；候选里没有时也能手选 */
  localBranches: Array<{ name: string; lastCommitAt: string | null }>;
  /** 台账会放在哪（已有项目沿用它的设置） */
  ledgerDir: string;
  ledgerNote: string;
}

/** 接入向导第二步：写注册表并建台账 */
export interface OnboardResult {
  project: ProjectSummary;
  /** true = 新建项目；false = 往已有项目里加 / 更新仓库 */
  created: boolean;
  repo: OnboardedRepo;
  ledger: { dir: string; created: boolean };
}

/* ───────────── M7：星图拖到合流点（POST /api/release/decision） ───────────── */

export interface ReleaseDecisionResult {
  feature: string;
  title: string;
  /** 排进的是哪一版的合并单 */
  milestone: string;
  /** 这次顺手预约到的版本（原来没预约或换了版本）；没动预约为 null */
  reservedTo: string | null;
  /** 决定实际改动的项数（0 = 本来就是这个决定，或已进集成） */
  changed: number;
  /** 合并单文件 */
  file: string;
  /** 始终为 false：这个接口只写合并单，从不执行 git 合并 */
  executed: false;
  /** 一句话中文结果（给不看页面的调用方） */
  message: string;
  /** 真正执行合并要在终端运行的命令（会先列摘要，输入 yes 才开始） */
  command: string;
  items: Array<{
    repo: string | null;
    branch: string | null;
    state: string;
    decision: string;
    detail: string | null;
    behind: number | null;
    conflicts: string[];
    union: string[];
    precheckState: "checked" | "failed" | "skipped" | null;
  }>;
}

/* ───────────── M8：合并闭环 ───────────── */

/** POST /api/release/prompt：拖版本行星到合流点 → 刷新合并单 → 复制到剪贴板的 Prompt */
export interface MergePromptData {
  milestone: string;
  prompt: string;
  previewCommand: string;
  command: string;
  syncCommand: string;
  counts: { newMerge: number; inIntegration: number; conflict: number; precheckFailed: number; deferred: number; waiting: number };
  file: string;
}

/** GET / POST /api/merged：合并后同步 */
export interface MergedData {
  dryRun: boolean;
  scannedAt: string;
  suggestions: Array<{ id: string; title: string; milestone: string | null; from: string; to: string; branches: Array<{ repo: string; repoLabel: string; branch: string; mergedState: string }> }>;
  changed: Array<{ id: string; title: string; from: string; to: string }>;
}

/** M9 跨仓配对：后台分析对话记录的进度 */
export interface PairJob {
  running: boolean;
  done: number;
  total: number;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  result: AnalyzeResult | null;
}

/** M9 GET /api/pairings：会话开在一个仓库、真实改动在别的仓库时的配对建议（建议 ≠ 事实，确认后才写台账） */
export interface PairingsData {
  /** 上次分析对话记录的时间；null = 还没分析过（report 也为 null） */
  analyzedAt: string | null;
  job: PairJob | null;
  report: PairReport | null;
  privacy: string[];
}

/** M9 POST /api/project/label：改仓库显示名（只改 project.yaml 里那一行） */
export interface LabelResult {
  repo: string;
  from: string;
  to: string;
  file: string;
}

/** Codex 本地任务只读视图；运行状态不表示功能已合并或发布。 */
export interface CodexTask {
  id: string;
  title: string;
  cwd: string;
  repoId: string;
  repoLabel: string;
  status: "running" | "idle" | "interrupted" | "stale" | "unknown";
  lastActivityAt: string | null;
  turnStartedAt: string | null;
}

/** GET /api/codex-tasks：只返回属于当前项目的任务摘要。 */
export interface CodexTasksData {
  tasks: CodexTask[];
  available: boolean;
  warning: string | null;
}

