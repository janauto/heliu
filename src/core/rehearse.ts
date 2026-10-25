/**
 * release rehearse：在主仓库的克隆上完整跑一遍 preview + run --yes，真仓库零写入。
 *
 * 1. 写保护沙箱必须可用（否则拒绝：克隆用 alternates 引用真实对象库，git 写已存在的对象时会去刷新真实 pack 的 mtime——实测）。
 * 2. 三个真实仓库做 stat 快照（前）。
 * 3. 台账整个复制到 ~/.cache/heliu/rehearsal/<项目>/<时间>/ledger（合并单、功能卡、审计日志都写在副本里）。
 * 4. git clone --mirror --shared <主仓库> …/<仓库>.git：只复制引用、对象库只读引用；沙箱 deny 全部真实仓库。
 * 5. preview：对真实仓库只读对账（会话状态、试合与真实执行时一致），合并单写进台账副本。
 * 6. run --yes：project.yaml 临时只含主仓库且指向克隆；其余仓库的项标「未演练」，不改它们的台账。
 * 7. 快照（后）比对，生成演练报告（耗时、合入/冲突/顺延/tag/花费、零写入结果）。
 * 多仓库项目只演练主仓库（project.yaml primary 或第一个仓库）。
 */
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { lines, runGit, runGitWrite, sandboxAvailable } from "./git.ts";
import { ledgerDir, Ledger } from "./ledger.ts";
import { heliuCacheDir, type HeliuPaths } from "./paths.ts";
import { primaryRepo, type ProjectConfig } from "./project.ts";
import { previewRelease, ReleaseError, resolveReleaseMilestone, stamp, type PreviewResult } from "./release.ts";
import { auditFile, conflictText, resultText } from "./release-plan.ts";
import { runRelease, type RunReport } from "./release-run.ts";
import { diffCount, diffSnapshots, snapshotRepo, type SnapshotDiff } from "./snapshot.ts";

export interface RehearseOptions {
  log?: (line: string) => void;
  now?: () => Date;
  reportFile?: string;
  resolverBudgetUsd?: number;
}

export interface RehearseResult {
  milestone: string;
  root: string;
  clone: string;
  ledgerCopy: string;
  primary: { id: string; label: string; path: string };
  notRehearsed: string[];
  cloneMs: number;
  previewMs: number;
  runMs: number;
  totalMs: number;
  preview: PreviewResult;
  run: RunReport;
  snapshots: Array<{ id: string; label: string; items: number; diff: SnapshotDiff }>;
  zeroWrite: boolean;
  reportText: string;
  reportFiles: string[];
}

