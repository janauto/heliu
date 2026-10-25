/**
 * M4 合并单 / 执行 / 回滚 / 演练的中文终端渲染（事实与建议分开写）。
 */
import type { ProjectConfig } from "../core/project.ts";
import type { PreviewResult, SetDecisionResult } from "../core/release.ts";
import { ACTION_TEXT, conflictText, planCountsLine, resultText, type PlanItem, type ReleasePlan } from "../core/release-plan.ts";
import type { RollbackReport, RunReport } from "../core/release-run.ts";
import { sec, type RehearseResult } from "../core/rehearse.ts";

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");

function labelMap(plan: ReleasePlan): Map<string, string> {
  return new Map(plan.repos.map((r) => [r.repo, r.label]));
}

export function renderItemLine(i: PlanItem, k: number, labels: Map<string, string>): string {
  const box = i.decision === "并入" ? "[x]" : "[ ]";
  const changed = i.decision !== i.default_decision ? "（你改的）" : "";
  const where = i.repo && i.branch ? ` · ${labels.get(i.repo) ?? i.repo} ${i.branch}` : "";
  const state = i.state === "已进集成" ? "已进集成（跳过）" : `${i.state} → ${ACTION_TEXT[i.state]}`;
  const extra = [i.precheck?.conflicts.length ? conflictText(i) : null, i.detail, i.behind ? `落后集成 ${i.behind}` : null].filter(Boolean).join(" · ");
  const res = resultText(i);
  return `  #${String(k + 1).padEnd(3)} ${box} ${i.decision}${changed}  ${i.feature} ${i.title}${where} · ${state}${extra ? ` · ${extra}` : ""}${res ? `  ⇒ ${res}` : ""}`;
}

export function renderPlan(plan: ReleasePlan, project: ProjectConfig): string {
  const labels = labelMap(plan);
  const L: string[] = [];
  L.push(`合流 · ${project.name} · 合并单 ${plan.milestone}（${plan.status}）`);
  for (const r of plan.repos) L.push(`  ${r.label}：集成分支 ${r.integration_branch ?? "（未配置）"}${r.base_sha ? ` @${short(r.base_sha)}` : ""}`);
  const groups: Array<[string, PlanItem[]]> = [];
  for (const it of plan.items) {
    const key = it.state;
    const g = groups.find((x) => x[0] === key);
    if (g) g[1].push(it);
    else groups.push([key, [it]]);
  }
  let k = 0;
  for (const [state, items] of groups) {
    L.push("", `${state}（${items.length}）`);
    for (const it of items) L.push(renderItemLine(it, k++, labels));
  }
  L.push("", `合计 ${plan.items.length} 项：${planCountsLine(plan)}`);
  return L.join("\n");
}

export function renderPreview(r: PreviewResult, project: ProjectConfig): string {
  const L = [renderPlan(r.plan, project), ""];
  L.push(`合并单：${r.file}`);
  if (r.kept) L.push(`保留了你改过的决定 ${r.kept} 项。`);
  if (r.boardDraft) {
    L.push(`原文件是看板生成的草稿，已备份到 ${r.boardDraft.backup}；它的决定没有导入${r.boardDraft.differing.length ? `，与本次默认不同的 ${r.boardDraft.differing.length} 项：${r.boardDraft.differing.map((d) => `${d.feature} 看板「${d.board}」/ 现在「${d.now}」`).join("；")}` : "（与本次默认一致）"}`);
  }
  const failed = r.plan.items.filter((i) => i.state === "未能试合");
  if (failed.length) L.push(`未能试合 ${failed.length} 项（没有得到试合结果，不等于有冲突）：默认「待定」，执行时跳过、留在本版；建议重新试合（heliu doctor 看沙箱是否可用）或人工确认后 heliu release set ${r.milestone.id} <卡号> 并入|顺延。`);
  L.push(`下一步（建议）：核对决定（改：heliu release set ${r.milestone.id} <卡号|#序号> 并入|顺延|等它|不并）→ heliu 合并 ${r.milestone.id} --dry-run → heliu 合并 ${r.milestone.id}`);
  return L.join("\n");
}

export function renderSetDecision(r: SetDecisionResult, project: ProjectConfig): string {
  const labels = labelMap(r.plan);
  const L = [r.changed.length ? `已改 ${r.changed.length} 项：` : "没有需要改的项（已是该决定，或已进集成/已合入）"];
  for (const it of r.changed) L.push(renderItemLine(it, r.plan.items.indexOf(it), labels));
  L.push(`合并单：${r.plan.file}`);
  void project;
  return L.join("\n");
}

