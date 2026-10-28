/**
 * heliu 对外稳定数据结构（--json 输出、后续 MCP 与看板复用）。
 *
 * 约定：
 * - 新增字段只追加，不改名、不删；破坏性变更时提升 SCHEMA_VERSION。
 * - 时间一律 ISO 8601 字符串（UTC），缺失为 null。
 * - 数值缺失（超时/未计算）为 null，不用 0 冒充。
 */

export const SCHEMA_VERSION = 1 as const;

/** 合并状态三档（ADR-5）：进主线 / 进集成分支 / 独立未合并 */
export type MergedState = "in_main" | "in_integration" | "unmerged";

/** 分支角色：主线、集成分支、普通功能分支 */
export type BranchRole = "main" | "integration" | "feature";

/** 工作区脏检查结果；skipped = 按规则未检查（iCloud 仓默认跳过） */
export type DirtyState = "clean" | "dirty" | "unknown" | "skipped";

/** 标签来源优先级：会话标题 > 首条独有提交主题 > 改动最多的一级目录 > 末次提交主题 > 分支名 */
export type LabelSource = "session" | "first_commit" | "top_dir" | "tip_commit" | "branch_name";

/** 会话状态归一（展示用） */
export type SessionStatus =
  | "running" // 进程在跑且 busy
  | "online" // 进程在跑但 idle
  | "blocked" // 等用户回答（postTurnSummary.status_category=blocked）
  | "review_ready" // 待验收
  | "completed"
  | "archived"
  | "unknown";

/** 会话与分支的关联强度 */
export type SessionLink = "branch" | "written" | "worktree";

export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface PrRef {
  number: number | null;
  repo: string | null;
  url: string | null;
  branch: string | null;
  state: string | null;
}

/** 挂在分支上的会话摘要 */
export interface SessionRef {
  sessionId: string;
  title: string | null;
  status: SessionStatus;
  statusCategory: string | null;
  needsAction: string | null;
  isArchived: boolean;
  lastActivityAt: string | null;
  link: SessionLink;
  prs: PrRef[];
}

export interface WorktreeRef {
  path: string;
  dirName: string;
  isMain: boolean;
  dirty: DirtyState;
}

export interface PrecheckResult {
  /** 试合目标分支（集成分支优先，否则主线） */
  target: string;
  /** 冲突文件数；超时/出错为 null */
  conflictFiles: number | null;
  conflicts: string[];
  /** 试合结果树与目标树相同：内容已等价（历史不同） */
  contentEquivalent: boolean;
  timedOut: boolean;
  error: string | null;
}

/** 对账单的一行：一个本地分支的全部事实 */
export interface FeatureView {
  branch: string;
  ref: string;
  sha: string;
  role: BranchRole;
  mergedState: MergedState;
  label: string;
  labelSource: LabelSource;
  /** 形如「形容词-科学家-hash」的随机名 */
  randomName: boolean;
  lastCommitAt: string | null;
  lastCommitSubject: string;
  /** 相对主线；主线自身或主线缺失为 null */
  vsMain: AheadBehind | null;
  /** 相对集成分支；未配置集成分支或集成分支自身为 null */
  vsIntegration: AheadBehind | null;
  upstream: string | null;
  /**
   * 本地有远端引用：refs/remotes/* 下存在同名分支，或配置的上游引用存在。
   * 只看本地已有引用（heliu 从不 fetch），false 表示「本地无远端引用」，不等于远端一定没有。
   */
  pushed: boolean;
  worktree: WorktreeRef | null;
  /** 关联会话，按关联强度、最后活动倒序；第一个为主会话 */
  sessions: SessionRef[];
  precheck: PrecheckResult | null;
  /**
   * M9「会话入口」：没有自己提交的功能分支（多是桌面会话开出来的入口，真实改动在别的仓库）。
   * 与「尚无独有提交」同一判定（owncommits.isZeroCommit），只在看板 /api/status 里填；
   * 未判定（CLI 对账、仓库不可达）时缺省；false = 有自己的提交或独立未合并。
   */
  sessionEntry?: boolean | null;
}

