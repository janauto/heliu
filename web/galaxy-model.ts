/**
 * 星图布局（M7，纯函数，不碰 DOM，便于测试）。
 *
 * 纵横：横轴 = 分支最后提交时间（平方根刻度，越右越新），纵轴 = 仓库泳道。
 * 每个泳道底部两条"星河主流"：主线、集成分支；功能分支是星点，排在主流上方，按时间横向铺开、碰撞时往上叠一层。
 * 右侧一列是版本行星（里程碑 + 未预约 + 已发布）；功能卡与它预约的版本之间画星座线。
 * 数据全部来自 /api/status（ReconcileReport）与 /api/features（FeaturesData），不额外请求。
 *
 * M8 收纳：每条泳道按类型（修复 / 功能 / 调研 / 文档 / 工程 / 其他）分成几行；收起的行是一个"星团"
 * （成员在时间轴上的小点 + 状态分布 + 数量 + 最新时间），展开的行才画出每颗星点。颜色 = 状态，形状 = 类型。
 */
import type { BoardCard, FeaturesData, Light } from "../src/board/api-types.ts";
import { FEATURE_TYPES, TYPE_GLYPH, classifyText, inferType, isFeatureType, type FeatureType } from "../src/core/classify.ts";
import type { FeatureView, ReconcileReport, RepoReport } from "../src/types.ts";

export type StarColor = Light | "blue";

export interface GalaxyOptions {
  width: number;
  now: number;
  /** 显示已进主线的分支（缺省隐藏：它们已经完成） */
  showMerged: boolean;
  /** 折叠的仓库 id */
  collapsed: Set<string>;
  /** M8：展开的类型行（`仓库|类型`）；不在里面的行收成星团 */
  expanded: Set<string>;
  /** M8：全部展开 */
  expandAll?: boolean;
}

export interface GBranch {
  key: string;
  kind: "branch";
  repo: string;
  repoLabel: string;
  branch: string;
  label: string;
  x: number;
  y: number;
  r: number;
  color: StarColor;
  merged: FeatureView["mergedState"];
  lastAt: string | null;
  ahead: number;
  behind: number | null;
  /** 绑定的功能卡（没有 = 流浪星，可拖到版本行星建卡） */
  card: BoardCard | null;
  waiting: string | null;
  conflicts: number | null;
  /** 最新的前几名：1 = 最新 */
  recent: number | null;
  sessionTitle: string | null;
  worktree: string | null;
  /** 常显标签放在星点哪一侧；null = 不常显（悬停 / 选中 / 搜索命中时才显示） */
  labelSide: "r" | "l" | "t" | "b" | null;
  labelText: string;
  /** M8：类型（卡片上写的 > 推测）与所在类型行 */
  type: FeatureType;
  row: string;
}

export interface GCard {
  key: string;
  kind: "card";
  card: BoardCard;
  x: number;
  y: number;
  r: number;
  color: StarColor;
  planet: string;
  type: FeatureType;
}

export type GNode = GBranch | GCard;

/** M8：泳道里的一行（一个类型） */
export interface GRow {
  key: string;
  repo: string;
  type: FeatureType;
  glyph: string;
  /** 行的上下边界与中线 */
  y0: number;
  y1: number;
  y: number;
  expanded: boolean;
  count: number;
  /** 本行全部分支 key（收起时也在） */
  members: string[];
  /** 状态分布（收起时的分布条、展开时的行头都用） */
  colors: Partial<Record<StarColor, number>>;
  waiting: number;
  conflict: number;
  newestAt: string | null;
  /** 含全项目最新的那条分支 */
  hasNewest: boolean;
  /** 收起时的星团：成员在时间轴上的范围与小点；展开时为 null */
  cluster: {
    x0: number;
    x1: number;
    dots: Array<{ x: number; dy: number; color: StarColor }>;
    color: StarColor;
    labelText: string;
    /** r = 星团右边；b = 星团下方（右边被行星 / 合流点挡住时） */
    labelSide: "r" | "b" | null;
    labelX: number;
    labelY: number;
  } | null;
}

export interface GLane {
  repo: string;
  label: string;
  y0: number;
  y1: number;
  mainY: number;
  integY: number | null;
  main: string;
  integration: string | null;
  integAhead: number | null;
  integDays: number | null;
  collapsed: boolean;
  /** 本泳道显示 / 总共的功能分支数 */
  shown: number;
  total: number;
  hiddenMerged: number;
  error: string | null;
}