function tsName(d: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function rehearseRelease(project: ProjectConfig, paths: HeliuPaths, ref: string, opts: RehearseOptions = {}): Promise<RehearseResult> {
  const t0 = performance.now();
  const now = () => (opts.now ? opts.now() : new Date());
  const log = opts.log ?? (() => undefined);
  if (!sandboxAvailable()) throw new ReleaseError("演练必须在写保护沙箱（sandbox-exec）里进行，当前不可用，已拒绝");
  const srcLedger = ledgerDir(project);
  if (!existsSync(srcLedger)) throw new ReleaseError(`还没有台账（${srcLedger}）：先 heliu init / heliu sync`);
  const m = resolveReleaseMilestone(new Ledger(srcLedger), ref);
  const primary = primaryRepo(project);
  const cacheRoot = heliuCacheDir();
  const root = join(cacheRoot, "rehearsal", project.name, tsName(now()));
  mkdirSync(root, { recursive: true });

  // 真实仓库路径（沙箱 deny）+ 快照（前）
  const protect: string[] = [];
  const commons = new Map<string, string>();
  for (const r of project.repos) {
    const rp = await runGit(r.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: 30_000, protect: [r.path] });
    const c = rp.ok ? (lines(rp.stdout)[0] ?? join(r.path, ".git")) : join(r.path, ".git");
    commons.set(r.id, c);
    protect.push(r.path, c);
  }
  log(`快照（前）：${project.repos.map((r) => r.label).join("、")}`);
  const before = new Map(project.repos.map((r) => [r.id, snapshotRepo(r.path, commons.get(r.id))]));

  // 台账副本
  const ledgerCopy = join(root, "ledger");
  cpSync(srcLedger, ledgerCopy, { recursive: true, filter: (s) => !s.endsWith("/.lock") });
  const audit = auditFile(ledgerCopy, m.id);
  mkdirSync(join(ledgerCopy, "releases"), { recursive: true });

  // 克隆主仓库
  const clone = join(root, `${primary.id}.git`);
  log(`克隆：git clone --mirror --shared ${primary.path} → ${clone}`);
  const tc = performance.now();
  const cl = await runGitWrite(root, ["clone", "--mirror", "--shared", "-q", primary.path, clone], {
    reason: "演练克隆（只读引用真实对象库）",
    auditLog: audit,
    cacheRoot,
    policy: { deny: protect, allow: [root] },
    requireSandbox: true,
    timeoutMs: 10 * 60_000,
  });
  const cloneMs = Math.round(performance.now() - tc);
  if (!cl.ok) throw new ReleaseError(`克隆失败（${Math.round(cloneMs / 1000)}s）：${cl.timedOut ? "超过 10 分钟" : cl.stderr.trim()}`);
  log(`  克隆完成 ${sec(cloneMs)}`);

  // 预演：真实仓库只读，合并单写进台账副本
  const tp = performance.now();
  const projPreview: ProjectConfig = { ...project, ledger: ledgerCopy };
  log("预演（真实仓库只读对账 + 试合）…");
  const preview = await previewRelease(projPreview, paths, m.id, { now: now() });
  const previewMs = Math.round(performance.now() - tp);
  log(`  合并单 ${preview.plan.items.length} 项，${sec(previewMs)}`);

  // 执行：只含主仓库、指向克隆
  const tr = performance.now();
  const projRun: ProjectConfig = { ...project, ledger: ledgerCopy, primary: primary.id, repos: [{ ...primary, path: clone, icloud: false }] };
  const run = await runRelease(projRun, m.id, {
    yes: true,
    log,
    now,
    resolverBudgetUsd: opts.resolverBudgetUsd,
    rehearsal: { protect, worktreeRoot: join(root, "worktrees") },
  });
  const runMs = Math.round(performance.now() - tr);

  // 快照（后）
  const snapshots = project.repos.map((r) => {
    const after = snapshotRepo(r.path, commons.get(r.id));
    const b = before.get(r.id) as Map<string, string>;
    return { id: r.id, label: r.label, items: b.size, diff: diffSnapshots(b, after) };
  });
  const zeroWrite = snapshots.every((s) => diffCount(s.diff) === 0);
  const totalMs = Math.round(performance.now() - t0);
  const res: RehearseResult = {
    milestone: m.id,
    root,
    clone,
    ledgerCopy,
    primary: { id: primary.id, label: primary.label, path: primary.path },
    notRehearsed: project.repos.filter((r) => r.id !== primary.id).map((r) => r.label),
    cloneMs, previewMs, runMs, totalMs, preview, run, snapshots, zeroWrite,
    reportText: "",
    reportFiles: [],
  };
  res.reportText = renderRehearsalReport(project, res, stamp(now()));
  const files = [join(root, "演练报告.md"), ...(opts.reportFile ? [opts.reportFile] : [])];
  for (const f of files) writeFileSync(f, res.reportText, "utf8");
  res.reportFiles = files;
  return res;
}