export interface WorktreeInfo {
  path: string;
  dirName: string;
  branch: string | null;
  head: string | null;
  isMain: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
  /** 由 Claude 桌面端创建（位于 .claude/worktrees/ 或登记在 git-worktrees.json） */
  managedByDesktop: boolean;
  /** git-worktrees.json 中的租用会话 */
  leasedBy: string | null;
  dirty: DirtyState;
  dirtyCount: number | null;
  dirtyReason: string | null;
}

export type HygieneKind =
  | "dir_branch_mismatch" // 目录名 ≠ 分支名
  | "orphan_admin_dir" // .git/worktrees/* 缺 gitdir
  | "prunable_worktree" // worktree 目录已不存在
  | "index_lock" // 检测到 index.lock（可能残留，也可能有 git 进程正在运行）
  | "merged_worktree_remains" // 分支已进主线但 worktree 目录仍在
  | "worktree_no_commits" // worktree 停在主线顶端，相对主线 0 提交
  | "detached_worktree" // worktree 处于分离 HEAD
  | "main_dirty" // 主目录脏项
  | "icloud_conflict_copy"; // .git 内的 iCloud 冲突副本（如「index 2」）

export interface HygieneIssue {
  kind: HygieneKind;
  severity: "warn" | "info";
  message: string;
  path: string | null;
  branch: string | null;
  count: number | null;
}

export interface RepoCounts {
  branches: number;
  /** 关联 worktree 数（不含主目录） */
  worktrees: number;
  mergedIntoMain: number;
  unmergedIntoMain: number;
  /** 未进主线但已被集成分支包含（不含集成分支自身） */
  inIntegration: number;
  /** 独立未合并（不含集成分支自身） */
  independent: number;
  /** 本地无远端引用的分支数（字段名沿用 v1；仅基于本地已有 refs/remotes，未 fetch，不代表远端真实状态） */
  neverPushed: number;
}

export interface RepoHealth {
  mainVsRemote: {
    remoteRef: string;
    ahead: number | null;
    behind: number | null;
    /** 远端引用不存在等原因 */
    note: string | null;
  } | null;
  integration: {
    branch: string;
    exists: boolean;
    mergedIntoMain: boolean;
    aheadOfMain: number | null;
    behindMain: number | null;
    /** 集成分支第一条自有提交（first-parent）时间 */
    since: string | null;
    unmergedDays: number | null;
  } | null;
  worktreeDirty: Record<DirtyState, number>;
  hygieneWarnings: number;
  hygieneInfos: number;
}

export interface RepoReport {
  id: string;
  label: string;
  path: string;
  icloud: boolean;
  main: string;
  integration: string | null;
  remote: string | null;
  reachable: boolean;
  /** 不可达原因（路径不存在 / 不是 git 仓库 / 主线分支不存在） */
  error: string | null;
  warnings: string[];
  counts: RepoCounts | null;
  health: RepoHealth | null;
  branches: FeatureView[];
  worktrees: WorktreeInfo[];
  hygiene: HygieneIssue[];
  elapsedMs: number;
  gitCalls: number;
  gitTimeouts: number;
}

export interface ProjectRef {
  name: string;
  /** project.yaml 所在位置 */
  source: string;
}

export interface ScanOptions {
  precheck: boolean;
  dirty: boolean;
  timeoutMs: number;
}

export interface ReconcileReport {
  schemaVersion: typeof SCHEMA_VERSION;
  generatedAt: string;
  elapsedMs: number;
  project: ProjectRef;
  options: ScanOptions;
  repos: RepoReport[];
  sessions: {
    /** 归属本项目的会话数 */
    total: number;
    /** 解析失败的会话文件数 */
    parseErrors: number;
  };
}