export interface GPlanet {
  key: string;
  title: string;
  kind: "milestone" | "unreserved" | "released";
  x: number;
  y: number;
  r: number;
  isNext: boolean;
  droppable: boolean;
  owed: number;
  waiting: number;
  conflict: number | null;
}

export interface GConfluence {
  key: string;
  repo: string;
  label: string;
  branch: string;
  x: number;
  y: number;
}

export interface GFlow {
  key: string;
  node: string;
  d: string;
  cls: "in" | "out" | "conflict" | "behind" | "waiting";
  /** M8：从收起的星团出发（画得更淡，免得斜穿其他行） */
  cluster?: boolean;
}

export interface GLink {
  key: string;
  from: string;
  to: string;
  /** 汇向行星的曲线（星座流） */
  d: string;
  /** M8：从收起的星团连出时，代表几颗星 */
  count?: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: StarColor;
}

export interface GTick {
  x: number;
  label: string;
}

export interface GalaxyModel {
  width: number;
  height: number;
  xL: number;
  xR: number;
  ticks: GTick[];
  lanes: GLane[];
  /** M8：类型行（含收起的星团） */
  rows: GRow[];
  /** 画出来的星点（展开行里的分支 + 没分支的小卡星） */
  nodes: GNode[];
  /** M8：所有显示范围内的分支（含收在星团里的；收起的分支坐标 = 星团位置） */
  all: GBranch[];
  flows: GFlow[];
  planets: GPlanet[];
  links: GLink[];
  confluences: GConfluence[];
  /** 最新的分支 key（按时间倒序） */
  latest: string[];
  counts: { branches: number; unbound: number; cards: number };
}

const DAY = 86_400_000;
const LEFT = 170;
const RIGHT = 280;
const ROW = 27;
/** 同一天提交的分支先在横向小范围内错开，放不下再往上叠一层（蜂群布局） */
const SWARM = [0, -16, 16, -32, 32, -48, 48, -64, 64];
const LANE_GAP = 44;
const TOP = 64;
const LATEST_N = 3;
/** M8：收起的类型行高度、行间距、展开行上下留白 */
const CLUSTER_H = 38;
const ROW_GAP = 6;
const ROW_PAD = 10;

/** 推测类型 / 模块用的分支文字：M1 标签、主会话标题、分支名（与服务端给卡片推测时同一套字段） */
export function branchText(b: Pick<FeatureView, "label" | "branch" | "sessions">): string {
  return classifyText([b.label, b.sessions[0]?.title, b.branch]);
}

/** 多颗星合在一起时显示哪种颜色：最需要人的优先 */
const COLOR_PRIO: StarColor[] = ["purple", "red", "yellow", "green", "blue", "gray"];
export function dominantColor(colors: Partial<Record<StarColor, number>>): StarColor {
  return COLOR_PRIO.find((c) => (colors[c] ?? 0) > 0) ?? "gray";
}

