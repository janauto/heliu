/**
 * M9 跨仓配对：会话开在 A 仓库（多是文档仓），真实改动在 B 仓库的 worktree（固件仓 / App 仓）——
 * 把「会话在 B 仓库的那条分支」配到会话所在的功能卡上。
 *
 * - analyzeTranscripts：读本项目会话的对话记录（transcripts.ts），按文件 mtime / 大小 / 目标集合增量提取，结果进项目缓存。
 * - suggestPairings：纯函数，把证据变成分档建议（强 / 中 / 弱）；建议 ≠ 事实，每条带依据原文。
 * - applyPairings：用户确认后才写台账（只加绑定 / 建卡，不碰仓库）。
 *
 * 局限：worktree 已删除的会话定位不到分支，不出建议；worktree → 分支按现在检出的分支（可能后来换过）。
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import type { FeatureBinding, FeatureSource, LedgerFeature, ReconcileReport, RepoReport, SessionView } from "../types.ts";
import { Cache, type EvidenceRow } from "./cache.ts";
import type { Ledger } from "./ledger.ts";
import { bindingKey, sourceBranchIndex, zeroCommitBranches } from "./owncommits.ts";
import { canonicalPath, type HeliuPaths } from "./paths.ts";
import { buildMatcher, extractFile, indexTranscripts, transcriptsRoot, type Matcher } from "./transcripts.ts";
import type { AnalyzeProgress, AnalyzeResult, PairGroup, PairReport, PairSuggestion, PairTarget, PairTier } from "./pairing-types.ts";

export type { AnalyzeProgress, AnalyzeResult, PairGroup, PairReport, PairSuggestion, PairTarget, PairTier } from "./pairing-types.ts";

/** 分档阈值（真实样本校验后定稿，见 M9 实现说明） */
export const PAIR_THRESHOLDS = {
  /** 中档：没有写入证据，但出现次数至少这么多 */
  mediumMinHits: 10,
  /** 中档：且占该会话跨仓出现总数的比例至少这么多 */
  mediumMinShare: 0.7,
  /** 强档：有写入 / 提交，且占比至少这么多（会话顺手碰一下的仓库不算主战场） */
  strongMinShare: 0.1,
} as const;

export const PAIR_PRIVACY = [
  "只读已归属本项目的会话的对话记录文件（~/.claude/projects 下），不读别的项目。",
  "缓存只存路径、次数、工具类别（改文件 / 提交）和时间，不存对话文字。",
  "删除缓存文件（~/Library/Application Support/heliu/cache/<项目>.sqlite）即删除全部提取结果，随时可重新分析。",
];

const ANALYZED_KEY = "transcripts_analyzed_at";

/** 每个仓库自己的 worktree（含主检出）：会话不在这里找"别的仓库" */
function worktreesOf(report: ReconcileReport): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of report.repos) if (r.reachable) out.set(r.id, r.worktrees.map((w) => canonicalPath(w.path)));
  return out;
}

/** 会话在别的仓库里可能去的地方：除自己仓库以外，所有仓库的 worktree */
function matcherFor(home: string, wts: Map<string, string[]>, homeDir: string): Matcher | null {
  return buildMatcher(
    [...wts].filter(([id]) => id !== home).flatMap(([, list]) => list),
    homeDir,
  );
}

