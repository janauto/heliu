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
  SessionRef,
  SessionView,
} from "../types.ts";
import { SESSION_STATUS_LABEL } from "../core/sessions.ts";
import { hangingWrap, outputWidth, pad, renderTable, truncate, truncateMiddle, width, type Column } from "./table.ts";

/** 表头/摘要上方的口径说明 */
export const LEGEND = "图例：↑领先 ↓落后（提交数）· worktree 数不含主目录 · 工作区检查数含主目录";
/** 健康条末尾的远端口径括注 */
export const REMOTE_NOTE = "（远端对比基于本地已有引用，未 fetch）";
/** 摘要末尾的展开提示 */
export const FULL_HINT = "提示：heliu status --full 查看全部分支长表";

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
  parts.push(`本地无远端引用 ${c.neverPushed}`);
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
  const rows = report.repos.map((r) => `  ${pad(r.label, w)}  ${healthLine(r)}`);
  rows.push(`  ${REMOTE_NOTE}`);
  return rows.join("\n");
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

/** heliu status --full：健康条 + 每个仓库的全部分支长表 */
export function renderStatusFull(report: ReconcileReport, opts: { wide?: boolean } = {}): string {
  const out: string[] = [renderHeader(report), LEGEND, "", "健康条", renderHealth(report)];
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
  out.push("", "标记：worktree 后 * = 有未提交改动，? = 检查超时/未知；会话 (+N) = 另有 N 个关联会话；--json 输出完整字段。");
  return out.join("\n");
}

export interface SummaryOptions {
  wide?: boolean;
  /** 输出宽度（折行用），默认取终端宽度 */
  width?: number;
  /** 会话明细（补 status_detail 用） */
  sessions?: SessionView[];
}

/** 等你处理的文案：needs_action 优先，其次 status_detail */
function needsText(s: SessionRef, byId: Map<string, SessionView>): string {
  return s.needsAction?.trim() || byId.get(s.sessionId)?.statusDetail?.trim() || "（会话未写明需要什么，见 heliu sessions）";
}

/**
 * 单行「标签 · 尾部」：不折行，超宽先截标签，标签已短仍超宽再中间截断尾部（分支名保留 hash 后缀）。
 * --wide 时原样输出。
 */
function fitLine(prefix: string, label: string, tail: string, W: number, wide?: boolean): string {
  const sep = " · ";
  if (wide) return prefix + label + sep + tail;
  const avail = W - width(prefix) - width(sep) - width(tail);
  if (avail >= 10) return prefix + truncate(label, avail) + sep + tail;
  const lab = truncate(label, 12);
  return prefix + lab + sep + truncateMiddle(tail, Math.max(10, W - width(prefix) - width(sep) - width(lab)));
}

/** 落后需同步的基准：有集成分支看集成，否则看主线 */
function behindBase(r: RepoReport, b: FeatureView): number {
  return (r.integration ? b.vsIntegration?.behind : b.vsMain?.behind) ?? 0;
}