function agoAt(iso: string | null, now: number): string {
  if (!iso) return "";
  const s = (now - Date.parse(iso)) / 1000;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 最后提交距今天数 → 横坐标（平方根刻度：最近几天铺得开） */
export function xOfAge(ageDays: number, maxAge: number, xL: number, xR: number): number {
  const a = Math.max(0, Math.min(ageDays, maxAge));
  return xR - (xR - xL) * Math.sqrt(a / maxAge);
}

function starRadius(ahead: number): number {
  return 5 + Math.min(7, Math.log2(1 + Math.max(0, ahead)) * 1.5);
}

function branchColor(b: FeatureView, card: BoardCard | null): StarColor {
  if (card && !card.done) return card.light;
  if (b.mergedState === "in_integration") return "green";
  if (b.mergedState === "in_main") return "gray";
  if (!card) return "blue";
  return "gray";
}

function flowClass(b: GBranch): GFlow["cls"] {
  if (b.merged !== "unmerged") return "in";
  if (b.color === "purple") return "waiting";
  if (b.color === "red") return "conflict";
  if (b.behind && b.behind > 0) return "behind";
  return "out";
}

const keyOf = (repo: string, branch: string) => `b:${repo}:${branch}`;

/** 汇入主流的曲线：从星点向左下弯进主流 */
function flowPath(x: number, y: number, riverY: number, xL: number): string {
  const ex = Math.max(xL + 4, x - 46 - (riverY - y) * 0.35);
  const c1x = x - 18;
  const c2x = ex + 22;
  return `M${x.toFixed(1)},${y.toFixed(1)} C${c1x.toFixed(1)},${y.toFixed(1)} ${c2x.toFixed(1)},${riverY.toFixed(1)} ${ex.toFixed(1)},${riverY.toFixed(1)}`;
}

export function buildGalaxy(report: ReconcileReport, features: FeaturesData | null, opts: GalaxyOptions): GalaxyModel {
  const width = Math.max(900, Math.round(opts.width));
  const xL = LEFT;
  const xR = width - RIGHT;
  const now = opts.now;

  // 功能卡索引：仓库|分支 → 卡
  const cards: BoardCard[] = features ? features.columns.flatMap((c) => c.cards) : [];
  const byBinding = new Map<string, BoardCard>();
  for (const c of cards) for (const b of c.bindings) if (b.exists) byBinding.set(`${b.repo}|${b.branch}`, c);

  // 横轴范围：最老的显示中分支，最少 30 天、最多 180 天
  const repos = report.repos.filter((r) => r.reachable);
  const visible = (b: FeatureView) => b.role === "feature" && (opts.showMerged || b.mergedState !== "in_main");
  let maxAge = 30;
  for (const r of repos) for (const b of r.branches) if (visible(b) && b.lastCommitAt) maxAge = Math.max(maxAge, (now - Date.parse(b.lastCommitAt)) / DAY);
  maxAge = Math.min(180, Math.ceil(maxAge));

  const ticks: GTick[] = [
    { x: xOfAge(0, maxAge, xL, xR), label: "今天" },
    { x: xOfAge(3, maxAge, xL, xR), label: "3 天前" },
    { x: xOfAge(7, maxAge, xL, xR), label: "1 周前" },
    { x: xOfAge(30, maxAge, xL, xR), label: "1 个月前" },
  ];
  if (maxAge >= 90) ticks.push({ x: xOfAge(90, maxAge, xL, xR), label: "3 个月前" });

  // 最新的分支（未进主线的功能分支里最后提交最新的几条）
  const pool: Array<{ r: RepoReport; b: FeatureView }> = [];
  for (const r of repos) for (const b of r.branches) if (b.role === "feature" && b.mergedState !== "in_main" && b.lastCommitAt) pool.push({ r, b });
  pool.sort((p, q) => Date.parse(q.b.lastCommitAt!) - Date.parse(p.b.lastCommitAt!));
  const rank = new Map<string, number>();
  pool.slice(0, LATEST_N).forEach((e, i) => rank.set(keyOf(e.r.id, e.b.branch), i + 1));

  const lanes: GLane[] = [];
  const rows: GRow[] = [];
  const nodes: GNode[] = [];
  const all: GBranch[] = [];
  const flows: GFlow[] = [];
  const confluences: GConfluence[] = [];
  let y = TOP;

  for (const r of report.repos) {
    if (!r.reachable) {
      lanes.push({ repo: r.id, label: r.label, y0: y, y1: y + 44, mainY: y + 30, integY: null, main: r.main, integration: r.integration, integAhead: null, integDays: null, collapsed: true, shown: 0, total: 0, hiddenMerged: 0, error: r.error ?? "不可达" });
      y += 44 + LANE_GAP;
      continue;
    }
    const feats = r.branches.filter((b) => b.role === "feature");
    const shown = feats.filter(visible);
    const collapsed = opts.collapsed.has(r.id);
    const integ = r.branches.find((b) => b.role === "integration") ?? null;
    const integAhead = r.health?.integration?.aheadOfMain ?? integ?.vsMain?.ahead ?? null;
    const integDays = r.health?.integration?.unmergedDays ?? null;
    const head = 64;

    // 先给每条分支建好数据（类型、颜色、时间横坐标），再按类型分行
    const items = shown.map((b) => {
      const card = byBinding.get(`${r.id}|${b.branch}`) ?? null;
      const type: FeatureType = card && isFeatureType(card.type) ? card.type : inferType(branchText(b));
      const age = b.lastCommitAt ? (now - Date.parse(b.lastCommitAt)) / DAY : maxAge;
      const ahead = b.vsIntegration?.ahead ?? b.vsMain?.ahead ?? 0;
      const key = keyOf(r.id, b.branch);
      const s = b.sessions[0] ?? null;
      const conflicts = b.precheck && !b.precheck.timedOut && !b.precheck.error ? (b.precheck.conflictFiles ?? null) : null;
      const node: GBranch = {
        key,
        kind: "branch",
        repo: r.id,
        repoLabel: r.label,
        branch: b.branch,
        label: card?.title ?? b.label,
        x: xOfAge(age, maxAge, xL + 24, xR),
        y: 0,
        r: starRadius(ahead),
        color: branchColor(b, card),
        merged: b.mergedState,
        lastAt: b.lastCommitAt,
        ahead,
        behind: b.vsIntegration?.behind ?? b.vsMain?.behind ?? null,
        card,
        waiting: card?.needsAction ?? (s?.status === "blocked" ? s.needsAction : null),
        conflicts,
        recent: rank.get(key) ?? null,
        sessionTitle: s?.title ?? null,
        worktree: b.worktree?.dirName ?? null,
        labelSide: null,
        labelText: "",
        type,
        row: `${r.id}|${type}`,
      };
      node.labelText = `${node.recent === 1 ? "★ 最新 · " : ""}${short(node.label, 18)}`;
      return node;
    });

    let cy = y + head;
    const laneRows: GRow[] = [];
    if (!collapsed) {
      for (const t of FEATURE_TYPES) {
        const group = items.filter((n) => n.type === t);
        if (!group.length) continue;
        const rowKey = `${r.id}|${t}`;
        const expanded = !!opts.expandAll || opts.expanded.has(rowKey);
        const colors: Partial<Record<StarColor, number>> = {};
        for (const n of group) colors[n.color] = (colors[n.color] ?? 0) + 1;
        const newestAt = group.reduce<string | null>((m, n) => (n.lastAt && (!m || Date.parse(n.lastAt) > Date.parse(m)) ? n.lastAt : m), null);
        const row: GRow = {
          key: rowKey,
          repo: r.id,
          type: t,
          glyph: TYPE_GLYPH[t],
          y0: cy,
          y1: cy,
          y: cy,
          expanded,
          count: group.length,
          members: group.map((n) => n.key),
          colors,
          waiting: group.filter((n) => n.color === "purple" || !!n.waiting).length,
          conflict: group.filter((n) => n.color === "red" || (n.conflicts ?? 0) > 0).length,
          newestAt,
          hasNewest: group.some((n) => n.recent === 1),
          cluster: null,
        };
        if (expanded) {
          // 碰撞分层：按横坐标从右往左放，同一层里两个星点至少相隔 2r+18
          const sorted = [...group].sort((p, q) => q.x - p.x);
          const layers: number[][] = [];
          const placed: Array<{ n: GBranch; layer: number }> = [];
          for (const it of sorted) {
            let layer = 0;
            let px = it.x;
            search: for (;;) {
              const used = layers[layer] ?? (layers[layer] = []);
              for (const dx of SWARM) {
                const cx = Math.max(xL + 24, Math.min(xR, it.x + dx));
                if (used.every((ux) => Math.abs(ux - cx) > it.r * 2 + 18)) {
                  used.push(cx);
                  px = cx;
                  break search;
                }
              }
              layer += 1;
            }
            it.x = px;
            placed.push({ n: it, layer });
          }
          const nLayers = Math.max(1, layers.length);
          const band = nLayers * ROW + ROW_PAD * 2;
          row.y1 = cy + band;
          row.y = cy + band / 2;
          for (const p of placed) {
            p.n.y = row.y1 - ROW_PAD - ROW / 2 - p.layer * ROW;
            nodes.push(p.n);
          }
        } else {
          row.y1 = cy + CLUSTER_H;
          row.y = cy + CLUSTER_H / 2;
          const xs = group.map((n) => n.x);
          const x0 = Math.min(...xs);
          const x1 = Math.max(...xs);
          // 成员都收在星团里：坐标指向星团（星座线、跳转都从这里出发）
          for (const n of group) {
            n.y = row.y;
          }
          const parts = [`${group.length} 条`];
          if (row.waiting) parts.push(`等你 ${row.waiting}`);
          if (row.conflict) parts.push(`冲突 ${row.conflict}`);
          if (newestAt) parts.push(`最新 ${agoAt(newestAt, now)}`);
          row.cluster = {
            x0,
            x1,
            dots: group.map((n, i) => ({ x: n.x, dy: ((i % 3) - 1) * 3.2, color: n.color })),
            color: dominantColor(colors),
            labelText: `${row.hasNewest ? "★ " : ""}${parts.join(" · ")}`,
            labelSide: null,
            labelX: x1,
            labelY: row.y,
          };
        }
        laneRows.push(row);
        cy = row.y1 + ROW_GAP;
      }
    }
    for (const n of items) all.push(n);
    rows.push(...laneRows);
    const bodyH = laneRows.length ? cy - ROW_GAP - (y + head) : 0;
    const integY = r.integration ? y + head + bodyH + 18 : null;
    const mainY = (integY ?? y + head + bodyH) + 26;
    const y1 = mainY + 16;
    const river = (n: GBranch) => (n.merged === "in_main" ? mainY : (integY ?? mainY));

    for (const row of laneRows) {
      if (row.expanded) {
        for (const key of row.members) {
          const n = items.find((x) => x.key === key)!;
          flows.push({ key: `f:${key}`, node: key, d: flowPath(n.x, n.y, river(n), xL), cls: flowClass(n) });
        }
      } else if (row.cluster) {
        const group = items.filter((n) => n.row === row.key);
        const cls: GFlow["cls"] = row.conflict ? "conflict" : group.every((n) => n.merged !== "unmerged") ? "in" : row.waiting ? "waiting" : "out";
        flows.push({ key: `f:${row.key}`, node: row.key, d: flowPath(row.cluster.x1, row.y, integY ?? mainY, xL), cls, cluster: true });
      }
    }
    if (integY !== null && integ) confluences.push({ key: `c:${r.id}`, repo: r.id, label: r.label, branch: integ.branch, x: xR + 26, y: integY });
    lanes.push({
      repo: r.id,
      label: r.label,
      y0: y,
      y1,
      mainY,
      integY,
      main: r.main,
      integration: r.integration,
      integAhead,
      integDays,
      collapsed,
      shown: shown.length,
      total: feats.length,
      hiddenMerged: feats.length - shown.length,
      error: null,
    });
    y = y1 + LANE_GAP;
  }

  // 版本行星：右侧一列，按 FeaturesData 的列顺序
  const cols = features?.columns ?? [];
  const planets: GPlanet[] = [];
  const span = Math.max(y - TOP, 220);
  const px = width - RIGHT / 2 + 20;
  cols.forEach((c, i) => {
    const owed = c.owed;
    planets.push({
      key: c.key,
      title: c.title,
      kind: c.kind === "milestone" ? "milestone" : c.kind === "released" ? "released" : "unreserved",
      x: px,
      // 紧凑一列靠上排：滚到哪都容易拖到；版本多时等距铺开
      y: TOP + 50 + i * Math.min(120, Math.max(84, (span - 60) / Math.max(1, cols.length))),
      r: c.kind === "milestone" ? 20 + Math.min(18, Math.sqrt(owed) * 3) : 14,
      isNext: c.isNext,
      droppable: c.droppable,
      owed,
      waiting: c.waiting,
      conflict: c.conflict,
    });
  });
  const planetOf = new Map(planets.map((p) => [p.key, p]));

  // 没绑分支（或分支已不存在）的功能卡：作为小星点绕在它的行星左边
  const branchKeys = new Set(all.map((n) => n.key));
  const orbit = new Map<string, number>();
  for (const c of cards) {
    const hasStar = c.bindings.some((b) => branchKeys.has(keyOf(b.repo, b.branch)));
    if (hasStar || c.done) continue;
    const p = planetOf.get(c.column);
    if (!p) continue;
    const i = orbit.get(p.key) ?? 0;
    orbit.set(p.key, i + 1);
    const ang = Math.PI * (0.62 + 0.13 * (i % 6));
    const dist = p.r + 22 + Math.floor(i / 6) * 18;
    nodes.push({ key: `k:${c.id}`, kind: "card", card: c, x: p.x + Math.cos(ang) * dist, y: p.y - Math.sin(ang) * dist * 0.9, r: 5, color: c.light, planet: p.key, type: isFeatureType(c.type) ? c.type : "其他" });
  }

  // 星座线：分支星点（有卡）→ 它预约的版本行星；收起的星团按"星团 → 行星"合成一条
  const links: GLink[] = [];
  const curve = (x: number, y0: number, p: GPlanet) => {
    const cx1 = x + (p.x - x) * 0.55;
    return `M${x.toFixed(1)},${y0.toFixed(1)} C${cx1.toFixed(1)},${y0.toFixed(1)} ${(p.x - 90).toFixed(1)},${p.y.toFixed(1)} ${(p.x - p.r).toFixed(1)},${p.y.toFixed(1)}`;
  };
  const rowOf = new Map(rows.map((r) => [r.key, r]));
  const agg = new Map<string, GLink>();
  for (const n of all) {
    if (!n.card || n.card.done) continue;
    const p = planetOf.get(n.card.column);
    if (!p) continue;
    const row = rowOf.get(n.row);
    if (row && !row.expanded && row.cluster) {
      const k = `l:${row.key}>${p.key}`;
      const cur = agg.get(k);
      if (cur) {
        cur.count = (cur.count ?? 1) + 1;
        continue;
      }
      const x = row.cluster.x1;
      const l: GLink = { key: k, from: row.key, to: p.key, d: curve(x, row.y, p), x1: x, y1: row.y, x2: p.x, y2: p.y, color: row.cluster.color, count: 1 };
      agg.set(k, l);
      links.push(l);
      continue;
    }
    if (!row) continue;
    links.push({ key: `l:${n.key}`, from: n.key, to: p.key, d: curve(n.x, n.y, p), x1: n.x, y1: n.y, x2: p.x, y2: p.y, color: n.color });
  }

  placeClusterLabels(rows, planets, confluences, xL, width);
  placeLabels(nodes, planets, clusterBoxes(rows));

  const planetsBottom = planets.length ? Math.max(...planets.map((p) => p.y + p.r + 40)) : 0;
  const height = Math.max(y + 10, planetsBottom, 360);
  return {
    width,
    height,
    xL,
    xR,
    ticks,
    lanes,
    rows,
    nodes,
    all,
    flows,
    planets,
    links,
    confluences,
    latest: [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k),
    counts: { branches: all.length, unbound: all.filter((b) => !b.card).length, cards: cards.length },
  };
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 12px 字号下的近似宽度：中文约 12px，其他约 7px */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u2E80-\uFFFF]/.test(ch) ? 12 : 7;
  return w;
}

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  owner: string | null;
}
const overlap = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