export const sec = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");
const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function renderRehearsalReport(project: ProjectConfig, r: RehearseResult, when: string): string {
  const p = r.run.plan;
  const L: string[] = [];
  L.push(`# M4 演练报告：${project.name} ${r.milestone}（${when}）`);
  L.push("");
  L.push(`> 由 \`heliu release rehearse ${r.milestone} --project ${project.name}\` 生成。全部写入只发生在演练目录：\`${r.root}\`。`);
  L.push("");
  L.push("## 结论");
  L.push(`- 主仓库 ${r.primary.label} 克隆上执行：合入 **${r.run.merged.length}** · 已在集成 ${r.run.alreadyIn.length} · 失败·待处理 ${r.run.failed.length} · 顺延 **${r.run.rolled.length}** · 未演练 ${r.run.unrehearsed.length}`);
  L.push(`- tag：${r.run.tags.map((t) => `${t.label} ${t.tag} → ${short(t.target)}`).join("；") || "未打（" + (r.run.finalized ? "失败" : "本版未收尾") + "）"}${r.run.tagErrors.length ? `；${r.run.tagErrors.join("；")}` : ""}`);
  L.push(`- 解冲突器（Opus）花费：$${r.run.costUsd.toFixed(2)}`);
  L.push(`- 耗时：克隆 ${sec(r.cloneMs)} · 预演 ${sec(r.previewMs)} · 执行 ${sec(r.runMs)} · 合计 ${sec(r.totalMs)}`);
  L.push(`- 真仓库零写入：${r.zeroWrite ? "**一致**（三仓库 stat 快照前后完全相同）" : "**有差异**（见下文，需逐条核实来源）"}`);
  L.push(`- 未推送：${r.run.unpushed.join("；") || "无"}（演练克隆上的引用，不影响真仓库）`);
  if (r.run.aborted.length) L.push(`- **中止**：${r.run.aborted.join("；")}`);
  for (const w of r.run.warnings) L.push(`- 提示：${w}`);
  L.push("");
  L.push("## 逐项结果");
  L.push("| # | 决定 | 功能 | 分支 | 预演状态 | 试合冲突 | 执行结果 |");
  L.push("|---|---|---|---|---|---|---|");
  p.items.forEach((i, k) => {
    L.push(`| ${k + 1} | ${i.decision} | ${cell(`${i.feature} ${i.title}`)} | ${cell(i.branch ? `${i.repo ?? ""} \`${i.branch}\`` : "—")} | ${cell(`${i.state}${i.detail ? `（${i.detail}）` : ""}`)} | ${cell(conflictText(i))} | ${cell(resultText(i) || (i.decision === "并入" ? "—" : "不合"))} |`);
  });
  L.push("");
  L.push("## 冲突怎么解的");
  const ci = p.items.filter((i) => i.union_resolved?.length || i.resolver);
  if (!ci.length) L.push("- 本次没有需要处理的冲突。");
  for (const i of ci) {
    if (i.union_resolved?.length) L.push(`- ${i.feature}：union（两边都保留、新日期在前）${i.union_resolved.join("、")}`);
    if (i.resolver) L.push(`- ${i.feature}：解冲突器 ${i.resolver.files.join("、")}，${i.resolver.rounds} 轮、${i.resolver.turns ?? "?"} 步、$${i.resolver.cost_usd.toFixed(2)}，${i.resolver.ok ? "解完" : "未解完"}。报告：${cell(i.resolver.summary || "（无）").slice(0, 600)}`);
  }
  L.push("");
  L.push("## 顺延");
  if (!r.run.rolled.length) L.push("- 无");
  for (const x of r.run.rolled) L.push(`- ${x.feature} ${x.title} → ${x.to}（${x.reason}）`);
  L.push("");
  L.push("## 真仓库零写入（stat 快照比对）");
  L.push("| 仓库 | 快照项 | 新增 | 删除 | 变化 |");
  L.push("|---|---|---|---|---|");
  for (const s of r.snapshots) L.push(`| ${s.label} | ${s.items} | ${s.diff.added.length} | ${s.diff.removed.length} | ${s.diff.changed.length} |`);
  for (const s of r.snapshots) {
    const all = [...s.diff.added.map((x) => `+ ${x}`), ...s.diff.removed.map((x) => `- ${x}`), ...s.diff.changed.map((x) => `~ ${x}`)];
    if (all.length) L.push(`- ${s.label} 差异（前 20 条）：${all.slice(0, 20).map((x) => `\`${x}\``).join("、")}`);
  }
  L.push("");
  L.push("## 未演练");
  L.push(`- 只克隆主仓库（${r.primary.label}）；${r.notRehearsed.length ? `${r.notRehearsed.join("、")} 的项标「未演练」，台账副本里不改它们` : "无其他仓库"}。`);
  L.push("");
  L.push("## 位置");
  L.push(`- 克隆：\`${r.clone}\``);
  L.push(`- 台账副本（合并单 / 审计日志 / 改过的功能卡）：\`${r.ledgerCopy}\``);
  L.push(`- 可直接删除整个演练目录：\`rm -rf "${r.root}"\``);
  L.push("");
  return L.join("\n");
}
