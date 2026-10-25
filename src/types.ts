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
  | "index_lock" // 残留 index.lock
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
