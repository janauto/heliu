/**
 * M2 台账相关命令的中文文本输出：我在哪 / 功能卡 / 里程碑 / 待办 / sync。
 * CLI 与 MCP 共用（MCP 另做 8k 字符截断）。
 */
import type { LedgerFeature, LedgerMilestone, TodoBinding, TodoItem, TodoReport, WhereAmI } from "../types.ts";
import type { SyncResult } from "../core/sync.ts";
import { fmtShort, LINK_MARK } from "./render.ts";
import { hangingWrap, outputWidth, renderTable, truncate, truncateMiddle, type Column } from "./table.ts";

export interface RenderOpts {
  width?: number;
  wide?: boolean;
}

const fit = (s: string, W: number, wide?: boolean) => (wide ? s : truncate(s, W));
const fitMid = (s: string, W: number, wide?: boolean) => (wide ? s : truncateMiddle(s, W));

/* ───────────── 我在哪 ───────────── */

export function renderWhereami(w: WhereAmI): string {
  const out = ["合流 · 我在哪", `  目录：${w.cwd}`];
  if (!w.project) {
    out.push(...w.notes.map((n) => `  ! ${n}`));
    return out.join("\n");
  }
  out.push(`  项目：${w.project.name}`);
  if (!w.repo) {
    out.push(...w.notes.map((n) => `  ! ${n}`));
    return out.join("\n");
  }
  const place = w.isMainCheckout ? "主目录" : `worktree ${w.worktree?.split("/").pop() ?? "?"}`;
  out.push(`  仓库：${w.repo.label}（${w.repo.id}）· ${place}`);
  const roleText = w.role === "main" ? "主线" : w.role === "integration" ? "集成分支" : w.role === "feature" ? "功能分支" : "";
  out.push(`  分支：${w.branch ?? (w.detached ? "（分离 HEAD）" : "未知")}${roleText ? `（${roleText}）` : ""}`);
  if (w.feature) {
    out.push(`  功能卡：${w.feature.id}「${w.feature.title}」· ${w.feature.status} · 验收 ${w.feature.acceptance}`);
    const ms = w.milestone ? `${w.milestone.id}${w.milestone.title ? ` ${w.milestone.title}` : ""}（${w.milestone.status}）` : (w.feature.milestone ?? "未预约");
    out.push(`  预约：${ms}`);
  } else if (w.role === "feature") {
    out.push("  功能卡：无");
  }
  const behind: string[] = [];
  if (w.behindMain !== null) behind.push(`主线 ${w.behindMain} 提交`);
  if (w.behindIntegration !== null) behind.push(`集成分支 ${w.behindIntegration} 提交`);
  if (behind.length) out.push(`  落后：${behind.join(" · ")}`);
  if (w.session) {
    const t = w.session.title ? `「${w.session.title}」` : "";
    out.push(`  会话：${t}${w.session.sessionId ?? w.session.cliSessionId ?? ""}`);
  }
  for (const n of w.notes) out.push(`  ! ${n}`);
  if (w.role === "feature" && !w.feature) {
    out.push(`  提示：本分支还没有功能卡 → heliu 新点子 "<一句话需求>"（自动绑定当前分支、预约下一版）`);
  }
  return out.join("\n");
}

/* ───────────── 功能卡 ───────────── */

export function bindingText(f: LedgerFeature): string {
  if (!f.bindings.length) return "—";
  const b = f.bindings[0]!;
  return `${b.repo}/${b.branch}${f.bindings.length > 1 ? ` (+${f.bindings.length - 1})` : ""}`;
}

export function renderFeatureLine(f: LedgerFeature): string {
  const ms = f.milestone ? `预约 ${f.milestone}` : "未预约";
  const bind = f.bindings.length ? ` · 绑定 ${f.bindings.map((b) => `${b.repo}/${b.branch}`).join("、")}` : " · 未绑定分支";
  return `${f.id}「${f.title}」· ${f.status} · ${ms}${bind}`;
}

