/**
 * 星图布局（M7，纯函数，不碰 DOM，便于测试）。
 *
 * 纵横：横轴 = 分支最后提交时间（平方根刻度，越右越新），纵轴 = 仓库泳道。
 * 每个泳道底部两条"星河主流"：主线、集成分支；功能分支是星点，排在主流上方，按时间横向铺开、碰撞时往上叠一层。
 * 右侧一列是版本行星（里程碑 + 未预约 + 已发布）；功能卡与它预约的版本之间画星座线。
 * 数据全部来自 /api/status（ReconcileReport）与 /api/features（FeaturesData），不额外请求。
 */
import type { BoardCard, FeaturesData, Light } from "../src/board/api-types.ts";
import type { FeatureView, ReconcileReport, RepoReport } from "../src/types.ts";

export type StarColor = Light | "blue";

export interface GalaxyOptions {
  width: number;
  now: number;
  /** 显示已进主线的分支（缺省隐藏：它们已经完成） */
  showMerged: boolean;
  /** 折叠的仓库 id */
  collapsed: Set<string>;
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
}

export type GNode = GBranch | GCard;

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
}

export interface GLink {
  key: string;
  from: string;
  to: string;
  /** 汇向行星的曲线（星座流） */
  d: string;
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
  nodes: GNode[];
  flows: GFlow[];
  planets: GPlanet[];
  links: GLink[];
  confluences: GConfluence[];
  /** 最新的分支 key（按时间倒序） */
  latest: string[];
  counts: { branches: number; unbound: number; cards: number };
}

