/**
 * 「合并这一版」的 Prompt（M8）：拖版本行星到合流点时复制到剪贴板，粘贴到 Claude 会话里用。
 *
 * 安全约定（ADR-4 不变）：Prompt 只让 Claude 预演、讲清楚、合并后同步；**真正合并由用户在终端自己运行并输入 yes**。
 * 因此 Prompt 里绝不出现 --yes。
 */
import type { PlanCounts } from "./release-plan.ts";

export interface MergePrompt {
  /** 粘贴到 Claude 会话的整段中文 */
  prompt: string;
  /** 预演命令（只读） */
  previewCommand: string;
  /** 真正合并的命令（用户自己在终端运行，会列摘要、输入 yes 才开始） */
  command: string;
  /** 合并完成后把结果同步回台账的命令 */
  syncCommand: string;
}

const quoteArg = (s: string) => (/[\s"'$`\\]/.test(s) ? JSON.stringify(s) : s);

export function buildMergePrompt(input: { project: string; milestone: string; bin: string; counts?: PlanCounts | null }): MergePrompt {
  const bin = `"${input.bin}"`;
  const p = ` --project ${quoteArg(input.project)}`;
  const ms = quoteArg(input.milestone);
  const previewCommand = `${bin} 合并 ${ms} --预演${p}`;
  const command = `${bin} 合并 ${ms}${p}`;
  const syncCommand = `${bin} 同步合并结果${p}`;
  const c = input.counts;
  const summary = c
    ? `（看板预演时：新增待合 ${c.newMerge} 项 · 已在集成 ${c.inIntegration} 项 · 有冲突 ${c.conflict} 项${c.precheckFailed ? ` · 未能试合 ${c.precheckFailed} 项` : ""} · 预计顺延 ${c.deferred} 项）`
    : "";
  const prompt = [
    `请帮我合并「${input.project}」的 ${input.milestone} 版本（由合流 heliu 管理）。`,
    "",
    `1. 先运行预演（只读，不改仓库）：`,
    `   ${previewCommand}`,
    `   用中文告诉我：会新增合入哪些功能、哪些已经在集成分支里、哪些会顺延到下一版、有没有需要解的冲突${summary}。`,
    `2. 不要替我执行合并。我确认没问题后，会在终端自己运行：`,
    `   ${command}`,
    `   （它会再列一遍摘要，我输入 yes 才开始；合错了可以用「heliu 回滚 ${input.milestone}」退回去。）`,
    `3. 我告诉你合并完成后，请运行：`,
    `   ${syncCommand}`,
    `   把已经合进去的功能卡同步到台账，再把结果告诉我。`,
    "",
    "全程不要 push，也不要删除任何分支。",
  ].join("\n");
  return { prompt, previewCommand, command, syncCommand };
}
