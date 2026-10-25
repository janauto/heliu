/**
 * 各命令的中文文本输出。
 */
import type {
  AheadBehind,
  DoctorCheck,
  FeatureView,
  HygieneIssue,
  HygieneKind,
  ReconcileReport,
  RepoReport,
  SessionView,
} from "../types.ts";
import { SESSION_STATUS_LABEL } from "../core/sessions.ts";
import { pad, renderTable, width, type Column } from "./table.ts";

const pad2 = (n: number) => String(n).padStart(2, "0");
export function fmtDate(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
export function fmtDateTime(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return `${fmtDate(isoStr)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const fmtAB = (ab: AheadBehind | null) => (ab ? `↑${ab.ahead} ↓${ab.behind}` : "—");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

export function mergedStateText(b: FeatureView): string {
  let base: string;
  if (b.role === "main") base = "主线";
  else if (b.role === "integration") base = b.mergedState === "in_main" ? "集成分支·已并回" : "集成分支·未并回";
  else base = b.mergedState === "in_main" ? "进主线" : b.mergedState === "in_integration" ? "进集成分支" : "独立未合并";
  const p = b.precheck;
  if (p) {
    if (p.timedOut) base += "·试合超时";
    else if (p.error) base += /unrelated histories/.test(p.error) ? "·历史无关" : "·试合出错";
    else if (p.contentEquivalent) base += "·内容等价";
    else if ((p.conflictFiles ?? 0) > 0) base += `·冲突${p.conflictFiles}`;
    else base += "·可直合";
  }
  return base;
}

function worktreeCell(b: FeatureView): string {
  const w = b.worktree;
  if (!w) return "—";
  const name = w.isMain ? "(主目录)" : w.dirName;
  const mark = w.dirty === "dirty" ? " *" : w.dirty === "unknown" ? " ?" : "";
  return name + mark;
}

function sessionCell(b: FeatureView): string {
  const s = b.sessions[0];
  if (!s) return "—";
  const more = b.sessions.length > 1 ? `(+${b.sessions.length - 1})` : "";
  const status = s.status === "unknown" ? "" : `${SESSION_STATUS_LABEL[s.status]}·`;
  return `${status}${s.title ?? "无标题"}${more}`;
}

export function healthLine(r: RepoReport): string {
  if (!r.reachable || !r.counts || !r.health) {
    return `✗ ${r.error ?? "不可达"}（已跳过，heliu doctor 查看详情）`;
  }
  const c = r.counts;
  const h = r.health;
  const parts: string[] = [];
  parts.push(`分支 ${c.branches}`);
  parts.push(`worktree ${c.worktrees}`);
  const unmergedDetail = r.integration
    ? `（进集成 ${c.inIntegration} / 独立 ${c.independent}${h.integration?.exists && !h.integration.mergedIntoMain ? " / 集成分支 1" : ""}）`
    : "";
  parts.push(`未进主线 ${c.unmergedIntoMain}${unmergedDetail}`);
  if (h.mainVsRemote) {
    const m = h.mainVsRemote;
    if (m.ahead !== null && m.behind !== null) {
      const ref = m.remoteRef.replace(/^refs\/remotes\//, "");
      const rel = m.ahead === 0 && m.behind === 0 ? "一致" : `↑${m.ahead} ↓${m.behind}${m.ahead > 0 && m.behind > 0 ? "（分叉）" : ""}`;
      parts.push(`主线 vs ${ref} ${rel}`);
    } else parts.push(`主线 vs 远端：${m.note ?? "未知"}`);
  }
  if (h.integration) {
    const i = h.integration;
    if (!i.exists) parts.push("集成分支不存在");
    else if (i.mergedIntoMain) parts.push("集成分支已并回主线");
    else {
      const days = i.unmergedDays !== null ? `，${i.unmergedDays} 天未并回` : "";
      parts.push(`集成分支领先主线 ${i.aheadOfMain ?? "?"}${days}`);
    }
  }
  parts.push(`从未推送 ${c.neverPushed}`);
  const d = h.worktreeDirty;
  const dirtyParts = [
    d.clean ? `干净 ${d.clean}` : "",
    d.dirty ? `脏 ${d.dirty}` : "",
    d.unknown ? `未知 ${d.unknown}` : "",
    d.skipped ? `未检查 ${d.skipped}` : "",
  ].filter(Boolean);
  parts.push(`工作区 ${dirtyParts.join(" / ") || "—"}`);
  parts.push(`卫生 ${h.hygieneWarnings} 警告 / ${h.hygieneInfos} 提示`);
  if (r.gitTimeouts) parts.push(`git 超时 ${r.gitTimeouts} 次`);
  return parts.join(" · ");
}

export function renderHeader(report: ReconcileReport): string {
  const opts = [report.options.precheck ? "预检" : "", report.options.dirty ? "脏检查" : ""].filter(Boolean);
  return `合流 · ${report.project.name} · ${fmtDateTime(report.generatedAt)} · ${report.repos.length} 个仓库 · 用时 ${secs(report.elapsedMs)}${opts.length ? " · " + opts.join("+") : ""}`;
}

export function renderHealth(report: ReconcileReport): string {
  const w = Math.max(0, ...report.repos.map((r) => width(r.label)));
  return report.repos.map((r) => `  ${pad(r.label, w)}  ${healthLine(r)}`).join("\n");
}

export function repoTitle(r: RepoReport): string {
  const integ = r.integration ? ` · 集成=${r.integration}` : "";
  return `■ ${r.label}（${r.id}） 主线=${r.main}${integ}${r.icloud ? " · iCloud" : ""}\n  ${r.path}`;
}

export function renderBranchTable(r: RepoReport, opts: { wide?: boolean; filter?: (b: FeatureView) => boolean } = {}): string {
  const columns: Column[] = [
    { header: "标签", max: 22 },
    { header: "分支", max: 40, cut: "middle" },
    { header: "worktree", max: 28, cut: "middle" },
    { header: "会话（状态·标题）", max: 26 },
    { header: "主线↑/↓", align: "right" },
    { header: "集成↑/↓", align: "right" },
    { header: "合并状态" },
    { header: "最后提交" },
  ];
  const list = opts.filter ? r.branches.filter(opts.filter) : r.branches;
  const rows = list.map((b) => [
    b.label,
    b.branch,
    worktreeCell(b),
    sessionCell(b),
    b.role === "main" ? "—" : fmtAB(b.vsMain),
    fmtAB(b.vsIntegration),
    mergedStateText(b),
    fmtDate(b.lastCommitAt),
  ]);
  if (!rows.length) return "  （无分支）";
  return renderTable(columns, rows, { wide: opts.wide, indent: "  " });
}

export function renderStatus(report: ReconcileReport, opts: { wide?: boolean } = {}): string {
  const out: string[] = [renderHeader(report), "", "健康条", renderHealth(report)];
  for (const r of report.repos) {
    out.push("", repoTitle(r));
    for (const w of r.warnings) out.push(`  ! ${w}`);
    if (!r.reachable) {
      out.push(`  ✗ ${r.error ?? "不可达"}，已跳过`);
      continue;
    }
    if (r.error) out.push(`  ! ${r.error}`);
    out.push(renderBranchTable(r, opts));
  }
  out.push("", "图例：worktree 后 * = 有未提交改动，? = 检查超时/未知；会话 (+N) = 另有 N 个关联会话；--json 输出完整字段。");
  return out.join("\n");
}

const HYGIENE_TITLE: Record<HygieneKind, string> = {
  dir_branch_mismatch: "目录名 ≠ 分支名",
  orphan_admin_dir: "孤儿 .git/worktrees 条目",
  prunable_worktree: "worktree 目录已不存在",
  index_lock: "残留 index.lock",
  merged_worktree_remains: "分支已进主线但 worktree 仍在",
  worktree_no_commits: "worktree 相对主线 0 提交",
  detached_worktree: "worktree 分离 HEAD",
  main_dirty: "主目录脏项",
  icloud_conflict_copy: "iCloud 冲突副本",
};
const HYGIENE_ORDER: HygieneKind[] = [
  "index_lock",
  "orphan_admin_dir",
  "prunable_worktree",
  "dir_branch_mismatch",
  "icloud_conflict_copy",
  "merged_worktree_remains",
  "worktree_no_commits",
  "detached_worktree",
  "main_dirty",
];

export function renderHygiene(report: ReconcileReport): string {
  const out: string[] = [renderHeader(report), "（只报告，不动手；清理请人工确认后执行）"];
  for (const r of report.repos) {
    out.push("", repoTitle(r));
    if (!r.reachable) {
      out.push(`  ✗ ${r.error ?? "不可达"}，已跳过`);
      continue;
    }
    if (!r.hygiene.length) {
      out.push("  ✓ 未发现卫生问题");
      continue;
    }
    const groups = new Map<HygieneKind, HygieneIssue[]>();
    for (const h of r.hygiene) groups.set(h.kind, [...(groups.get(h.kind) ?? []), h]);
    for (const k of HYGIENE_ORDER) {
      const g = groups.get(k);
      if (!g) continue;
      const sev = g.some((x) => x.severity === "warn") ? "警告" : "提示";
      out.push(`  [${sev}] ${HYGIENE_TITLE[k]}（${g.length}）`);
      for (const h of g) out.push(`    - ${h.message}`);
    }
  }
  return out.join("\n");
}

export function renderSessions(projectName: string, sessions: SessionView[], opts: { all?: boolean; wide?: boolean } = {}): string {
  const shown = opts.all ? sessions : sessions.filter((s) => !s.isArchived);
  const hidden = sessions.length - shown.length;
  const needs = shown.filter((s) => s.status === "blocked" || s.needsAction).length;
  const out: string[] = [`合流 · ${projectName} · 会话 ${sessions.length} 条（显示 ${shown.length}，等你处理 ${needs}）`];
  const columns: Column[] = [
    { header: "最后活动" },
    { header: "状态" },
    { header: "标题", max: 30 },
    { header: "仓库" },
    { header: "分支", max: 36, cut: "middle" },
    { header: "worktree", max: 28, cut: "middle" },
    { header: "待你处理", max: 36 },
    { header: "PR", max: 16 },
  ];
  const rows = shown.map((s) => [
    fmtDateTime(s.lastActivityAt),
    SESSION_STATUS_LABEL[s.status],
    s.title ?? "无标题",
    s.repo,
    s.branch ?? "—",
    s.worktreeName ?? (s.worktreePath ? s.worktreePath.split("/").pop() ?? "" : "—"),
    s.needsAction ?? (s.statusCategory === "blocked" ? s.statusDetail ?? "（未说明）" : "—"),
    s.prs.length ? s.prs.map((p) => `#${p.number ?? "?"}${p.state ? " " + p.state.toLowerCase() : ""}`).join(",") : "—",
  ]);
  out.push(rows.length ? renderTable(columns, rows, { wide: opts.wide, indent: "  " }) : "  （无会话）");
  if (hidden > 0) out.push("", `另有 ${hidden} 条已归档会话未显示（--all 显示全部）。`);
  return out.join("\n");
}

export function renderDoctor(checks: DoctorCheck[]): string {
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  const out = ["合流 · 环境自检"];
  for (const c of checks) out.push(`  ${mark[c.level]} ${c.message}`);
  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  out.push("", fails ? `结论：${fails} 项失败，${warns} 项警告` : warns ? `结论：可用，${warns} 项警告` : "结论：一切正常");
  return out.join("\n");
}