export function renderFeatureTable(features: LedgerFeature[], opts: RenderOpts & { title?: string } = {}): string {
  const out = [opts.title ?? `合流 · 功能卡 ${features.length} 张`];
  if (!features.length) {
    out.push("  （没有功能卡：heliu 新点子 \"<一句话需求>\" 登记一张）");
    return out.join("\n");
  }
  const columns: Column[] = [
    { header: "卡号" },
    { header: "标题", max: 28 },
    { header: "状态" },
    { header: "预约" },
    { header: "验收" },
    { header: "绑定", max: 44, cut: "middle" },
    { header: "来源" },
  ];
  const rows = features.map((f) => [f.id, f.title, f.status, f.milestone ?? "—", f.acceptance, bindingText(f), f.source]);
  out.push(renderTable(columns, rows, { wide: opts.wide, indent: "  " }));
  return out.join("\n");
}

/* ───────────── 里程碑 ───────────── */

export function renderMilestones(
  list: LedgerMilestone[],
  counts: Array<{ id: string; todo: number; total: number }>,
  unreserved: number,
  opts: RenderOpts = {},
): string {
  const next = list.find((m) => m.status === "规划中");
  const out = [`合流 · 里程碑 ${list.length} 个${next ? `（下一版 = ${next.id}）` : "（还没有「规划中」的版本；新点子会自动建 vNext）"}`];
  if (!list.length) {
    out.push("  （没有里程碑：heliu milestone add v1.2 --title \"…\"）");
  } else {
    const columns: Column[] = [
      { header: "版本" },
      { header: "标题", max: 30 },
      { header: "状态" },
      { header: "目标日期" },
      { header: "集成分支", max: 36, cut: "middle" },
      { header: "待办/全部", align: "right" },
    ];
    const rows = list.map((m) => {
      const c = counts.find((x) => x.id === m.id) ?? { todo: 0, total: 0 };
      return [`${m.id}${m === next ? " ←下一版" : ""}`, m.title || "—", m.status, m.target_date ?? "—", m.integration_branch ?? "（用项目配置）", `${c.todo}/${c.total}`];
    });
    out.push(renderTable(columns, rows, { wide: opts.wide, indent: "  " }));
  }
  if (unreserved) out.push(`  未预约的功能卡 ${unreserved} 张（heliu 预约 <卡号> <版本>）`);
  out.push("  待办 = 预约到该版、状态为 想法/开发中/待合并 的卡（与 heliu 待办 同一口径）");
  out.push("  状态：规划中 → 冻结（不再接新预约）→ 合并中 → 已发布；合并时未兑现的功能自动顺延到下一版并标「从 vX 顺延」（M4）");
  return out.join("\n");
}

/* ───────────── 待办 ───────────── */

function bindingState(b: TodoBinding, precheck: boolean): string {
  if (!b.exists) return "分支已不存在";
  if (b.noCommits) return "尚无提交（与主线同点或自创建后未提交）";
  if (b.mergedState === "in_main") return "已进主线";
  if (b.mergedState === "in_integration") return "已进集成分支";
  const parts: string[] = [];
  if (b.behindIntegration !== null) parts.push(`落后集成分支 ${b.behindIntegration}`);
  else if (b.behindMain !== null) parts.push(`落后主线 ${b.behindMain}`);
  if (precheck && b.conflictFiles !== null) parts.push(b.conflictFiles > 0 ? `冲突 ${b.conflictFiles} 个文件` : "试合无冲突");
  return parts.join(" · ") || "独立未合并";
}