export async function analyzeTranscripts(
  paths: HeliuPaths,
  projectName: string,
  report: ReconcileReport,
  sessions: SessionView[],
  opts: { force?: boolean; root?: string; home?: string; onProgress?: (p: AnalyzeProgress) => void; now?: () => number } = {},
): Promise<AnalyzeResult> {
  const started = performance.now();
  const now = opts.now ?? (() => Date.now());
  const home = opts.home ?? homedir();
  const index = indexTranscripts(opts.root ?? transcriptsRoot());
  const wts = worktreesOf(report);
  const matchers = new Map<string, Matcher | null>();
  const todo = sessions.filter((s) => s.cliSessionId && wts.has(s.repo));
  const cache = Cache.open(paths, projectName);
  if (!cache) throw new Error("打不开项目缓存");
  let extracted = 0;
  let skipped = 0;
  let missing = 0;
  try {
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i]!;
      opts.onProgress?.({ done: i, total: todo.length });
      const file = index.get(s.cliSessionId!);
      if (!file) {
        missing++;
        continue;
      }
      if (!matchers.has(s.repo)) matchers.set(s.repo, matcherFor(s.repo, wts, home));
      const m = matchers.get(s.repo)!;
      if (!m) {
        skipped++;
        continue;
      }
      let st: { mtimeMs: number; size: number };
      try {
        st = statSync(file);
      } catch {
        missing++;
        continue;
      }
      const mtimeMs = Math.round(st.mtimeMs);
      const prev = cache.transcriptFile(file);
      if (!opts.force && prev && prev.mtimeMs === mtimeMs && prev.size === st.size && prev.targetsSig === m.sig) {
        skipped++;
        continue;
      }
      const rows = extractFile(file, m);
      if (rows === null) {
        missing++;
        continue;
      }
      cache.saveTranscript({ file, cliSessionId: s.cliSessionId!, mtimeMs, size: st.size, targetsSig: m.sig, extractedAt: now() }, rows);
      extracted++;
      // 让出事件循环：看板在后台分析时，页面请求不被饿死
      if (extracted % 4 === 0) await Bun.sleep(0);
    }
    const analyzedAt = new Date(now()).toISOString();
    cache.setMeta(ANALYZED_KEY, analyzedAt);
    opts.onProgress?.({ done: todo.length, total: todo.length });
    return { files: todo.length, extracted, skipped, missing, ms: Math.round(performance.now() - started), analyzedAt };
  } finally {
    cache.close();
  }
}

/** 读缓存里的证据与上次分析时间（缓存不存在 / 还没分析过 → analyzedAt = null） */
export function loadEvidence(paths: HeliuPaths, projectName: string): { analyzedAt: string | null; rows: EvidenceRow[] } {
  try {
    const c = Cache.open(paths, projectName, { readonly: true });
    if (!c) return { analyzedAt: null, rows: [] };
    try {
      return { analyzedAt: c.getMeta(ANALYZED_KEY), rows: c.evidence() };
    } finally {
      c.close();
    }
  } catch {
    return { analyzedAt: null, rows: [] }; // M9 之前建的缓存没有这两张表：当作还没分析过
  }
}

/**
 * 「分支有没有自己的提交」：独立未合并 = 有；已被包含的用「尚无独有提交」判定（与待办、会话入口同一个函数）。
 * 看板里已有 FeatureView.sessionEntry 时直接用；CLI / MCP 现算（只算 worktree 里检出的那些分支）。
 */
export async function ownCommitsOf(paths: HeliuPaths, report: ReconcileReport): Promise<(repo: string, branch: string) => boolean | null> {
  const want: Array<{ repo: string; branch: string }> = [];
  for (const r of report.repos) {
    if (!r.reachable) continue;
    for (const w of r.worktrees) {
      const fv = w.branch ? r.branches.find((b) => b.branch === w.branch) : null;
      if (fv && fv.role === "feature" && fv.mergedState !== "unmerged" && fv.sessionEntry === undefined) want.push({ repo: r.id, branch: fv.branch });
    }
  }
  const zero = want.length ? await zeroCommitBranches(report, want, { sourceOf: sourceBranchIndex(paths, report) }) : new Set<string>();
  return (repo, branch) => {
    const fv = report.repos.find((r) => r.id === repo)?.branches.find((b) => b.branch === branch);
    if (!fv) return null;
    if (fv.mergedState === "unmerged") return true;
    if (fv.sessionEntry !== undefined && fv.sessionEntry !== null) return !fv.sessionEntry;
    return !zero.has(bindingKey(repo, branch));
  };
}

/* ───────────── 建议 ───────────── */

export interface PairInput {
  report: ReconcileReport;
  sessions: SessionView[];
  features: LedgerFeature[];
  evidence: Array<Pick<EvidenceRow, "cliSessionId" | "worktree" | "reads" | "writes" | "commits" | "lastSeenAt">>;
  /** 分支有没有自己的提交（独立未合并 = 有；已被包含的看「尚无独有提交」判定）；null = 不知道 */
  hasOwnCommits: (repo: string, branch: string) => boolean | null;
}

const TIER_RANK: Record<PairTier, number> = { strong: 0, medium: 1, weak: 2 };

const mmdd = (iso: string | null) => (iso ? iso.slice(5, 10) : "");