/**
 * 常显标签的避让：按优先级（最新 > 等你回答 > 有冲突）贪心放置，右边放不下放左边，都放不下就不常显。
 * 障碍物 = 行星（含名字）、所有星点、已放好的标签。
 */
export function placeLabels(nodes: GNode[], planets: GPlanet[], blocks: Box[] = []): void {
  const obstacles: Box[] = planets.map((p) => ({ x0: p.x - p.r - 6, x1: p.x + p.r + 70, y0: p.y - p.r - 6, y1: p.y + p.r + 36, owner: null }));
  obstacles.push(...blocks);
  for (const n of nodes) obstacles.push({ x0: n.x - n.r - 1, x1: n.x + n.r + 1, y0: n.y - n.r - 1, y1: n.y + n.r + 1, owner: n.key });
  const prio = (b: GBranch) => (b.recent ? b.recent : b.color === "purple" ? 10 : b.color === "red" ? 20 : 99);
  const cands = nodes.filter((n): n is GBranch => n.kind === "branch" && prio(n) < 99).sort((a, b) => prio(a) - prio(b) || b.x - a.x);
  for (const b of cands) {
    const w = textWidth(b.labelText);
    const boxes: Array<["r" | "l" | "t" | "b", Box]> = [
      ["r", { x0: b.x + b.r + 4, x1: b.x + b.r + 6 + w, y0: b.y - 9, y1: b.y + 7, owner: b.key }],
      ["l", { x0: b.x - b.r - 6 - w, x1: b.x - b.r - 4, y0: b.y - 9, y1: b.y + 7, owner: b.key }],
    ];
    // 最新的几颗：左右都放不下时，再试正上方 / 正下方（"快速找到最新的分支"）
    if (b.recent) {
      boxes.push(["t", { x0: b.x - w / 2, x1: b.x + w / 2, y0: b.y - b.r - 20, y1: b.y - b.r - 4, owner: b.key }]);
      boxes.push(["b", { x0: b.x - w / 2, x1: b.x + w / 2, y0: b.y + b.r + 4, y1: b.y + b.r + 20, owner: b.key }]);
    }
    for (const [side, box] of boxes) {
      if (obstacles.some((o) => o.owner !== b.key && overlap(o, box))) continue;
      b.labelSide = side;
      obstacles.push({ ...box, owner: `label:${b.key}` });
      break;
    }
  }
}

