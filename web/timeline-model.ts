/**
 * 时间线模型（M10，纯函数：不碰 DOM、不依赖 preact，便于测试）。
 *
 * 横轴 = 时间窗 [from, to]：to = 现在 + 2 天留白，from = 按范围（2 周 / 1 月 / 3 月）往前推到那天 0 点；线性刻度。
 * 纵轴 = WBS 树：仓库 → 模块 → 条目。条目 = 一条功能：有卡的功能卡，或还没登记的分支（与星图同一套配对：
 * 按「仓库 id | 分支名」匹配 card.bindings）。每个条目在时间轴上画一条「活跃区间」：
 * - 有卡：起点 = 卡片 created（BoardCard 目前没有这个字段，见下）；拿不到就用「绑定里最早的可见活动」近似，
 *   并标 startKind = "approx"（页面画虚线边、提示「起点为近似」），不假装精确。终点 = 卡的 lastActivityAt。
 * - 没卡的分支：起点 = 主会话最后活动与最后提交中更早者（近似），终点 = 更晚者。只有一个时间 = 画一个点。
 * - 会话入口（FeatureView.sessionEntry，没有自己的提交）不画成条，折叠成该仓库下一行「会话入口 N」。
 * - 已进主线且没卡的分支不画（同星图默认）；台账状态已完成（card.done）的卡不画（它们已经不在动）。
 * 颜色只读服务端的 card.light；没卡的分支固定蓝「还没登记」。前端不自己判断 git 事实。
 *
 * 注意：本文件会被 tests/ 用根 tsconfig（无 DOM、无 JSX）编译，所以不能 import web/ui.tsx（哪怕只是类型）。
 * 方块模型（BlockModel）由页面在渲染时用 modelOfCard / modelOfBranch 现算；这里给分组用的模块推测
 * 与 modelOfBranch 用同一段文字（标签 + 分支名 + 最后提交主题），保证「左栏分组」与「方块上显示的模块」一致。
 */
import type { BoardCard, FeaturesData, Light } from "../src/board/api-types.ts";
import { OTHER_MODULE, inferModule, type ModuleDef } from "../src/core/classify.ts";
import type { FeatureView, LedgerMilestone, ReconcileReport } from "../src/types.ts";

export const DAY = 86_400_000;
/** 今天右边留白的天数 */
export const TAIL_DAYS = 2;
/** 行高：条目行 / 组行（左右两栏共用，保证对齐） */
export const ROW_H = 40;
export const GROUP_H = 36;

export type TLRange = "2w" | "1m" | "3m";
export const RANGES: Array<{ value: TLRange; label: string; days: number; minPxPerDay: number }> = [
  { value: "2w", label: "2 周", days: 14, minPxPerDay: 64 },
  { value: "1m", label: "1 月", days: 30, minPxPerDay: 32 },
  { value: "3m", label: "3 月", days: 90, minPxPerDay: 12 },
];
export const rangeDef = (r: TLRange) => RANGES.find((x) => x.value === r) ?? RANGES[1]!;
export const isRange = (v: unknown): v is TLRange => RANGES.some((x) => x.value === v);

/** 颜色：服务端五色灯 + 没卡的分支（蓝） */
export type TLTone = Light | "blue";

/* ───────────── 时间 → 像素 ───────────── */