function todoItemLines(it: TodoItem, precheck: boolean, W: number, wide?: boolean): string[] {
  const tags: string[] = [it.status];
  if (it.note && it.group !== "mergeable") tags.push(it.note);
  if (it.rolledFrom.length) tags.push(`从 ${it.rolledFrom[it.rolledFrom.length - 1]} 顺延`);
  if (it.group === "stale" && it.idleDays !== null) tags.push(`${it.idleDays} 天没动静`);
  const out = [fit(`  - ${it.id} ${it.title} · ${tags.join(" · ")}`, W, wide)];
  if (!it.bindings.length) out.push("    （未绑定分支：heliu feature bind <卡号> 或在该分支的会话里登记）");
  for (const b of it.bindings) {
    const last = b === it.bindings[0] && it.lastActivityAt ? ` · 最后活动 ${fmtShort(it.lastActivityAt)}` : "";
    out.push("    " + fitMid(`${b.repoLabel} · ${b.branch} · ${bindingState(b, precheck)}${last}`, W - 4, wide));
  }
  if (it.needsAction) out.push(...(wide ? [`    需要你：${it.needsAction}`] : hangingWrap("    需要你：", it.needsAction, W)));
  return out;
}

export function renderTodo(projectName: string, t: TodoReport, opts: RenderOpts & { limitPerGroup?: number } = {}): string {
  const W = opts.width ?? outputWidth();
  const m = t.milestone;
  const isNext = ["next", "下一版", "下个版本", "下一个版本", "下版"].includes(t.requested.trim().toLowerCase());
  const head = `合流 · ${projectName} · 待办 ${m.id}${m.title ? ` ${m.title}` : ""}（${isNext ? "下一版 · " : ""}${m.status}）· 未合入 ${t.total} 条`;
  const out = [fit(head, W, opts.wide)];
  const nm = t.nextMilestone;
  out.push(nm ? `下一版 = ${nm.id}（${nm.status}）` : "下一版 = （还没有「规划中」的版本；登记新点子时自动建 vNext）");
  const overview = t.groups.map((g) => `${g.title} ${g.count === null ? "未检查" : g.count}`).join(" > ");
  out.push(...hangingWrap("概览：", `${overview}（按优先级排，每张卡只进最靠前的一组）`, W));
  out.push(...hangingWrap("顺延：", "某版合并时没合完的功能自动挪到下一版，标「从 vX 顺延」排在组内最前（M4 执行，不会静默丢弃）", W));
  const empty = t.groups.filter((g) => g.count === 0).map((g) => g.title);
  for (const g of t.groups) {
    if (g.count === 0) continue;
    out.push("");
    if (g.count === null) {
      out.push(`■ ${g.title}：未检查（加 --precheck 在临时对象区试合，不碰仓库）`);
      continue;
    }
    out.push(...hangingWrap("", `■ ${g.title}（${g.count}）· ${g.hint}`, W));
    const lim = opts.limitPerGroup ?? Infinity;
    if (g.key === "mergeable") {
      // 可合并细分：已进主线 / 已进集成分支 / 试合无冲突
      for (const sub of ["已进主线", "已进集成分支", "试合无冲突"]) {
        const list = g.items.filter((i) => (i.note ?? "试合无冲突") === sub);
        if (!list.length) continue;
        out.push(`  可合并 · ${sub}（${list.length}）`);
        for (const it of list.slice(0, lim)) out.push(...todoItemLines(it, t.precheck, W, opts.wide));
        if (list.length > lim) out.push(`  …还有 ${list.length - lim} 条（终端运行 heliu 待办 ${m.id} 查看全部）`);
        const sug = list.filter((i) => i.suggestion);
        if (sug.length) {
          const what = sub === "已进主线" ? "已进主线" : "已合入";
          out.push(...hangingWrap("  建议：", `以上 ${sug.length} 张卡的分支${sub === "已进主线" ? "已进主线" : "已被集成分支包含"}，是否标为${what}？（heliu feature status <卡号> ${what}；台账状态只由你改，heliu 不自动改）`, W));
        }
      }
      continue;
    }
    for (const it of g.items.slice(0, lim)) out.push(...todoItemLines(it, t.precheck, W, opts.wide));
    if (g.items.length > lim) out.push(`  …还有 ${g.items.length - lim} 条（终端运行 heliu 待办 ${m.id} 查看全部）`);
  }
  if (empty.length) out.push("", `（暂无：${empty.join("、")}）`);
  if (!t.total) out.push("", `（${m.id} 还没有预约任何功能：heliu 新点子 "<一句话需求>" 会默认预约到下一版）`);
  out.push("", "提示：heliu 预约 <卡号> <版本> 改预约 · heliu feature list 看全部卡 · --json 输出完整字段");
  return out.join("\n");
}

