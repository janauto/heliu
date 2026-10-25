/**
 * 「复制给 Claude 会话」的中文指令（只生成文本，看板不执行任何 git 操作）。
 * 用在「需解冲突」「需同步基线」的卡片展开态：把冲突文件、目录、基线分支说清楚，粘贴到该分支的会话里让 Claude 去做。
 */
import type { CardBinding } from "../src/board/api-types.ts";

export type PromptMode = "conflict" | "sync";

export function claudePrompt(mode: PromptMode, b: CardBinding): string {
  const base = b.precheckTarget ?? b.integration ?? b.main;
  const dir = b.worktree ?? "目录未知，请先打开该分支的会话";
  const files = b.conflicts.length
    ? b.conflicts.join("、")
    : b.precheckState === "checked"
      ? "（试合没有冲突文件）"
      : "（冲突文件未知，以实际合并结果为准）";
  const verb = mode === "conflict" ? "合并进来" : "同步基线";
  return `请在分支 ${b.branch} 的 worktree（${dir}）里，把 ${base} ${verb}并解决冲突文件：${files}；两边功能都保留，解完 git add，不要 push。`;
}