const p2 = (n: number) => String(n).padStart(2, "0");
/** 本地时区那天的 0 点 */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 解析 ISO 时间；缺失 / 不合法为 null */
export function parseTime(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}
/** 里程碑 target_date：纯日期（2026-11-20）按本地 0 点，带时间的按原样 */
export function parseDay(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
  return parseTime(s);
}
export const mmdd = (t: number): string => {
  const d = new Date(t);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

/** 时间窗：to = now + 2 天；from = (now - 范围天数) 那天的 0 点 */
export function timeWindow(now: Date, range: TLRange): { from: Date; to: Date; days: number } {
  const n = now.getTime();
  const from = startOfDay(n - rangeDef(range).days * DAY);
  const to = n + TAIL_DAYS * DAY;
  return { from: new Date(from), to: new Date(to), days: (to - from) / DAY };
}

/** 时间轴内部宽度：至少铺满可视区；范围越短每天越宽（2 周每天 ≥64px，1 月 ≥32px，3 月 ≥12px），放不下就横向滚动 */
export function axisWidth(range: TLRange, visible: number, now: Date): number {
  const { days } = timeWindow(now, range);
  return Math.max(Math.round(visible), Math.ceil(days * rangeDef(range).minPxPerDay));
}

/** 线性映射（不截断：窗外的点会 < 0 或 > width，由调用方决定怎么画） */
export function xOf(date: Date | number, from: Date | number, to: Date | number, width: number): number {
  const t = +date;
  const a = +from;
  const b = +to;
  if (b <= a) return 0;
  return ((t - a) / (b - a)) * width;
}

/** 「回到今天」：让今天落在可视时间轴的 80% 处（左栏是 sticky 的，要扣掉它的宽度） */
export function todayScrollLeft(todayX: number, clientWidth: number, leftWidth: number, frac = 0.8): number {
  return Math.max(0, Math.round(todayX - frac * Math.max(0, clientWidth - leftWidth)));
}

/* ───────────── 刻度 ───────────── */

export type TickUnit = "day" | "week" | "month";
export interface TLTick {
  x: number;
  t: number;
  /** null = 只画刻度线不写字（放不下） */
  label: string | null;
  kind: "day" | "week" | "month" | "today";
  /** 主刻度（月初 / 周一）画得深一点 */
  major: boolean;
}

/** 每天多宽决定刻度粒度：≥40px 按天，≥16px 按周（每周一），再窄按月（月初 + 周一小刻度） */
export function tickUnit(pxPerDay: number): TickUnit {
  if (pxPerDay >= 40) return "day";
  if (pxPerDay >= 16) return "week";
  return "month";
}

/** 标签之间至少隔这么宽（「10-28」约 36px） */
const LABEL_GAP = 44;

export function rangeTicks(from: Date, to: Date, width: number, now?: Date): TLTick[] {
  const a = from.getTime();
  const b = to.getTime();
  if (b <= a || width <= 0) return [];
  const pxPerDay = (width * DAY) / (b - a);
  const unit = tickUnit(pxPerDay);
  const raw: TLTick[] = [];
  const d = new Date(startOfDay(a));
  if (d.getTime() < a) d.setDate(d.getDate() + 1);
  for (; d.getTime() <= b; d.setDate(d.getDate() + 1)) {
    const t = d.getTime();
    const x = xOf(t, a, b, width);
    const monday = d.getDay() === 1;
    const first = d.getDate() === 1;
    if (unit === "day") raw.push({ x, t, label: mmdd(t), kind: "day", major: monday || first });
    else if (unit === "week") {
      if (monday) raw.push({ x, t, label: mmdd(t), kind: "week", major: first || d.getDate() <= 7 });
    } else if (first) raw.push({ x, t, label: `${d.getMonth() + 1}月`, kind: "month", major: true });
    else if (monday) raw.push({ x, t, label: pxPerDay * 7 >= 64 ? mmdd(t) : null, kind: "week", major: false });
  }
  if (now) {
    const n = now.getTime();
    if (n >= a && n <= b) raw.push({ x: xOf(n, a, b, width), t: n, label: "今天", kind: "today", major: true });
  }
  raw.sort((p, q) => p.x - q.x);
  // 标签避让：今天 > 月 > 其余；离右边太近的（写不下）只留刻度线
  const placed: number[] = [];
  const rank = (k: TLTick) => (k.kind === "today" ? 0 : k.kind === "month" ? 1 : 2);
  for (const k of [...raw].sort((p, q) => rank(p) - rank(q) || p.x - q.x)) {
    if (k.label === null) continue;
    if (k.kind !== "today" && (k.x > width - 30 || placed.some((x) => Math.abs(x - k.x) < LABEL_GAP))) {
      k.label = null;
      continue;
    }
    placed.push(k.x);
  }
  return raw;
}

/* ───────────── 条目与树 ───────────── */

export interface TLItem {
  /** 卡号，或「仓库 id|分支名」 */
  key: string;
  kind: "card" | "branch";
  card: BoardCard | null;
  branch: FeatureView | null;
  repo: string;
  repoLabel: string;
  /** 仓库主线 / 集成分支（选中没卡的分支时详情要用；没绑分支的卡为 null） */
  main: string | null;
  integration: string | null;
  module: string;
  title: string;
  tone: TLTone;
  start: Date | null;
  end: Date;
  /** created = 卡片创建时间（精确）；approx = 最早可见活动（近似，虚线）；none = 没有起点（画点） */
  startKind: "created" | "approx" | "none";
  /** activity = 有最后活动时间；none = 一点活动记录都没有，画在「现在」（空心点） */
  endKind: "activity" | "none";
  shape: "bar" | "dot";
  /** 像素（相对时间轴左边），已截到 [0, width] */
  x0: number;
  x1: number;
  /** 起点早于时间窗：从窗左边起画，加「←」 */
  clippedLeft: boolean;
  /** 整条都早于时间窗（最后活动在窗外） */
  outside: boolean;
}

export interface TLModuleNode {
  key: string;
  repo: string;
  module: string;
  items: TLItem[];
  tones: Partial<Record<TLTone, number>>;
}

export interface TLRepoNode {
  key: string;
  repo: string;
  label: string;
  main: string | null;
  integration: string | null;
  /** 不可达原因；有值时没有子节点 */
  error: string | null;
  /** 伪仓库：还没绑分支的卡 */
  pseudo: boolean;
  modules: TLModuleNode[];
  count: number;
  /** 没卡的会话入口分支数（不画成条） */
  entries: number;
  /** 其中会话在等你的 */
  entriesWaiting: number;
}

export type TLRow =
  | { kind: "repo"; key: string; y: number; h: number; node: TLRepoNode; count: number; open: boolean; items: TLItem[] }
  | { kind: "module"; key: string; y: number; h: number; node: TLModuleNode; count: number; tones: Partial<Record<TLTone, number>>; open: boolean; items: TLItem[] }
  | { kind: "item"; key: string; y: number; h: number; item: TLItem; parent: string }
  | { kind: "entries"; key: string; y: number; h: number; repo: string; repoLabel: string; count: number; waiting: number };

export interface TLMilestoneLine {
  id: string;
  title: string;
  status: LedgerMilestone["status"];
  date: Date;
  x: number;
  inWindow: boolean;
}

export interface TimelineModel {
  now: Date;
  from: Date;
  to: Date;
  days: number;
  width: number;
  pxPerDay: number;
  unit: TickUnit;
  ticks: TLTick[];
  todayX: number;
  tree: TLRepoNode[];
  /** 全部展开、不筛选时的行（页面按折叠 / 筛选用 flattenRows 重算） */
  rows: TLRow[];
  height: number;
  items: TLItem[];
  /** 只含 target_date 有值的里程碑 */
  milestones: TLMilestoneLine[];
  counts: { cards: number; branches: number; entries: number; total: number };
}

export interface TimelineOptions {
  now: Date;
  range: TLRange;
  /** 时间轴内部宽度（像素） */
  width: number;
  /** 模块定义（FeaturesData.modules）；与传给 modelOfBranch 的保持同一个值 */
  modules?: ModuleDef[];
  /** 里程碑（/api/milestones，含已发布）；缺省从 features.columns[].milestone 取 */
  milestones?: LedgerMilestone[];
}

export const NOBIND_REPO = "__nobind";
export const NOBIND_LABEL = "还没绑分支";

export const repoKey = (repo: string) => `r:${repo}`;
export const moduleKey = (repo: string, module: string) => `m:${repo}|${module}`;
export const entriesKey = (repo: string) => `e:${repo}`;
export const branchItemKey = (repo: string, branch: string) => `${repo}|${branch}`;

/** 与 ui.tsx modelOfBranch 推测模块用的同一段文字 */
export function branchModuleText(f: Pick<FeatureView, "label" | "branch" | "lastCommitSubject">): string {
  return [f.label, f.branch, f.lastCommitSubject].filter(Boolean).join(" ");
}

/** 卡片的「主绑定」：有真实改动的那条 > 存在的 > 第一条 */
export function primaryBinding(card: BoardCard): BoardCard["bindings"][number] | null {
  return card.bindings.find((b) => b.exists && b.sessionEntry !== true) ?? card.bindings.find((b) => b.exists) ?? card.bindings[0] ?? null;
}

/**
 * 卡片区间。BoardCard 现在没有 created：起点用「全部绑定里最早的可见活动」近似——
 * 每条绑定的 lastCommitAt（会话入口的除外：它是出发点的时间，不是这张卡的活动）与绑定会话的 lastActivityAt 取最早。
 * 服务端以后在 BoardCard 上补 created 时自动改用它（startKind = "created"）。
 */
export function cardSpan(card: BoardCard, now: number): { start: number | null; end: number; startKind: TLItem["startKind"]; endKind: TLItem["endKind"] } {
  const created = parseTime((card as BoardCard & { created?: string | null }).created);
  const seen: number[] = [];
  for (const b of card.bindings) {
    const c = b.sessionEntry === true ? null : parseTime(b.lastCommitAt);
    const s = parseTime(b.session?.lastActivityAt);
    if (c !== null) seen.push(c);
    if (s !== null) seen.push(s);
  }
  const last = parseTime(card.lastActivityAt) ?? (seen.length ? Math.max(...seen) : null);
  const end = last ?? now;
  let start: number | null = null;
  let startKind: TLItem["startKind"] = "none";
  if (created !== null) {
    start = created;
    startKind = "created";
  } else if (seen.length) {
    start = Math.min(...seen);
    startKind = "approx";
  }
  if (start !== null && start > end) start = end;
  return { start, end, startKind, endKind: last === null ? "none" : "activity" };
}

/** 没卡的分支区间：主会话最后活动与最后提交，早者为起点（近似）、晚者为终点 */
export function branchSpan(f: FeatureView, now: number): { start: number | null; end: number; startKind: TLItem["startKind"]; endKind: TLItem["endKind"] } {
  const ts = [parseTime(f.lastCommitAt), parseTime(f.sessions[0]?.lastActivityAt)].filter((x): x is number => x !== null);
  if (!ts.length) return { start: null, end: now, startKind: "none", endKind: "none" };
  return { start: Math.min(...ts), end: Math.max(...ts), startKind: "approx", endKind: "activity" };
}

export function countByTone(items: Array<Pick<TLItem, "tone">>): Partial<Record<TLTone, number>> {
  const out: Partial<Record<TLTone, number>> = {};
  for (const it of items) out[it.tone] = (out[it.tone] ?? 0) + 1;
  return out;
}

/** 按折叠状态与筛选把树摊平成行（左右两栏用同一个数组渲染，行高一致才对得齐） */
export function flattenRows(
  tree: TLRepoNode[],
  opts: { collapsed?: ReadonlySet<string>; keep?: (it: TLItem) => boolean } = {},
): { rows: TLRow[]; height: number; shown: number } {
  const collapsed = opts.collapsed ?? new Set<string>();
  const keep = opts.keep;
  const filtering = !!keep;
  const rows: TLRow[] = [];
  let y = 0;
  let shown = 0;
  const push = (r: TLRow) => {
    rows.push(r);
    y += r.h;
  };
  for (const node of tree) {
    const mods = node.modules.map((m) => ({ m, items: keep ? m.items.filter(keep) : m.items })).filter((x) => x.items.length);
    const count = mods.reduce((a, x) => a + x.items.length, 0);
    if (filtering && !count) continue;
    if (!count && !node.error && !node.entries) continue;
    const rk = repoKey(node.repo);
    const open = !collapsed.has(rk);
    push({ kind: "repo", key: rk, y, h: GROUP_H, node, count, open, items: mods.flatMap((x) => x.items) });
    shown += count;
    if (!open || node.error) continue;
    for (const { m, items } of mods) {
      const mk = m.key;
      const mopen = !collapsed.has(mk);
      push({ kind: "module", key: mk, y, h: GROUP_H, node: m, count: items.length, tones: countByTone(items), open: mopen, items });
      if (!mopen) continue;
      for (const it of items) push({ kind: "item", key: it.key, y, h: ROW_H, item: it, parent: mk });
    }
    if (!filtering && node.entries) push({ kind: "entries", key: entriesKey(node.repo), y, h: GROUP_H, repo: node.repo, repoLabel: node.label, count: node.entries, waiting: node.entriesWaiting });
  }
  return { rows, height: y, shown };
}

/** 乐观更新：把一张卡的若干字段先改掉（请求成功后用服务端新数据替换；失败丢掉这份覆盖即回滚） */
export function withCardPatch(features: FeaturesData | null, id: string, patch: Partial<Pick<BoardCard, "module" | "moduleSource" | "milestone" | "column">>): FeaturesData | null {
  if (!features) return features;
  let hit = false;
  const columns = features.columns.map((col) => {
    if (!col.cards.some((c) => c.id === id)) return col;
    hit = true;
    return { ...col, cards: col.cards.map((c) => (c.id === id ? { ...c, ...patch } : c)) };
  });
  return hit ? { ...features, columns } : features;
}

export function buildTimeline(report: ReconcileReport | null, features: FeaturesData | null, opts: TimelineOptions): TimelineModel {
  const now = opts.now.getTime();
  const { from, to, days } = timeWindow(opts.now, opts.range);
  const width = Math.max(1, Math.round(opts.width));
  const a = from.getTime();
  const b = to.getTime();
  const X = (t: number) => Math.max(0, Math.min(width, xOf(t, a, b, width)));
  const modules = opts.modules;

  const cards: BoardCard[] = features ? features.columns.flatMap((c) => c.cards) : [];
  // 有卡的分支：所有卡（含已完成）的绑定都算「已登记」，不再当成没卡的分支
  const bound = new Set<string>();
  for (const c of cards) for (const x of c.bindings) bound.add(branchItemKey(x.repo, x.branch));

  // 仓库节点：对账顺序 → 只在卡片里出现的仓库 → 还没绑分支的卡
  const repoNodes = new Map<string, TLRepoNode & { _items: TLItem[] }>();
  const ensureRepo = (id: string, label: string, extra: Partial<TLRepoNode> = {}) => {
    let n = repoNodes.get(id);
    if (!n) {
      n = { key: repoKey(id), repo: id, label, main: null, integration: null, error: null, pseudo: false, modules: [], count: 0, entries: 0, entriesWaiting: 0, _items: [], ...extra };
      repoNodes.set(id, n);
    }
    return n;
  };
  for (const r of report?.repos ?? []) ensureRepo(r.id, r.label, { main: r.main, integration: r.integration, error: r.reachable ? null : (r.error ?? "仓库不可达") });

  const mkItem = (base: Omit<TLItem, "start" | "end" | "shape" | "x0" | "x1" | "clippedLeft" | "outside">, span: { start: number | null; end: number }): TLItem => {
    const { start, end } = span;
    const shape: TLItem["shape"] = start === null || start === end ? "dot" : "bar";
    const outside = end < a;
    const clippedLeft = !outside && shape === "bar" && start !== null && start < a;
    const x1 = outside ? 0 : X(end);
    const x0 = outside ? 0 : shape === "dot" ? x1 : X(start!);
    return { ...base, start: start === null ? null : new Date(start), end: new Date(end), shape, x0, x1, clippedLeft, outside };
  };

  let nCards = 0;
  let nBranches = 0;
  let nEntries = 0;

  for (const c of cards) {
    if (c.done) continue;
    const pb = primaryBinding(c);
    const rr = pb ? report?.repos.find((r) => r.id === pb.repo) : undefined;
    const node = pb ? ensureRepo(pb.repo, rr?.label ?? pb.repoLabel, { main: rr?.main ?? pb.main, integration: rr?.integration ?? pb.integration }) : ensureRepo(NOBIND_REPO, NOBIND_LABEL, { pseudo: true });
    const span = cardSpan(c, now);
    node._items.push(
      mkItem(
        {
          key: c.id,
          kind: "card",
          card: c,
          branch: null,
          repo: node.repo,
          repoLabel: node.label,
          main: node.main,
          integration: node.integration,
          module: c.module || OTHER_MODULE,
          title: c.title,
          tone: c.light,
          startKind: span.startKind,
          endKind: span.endKind,
        },
        span,
      ),
    );
    nCards += 1;
  }

  for (const r of report?.repos ?? []) {
    if (!r.reachable) continue;
    const node = repoNodes.get(r.id)!;
    for (const f of r.branches) {
      if (f.role !== "feature" || bound.has(branchItemKey(r.id, f.branch))) continue;
      // 会话入口：没有自己的提交（git 祖先判断恒为「已进主线」），先于已进主线的过滤
      if (f.sessionEntry === true) {
        node.entries += 1;
        if (f.sessions[0]?.status === "blocked") node.entriesWaiting += 1;
        nEntries += 1;
        continue;
      }
      if (f.mergedState === "in_main") continue;
      const span = branchSpan(f, now);
      node._items.push(
        mkItem(
          {
            key: branchItemKey(r.id, f.branch),
            kind: "branch",
            card: null,
            branch: f,
            repo: r.id,
            repoLabel: r.label,
            main: r.main,
            integration: r.integration,
            module: inferModule(branchModuleText(f), modules),
            title: f.label || f.branch,
            tone: "blue",
            startKind: span.startKind,
            endKind: span.endKind,
          },
          span,
        ),
      );
      nBranches += 1;
    }
  }

  // 模块顺序：模块定义的顺序 → 卡片上手写的其他模块（按出现）→「其他」最后
  const defNames = (modules && modules.length ? modules : []).map((m) => m.name);
  const order = (names: string[]) => {
    const out = defNames.filter((n) => names.includes(n) && n !== OTHER_MODULE);
    for (const n of names) if (!out.includes(n) && n !== OTHER_MODULE) out.push(n);
    if (names.includes(OTHER_MODULE)) out.push(OTHER_MODULE);
    return out;
  };
  // 组内：最近在动的在上
  const byRecent = (p: TLItem, q: TLItem) => q.end.getTime() - p.end.getTime() || p.title.localeCompare(q.title, "zh");

  const tree: TLRepoNode[] = [];
  const all: TLItem[] = [];
  const nodes = [...repoNodes.values()];
  // 伪仓库放最后
  nodes.sort((p, q) => Number(p.pseudo) - Number(q.pseudo));
  for (const n of nodes) {
    const { _items, ...node } = n;
    const names = [...new Set(_items.map((i) => i.module))];
    node.modules = order(names).map((name) => {
      const items = _items.filter((i) => i.module === name).sort(byRecent);
      return { key: moduleKey(node.repo, name), repo: node.repo, module: name, items, tones: countByTone(items) };
    });
    node.count = _items.length;
    for (const m of node.modules) all.push(...m.items);
    tree.push(node);
  }

  // 里程碑日期线：只画有 target_date 的
  const msList = opts.milestones ?? (features?.columns.map((c) => c.milestone).filter((m): m is LedgerMilestone => !!m) ?? []);
  const milestones: TLMilestoneLine[] = [];
  for (const m of msList) {
    const t = parseDay(m.target_date);
    if (t === null) continue;
    milestones.push({ id: m.id, title: m.title, status: m.status, date: new Date(t), x: xOf(t, a, b, width), inWindow: t >= a && t <= b });
  }
  milestones.sort((p, q) => p.date.getTime() - q.date.getTime());

  const flat = flattenRows(tree);
  return {
    now: opts.now,
    from,
    to,
    days,
    width,
    pxPerDay: (width * DAY) / (b - a),
    unit: tickUnit((width * DAY) / (b - a)),
    ticks: rangeTicks(from, to, width, opts.now),
    todayX: xOf(now, a, b, width),
    tree,
    rows: flat.rows,
    height: flat.height,
    items: all,
    milestones,
    counts: { cards: nCards, branches: nBranches, entries: nEntries, total: nCards + nBranches },
  };
}
