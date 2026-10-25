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
  SessionLink,
  SessionView,
} from "../types.ts";
import { SESSION_STATUS_LABEL } from "../core/sessions.ts";
import { hangingWrap, outputWidth, pad, renderTable, truncate, truncateMiddle, width, type Column } from "./table.ts";

/** 表头/摘要上方的口径说明 */
export const LEGEND = "图例：↑领先 ↓落后（提交数）· worktree 数不含主目录 · 工作区检查数含主目录 · 已进主线 = 提交已被主线包含，不代表功能已验收";
/** 会话↔分支关联来源的中文标记 */
export const LINK_MARK: Record<SessionLink, string> = { branch: "记录", written: "写入", worktree: "目录" };
/** 关联来源的口径说明 */
export const LINK_NOTE = "会话关联来源：记录 = 会话记录的分支；写入 = 会话往该分支写过提交；目录 = 仅按会话目录所在 worktree 推断（目录可能已被复用）";
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
/** MM-DD HH:mm（等你处理条目末尾的最后活动时间） */
export function fmtShort(isoStr: string | null): string {
  if (!isoStr) return "—";
  const d = new Date(isoStr);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const fmtAB = (ab: AheadBehind | null) => (ab ? `↑${ab.ahead} ↓${ab.behind}` : "—");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/**
 * 合并状态文案。tips 给出时，与主线/集成分支顶端同点的功能分支标「（无独有提交）」：
 * 这类分支 git 祖先判断恒为「进主线/进集成分支」，但并没有任何工作被合入（分支视角的三档本身不变）。
 */
export function mergedStateText(b: FeatureView, tips?: { main: string | null; integ: string | null }): string {
  let base: string;
  if (b.role === "main") base = "主线";
  else if (b.role === "integration") base = b.mergedState === "in_main" ? "集成分支·已并回" : "集成分支·未并回";
  else base = b.mergedState === "in_main" ? "进主线" : b.mergedState === "in_integration" ? "进集成分支" : "独立未合并";
  if (b.role === "feature" && b.mergedState !== "unmerged" && tips && (b.sha === tips.main || b.sha === tips.integ)) base += "（无独有提交）";
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
  return `(${LINK_MARK[s.link]})${status}${s.title ?? "无标题"}${more}`;
}

export function healthLine(r: RepoReport): string {
  if (!r.reachable || !r.counts || !r.health) {
    return `✗ ${r.error ?? "不可达"}（已跳过，heliu doctor 查看详情）`;
  }
  const c = r.counts;
  const h = r.health;
  const parts: string[] = [];
  parts.push(`分支 ${c.branches}`);
  parts.push(`已进主线 ${c.mergedIntoMain}`);
  const unmergedDetail = r.integration
    ? `（进集成 ${c.inIntegration} / 独立 ${c.independent}${h.integration?.exists && !h.integration.mergedIntoMain ? " / 集成分支 1" : ""}）`
    : "";
  parts.push(`未进主线 ${c.unmergedIntoMain}${unmergedDetail}`);
  parts.push(`worktree ${c.worktrees}`);
  if (h.mainVsRemote) {
    const m = h.mainVsRemote;
    const ref = m.remoteRef.replace(/^refs\/remotes\//, "");
    if (m.ahead !== null && m.behind !== null) {
      const rel = m.ahead === 0 && m.behind === 0 ? "一致" : `↑${m.ahead} ↓${m.behind}${m.ahead > 0 && m.behind > 0 ? "（分叉）" : ""}`;
      parts.push(`主线 vs ${ref} ${rel}`);
    } else parts.push(ref ? `主线 vs ${ref}：本地无此引用` : "主线未配置远端");
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
    d.clean ? `已跟踪文件干净 ${d.clean}` : "",
    d.dirty ? `有改动 ${d.dirty}` : "",
    d.unknown ? `未知 ${d.unknown}` : "",
    d.skipped ? `未检查 ${d.skipped}` : "",
  ].filter(Boolean);
  parts.push(`工作区 ${dirtyParts.join(" / ") || "—"}`);
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
  const tips = { main: r.branches.find((b) => b.role === "main")?.sha ?? null, integ: r.branches.find((b) => b.role === "integration")?.sha ?? null };
  const rows = list.map((b) => [
    b.label,
    b.branch,
    worktreeCell(b),
    sessionCell(b),
    b.role === "main" ? "—" : fmtAB(b.vsMain),
    fmtAB(b.vsIntegration),
    mergedStateText(b, tips),
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
  out.push(
    "",
    "标记：worktree 后 * = 有未提交改动，? = 检查超时/未知；会话 (+N) = 另有 N 个关联会话；「（无独有提交）」= 分支与主线/集成分支顶端同点，并没有工作被合入；--json 输出完整字段。",
    LINK_NOTE + "。",
  );
  return out.join("\n");
}

export interface SummaryOptions {
  wide?: boolean;
  /** 输出宽度（折行用），默认取终端宽度 */
  width?: number;
  /** 会话明细（补 status_detail 用） */
  sessions?: SessionView[];
}

/** 摘要里每组最多列几条 */
export const SUMMARY_LIMIT = 8;
/** ④ 不是全集时最多列几条 */
export const BEHIND_LIMIT = 5;

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

const independentOf = (r: RepoReport) => r.branches.filter((b) => b.role === "feature" && b.mergedState === "unmerged");
const reachable = (report: ReconcileReport) => report.repos.filter((r) => r.reachable && r.health);

interface WaitingItem {
  repo: string;
  title: string;
  needs: string;
  at: string | null;
}

/** 等你处理：有会话明细时按会话（含未关联分支的会话），否则从分支挂的会话里去重 */
function waitingItems(report: ReconcileReport, sessions: SessionView[] | undefined): WaitingItem[] {
  const repoLabel = new Map(report.repos.map((r) => [r.id, r.label]));
  const items: WaitingItem[] = [];
  if (sessions) {
    for (const s of sessions) {
      if (s.status !== "blocked") continue;
      items.push({
        repo: repoLabel.get(s.repo) ?? s.repo,
        title: s.title ?? "无标题会话",
        needs: s.needsAction?.trim() || s.statusDetail?.trim() || "（会话未写明需要什么，见 heliu sessions）",
        at: s.lastActivityAt,
      });
    }
  } else {
    const seen = new Set<string>();
    for (const r of report.repos) {
      for (const b of r.branches) {
        for (const s of b.sessions) {
          if (s.status !== "blocked" || seen.has(s.sessionId)) continue;
          seen.add(s.sessionId);
          items.push({ repo: r.label, title: s.title ?? b.label, needs: s.needsAction?.trim() || "（会话未写明需要什么，见 heliu sessions）", at: s.lastActivityAt });
        }
      }
    }
  }
  return items.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
}

/**
 * 「现在最该做的」：按严重度依次检查，各一句，最多 3 句。
 * 集成分支未并回 ≥1 天 > 等你 ≥1 > 独立未合并 ≥1 > 主线与远端分叉 > 孤儿/锁文件警告
 */
export function topActions(report: ReconcileReport, waitingCount: number): string[] {
  const repos = reachable(report);
  const out: string[] = [];
  const integ = repos.filter((r) => {
    const i = r.health!.integration;
    return !!i && i.exists && !i.mergedIntoMain && (i.unmergedDays ?? 0) >= 1;
  });
  if (integ.length === 1) {
    const r = integ[0]!;
    const i = r.health!.integration!;
    out.push(`${r.label}集成分支领先主线 ${i.aheadOfMain ?? "?"} 提交、${i.unmergedDays} 天未并回 → 检查集成分支是否可并回主线（heliu 合并 <版本> --预演 可预检）`);
  } else if (integ.length > 1) {
    const parts = integ.map((r) => `${r.label}（领先 ${r.health!.integration!.aheadOfMain ?? "?"}、${r.health!.integration!.unmergedDays} 天）`);
    out.push(`集成分支未并回主线：${parts.join("、")} → 检查集成分支是否可并回主线（heliu 合并 <版本> --预演 可预检）`);
  }
  if (waitingCount > 0) out.push(`${waitingCount} 个会话在等你拍板（见 ①，全部：heliu sessions）`);
  const indep = repos.map((r) => ({ r, n: independentOf(r).length })).filter((x) => x.n > 0);
  const indepTotal = indep.reduce((a, x) => a + x.n, 0);
  if (indepTotal > 0) {
    const detail = repos.length > 1 ? `${indep.map((x) => `${x.r.label} ${x.n}`).join(" / ")}；` : "";
    out.push(`${indepTotal} 条独立分支未被主线或集成分支包含（${detail}M2 起可预约版本）`);
  }
  for (const r of repos) {
    const m = r.health!.mainVsRemote;
    if (m && (m.ahead ?? 0) > 0 && (m.behind ?? 0) > 0) {
      out.push(`${r.label}主线与 ${m.remoteRef.replace(/^refs\/remotes\//, "")} 分叉（↑${m.ahead} ↓${m.behind}）→ 先对齐远端`);
    }
  }
  for (const r of repos) {
    const orphans = r.hygiene.filter((h) => h.kind === "orphan_admin_dir" || h.kind === "prunable_worktree").length;
    const locks = r.hygiene.filter((h) => h.kind === "index_lock").length;
    if (orphans || locks) {
      const what = [orphans ? `${orphans} 个孤儿 worktree 条目` : "", locks ? `${locks} 个 index.lock（是否残留待确认）` : ""].filter(Boolean).join("、");
      out.push(`${r.label}有 ${what}（heliu hygiene 查看，人工确认后清理）`);
    }
  }
  return out.slice(0, 3);
}

/**
 * heliu status 默认：一屏行动摘要（项目级，跨仓库合并四组，每组限条数）。
 * ① 等你处理 ≤8（全文）② 独立未合并 ≤8（按最后提交倒序）③ 计数 + 一句话 ④ 全部落后时一句话，否则 ≤5
 */
export function renderStatusSummary(report: ReconcileReport, opts: SummaryOptions = {}): string {
  const W = opts.width ?? outputWidth();
  const repos = reachable(report);
  const multi = report.repos.length > 1;
  const out: string[] = [renderHeader(report), LEGEND, "健康条", renderHealth(report)];
  for (const r of report.repos) {
    for (const w of r.warnings) out.push(`  ! ${r.label}：${w}`);
    if (r.reachable && r.error) out.push(`  ! ${r.label}：${r.error}`);
  }

  const waiting = waitingItems(report, opts.sessions);
  const actions = topActions(report, waiting.length);
  if (actions.length) {
    out.push("现在最该做的");
    // 结论句不截断：放不下就悬挂缩进折行
    actions.forEach((a, i) => out.push(...(opts.wide ? [`  ${i + 1}）${a}`] : hangingWrap(`  ${i + 1}）`, a, W))));
  }

  // ① 等你处理：全来自同一仓库时不逐条打仓库标记（省宽度、少折行），在标题里说明
  const waitRepos = [...new Set(waiting.map((w) => w.repo))];
  const tagEach = multi && waitRepos.length > 1;
  const where = multi && waitRepos.length === 1 ? `，均在${waitRepos[0]}` : "";
  out.push(`① 等你处理（${waiting.length}${where}${waiting.length ? "；会话最后记录的请求，可能已过期" : ""}）${waiting.length ? "" : "：无"}`);
  for (const w of waiting.slice(0, SUMMARY_LIMIT)) {
    out.push(...hangingWrap("  - ", `${tagEach ? `[${w.repo}] ` : ""}${w.title}：${w.needs}${w.at ? ` · ${fmtShort(w.at)}` : ""}`, W));
  }
  if (waiting.length > SUMMARY_LIMIT) out.push(`  …还有 ${waiting.length - SUMMARY_LIMIT} 条，\`heliu sessions\` 查看`);

  // ② 独立未合并
  const indep = repos.flatMap((r) => independentOf(r).map((b) => ({ r, b })));
  indep.sort((x, y) => (y.b.lastCommitAt ?? "").localeCompare(x.b.lastCommitAt ?? ""));
  const perRepo = multi ? `：${repos.map((r) => `${r.label} ${independentOf(r).length}`).join(" · ")}` : "";
  out.push(`② 独立未合并（${indep.length}${indep.length ? perRepo : ""}）${indep.length ? "" : "：无"}`);
  if (indep.length) {
    const anyInteg = indep.some((x) => x.r.integration);
    const columns: Column[] = [
      ...(multi ? [{ header: "仓库" } as Column] : []),
      { header: "标签", max: 24 },
      { header: "分支", max: 40, cut: "middle" },
      { header: "主线↑/↓", align: "right" },
      ...(anyInteg ? [{ header: "集成↑/↓", align: "right" } as Column] : []),
      { header: "最后提交" },
    ];
    const rows = indep.slice(0, SUMMARY_LIMIT).map(({ r, b }) => [
      ...(multi ? [r.label] : []),
      b.label,
      b.branch,
      fmtAB(b.vsMain),
      ...(anyInteg ? [r.integration ? fmtAB(b.vsIntegration) : "—"] : []),
      fmtDate(b.lastCommitAt),
    ]);
    out.push(renderTable(columns, rows, { wide: opts.wide, indent: "  " }));
    if (indep.length > SUMMARY_LIMIT) out.push(`  …还有 ${indep.length - SUMMARY_LIMIT} 条，\`--full\` 查看`);
  }

  // ③ 已进集成分支待回主线：计数 + 一句话
  const integParts: string[] = [];
  for (const r of repos) {
    if (!r.integration) continue;
    const n = r.branches.filter((b) => b.role === "feature" && b.mergedState === "in_integration").length;
    const i = r.health!.integration;
    const who = multi ? `${r.label} ` : "";
    // 第一句写全「集成分支领先主线 N，M 天未并回」，后面的仓库只写数字，控制在一行内
    const days = i?.unmergedDays !== null && i?.unmergedDays !== undefined ? `，${i.unmergedDays} 天未并回` : "";
    if (!i?.exists) integParts.push(`${who}集成分支 ${r.integration} 不存在`);
    else if (i.mergedIntoMain) integParts.push(`${who}${n} 条（集成分支已并回主线）`);
    else integParts.push(`${who}${n} 条（集成分支领先主线 ${i.aheadOfMain ?? "?"}${days}）`);
  }
  {
    // 一行放得下就一行；放不下则每个仓库一行（不在句子中间折断）
    const prefix = "③ 已进集成分支待回主线：";
    const one = prefix + (integParts.length ? integParts.join("；") : "未配置集成分支");
    if (opts.wide || integParts.length <= 1 || width(one) <= W) out.push(one);
    else integParts.forEach((p, i) => out.push((i === 0 ? prefix : " ".repeat(width(prefix))) + p));
  }

  // ④ 落后需同步：已进主线的不算；全部落后时只给一句话
  const behindLines: string[] = [];
  for (const r of repos) {
    const ind = independentOf(r);
    const behind = ind.filter((b) => behindBase(r, b) > 0).sort((a, b) => behindBase(r, b) - behindBase(r, a));
    if (!behind.length) continue;
    const base = r.integration ? "集成分支" : "主线";
    const who = multi ? r.label : "";
    if (behind.length === ind.length) {
      const min = Math.min(...behind.map((b) => behindBase(r, b)));
      behindLines.push(`  ${who}${who ? " " : ""}${ind.length} 条独立分支全部落后${base}（最少 ↓${min}），合并前请评估是否需同步基线`);
    } else {
      behindLines.push(`  ${who}${who ? " " : ""}${behind.length} 条落后${base}${behind.length > BEHIND_LIMIT ? `，落后最多的 ${BEHIND_LIMIT} 条` : ""}：`);
      for (const b of behind.slice(0, BEHIND_LIMIT)) behindLines.push(fitLine("    - ", b.label, `${b.branch} · ↓${behindBase(r, b)}`, W, opts.wide));
    }
  }
  out.push(`④ 落后需同步${behindLines.length ? "" : "：无"}`);
  out.push(...behindLines.map((l) => (opts.wide ? l : truncate(l, W))));

  out.push(FULL_HINT);
  return out.join("\n");
}

/** 兼容旧名 */
export const renderStatus = renderStatusFull;

const HYGIENE_TITLE: Record<HygieneKind, string> = {
  dir_branch_mismatch: "目录名 ≠ 分支名",
  orphan_admin_dir: "孤儿 .git/worktrees 条目",
  prunable_worktree: "worktree 目录已不存在",
  index_lock: "检测到 index.lock",
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
      // 主目录未检查/未完成：只给一行说明，不计数
      if (k === "main_dirty") {
        const notChecked = g.filter((x) => x.severity === "info");
        for (const h of notChecked) out.push(`  [提示] ${h.message}`);
        const dirty = g.filter((x) => x.severity !== "info");
        if (!dirty.length) continue;
        out.push(`  [警告] ${HYGIENE_TITLE[k]}（${dirty.reduce((a, x) => a + (x.count ?? 1), 0)} 个）`);
        for (const h of dirty) out.push(`    - ${h.message}`);
        continue;
      }
      const sev = g.some((x) => x.severity === "warn") ? "警告" : "提示";
      // 按文件数计：一条问题自带 count（如 iCloud 冲突副本 12 个文件）时用它
      const n = g.reduce((a, x) => a + (x.count ?? 1), 0);
      const note = k === "index_lock" ? "：是否残留待确认（可能有 git 进程正在运行）" : "";
      out.push(`  [${sev}] ${HYGIENE_TITLE[k]}（${n} 个）${note}`);
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
  const branch = s.linkedBranch ?? s.branch;
  const slug = branch ? (branch.split("/").pop() ?? branch) : null;
  const dir = s.worktreeName && s.worktreeName !== slug ? `目录 ${s.worktreeName}` : "";
  const link = branch ? `（${LINK_MARK[s.branchLink ?? "branch"]}）` : "";
  const where = [s.repo, branch ? `分支 ${branch}${link}` : "无分支", dir, pr].filter(Boolean).join(" · ");
  if (wide || width(where) <= W - 4 || !dir) out.push("    " + (wide ? where : truncateMiddle(where, W - 4)));
  else {
    // 放不下时把目录挪到下一行，保证分支名与关联来源标记完整（分支名断开就没法复制了）
    out.push("    " + truncateMiddle([s.repo, branch ? `分支 ${branch}${link}` : "无分支", pr].filter(Boolean).join(" · "), W - 4));
    out.push("    " + truncateMiddle(dir, W - 4));
  }
  if (branch && s.dirBranch && s.dirBranch !== branch) {
    out.push(...hangingWrap("    ", `目录现在在 ${s.dirBranch} 上（目录已被复用，以记录的分支为准）`, W));
  }
  if (s.status === "blocked") {
    out.push(...hangingWrap("    需要你：", s.needsAction?.trim() || s.statusDetail?.trim() || "（会话未写明需要什么）", W));
  }
  return out;
}

/**
 * heliu sessions：默认列出全部「等你处理」与全部「运行中」并完整显示文案；
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
        (s.linkedBranch ?? s.branch) ? `${s.linkedBranch ?? s.branch}（${LINK_MARK[s.branchLink ?? "branch"]}）` : "—",
        s.worktreeName ?? (s.worktreePath ? (s.worktreePath.split("/").pop() ?? "") : "—"),
        s.prs.length ? s.prs.map((p) => `#${p.number ?? "?"}${p.state ? " " + p.state.toLowerCase() : ""}`).join(",") : "—",
      ]);
      out.push(renderTable(columns, rows, { wide: opts.wide, indent: "  " }));
    }
  } else if (rest.length) {
    out.push("", `提示：heliu sessions --all 显示其余 ${rest.length} 条（${restParts.join(" · ")}）`);
  }
  if (sessions.length) out.push("", ...hangingWrap("", LINK_NOTE, W));
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