/** 星团说明（数量 · 等你 · 冲突 · 最新）：优先放在星团右边；右边会撞上行星 / 合流点就放到星团下方（右对齐，不越过左侧行头） */
export function placeClusterLabels(rows: GRow[], planets: GPlanet[], confluences: GConfluence[], xL: number, width: number): void {
  const blocks: Box[] = planets.map((p) => ({ x0: p.x - p.r - 6, x1: p.x + p.r + 70, y0: p.y - p.r - 6, y1: p.y + p.r + 36, owner: null }));
  for (const c of confluences) blocks.push({ x0: c.x - 34, x1: c.x + 34, y0: c.y - 34, y1: c.y + 16, owner: null });
  for (const r of rows) {
    const c = r.cluster;
    if (!c) continue;
    const w = textWidth(c.labelText);
    const right: Box = { x0: c.x1 + 16, x1: c.x1 + 18 + w, y0: r.y - 9, y1: r.y + 7, owner: null };
    if (right.x1 <= width - 10 && !blocks.some((b) => overlap(b, right))) {
      c.labelSide = "r";
      c.labelX = c.x1 + 17;
      c.labelY = r.y + 4;
    } else {
      c.labelSide = "b";
      c.labelX = Math.max(c.x1 + 8, xL + w);
      c.labelY = r.y + 22;
    }
  }
}