function renderRepoSummary(r: RepoReport, opts: Required<Pick<SummaryOptions, "width">> & SummaryOptions, byId: Map<string, SessionView>): string[] {
  const out: string[] = [];
  const W = opts.width;
  const feats = r.branches.filter((b) => b.role !== "main");

  // ① 等你处理：关联会话状态为「等你」的分支，needs_action 全文折行
  const waiting = r.branches
    .map((b) => ({ b, ss: b.sessions.filter((s) => s.status === "blocked") }))
    .filter((x) => x.ss.length > 0);
  out.push(`  ① 等你处理（${waiting.length}）${waiting.length ? "" : "：无"}`);
  for (const { b, ss } of waiting) {
    // 目录被复用（目录名≠分支名）时补上目录，方便找到工作区
    const reused = b.worktree && !b.worktree.isMain && b.worktree.dirName !== (b.branch.split("/").pop() ?? b.branch);
    out.push(fitLine("    - ", b.label, b.branch + (reused ? `（目录 ${b.worktree?.dirName}）` : ""), W, opts.wide));
    for (const s of ss) {
      if (s.title && s.title !== b.label) out.push(...hangingWrap("      会话：", s.title, W));
      out.push(...hangingWrap("      需要你：", needsText(s, byId), W));
    }
  }

  // ② 独立未合并
  const independent = feats.filter((b) => b.role === "feature" && b.mergedState === "unmerged");
  out.push(`  ② 独立未合并（${independent.length}）${independent.length ? "" : "：无"}`);
  if (independent.length) {
    const columns: Column[] = [
      { header: "标签", max: 26 },
      { header: "分支", max: 44, cut: "middle" },
      { header: "主线↑/↓", align: "right" },
      ...(r.integration ? [{ header: "集成↑/↓", align: "right" } as Column] : []),
      { header: "最后提交" },
    ];
    const rows = independent.map((b) => [
      b.label,
      b.branch,
      fmtAB(b.vsMain),
      ...(r.integration ? [fmtAB(b.vsIntegration)] : []),
      fmtDate(b.lastCommitAt),
    ]);
    out.push(renderTable(columns, rows, { wide: opts.wide, indent: "    " }));
  }

  // ③ 已进集成分支待回主线：只给计数 + 一句话
  const inInteg = feats.filter((b) => b.role === "feature" && b.mergedState === "in_integration").length;
  const integ = r.health?.integration ?? null;
  let integLine: string;
  if (!r.integration) integLine = "未配置集成分支";
  else if (!integ?.exists) integLine = `集成分支 ${r.integration} 不存在`;
  else if (integ.mergedIntoMain) integLine = `${inInteg} 条 · 集成分支已并回主线`;
  else {
    const days = integ.unmergedDays !== null ? `，${integ.unmergedDays} 天未并回` : "，尚未并回";
    integLine = `${inInteg} 条 · 集成分支领先主线 ${integ.aheadOfMain ?? "?"}${days}`;
  }
  out.push(`  ③ 已进集成分支待回主线：${integLine}`);

  // ④ 落后需同步：尚未合入（不在主线、不在集成分支）且相对集成分支（无集成则主线）落后的分支
  const behind = independent.filter((b) => behindBase(r, b) > 0).sort((a, b) => behindBase(r, b) - behindBase(r, a));
  const baseName = r.integration ? "集成分支" : "主线";
  out.push(`  ④ 落后需同步（相对${baseName}，${behind.length} 条）${behind.length ? (behind.length > 5 ? "，落后最多的 5 条：" : "：") : "：无"}`);
  for (const b of behind.slice(0, 5)) {
    out.push(fitLine("    - ", b.label, `${b.branch} · ↓${behindBase(r, b)}`, W, opts.wide));
  }
  return out;
}

/** heliu status 默认：行动摘要（健康条 + 每仓库四组） */
export function renderStatusSummary(report: ReconcileReport, opts: SummaryOptions = {}): string {
  const W = opts.width ?? outputWidth();
  const byId = new Map((opts.sessions ?? []).map((s) => [s.sessionId, s]));
  const out: string[] = [renderHeader(report), LEGEND, "", "健康条", renderHealth(report)];
  for (const r of report.repos) {
    out.push("", repoTitle(r));
    for (const w of r.warnings) out.push(`  ! ${w}`);
    if (!r.reachable) {
      out.push(`  ✗ ${r.error ?? "不可达"}，已跳过`);
      continue;
    }
    if (r.error) out.push(`  ! ${r.error}`);
    out.push(...renderRepoSummary(r, { ...opts, width: W }, byId));
  }
  out.push("", FULL_HINT);
  return out.join("\n");
}

/** 兼容旧名 */
export const renderStatus = renderStatusFull;

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