const DAY = 86_400_000;
const LEFT = 150;
const RIGHT = 250;
const ROW = 20;
/** 同一天提交的分支先在横向小范围内错开，放不下再往上叠一层（蜂群布局） */
const SWARM = [0, -14, 14, -28, 28, -42, 42, -56, 56];
const LANE_GAP = 28;
const TOP = 56;
const LATEST_N = 3;

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
  const all: Array<{ r: RepoReport; b: FeatureView }> = [];
  for (const r of repos) for (const b of r.branches) if (b.role === "feature" && b.mergedState !== "in_main" && b.lastCommitAt) all.push({ r, b });
  all.sort((p, q) => Date.parse(q.b.lastCommitAt!) - Date.parse(p.b.lastCommitAt!));
  const rank = new Map<string, number>();
  all.slice(0, LATEST_N).forEach((e, i) => rank.set(keyOf(e.r.id, e.b.branch), i + 1));

  const lanes: GLane[] = [];
  const nodes: GNode[] = [];
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

    // 碰撞分层：按横坐标从右往左放，同一层里两个星点至少相隔 2r+10
    const placed: Array<{ b: FeatureView; x: number; row: number; r: number }> = [];
    if (!collapsed) {
      const items = shown
        .map((b) => {
          const age = b.lastCommitAt ? (now - Date.parse(b.lastCommitAt)) / DAY : maxAge;
          const ahead = b.vsIntegration?.ahead ?? b.vsMain?.ahead ?? 0;
          return { b, x: xOfAge(age, maxAge, xL + 24, xR), r: starRadius(ahead) };
        })
        .sort((p, q) => q.x - p.x);
      const rows: number[][] = [];
      for (const it of items) {
        let row = 0;
        let px = it.x;
        search: for (;;) {
          const used = rows[row] ?? (rows[row] = []);
          for (const dx of SWARM) {
            const cx = Math.max(xL + 24, Math.min(xR, it.x + dx));
            if (used.every((ux) => Math.abs(ux - cx) > it.r * 2 + 12)) {
              used.push(cx);
              px = cx;
              break search;
            }
          }
          row += 1;
        }
        placed.push({ ...it, x: px, row });
      }
    }
    const nRows = placed.length ? Math.max(...placed.map((p) => p.row)) + 1 : 0;
    const head = 40;
    const bodyH = collapsed ? 0 : nRows * ROW;
    const integY = r.integration ? y + head + bodyH + 18 : null;
    const mainY = (integY ?? y + head + bodyH) + 26;
    const y1 = mainY + 16;

    for (const p of placed) {
      const b = p.b;
      const key = keyOf(r.id, b.branch);
      const card = byBinding.get(`${r.id}|${b.branch}`) ?? null;
      const ny = (integY ?? mainY) - 26 - p.row * ROW;
      const s = b.sessions[0] ?? null;
      const conflicts = b.precheck && !b.precheck.timedOut && !b.precheck.error ? (b.precheck.conflictFiles ?? null) : null;
      const node: GBranch = {
        key,
        kind: "branch",
        repo: r.id,
        repoLabel: r.label,
        branch: b.branch,
        label: card?.title ?? b.label,
        x: p.x,
        y: ny,
        r: p.r,
        color: branchColor(b, card),
        merged: b.mergedState,
        lastAt: b.lastCommitAt,
        ahead: b.vsIntegration?.ahead ?? b.vsMain?.ahead ?? 0,
        behind: b.vsIntegration?.behind ?? b.vsMain?.behind ?? null,
        card,
        waiting: card?.needsAction ?? (s?.status === "blocked" ? s.needsAction : null),
        conflicts,
        recent: rank.get(key) ?? null,
        sessionTitle: s?.title ?? null,
        worktree: b.worktree?.dirName ?? null,
        labelSide: null,
        labelText: "",
      };
      node.labelText = `${node.recent === 1 ? "★ 最新 · " : ""}${short(node.label, 18)}`;
      nodes.push(node);
      const river = node.merged === "in_main" ? mainY : (integY ?? mainY);
      flows.push({ key: `f:${key}`, node: key, d: flowPath(node.x, node.y, river, xL), cls: flowClass(node) });
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
      shown: placed.length,
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
  const branchKeys = new Set(nodes.map((n) => n.key));
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
    nodes.push({ key: `k:${c.id}`, kind: "card", card: c, x: p.x + Math.cos(ang) * dist, y: p.y - Math.sin(ang) * dist * 0.9, r: 5, color: c.light, planet: p.key });
  }

  // 星座线：分支星点（有卡）→ 它预约的版本行星
  const links: GLink[] = [];
  for (const n of nodes) {
    if (n.kind !== "branch" || !n.card || n.card.done) continue;
    const p = planetOf.get(n.card.column);
    if (!p) continue;
    const cx1 = n.x + (p.x - n.x) * 0.55;
    const d = `M${n.x.toFixed(1)},${n.y.toFixed(1)} C${cx1.toFixed(1)},${n.y.toFixed(1)} ${(p.x - 90).toFixed(1)},${p.y.toFixed(1)} ${(p.x - p.r).toFixed(1)},${p.y.toFixed(1)}`;
    links.push({ key: `l:${n.key}`, from: n.key, to: p.key, d, x1: n.x, y1: n.y, x2: p.x, y2: p.y, color: n.color });
  }

  placeLabels(nodes, planets);

  const planetsBottom = planets.length ? Math.max(...planets.map((p) => p.y + p.r + 40)) : 0;
  const height = Math.max(y + 10, planetsBottom, 360);
  const branches = nodes.filter((n): n is GBranch => n.kind === "branch");
  return {
    width,
    height,
    xL,
    xR,
    ticks,
    lanes,
    nodes,
    flows,
    planets,
    links,
    confluences,
    latest: [...rank.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k),
    counts: { branches: branches.length, unbound: branches.filter((b) => !b.card).length, cards: cards.length },
  };
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** 12px 字号下的近似宽度：中文约 12px，其他约 7px */
export function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += /[\u2E80-\uFFFF]/.test(ch) ? 12 : 7;
  return w;
}

interface Box {
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
export function placeLabels(nodes: GNode[], planets: GPlanet[]): void {
  const obstacles: Box[] = planets.map((p) => ({ x0: p.x - p.r - 6, x1: p.x + p.r + 70, y0: p.y - p.r - 6, y1: p.y + p.r + 36, owner: null }));
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

/** 拖拽落点判定：离指针最近、且在吸附半径内的目标 */
export type DropTarget = { kind: "planet"; planet: GPlanet } | { kind: "confluence"; conf: GConfluence } | { kind: "card"; node: GCard };

export function hitTarget(m: GalaxyModel, x: number, y: number, dragging: GNode): DropTarget | null {
  let best: { t: DropTarget; d: number } | null = null;
  const consider = (t: DropTarget, cx: number, cy: number, radius: number) => {
    const d = Math.hypot(cx - x, cy - y);
    if (d <= radius && (!best || d < best.d)) best = { t, d };
  };
  for (const p of m.planets) if (p.droppable) consider({ kind: "planet", planet: p }, p.x, p.y, p.r + 26);
  for (const c of m.confluences) if (dragging.kind === "card" || (dragging.kind === "branch" && dragging.merged !== "in_main")) consider({ kind: "confluence", conf: c }, c.x, c.y, 30);
  if (dragging.kind === "branch") for (const n of m.nodes) if (n.kind === "card") consider({ kind: "card", node: n }, n.x, n.y, 16);
  return best ? (best as { t: DropTarget }).t : null;
}