/** 收起的星团占的位置（星点标签要避开） */
export function clusterBoxes(rows: GRow[]): Box[] {
  const out: Box[] = [];
  for (const r of rows) {
    const c = r.cluster;
    if (!c) continue;
    out.push({ x0: c.x0 - 12, x1: c.x1 + 12, y0: r.y - 12, y1: r.y + 12, owner: null });
    const w = textWidth(c.labelText);
    if (c.labelSide === "r") out.push({ x0: c.labelX - 1, x1: c.labelX + w + 1, y0: c.labelY - 13, y1: c.labelY + 3, owner: null });
    else if (c.labelSide === "b") out.push({ x0: c.labelX - w - 1, x1: c.labelX + 1, y0: c.labelY - 13, y1: c.labelY + 3, owner: null });
  }
  return out;
}

/** 拖拽落点判定：离指针最近、且在吸附半径内的目标 */
export type DropTarget = { kind: "planet"; planet: GPlanet } | { kind: "confluence"; conf: GConfluence } | { kind: "card"; node: GCard } | { kind: "row"; row: GRow };

export function hitTarget(m: GalaxyModel, x: number, y: number, dragging: GNode): DropTarget | null {
  let best: { t: DropTarget; d: number } | null = null;
  const consider = (t: DropTarget, cx: number, cy: number, radius: number) => {
    const d = Math.hypot(cx - x, cy - y);
    if (d <= radius && (!best || d < best.d)) best = { t, d };
  };
  for (const p of m.planets) if (p.droppable) consider({ kind: "planet", planet: p }, p.x, p.y, p.r + 26);
  for (const c of m.confluences) if (dragging.kind === "card" || (dragging.kind === "branch" && dragging.merged !== "in_main")) consider({ kind: "confluence", conf: c }, c.x, c.y, 30);
  if (dragging.kind === "branch") for (const n of m.nodes) if (n.kind === "card") consider({ kind: "card", node: n }, n.x, n.y, 16);
  // M8：拖到左侧的类型行头 = 改类型
  for (const r of m.rows) if (r.type !== dragging.type && x >= 12 && x <= m.xL - 4 && y >= r.y0 && y <= r.y1) consider({ kind: "row", row: r }, x, r.y, 999);
  return best ? (best as { t: DropTarget }).t : null;
}

/** M8：拖版本行星时，只有合流点能接（= 合并这一版：复制合并 Prompt） */
export function hitConfluence(m: GalaxyModel, x: number, y: number): GConfluence | null {
  let best: { c: GConfluence; d: number } | null = null;
  for (const c of m.confluences) {
    const d = Math.hypot(c.x - x, c.y - y);
    if (d <= 34 && (!best || d < best.d)) best = { c, d };
  }
  return best ? best.c : null;
}

/** M8：某条分支 / 卡在哪个类型行（跳转定位、搜索时自动展开用） */
export function rowKeyOf(m: GalaxyModel, key: string): string | null {
  return m.all.find((b) => b.key === key)?.row ?? null;
}