/** 会话对应的卡：卡上记了这个会话，或绑了会话所在的分支 */
export function cardOfSession(features: LedgerFeature[], s: Pick<SessionView, "sessionId" | "repo" | "branch">): LedgerFeature | null {
  const live = features.filter((f) => f.status !== "已放弃");
  return (
    live.find((f) => f.bindings.some((b) => b.session === s.sessionId)) ??
    (s.branch ? (live.find((f) => f.bindings.some((b) => b.repo === s.repo && b.branch === s.branch)) ?? null) : null)
  );
}

/** 同一条分支被这么多个会话"强"指向时，它更像发布 / 共用分支：降为中档 */
export const SHARED_BRANCH_SESSIONS = 3;

export function suggestPairings(input: PairInput): PairReport {
  const repos = new Map(input.report.repos.filter((r) => r.reachable).map((r) => [r.id, r]));
  // worktree 路径 → 仓库 + 现在检出的分支
  const where = new Map<string, { repo: RepoReport; branch: string | null; name: string; isMain: boolean }>();
  for (const r of repos.values()) for (const w of r.worktrees) where.set(canonicalPath(w.path), { repo: r, branch: w.detached ? null : w.branch, name: w.dirName, isMain: w.isMain });
  const bySession = new Map<string, typeof input.evidence>();
  for (const e of input.evidence) bySession.set(e.cliSessionId, [...(bySession.get(e.cliSessionId) ?? []), e]);
  const bound = new Map<string, LedgerFeature>();
  for (const f of input.features) if (f.status !== "已放弃") for (const b of f.bindings) bound.set(`${b.repo}|${b.branch}`, f);
  const sessionById = new Map(input.sessions.map((s) => [s.sessionId, s]));

  const groups: PairGroup[] = [];
  const notes: PairReport["notes"] = [];
  let paired = 0;
  for (const s of input.sessions) {
    if (!s.cliSessionId) continue;
    const rows = bySession.get(s.cliSessionId);
    if (!rows?.length) continue;
    const home = repos.get(s.repo);
    if (!home) continue;
    // 开在主线 / 集成分支上的会话（主控、做集成的）什么都碰：它的跨仓活动不是"某个功能的另一半"，不出建议
    const homeRole = s.branch ? home.branches.find((b) => b.branch === s.branch)?.role : null;
    if (homeRole === "main" || homeRole === "integration") continue;
    const merged = new Map<string, { reads: number; writes: number; commits: number; lastSeenAt: string | null }>();
    for (const e of rows) {
      const k = canonicalPath(e.worktree);
      const cur = merged.get(k) ?? { reads: 0, writes: 0, commits: 0, lastSeenAt: null };
      cur.reads += e.reads;
      cur.writes += e.writes;
      cur.commits += e.commits;
      if (e.lastSeenAt && (!cur.lastSeenAt || e.lastSeenAt > cur.lastSeenAt)) cur.lastSeenAt = e.lastSeenAt;
      merged.set(k, cur);
    }
    const total = [...merged.values()].reduce((a, e) => a + e.reads + e.writes + e.commits, 0);
    // fork 出来的会话没有自己的卡时，跟原会话的卡走（不另建重复的卡）
    const parent = s.spawnedFrom?.sessionId ? sessionById.get(s.spawnedFrom.sessionId) : undefined;
    const card = cardOfSession(input.features, s) ?? (parent ? cardOfSession(input.features, parent) : null);
    const title = s.title?.trim() || s.branch || s.sessionId;
    const items: PairSuggestion[] = [];
    for (const [wt, e] of merged) {
      const w = where.get(wt);
      if (!w || w.repo.id === s.repo) continue; // worktree 已删除：定位不到分支
      const hits = e.reads + e.writes + e.commits;
      const share = total ? hits / total : 0;
      const wrote = e.writes + e.commits > 0;
      // 写入 / 提交 0 次也写出来：强弱一眼可比
      const parts = [`${w.name}：出现 ${hits} 次（占 ${Math.round(share * 100)}%）`, `改文件 ${e.writes} 次`, `提交 ${e.commits} 次`];
      if (e.lastSeenAt) parts.push(`最近 ${mmdd(e.lastSeenAt)}`);
      if (!w.branch) {
        if (wrote && !w.isMain) notes.push({ sessionId: s.sessionId, title, text: `记录显示曾在${w.repo.label}的 ${w.name}（现在是分离 HEAD，没有检出分支）里改动（${parts.join(" · ")}）：定位不到分支，没法出配对建议` });
        continue;
      }
      const fv = w.repo.branches.find((b) => b.branch === w.branch);
      if (!fv || fv.role !== "feature") {
        // 在主线 / 集成分支的 worktree 里直接改：不能当功能分支绑，但值得告诉用户这项工作在哪
        if (fv && !w.isMain && wrote) {
          notes.push({ sessionId: s.sessionId, title, text: `记录显示曾在${w.repo.label}的 ${w.name}（现在检出${fv.role === "main" ? "主线" : "集成分支"} ${w.branch}）里改动（${parts.join(" · ")}）：主线 / 集成分支不能绑到功能卡；这不代表这些改动现在一定还在这条分支里` });
        }
        continue;
      }
      const owner = bound.get(`${w.repo.id}|${w.branch}`) ?? null;
      if (owner && card && owner.id === card.id) {
        paired++;
        continue;
      }
      const own = input.hasOwnCommits(w.repo.id, w.branch);
      // 仓库主目录常切换分支：现在检出的未必是当时那条，只算弱证据
      const tier: PairTier = w.isMain
        ? "weak"
        : wrote && own === true && share >= PAIR_THRESHOLDS.strongMinShare
          ? "strong"
          : wrote || (hits >= PAIR_THRESHOLDS.mediumMinHits && share >= PAIR_THRESHOLDS.mediumMinShare)
            ? "medium"
            : "weak";
      // 已绑在别的卡上的：只有证据够强才提示（顺手碰一下的不打扰）
      if (owner && tier === "weak") continue;
      const target: PairTarget = owner ? { kind: "other", id: owner.id, title: owner.title } : card ? { kind: "card", id: card.id, title: card.title } : { kind: "new", title };
      const branchNote = `${w.isMain ? "仓库主目录（常切换分支），" : ""}现在检出 ${w.branch}${own === false ? "（还没有自己的提交）" : ""}`;
      items.push({
        key: `${s.sessionId}|${w.repo.id}|${w.branch}`,
        no: 0,
        sessionId: s.sessionId,
        repo: w.repo.id,
        repoLabel: w.repo.label,
        branch: w.branch,
        worktree: wt,
        worktreeName: w.name,
        reads: e.reads,
        writes: e.writes,
        commits: e.commits,
        share,
        lastSeenAt: e.lastSeenAt,
        branchHasCommits: own,
        tier,
        evidence: `${parts.join(" · ")}；${branchNote}`,
        target,
        checked: tier === "strong" && target.kind !== "other",
      });
    }
    if (!items.length) continue;
    groups.push({
      sessionId: s.sessionId,
      title,
      status: s.status,
      needsAction: s.needsAction,
      isArchived: s.isArchived,
      repo: s.repo,
      repoLabel: home.label,
      branch: s.branch,
      lastActivityAt: s.lastActivityAt,
      card: card ? { id: card.id, title: card.title } : null,
      items,
    });
  }
  // 很多会话都"强"指向同一条分支：多半是发布 / 共用分支，不默认勾选
  const strongBy = new Map<string, Set<string>>();
  for (const g of groups) for (const i of g.items) if (i.tier === "strong") strongBy.set(`${i.repo}|${i.branch}`, (strongBy.get(`${i.repo}|${i.branch}`) ?? new Set()).add(g.sessionId));
  for (const g of groups)
    for (const i of g.items) {
      const n = strongBy.get(`${i.repo}|${i.branch}`)?.size ?? 0;
      if (i.tier === "strong" && n >= SHARED_BRANCH_SESSIONS) {
        i.tier = "medium";
        i.checked = false;
        i.evidence += `；有 ${n} 个会话都在这条分支上提交过，可能是发布 / 共用分支`;
      }
    }
  for (const g of groups) g.items.sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || b.reads + b.writes + b.commits - (a.reads + a.writes + a.commits));
  // 强档多的会话在前，其次最近活动
  const best = (g: PairGroup) => Math.min(...g.items.map((i) => (i.target.kind === "other" ? 3 : TIER_RANK[i.tier])));
  groups.sort((a, b) => best(a) - best(b) || Date.parse(b.lastActivityAt ?? "1970") - Date.parse(a.lastActivityAt ?? "1970"));
  let no = 0;
  for (const g of groups) for (const i of g.items) i.no = ++no;
  const all = groups.flatMap((g) => g.items);
  const live = all.filter((i) => i.target.kind !== "other");
  return {
    groups,
    counts: {
      sessions: groups.filter((g) => g.items.some((i) => i.target.kind !== "other")).length,
      strong: live.filter((i) => i.tier === "strong").length,
      medium: live.filter((i) => i.tier === "medium").length,
      weak: live.filter((i) => i.tier === "weak").length,
      other: all.length - live.length,
      paired,
    },
    notes,
  };
}

