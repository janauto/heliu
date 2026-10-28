/**
 * M9 跨仓配对的数据结构（纯类型，看板前端也用；逻辑在 pairing.ts）。
 */
import type { SessionView } from "../types.ts";

export interface AnalyzeProgress {
  done: number;
  total: number;
}

export interface AnalyzeResult {
  files: number;
  extracted: number;
  skipped: number;
  missing: number;
  ms: number;
  analyzedAt: string;
}

export type PairTier = "strong" | "medium" | "weak";

export type PairTarget =
  /** 绑到会话已有的那张卡 */
  | { kind: "card"; id: string; title: string }
  /** 会话还没有卡：确认时用会话标题建卡，并同时绑会话所在分支与这条分支 */
  | { kind: "new"; title: string }
  /** 这条分支已经绑在另一张卡上：只提示，不自动合卡 */
  | { kind: "other"; id: string; title: string };

export interface PairSuggestion {
  /** 稳定键：会话|仓库|分支 */
  key: string;
  /** 本次列表里的编号（CLI / MCP 用） */
  no: number;
  sessionId: string;
  repo: string;
  repoLabel: string;
  branch: string;
  worktree: string;
  worktreeName: string;
  reads: number;
  writes: number;
  commits: number;
  /** 占该会话在别的仓库里出现总数的比例 */
  share: number;
  lastSeenAt: string | null;
  /** 该分支有自己的提交（不是空分支） */
  branchHasCommits: boolean | null;
  tier: PairTier;
  /** 依据原文，如「esp_claw-aios：出现 638 次（占 92%）· 改文件 94 次 · 提交 3 次 · 最近 10-25」 */
  evidence: string;
  target: PairTarget;
  /** 默认勾选：强档且能直接绑 */
  checked: boolean;
}

export interface PairGroup {
  sessionId: string;
  title: string;
  status: SessionView["status"];
  needsAction: string | null;
  isArchived: boolean;
  repo: string;
  repoLabel: string;
  branch: string | null;
  lastActivityAt: string | null;
  card: { id: string; title: string } | null;
  items: PairSuggestion[];
}

export interface PairReport {
  groups: PairGroup[];
  counts: {
    /** 出了建议的会话数（不含只剩"已绑在别的卡"的） */
    sessions: number;
    strong: number;
    medium: number;
    weak: number;
    other: number;
    /** 已经配好的（会话的卡上已有这条分支） */
    paired: number;
  };
  /** 不是建议、但值得知道的：会话直接在别的仓库的主线 / 集成分支上改动 */
  notes: Array<{ sessionId: string; title: string; text: string }>;
}