/** sessions 命令的一行 */
export interface SessionView {
  sessionId: string;
  cliSessionId: string | null;
  title: string | null;
  repo: string;
  branch: string | null;
  worktreeName: string | null;
  worktreePath: string | null;
  cwd: string | null;
  status: SessionStatus;
  statusCategory: string | null;
  statusDetail: string | null;
  needsAction: string | null;
  isArchived: boolean;
  running: "busy" | "idle" | null;
  createdAt: string | null;
  lastActivityAt: string | null;
  completedTurns: number | null;
  model: string | null;
  spawnedFrom: { sessionId: string | null; title: string | null } | null;
  prs: PrRef[];
  /**
   * 会话关联到的分支（M2 追加）：记录（JSON 的 branch 字段）> 写入（writtenBranches 最后一条）> 目录（cwd 所在 worktree 当前分支）。
   * branch 字段保持 v1 语义（只取 JSON 记录值）。
   */
  linkedBranch?: string | null;
  /** linkedBranch 的来源：branch=记录 / written=写入 / worktree=目录 */
  branchLink?: SessionLink | null;
  /** 会话目录（cwd/worktreePath 所在 worktree）现在检出的分支；与记录分支不同说明目录被复用 */
  dirBranch?: string | null;
}

export interface DoctorCheck {
  id: string;
  ok: boolean;
  level: "ok" | "warn" | "fail";
  message: string;
}

/** 所有 --json 输出共用的外壳 */
export interface JsonEnvelope<T> {
  schemaVersion: typeof SCHEMA_VERSION;
  command: string;
  generatedAt: string;
  project: ProjectRef | null;
  data: T;
}

/* ───────────────────────── M2：台账（承诺层） ───────────────────────── */

/** 功能状态机（产品定义第 4 节） */
export const FEATURE_STATUSES = ["想法", "开发中", "待合并", "已合入", "已进主线", "已发布", "已放弃"] as const;
export type FeatureStatus = (typeof FEATURE_STATUSES)[number];

/** 验收档位（ADR-5，独立字段，合并不自动提升） */
export const ACCEPTANCE_LEVELS = ["未", "已合并", "已构建", "宿主测试", "实机通过"] as const;
export type AcceptanceLevel = (typeof ACCEPTANCE_LEVELS)[number];

/** 里程碑状态 */
export const MILESTONE_STATUSES = ["规划中", "冻结", "合并中", "已发布"] as const;
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number];

/** 功能卡来源（board = M3 看板登记，追加） */
export type FeatureSource = "session" | "cli" | "mcp" | "hook" | "sync" | "board";

export interface FeatureBinding {
  repo: string;
  branch: string;
  worktree: string | null;
  session: string | null;
  pr: number | null;
}

/** 台账里的一张功能卡（features/F-0001-<slug>.md 的 frontmatter + 正文） */
export interface LedgerFeature {
  id: string;
  title: string;
  status: FeatureStatus;
  /** 预约的里程碑 id（可能是字面量 next）；null = 未预约 */
  milestone: string | null;
  acceptance: AcceptanceLevel;
  bindings: FeatureBinding[];
  rolled_from: string[];
  source: FeatureSource;
  /** M8：类型（修复 / 功能 / 调研 / 文档 / 工程 / 其他）；null = 没写，界面上显示推测 */
  type: string | null;
  /** M8：所属模块（整机的组成部分）；null = 没写，界面上显示推测 */
  module: string | null;
  created: string;
  updated: string;
  /** frontmatter 之后的正文（原样保留） */
  body: string;
  /** 卡片文件绝对路径 */
  file: string;
}

export interface LedgerMilestone {
  id: string;
  title: string;
  status: MilestoneStatus;
  target_date: string | null;
  integration_branch: string | null;
  notes: string;
}

/** milestone.todo 的分组（按优先级从高到低） */
export type TodoGroupKey = "blocked" | "conflict" | "mergeable" | "behind" | "stale" | "active" | "unbound";

/**
 * 试合（merge-tree 预检）三态（M3 第 2 轮，Codex 反馈）：
 * checked = 有结果；failed = 请求了但没得到结果（建不了写保护沙箱 / 超时 / 出错）；skipped = 没请求预检。
 * 不需要试合的绑定（已进主线/集成分支、分支不存在）为 null。失败绝不当成「无冲突」。
 */
export type PrecheckState = "checked" | "failed" | "skipped";

