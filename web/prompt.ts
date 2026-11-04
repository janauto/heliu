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

/**
 * F-0003「发给 Claude 开工」的中文指令：预填到新会话输入框里，由用户按回车发出。
 * 要点：说清是哪张卡、先读项目规则、开工就把会话绑回这张卡（看板之后才能跟进到它），推送 / 合并前先问。
 */
export function startPrompt(card: { id: string; title: string; file?: string | null }, ctx: { project: string | null; milestone: string | null }): string {
  const where = [ctx.project ? `合流项目「${ctx.project}」` : null, ctx.milestone ? `预约 ${ctx.milestone}` : null].filter(Boolean).join("，");
  const lines = [
    `请开始做功能卡 ${card.id}「${card.title}」${where ? `（${where}）` : ""}。`,
    `1. 先读本仓库的 CLAUDE.md / AGENTS.md，按项目规则来${card.file ? `；卡片原文在 ${card.file}` : ""}。`,
    `2. 开工前把本会话绑回这张卡：调用 heliu_feature_bind（卡号 ${card.id}，cwd 传本会话所在目录）；这张卡已存在，不要再新建功能卡。没有 heliu 工具时在终端运行：heliu feature bind ${card.id}`,
    "3. 需求不清楚先问我；做完一轮就提交，推送和合并主线前先问我。",
  ];
  return lines.join("\n");
}