/** 选择器：编号（3、#3）、稳定键、或 all（= 全部强档） */
export function selectPairings(rep: PairReport, picks: string[]): { chosen: PairSuggestion[]; unknown: string[] } {
  const all = rep.groups.flatMap((g) => g.items);
  const chosen = new Map<string, PairSuggestion>();
  const unknown: string[] = [];
  for (const raw of picks.flatMap((p) => p.split(/[,，\s]+/)).filter(Boolean)) {
    if (raw === "all" || raw === "全部") {
      for (const i of all) if (i.checked) chosen.set(i.key, i);
      continue;
    }
    const n = Number(raw.replace(/^#/, ""));
    const hit = Number.isInteger(n) && n > 0 ? all.find((i) => i.no === n) : all.find((i) => i.key === raw);
    if (hit) chosen.set(hit.key, hit);
    else unknown.push(raw);
  }
  return { chosen: [...chosen.values()], unknown };
}

export interface ApplyResult {
  bound: Array<{ key: string; card: string; repoLabel: string; branch: string }>;
  created: Array<{ id: string; title: string; milestone: string | null; branches: string[] }>;
  skipped: Array<{ key: string; reason: string }>;
}

/**
 * 写台账：绑到已有卡；没卡的会话建一张卡（会话标题），同时绑会话所在分支与选中的分支。只写台账，不碰仓库。
 * 「已绑在别的卡」的不写（不合卡）。
 */
export function applyPairings(
  ledger: Ledger,
  rep: PairReport,
  report: ReconcileReport,
  chosen: PairSuggestion[],
  opts: { milestone?: string | null; source: FeatureSource; now?: Date },
): ApplyResult {
  const now = opts.now ?? new Date();
  const out: ApplyResult = { bound: [], created: [], skipped: [] };
  const groupOf = new Map(rep.groups.map((g) => [g.sessionId, g]));
  const wtOf = (repo: string, branch: string): string | null => {
    const r = report.repos.find((x) => x.id === repo);
    const w = r?.worktrees.find((x) => x.branch === branch && !x.isMain);
    return w ? w.path : null;
  };
  const bindingOf = (i: PairSuggestion): FeatureBinding => ({ repo: i.repo, branch: i.branch, worktree: wtOf(i.repo, i.branch) ?? i.worktree, session: i.sessionId, pr: null });
  const fresh = new Map<string, PairSuggestion[]>();
  for (const i of chosen) {
    if (i.target.kind === "other") {
      out.skipped.push({ key: i.key, reason: `${i.branch} 已经绑在 ${i.target.id}「${i.target.title}」上；如果是同一件事，请手动处理` });
      continue;
    }
    const ex = ledger.findByBinding(i.repo, i.branch);
    if (i.target.kind === "card") {
      if (ex && ex.id !== i.target.id) {
        out.skipped.push({ key: i.key, reason: `${i.branch} 刚被绑到了 ${ex.id}「${ex.title}」上` });
        continue;
      }
      ledger.bind(i.target.id, bindingOf(i), now);
      out.bound.push({ key: i.key, card: i.target.id, repoLabel: i.repoLabel, branch: i.branch });
      continue;
    }
    if (ex) {
      out.skipped.push({ key: i.key, reason: `${i.branch} 刚被绑到了 ${ex.id}「${ex.title}」上` });
      continue;
    }
    fresh.set(i.sessionId, [...(fresh.get(i.sessionId) ?? []), i]);
  }
  for (const [sid, items] of fresh) {
    const g = groupOf.get(sid)!;
    const bindings: FeatureBinding[] = [];
    // 会话所在的分支（入口）也绑上：会话状态（等你回答）跟着卡走
    if (g.branch && !ledger.findByBinding(g.repo, g.branch)) {
      const r = report.repos.find((x) => x.id === g.repo);
      const fv = r?.branches.find((b) => b.branch === g.branch);
      if (fv?.role === "feature") bindings.push({ repo: g.repo, branch: g.branch, worktree: wtOf(g.repo, g.branch), session: sid, pr: null });
    }
    for (const i of items) bindings.push(bindingOf(i));
    const r = ledger.addFeature({ title: items[0]!.target.kind === "new" ? items[0]!.target.title : g.title, milestone: opts.milestone === undefined ? "next" : opts.milestone, bindings, status: "开发中", source: opts.source, now });
    out.created.push({ id: r.feature.id, title: r.feature.title, milestone: r.feature.milestone, branches: bindings.map((b) => `${b.repo}/${b.branch}`) });
    for (const i of items) out.bound.push({ key: i.key, card: r.feature.id, repoLabel: i.repoLabel, branch: i.branch });
  }
  return out;
}

const TIER_TEXT: Record<PairTier, string> = { strong: "强", medium: "中", weak: "弱" };

/** CLI / MCP 的中文列表（弱档只给数量，--全部 才逐条列） */
export function renderPairings(rep: PairReport, analyzedAt: string | null, opts: { weak?: boolean } = {}): string {
  const lines: string[] = [];
  if (!analyzedAt) return `还没分析过对话记录：运行 heliu 配对 会先分析一遍（只读，通常几秒）。\n隐私：${PAIR_PRIVACY.join("")}`;
  const c = rep.counts;
  lines.push(`上次分析：${analyzedAt.replace("T", " ").slice(0, 16)}。会话开在一个仓库、在别的仓库里干活的建议（建议 ≠ 事实，确认后才写台账）：`);
  lines.push(`  强 ${c.strong} · 中 ${c.medium} · 弱 ${c.weak}${c.other ? ` · 已绑在别的卡 ${c.other}（只提示）` : ""}${c.paired ? ` · 已配好 ${c.paired}` : ""}`);
  if (!rep.groups.length) {
    lines.push("没有要配对的：会话没有在别的仓库的 worktree 里干过活，或者已经都配好了。");
    return lines.join("\n");
  }
  for (const g of rep.groups) {
    const shown = g.items.filter((i) => opts.weak || i.tier !== "weak" || i.target.kind === "other");
    if (!shown.length) continue;
    const st = g.status === "blocked" ? " · 等你回答" : g.status === "running" ? " · 运行中" : "";
    lines.push("");
    lines.push(`会话「${g.title}」（${g.repoLabel}${g.branch ? ` ${g.branch}` : ""}${st}）→ ${g.card ? `${g.card.id}「${g.card.title}」` : "还没有卡（确认时用会话标题建卡）"}`);
    for (const i of shown) {
      const t = i.target.kind === "other" ? `已绑在 ${i.target.id}「${i.target.title}」，只提示` : `${TIER_TEXT[i.tier]}${i.checked ? " · 建议勾选" : ""}`;
      lines.push(`  #${i.no} ${i.repoLabel} ${i.branch}  [${t}]`);
      lines.push(`      依据：${i.evidence}`);
    }
  }
  if (rep.notes.length) {
    lines.push("", "另外（不是建议，只是事实）：");
    for (const n of rep.notes) lines.push(`  · 会话「${n.title}」${n.text}`);
  }
  const hiddenWeak = rep.groups.flatMap((g) => g.items).filter((i) => i.tier === "weak" && i.target.kind !== "other").length;
  if (!opts.weak && hiddenWeak) lines.push("", `另有 ${hiddenWeak} 条弱证据没列出（加 --全部 显示）。`);
  lines.push("", "确认：heliu 配对 --确认 <编号,编号…>（或 all = 全部强档）；只写台账，不碰仓库。");
  lines.push("依据是建议不是事实：worktree 按现在检出的分支对应，可能后来换过；仓库主目录常切换分支，只算弱证据。");
  lines.push(`隐私：${PAIR_PRIVACY.join("")}`);
  return lines.join("\n");
}

export function renderApply(r: ApplyResult): string {
  const lines: string[] = [];
  for (const c of r.created) lines.push(`✓ 新建 ${c.id}「${c.title}」（${c.milestone ?? "未预约"}），绑定 ${c.branches.join("、")}`);
  const createdIds = new Set(r.created.map((c) => c.id));
  for (const b of r.bound) if (!createdIds.has(b.card)) lines.push(`✓ ${b.card} 绑定 ${b.repoLabel} ${b.branch}`);
  for (const s of r.skipped) lines.push(`· 跳过：${s.reason}`);
  if (!lines.length) lines.push("没有写入任何东西。");
  lines.push("（只写了台账，没有碰任何仓库。）");
  return lines.join("\n");
}