/** 一批待办卡片的试合汇总（CLI 待办、看板列头/总览/顶栏共用 summarizePrecheck） */
export interface PrecheckSummary {
  /** 是否请求了预检 */
  requested: boolean;
  /** checked = 全部有结果；partial = 部分未能试合；failed = 需要试合的全部失败；skipped = 未请求 */
  status: "checked" | "partial" | "failed" | "skipped";
  /** 有冲突的卡数（未请求为 null） */
  conflicts: number | null;
  /** 未能试合的卡数（任一绑定 failed） */
  failed: number;
  /** 未检查的卡数（任一绑定 skipped） */
  unchecked: number;
  /** 第一条失败原因 */
  firstError: string | null;
}

export interface TodoBinding {
  repo: string;
  repoLabel: string;
  branch: string;
  /** 分支在本地是否存在 */
  exists: boolean;
  mergedState: MergedState | null;
  /** 落后主线提交数 */
  behindMain: number | null;
  /** 落后集成分支提交数（仓库无集成分支为 null） */
  behindIntegration: number | null;
  /** 冲突文件数（仅 --precheck） */
  conflictFiles: number | null;
  sessionId: string | null;
  sessionStatus: SessionStatus | null;
  lastCommitAt: string | null;
  /**
   * 尚无独有提交（M2 第 2 轮）：分支与主线/集成分支顶端同点，或 reflog 显示自创建后从未移动。
   * 这种分支 git 祖先判断恒为「已进主线」，但并没有任何工作被合入，分组时视为「开发中 · 尚无提交」。
   */
  noCommits?: boolean;
  /** 试合三态（M3 第 2 轮追加）；不需要试合为 null */
  precheck?: PrecheckState | null;
  /** precheck=failed 时的原因 */
  precheckError?: string | null;
}

export interface TodoItem {
  id: string;
  title: string;
  status: FeatureStatus;
  acceptance: AcceptanceLevel;
  rolledFrom: string[];
  group: TodoGroupKey;
  bindings: TodoBinding[];
  /** 等你回答时的 needs_action 原文（缺失用 status_detail） */
  needsAction: string | null;
  /** 最后活动：会话最后活动 / 最后提交 / Stop hook 记录 取最新 */
  lastActivityAt: string | null;
  idleDays: number | null;
  file: string;
  /** 组内细分：可合并 → 已进主线 / 已进集成分支 / 试合无冲突；开发中 → 尚无提交（M2 第 2 轮追加） */
  note?: string | null;
  /** 只给建议、不自动改台账：如「该分支已被集成分支包含，是否把 F-0003 标为已合入？」 */
  suggestion?: string | null;
}

export interface TodoGroup {
  key: TodoGroupKey;
  title: string;
  hint: string;
  /** 有冲突组在未 --precheck 时为 null（未检查） */
  count: number | null;
  items: TodoItem[];
}

export interface TodoReport {
  milestone: LedgerMilestone;
  /** 用户输入的里程碑引用（如「下一版」） */
  requested: string;
  precheck: boolean;
  /** 计入待办的条数 */
  total: number;
  groups: TodoGroup[];
  /**
   * 兼容字段，M2 第 2 轮起恒为空：台账状态是承诺层事实，想法/开发中/待合并的卡永远计入待办，
   * 不再因 git 状态移出；分支已进主线时改为在 suggestion 里建议改状态。
   */
  doneByGit: TodoItem[];
  /** 当前「下一版」（第一个规划中的里程碑），无则 null（M2 第 2 轮追加） */
  nextMilestone?: { id: string; status: MilestoneStatus } | null;
}

/** whereami：当前目录 → 项目/仓库/分支/功能卡/里程碑/落后数/会话 */
export interface WhereAmI {
  cwd: string;
  project: ProjectRef | null;
  repo: { id: string; label: string; path: string } | null;
  /** 当前所在检出目录（worktree 或主目录）的顶层路径 */
  worktree: string | null;
  isMainCheckout: boolean;
  branch: string | null;
  detached: boolean;
  role: BranchRole | null;
  feature: { id: string; title: string; status: FeatureStatus; milestone: string | null; acceptance: AcceptanceLevel; file: string } | null;
  milestone: { id: string; title: string; status: MilestoneStatus } | null;
  behindMain: number | null;
  behindIntegration: number | null;
  session: { sessionId: string | null; cliSessionId: string | null; title: string | null } | null;
  ledgerDir: string | null;
  notes: string[];
  elapsedMs: number;
}