function sessionBlock(s: SessionView, W: number, wide?: boolean): string[] {
  const out: string[] = [];
  const pr = s.prs.length ? `PR ${s.prs.map((p) => `#${p.number ?? "?"}${p.state ? " " + p.state.toLowerCase() : ""}`).join(", ")}` : "";
  const status = s.status === "blocked" ? "" : `${SESSION_STATUS_LABEL[s.status]} · `;
  out.push(...hangingWrap("  - ", `${fmtDateTime(s.lastActivityAt)} · ${status}${s.title ?? "无标题"}`, W));
  // 位置行不折行（分支名/目录名断开就没法复制了）：目录名与分支同名时省略目录
  const slug = s.branch ? (s.branch.split("/").pop() ?? s.branch) : null;
  const dir = s.worktreeName && s.worktreeName !== slug ? `目录 ${s.worktreeName}` : "";
  const where = [s.repo, s.branch ? `分支 ${s.branch}` : "无分支", dir, pr].filter(Boolean).join(" · ");
  out.push("    " + (wide ? where : truncateMiddle(where, W - 4)));
  if (s.status === "blocked") {
    out.push(...hangingWrap("    需要你：", s.needsAction?.trim() || s.statusDetail?.trim() || "（会话未写明需要什么）", W));
  }
  return out;
}

/**
 * heliu sessions：默认只列「等你处理」与「运行中」两组并完整显示文案；
 * --all 再追加其余会话（待验收/已完成/已归档等）的表格。
 */
export function renderSessions(projectName: string, sessions: SessionView[], opts: { all?: boolean; wide?: boolean; width?: number } = {}): string {
  const W = opts.width ?? outputWidth();
  const waiting = sessions.filter((s) => s.status === "blocked");
  const running = sessions.filter((s) => s.status === "running" || s.status === "online");
  const rest = sessions.filter((s) => !waiting.includes(s) && !running.includes(s));
  const count = (st: SessionView["status"]) => rest.filter((s) => s.status === st).length;
  const restParts = [
    count("review_ready") ? `待验收 ${count("review_ready")}` : "",
    count("completed") ? `已完成 ${count("completed")}` : "",
    count("archived") ? `已归档 ${count("archived")}` : "",
    count("unknown") ? `无状态 ${count("unknown")}` : "",
  ].filter(Boolean);
  const out: string[] = [
    `合流 · ${projectName} · 会话 ${sessions.length} 条：等你 ${waiting.length} · 运行中 ${running.length}${restParts.length ? `；另有 ${restParts.join(" · ")}` : ""}`,
  ];
  out.push("", `■ 等你处理（${waiting.length}）${waiting.length ? "" : "：无"}`);
  for (const s of waiting) out.push(...sessionBlock(s, W, opts.wide));
  out.push("", `■ 运行中（${running.length}，含在线空闲）${running.length ? "" : "：无"}`);
  for (const s of running) out.push(...sessionBlock(s, W, opts.wide));

  if (opts.all) {
    out.push("", `■ 其余会话（${rest.length}）${rest.length ? "" : "：无"}`);
    if (rest.length) {
      const columns: Column[] = [
        { header: "最后活动" },
        { header: "状态" },
        { header: "标题", max: 30 },
        { header: "仓库" },
        { header: "分支", max: 36, cut: "middle" },
        { header: "worktree", max: 28, cut: "middle" },
        { header: "PR", max: 16 },
      ];
      const rows = rest.map((s) => [
        fmtDateTime(s.lastActivityAt),
        SESSION_STATUS_LABEL[s.status],
        s.title ?? "无标题",
        s.repo,
        s.branch ?? "—",
        s.worktreeName ?? (s.worktreePath ? (s.worktreePath.split("/").pop() ?? "") : "—"),
        s.prs.length ? s.prs.map((p) => `#${p.number ?? "?"}${p.state ? " " + p.state.toLowerCase() : ""}`).join(",") : "—",
      ]);
      out.push(renderTable(columns, rows, { wide: opts.wide, indent: "  " }));
    }
  } else if (rest.length) {
    out.push("", `提示：heliu sessions --all 显示其余 ${rest.length} 条（${restParts.join(" · ")}）`);
  }
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