export function renderRunReport(r: RunReport, project: ProjectConfig): string {
  const L: string[] = [];
  const labels = labelMap(r.plan);
  if (r.aborted.length) {
    L.push(`合流 · ${project.name} · 合并 ${r.milestone}：已中止，没有写任何东西`);
    for (const a of r.aborted) L.push(`  ✗ ${a}`);
    for (const w of r.warnings) L.push(`  ! ${w}`);
    return L.join("\n");
  }
  if (r.cancelled) {
    L.push(`合流 · ${project.name} · 合并 ${r.milestone}：已取消（没有输入 yes），没有写任何东西`);
    return L.join("\n");
  }
  if (r.dryRun) {
    L.push(`合流 · ${project.name} · 合并 ${r.milestone}（--dry-run，只演示不执行）`);
    for (const l of r.summaryLines) L.push(`  ${l}`);
    L.push("  逐项：");
    for (const l of r.dryRunLines) L.push(`  ${l}`);
    for (const w of r.warnings) L.push(`  ! ${w}`);
    return L.join("\n");
  }
  L.push(`合流 · ${project.name} · 合并 ${r.milestone}：${r.finalized ? "已发布" : "未收尾（待续）"} · 用时 ${(r.elapsedMs / 1000).toFixed(1)}s`);
  L.push(`  合入 ${r.merged.length} · 已在集成 ${r.alreadyIn.length} · 失败·待处理 ${r.failed.length} · 顺延 ${r.rolled.length} · 等它/未执行 ${r.waiting.length} · 待定跳过 ${r.pending.length}${r.unrehearsed.length ? ` · 未演练 ${r.unrehearsed.length}` : ""}`);
  for (const i of r.merged) L.push(`  ✓ ${i.feature} ${i.title}（${labels.get(i.repo ?? "") ?? i.repo} ${i.branch}）→ ${short(i.new_sha)}${i.union_resolved?.length ? ` · union（两边内容都保留、新日期在前）${i.union_resolved.join("、")}` : ""}${i.resolver ? ` · 解冲突器 ${i.resolver.rounds} 轮 $${i.resolver.cost_usd.toFixed(2)}` : ""}`);
  for (const i of r.failed) L.push(`  ✗ ${i.feature} ${i.title}：${i.result_detail ?? ""}`);
  for (const x of r.rolled) L.push(`  → 顺延 ${x.feature} ${x.title} → ${x.to}（${x.reason}）`);
  for (const i of r.waiting) L.push(`  … ${i.feature} ${i.title}：${i.decision === "等它" ? "等它" : "未执行"}`);
  if (r.pending.length) {
    L.push(`  跳过的待定项 ${r.pending.length} 个（不并入、不顺延，留在本版；本版因此先不收尾）：`);
    for (const i of r.pending) L.push(`    ? ${i.feature} ${i.title}${i.state === "未能试合" ? " · 未能试合 → 重新试合或人工确认" : ""}`);
    L.push(`    处理后：heliu 合并 ${r.milestone} --预演（重新试合）或 heliu release set ${r.milestone} <卡号> 并入|顺延，再执行`);
  }
  for (const t of r.tags) L.push(`  tag ${t.label} ${t.tag} → ${short(t.target)}`);
  for (const t of r.tagErrors) L.push(`  ✗ ${t}`);
  for (const mm of r.mainMoved) L.push(`  主线 ${mm.label}：${short(mm.from)} → ${short(mm.to)}（快进）`);
  for (const s of r.mainSkipped) L.push(`  主线未动 ${s.label}：${s.reason}`);
  if (r.costUsd > 0) L.push(`  解冲突器花费 $${r.costUsd.toFixed(2)}`);
  for (const w of r.warnings) L.push(`  ! ${w}`);
  L.push(`  合并单与发布说明：${r.plan.file}`);
  if (r.unpushed.length) {
    L.push("");
    L.push(`未推送：${r.unpushed.join("；")}（按仓库规矩，推送由你决定）`);
    L.push(`需要撤回：heliu 回滚 ${r.milestone}`);
  }
  return L.join("\n");
}

export function renderRollback(r: RollbackReport, project: ProjectConfig): string {
  if (r.nothing) return `合流 · ${project.name} · 回滚 ${r.milestone}：合并单里没有 heliu 移动过的引用，无需回滚`;
  const L = [`合流 · ${project.name} · 回滚 ${r.milestone}：${r.complete ? "完成" : "未完成"}`];
  for (const x of r.reverted) L.push(`  ✓ ${x.repo} ${x.ref}：${x.action}${x.to ? ` ${short(x.to)}` : ""}`);
  for (const x of r.skipped) L.push(`  - ${x.repo} ${x.ref}：${x.reason}`);
  for (const c of r.conflicts) L.push(`  ✗ ${c}`);
  if (r.ledgerRestored.length) L.push(`  台账恢复：${r.ledgerRestored.join("、")}`);
  for (const s of r.ledgerSkipped) L.push(`  ! ${s}`);
  if (r.milestoneStatus) L.push(`  里程碑状态恢复为「${r.milestoneStatus}」`);
  return L.join("\n");
}

export function renderRehearsal(r: RehearseResult): string {
  const L = [
    `演练完成：${r.milestone} · 合入 ${r.run.merged.length} · 失败 ${r.run.failed.length} · 顺延 ${r.run.rolled.length} · tag ${r.run.tags.length ? "已打" : "未打"} · 解冲突器 $${r.run.costUsd.toFixed(2)}`,
    `耗时：克隆 ${sec(r.cloneMs)} · 预演 ${sec(r.previewMs)} · 执行 ${sec(r.runMs)} · 合计 ${sec(r.totalMs)}`,
    `真仓库零写入：${r.zeroWrite ? "一致" : "有差异（见报告）"}（${r.snapshots.map((s) => `${s.label} ${s.items} 项`).join("、")}）`,
  ];
  if (r.run.aborted.length) L.push(`中止：${r.run.aborted.join("；")}`);
  L.push(`报告：${r.reportFiles.join("、")}`);
  return L.join("\n");
}