/* ───────────── sync ───────────── */

/** local_463463d5-740a-… → local_463463d5（完整 id 见 --json 与卡片） */
export function shortSession(id: string): string {
  const m = /^(local_)?([0-9a-f]{8})-[0-9a-f-]{20,}$/i.exec(id);
  return m ? `${m[1] ?? ""}${m[2]}` : id;
}

export function renderSync(projectName: string, r: SyncResult, opts: RenderOpts = {}): string {
  const W = opts.width ?? outputWidth();
  const out = [`合流 · ${projectName} · sync${r.dryRun ? "（预演，不写入）" : ""}`];
  const ms = r.milestone ? `${r.milestone}（下一版）` : "vNext（下一版；还没有「规划中」的版本，写入时自动创建）";
  out.push(`${r.dryRun ? "将建" : "已建"}草稿卡 ${r.drafts.length} 张 → 预约 ${ms}`);
  const s = r.skipped;
  out.push(`跳过：已有功能卡 ${s.hasCard} · 已进主线（有独有提交且已合入）${s.inMain} · 没有独立 worktree ${s.noWorktree} · 主线/集成分支 ${s.notFeature}`);
  const zero = r.drafts.filter((d) => d.noCommits).length;
  if (zero) out.push(`其中 ${zero} 张的分支尚无独有提交（与主线同点或自创建后未提交），按「开发中」登记`);
  out.push(`台账：${r.ledgerDir}`);
  const byRepo = new Map<string, typeof r.drafts>();
  for (const d of r.drafts) byRepo.set(d.repoLabel, [...(byRepo.get(d.repoLabel) ?? []), d]);
  for (const [label, list] of byRepo) {
    out.push("", `■ ${label}（${list.length}）`);
    for (const d of list) {
      const id = d.id ? `${d.id} ` : "";
      out.push(fit(`  - ${id}${d.title} · ${d.status}${d.noCommits ? " · 尚无提交" : ""}${d.titleSource === "label" ? " · 标题取自分支标签" : ""}`, W, opts.wide));
      const sess = d.session ? ` · 会话 ${shortSession(d.session)}（${LINK_MARK[d.sessionLink ?? "branch"]}）` : " · 无关联会话";
      const pr = d.pr !== null ? ` · PR #${d.pr}` : "";
      out.push("    " + fitMid(`${d.branch}${sess}${pr}`, W - 4, opts.wide));
    }
  }
  out.push("");
  out.push(
    r.dryRun
      ? "下一步：去掉 --dry-run 写入；写入后逐条确认标题与预约（heliu feature list；heliu 预约 <卡号> <版本>；heliu feature rename <卡号> <新标题>）"
      : "下一步：逐条确认标题与预约（heliu feature rename <卡号> <新标题>；heliu 预约 <卡号> <版本>）；草稿标记 source: sync",
  );
  return out.join("\n");
}

/** MCP 返回文本上限：超出截断并提示用 CLI --json */
export const MCP_TEXT_LIMIT = 8000;
export function clampText(text: string, cliHint: string, limit = MCP_TEXT_LIMIT): string {
  if (text.length <= limit) return text;
  const tail = `\n…（已截断：共 ${text.length} 字符，超过 ${limit}。完整内容请在终端运行 \`${cliHint} --json\`）`;
  const cut = text.slice(0, limit - tail.length);
  return cut.slice(0, cut.lastIndexOf("\n") > 0 ? cut.lastIndexOf("\n") : cut.length) + tail;
}
