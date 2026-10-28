/** @jsxImportSource preact */
/**
 * 星图（M7）：宇宙星河风格的分支关系图。
 * - 纵横：横轴 = 最后提交时间（越右越新），纵轴 = 仓库泳道；每条泳道底部是主线与集成分支两条"星河主流"。
 * - 星点 = 功能分支；颜色 = 状态灯；最亮会呼吸的三颗 = 最新的分支；蓝色虚边 = 还没有功能卡的"流浪星"。
 * - 右侧行星 = 版本；细线 = 星座线（功能卡预约到哪一版）。
 * - 拖拽（Pointer Events，鼠标与触屏都行）：拖动时牵出一条发光线段，可放的目标会亮。
 *   分支 → 版本行星：改预约（没卡就建卡）；分支 → 小卡星：绑定；任意 → 合流点：排进合并单「并入」并显示试合结果。
 *   全部只写台账 / 合并单；真正的 git 合并仍在终端 heliu 合并 <版本>，输入 yes 才执行。
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FeaturesData, ProjectsData, ReleaseDecisionResult } from "../src/board/api-types.ts";
import type { ReconcileReport } from "../src/types.ts";
import { buildGalaxy, hitTarget, type DropTarget, type GBranch, type GNode, type GalaxyModel, type StarColor } from "./galaxy-model.ts";
import { ago, api, copyText, currentProject, mdhm, switchProject, useApi } from "./lib.ts";

const COLOR: Record<StarColor, string> = {
  green: "#5cf2a0",
  yellow: "#ffcf5c",
  red: "#ff6b6b",
  purple: "#c49bff",
  gray: "#9aa3b8",
  blue: "#6fd3ff",
};
const STATE_TEXT: Record<StarColor, string> = {
  green: "可合并",
  yellow: "落后需同步",
  red: "有冲突",
  purple: "等你回答",
  gray: "开发中 / 停滞",
  blue: "还没有功能卡",
};

interface Drag {
  node: GNode;
  sx: number;
  sy: number;
  x: number;
  y: number;
  moved: boolean;
  target: DropTarget | null;
}

/** 固定种子的伪随机：星空每次渲染位置一致，不闪 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(1200);
  // 依赖 ref.current：页面先显示「正在对账」、画布稍后才挂上，挂上后才开始量宽度
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, [ref.current]);
  return w;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function GalaxyPage({ tick, status, precheck, onChanged, projects }: { tick: number; status: ReconcileReport | null; precheck: boolean; onChanged: () => void; projects: ProjectsData }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const width = useWidth(wrapRef);
  const features = useApi<FeaturesData>(`/api/features?precheck=${precheck ? 1 : 0}`, [tick]);
  const [showMerged, setShowMerged] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [decision, setDecision] = useState<ReleaseDecisionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [intro, setIntro] = useState(true);
  const [hoverPlanet, setHoverPlanet] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const model: GalaxyModel | null = useMemo(
    () => (status ? buildGalaxy(status, features.env?.data ?? null, { width: Math.max(width, 900), now: Date.now(), showMerged, collapsed }) : null),
    [status, features.env, width, showMerged, collapsed],
  );
  const modelRef = useRef(model);
  modelRef.current = model;
  const dragRef = useRef(drag);
  dragRef.current = drag;

  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 1600);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const stars = useMemo(() => {
    const h = model?.height ?? 800;
    const w = model?.width ?? 1200;
    const r = rng(7);
    return Array.from({ length: Math.round((w * h) / 5200) }, (_, i) => ({ x: r() * w, y: r() * h, s: r() < 0.08 ? 1.6 : r() < 0.3 ? 1.1 : 0.7, tw: i % 7 === 0, d: (r() * 6).toFixed(2) }));
  }, [model?.width, model?.height]);

  const q = query.trim().toLowerCase();
  const inFilter = (n: GNode) => filterHit(filter, n);
  const matches = (n: GNode) => {
    if (!inFilter(n)) return false;
    if (!q) return true;
    const hay = n.kind === "branch" ? `${n.label} ${n.branch} ${n.card?.id ?? ""} ${n.sessionTitle ?? ""}` : `${n.card.title} ${n.card.id}`;
    return hay.toLowerCase().includes(q);
  };

  /* ───────────── 拖拽 ───────────── */

  const pt = (e: PointerEvent) => {
    const r = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const m = modelRef.current;
      if (!d || !m || !svgRef.current) return;
      const p = pt(e);
      const moved = d.moved || Math.hypot(p.x - d.sx, p.y - d.sy) > 6;
      setDrag({ ...d, x: p.x, y: p.y, moved, target: moved ? hitTarget(m, p.x, p.y, d.node) : null });
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (!d.moved) {
        setSel((s) => (s === d.node.key ? null : d.node.key));
        return;
      }
      if (d.target) void drop(d.node, d.target);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  const startDrag = (n: GNode, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pt(e);
    setDrag({ node: n, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false, target: null });
  };

  const cardIdOf = (n: GNode): string | null => (n.kind === "card" ? n.card.id : (n.card?.id ?? null));

  /** 没卡的分支：先建卡（绑定该分支），返回新卡号 */
  const ensureCard = async (n: GBranch, milestone: string | null): Promise<string> => {
    const r = await api<{ feature: { id: string; title: string; milestone: string | null } }>("/api/features", { body: { bind: { repo: n.repo, branch: n.branch }, milestone } });
    return r.data.feature.id;
  };

  const drop = async (n: GNode, t: DropTarget) => {
    setBusy(true);
    try {
      if (t.kind === "planet") {
        const ms = t.planet.kind === "unreserved" ? null : t.planet.key;
        const id = cardIdOf(n);
        if (id) {
          await api(`/api/features/${id}`, { method: "PATCH", body: { milestone: ms } });
          setToast(`已把 ${id} ${ms ? `预约到 ${t.planet.title}` : "改为未预约"}（已写入台账）`);
        } else if (n.kind === "branch") {
          const nid = await ensureCard(n, ms);
          setToast(`已为「${short(n.label, 20)}」建卡 ${nid}${ms ? `，预约到 ${t.planet.title}` : "（未预约）"}`);
        }
      } else if (t.kind === "card") {
        if (n.kind !== "branch") return;
        await api(`/api/features/${t.node.card.id}/bind`, { body: { repo: n.repo, branch: n.branch } });
        setToast(`已把分支 ${short(n.branch, 32)} 绑到 ${t.node.card.id}「${short(t.node.card.title, 16)}」`);
      } else {
        let id = cardIdOf(n);
        if (!id && n.kind === "branch") id = await ensureCard(n, "next");
        if (!id) return;
        const r = await api<ReleaseDecisionResult>("/api/release/decision", { body: { feature: id } });
        setDecision(r.data);
        setToast(`${id} 已排进 ${r.data.milestone} 合并单：并入（只写合并单，未执行合并）`);
      }
      onChanged();
    } catch (e) {
      setToast(`没成功：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  if (!status) return <p class="muted">正在对账…</p>;
  if (!model) return null;
  const selNode = model.nodes.find((n) => n.key === sel) ?? null;
  const related = new Set<string>();
  if (selNode) {
    related.add(selNode.key);
    for (const l of model.links) if (l.from === selNode.key) related.add(l.to);
  }
  const planetHL = drag?.target?.kind === "planet" ? drag.target.planet.key : null;
  const confHL = drag?.target?.kind === "confluence" ? drag.target.conf.key : null;
  const cardHL = drag?.target?.kind === "card" ? drag.target.node.key : null;
  const dragging = !!drag?.moved;
  const latest = model.latest.map((k) => model.nodes.find((n) => n.key === k)).filter((n): n is GBranch => !!n && n.kind === "branch");

  return (
    <div class="galaxy-page">
      <div class="galaxy-bar">
        <Universe projects={projects} />
        <input type="text" value={query} placeholder="搜分支 / 功能 / 卡号" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <label class="chk">
          <input type="checkbox" checked={showMerged} onChange={(e) => setShowMerged((e.target as HTMLInputElement).checked)} />
          显示已进主线
        </label>
        <span class="galaxy-meta">
          {model.counts.branches} 颗分支星 · {model.counts.unbound} 颗没卡 · {model.counts.cards} 张功能卡
        </span>
      </div>
      <div class="galaxy-tools">
        <div class="filters" role="group" aria-label="筛选星点">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? model.nodes.length : model.nodes.filter((x) => filterHit(f.key, x)).length;
            return (
              <button class={`fchip f-${f.key}${filter === f.key ? " on" : ""}`} onClick={() => setFilter(f.key)} disabled={f.key !== "all" && n === 0}>
                {f.title} <b>{n}</b>
              </button>
            );
          })}
        </div>
        {latest.length ? (
          <span class="latest-pills">
            最新：
            {latest.map((n) => (
              <button class="pill" onClick={() => setSel(n.key)} title={`${n.repoLabel} · ${n.branch}`}>
                {short(n.label, 14)} · {ago(n.lastAt)}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <div class={`galaxy${intro ? " intro" : ""}${dragging ? " dragging" : ""}`} ref={wrapRef}>
        <svg ref={svgRef} width={model.width} height={model.height} class="galaxy-svg" role="img" aria-label="分支星图">
          <defs>
            {(Object.keys(COLOR) as StarColor[]).map((c) => (
              <radialGradient id={`star-${c}`}>
                <stop offset="0%" stop-color="#ffffff" />
                <stop offset="35%" stop-color={COLOR[c]} />
                <stop offset="100%" stop-color={COLOR[c]} stop-opacity="0" />
              </radialGradient>
            ))}
            <linearGradient id="river-main" x1="0" x2="1">
              <stop offset="0%" stop-color="#3a6df0" stop-opacity="0.1" />
              <stop offset="100%" stop-color="#6fd3ff" stop-opacity="0.9" />
            </linearGradient>
            <linearGradient id="river-integ" x1="0" x2="1">
              <stop offset="0%" stop-color="#8a4dff" stop-opacity="0.1" />
              <stop offset="100%" stop-color="#ff7ad9" stop-opacity="0.95" />
            </linearGradient>
            <radialGradient id="planet" cx="35%" cy="35%">
              <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95" />
              <stop offset="40%" stop-color="#7aa8ff" />
              <stop offset="100%" stop-color="#1b2a6b" />
            </radialGradient>
            <radialGradient id="planet-next" cx="35%" cy="35%">
              <stop offset="0%" stop-color="#ffffff" />
              <stop offset="40%" stop-color="#ffb36b" />
              <stop offset="100%" stop-color="#7a2d5b" />
            </radialGradient>
            <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
              <feGaussianBlur stdDeviation="3" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* 星空 */}
          <g class="stars">
            {stars.map((s) => (
              <circle cx={s.x} cy={s.y} r={s.s} class={s.tw ? "tw" : ""} style={s.tw ? { animationDelay: `${s.d}s` } : undefined} />
            ))}
          </g>

          {/* 时间刻度 */}
          <g class="ticks">
            {model.ticks.map((t) => (
              <g>
                <line x1={t.x} x2={t.x} y1={30} y2={model.height - 10} />
                <text x={t.x} y={22} text-anchor="middle">
                  {t.label}
                </text>
              </g>
            ))}
            <text x={model.xR} y={40} text-anchor="end" class="axis">
              → 越靠右越新
            </text>
          </g>

          {/* 泳道与两条星河主流 */}
          {model.lanes.map((l) => (
            <g class="lane">
              <rect x={8} y={l.y0} width={model.xR + 60} height={l.y1 - l.y0} rx={14} class="lane-bg" />
              <g
                class="lane-label"
                onClick={() =>
                  setCollapsed((s) => {
                    const n = new Set(s);
                    if (n.has(l.repo)) n.delete(l.repo);
                    else n.add(l.repo);
                    return n;
                  })
                }
              >
                <text x={20} y={l.y0 + 22} class="lane-name">
                  {l.collapsed ? "▸" : "▾"} {l.label}
                </text>
                <text x={20} y={l.y0 + 38} class="lane-sub">
                  {l.error ? l.error : `${l.shown} / ${l.total} 条分支${l.hiddenMerged && !showMerged ? `（${l.hiddenMerged} 条已进主线未显示）` : ""}`}
                </text>
              </g>
              {l.integY !== null ? (
                <g>
                  <path d={`M${model.xL},${l.integY} L${model.xR + 26},${l.integY}`} class="river integ" stroke="url(#river-integ)" />
                  <path d={`M${model.xL},${l.integY} L${model.xR + 26},${l.integY}`} class="river-flow integ" />
                  <text x={model.xL - 8} y={l.integY + 4} text-anchor="end" class="river-label">
                    集成 {short(l.integration ?? "", 18)}
                  </text>
                </g>
              ) : null}
              <path d={`M${model.xL},${l.mainY} L${model.xR},${l.mainY}`} class="river main" stroke="url(#river-main)" />
              <path d={`M${model.xL},${l.mainY} L${model.xR},${l.mainY}`} class="river-flow main" />
              <text x={model.xL - 8} y={l.mainY + 4} text-anchor="end" class="river-label">
                主线 {short(l.main, 18)}
              </text>
              {l.integY !== null ? (
                <g>
                  <path d={`M${model.xR + 26},${l.integY} C${model.xR + 70},${l.integY} ${model.xR + 40},${l.mainY} ${model.xR},${l.mainY}`} class="return-arc" />
                  <text x={model.xR - 6} y={l.mainY - 6} text-anchor="end" class="return-label">
                    {l.integAhead !== null ? `集成领先主线 ${l.integAhead}` : ""}
                    {l.integDays !== null ? ` · ${l.integDays} 天未并回` : ""}
                  </text>
                </g>
              ) : null}
            </g>
          ))}

          {/* 流线：星点汇入主流 */}
          <g class="flows">
            {model.flows.map((f) => (
              <path d={f.d} class={`flow ${f.cls}${sel && sel !== f.node ? " dim" : ""}`} />
            ))}
          </g>

          {/* 星座线：功能卡 → 版本 */}
          <g class="links">
            {model.links.map((l) => (
              <path d={l.d} class={`link${sel === l.from || hoverPlanet === l.to ? " on" : ""}`} stroke={COLOR[l.color]} />
            ))}
          </g>

          {/* 版本行星 */}
          {model.planets.map((p) => (
            <g
              class={`planet${p.droppable ? " drop" : ""}${planetHL === p.key ? " hot" : ""}${related.has(p.key) ? " rel" : ""}${dragging && p.droppable ? " can" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              onPointerEnter={() => setHoverPlanet(p.key)}
              onPointerLeave={() => setHoverPlanet((h) => (h === p.key ? null : h))}
            >
              <title>{`${p.title}：还欠 ${p.owed} 项。悬停可看哪些功能预约在这一版；把星点拖到这里即可预约。`}</title>
              {p.isNext ? <circle r={p.r + 9} class="ring" /> : null}
              <circle r={p.r} fill={p.kind === "milestone" ? (p.isNext ? "url(#planet-next)" : "url(#planet)") : "#2a3354"} class="body" />
              <text y={p.r + 16} text-anchor="middle" class="planet-name">
                {p.title}
                {p.isNext ? " · 下一版" : ""}
              </text>
              <text y={p.r + 31} text-anchor="middle" class="planet-sub">
                {p.kind === "released" ? "已发布" : `还欠 ${p.owed}${p.waiting ? ` · 等你 ${p.waiting}` : ""}`}
              </text>
            </g>
          ))}

          {/* 合流点：集成分支的终点 */}
          {model.confluences.map((c) => (
            <g class={`conf${confHL === c.key ? " hot" : ""}${dragging ? " can" : ""}`} transform={`translate(${c.x},${c.y})`}>
              <circle r={13} class="conf-ring" />
              <circle r={6} class="conf-core" />
              <text y={-20} text-anchor="middle" class="conf-label">
                合流点
              </text>
            </g>
          ))}

          {/* 星点 */}
          <g class="nodes">
            {model.nodes.map((n, i) => {
              const m = matches(n);
              const hl = sel === n.key || cardHL === n.key;
              const isB = n.kind === "branch";
              return (
                <g
                  class={`star ${n.kind} c-${n.color}${hl ? " sel" : ""}${!m ? " dim" : ""}${isB && n.recent ? " latest" : ""}${isB && !n.card ? " stray" : ""}`}
                  style={{ transform: `translate(${n.x}px, ${n.y}px)`, animationDelay: `${Math.min(900, i * 9)}ms` }}
                  onPointerDown={(e) => startDrag(n, e as unknown as PointerEvent)}
                >
                  <title>{isB ? `${n.label}\n${n.repoLabel} · ${n.branch}\n${STATE_TEXT[n.color]} · 最后提交 ${mdhm(n.lastAt)}` : `${n.card.id} ${n.card.title}（还没关联分支）`}</title>
                  {isB && n.recent ? <circle r={n.r + 9} class="halo" /> : null}
                  <circle r={n.r * 2.2} fill={`url(#star-${n.color})`} class="glow" />
                  <circle r={n.r} class="core" fill={COLOR[n.color]} />
                  {isB && n.behind && n.behind > 0 && n.merged === "unmerged" && (n.color === "yellow" || filter === "behind") ? (
                    <text y={n.r + 13} text-anchor="middle" class="behind-badge">
                      ↓{n.behind}
                    </text>
                  ) : null}
                  {isB && filter !== "all" && filter !== "behind" && m && !n.labelSide ? (
                    <text x={n.r + 6} y={4} class="star-label">
                      {n.labelText}
                    </text>
                  ) : null}
                  {isB && (n.labelSide || hl || (q && m)) ? (
                    <text
                      x={n.labelSide === "l" ? -(n.r + 6) : n.labelSide === "t" || n.labelSide === "b" ? 0 : n.r + 6}
                      y={n.labelSide === "t" ? -(n.r + 8) : n.labelSide === "b" ? n.r + 16 : 4}
                      text-anchor={n.labelSide === "l" ? "end" : n.labelSide === "t" || n.labelSide === "b" ? "middle" : "start"}
                      class={`star-label${n.recent === 1 ? " newest" : ""}`}
                    >
                      {n.labelText}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* 拖动时牵出的线段 */}
          {drag && drag.moved ? (
            <g class="dragline">
              <line x1={drag.node.x} y1={drag.node.y} x2={drag.x} y2={drag.y} class={drag.target ? "ok" : ""} />
              <circle cx={drag.x} cy={drag.y} r={7} class={drag.target ? "ok" : ""} />
              <text x={drag.x + 12} y={drag.y - 10} class="drag-tip">
                {drag.target ? dropText(drag.node, drag.target) : "拖到行星 / 小卡星 / 合流点"}
              </text>
            </g>
          ) : null}
        </svg>
      </div>

      <Legend />
      <p class="galaxy-hint">
        拖星点到右边的版本行星 = 改预约（没卡会自动建卡）· 拖到小卡星 = 绑定分支 · 拖到「合流点」= 排进合并单并入（只写合并单，不执行合并）· 点星点看详情 · 点泳道名折叠
      </p>

      {selNode ? <Detail node={selNode} model={model} busy={busy} onClose={() => setSel(null)} onDrop={(t) => void drop(selNode, t)} /> : null}
      {decision ? <DecisionPanel d={decision} root={projects.heliuRoot} onClose={() => setDecision(null)} /> : null}
      {toast ? <div class="toast">{toast}</div> : null}
    </div>
  );
}

type Filter = "all" | "waiting" | "behind" | "conflict" | "stray";
const FILTERS: Array<{ key: Filter; title: string }> = [
  { key: "all", title: "全部" },
  { key: "waiting", title: "等你回答" },
  { key: "behind", title: "落后需同步" },
  { key: "conflict", title: "有冲突" },
  { key: "stray", title: "还没建卡" },
];
function filterHit(f: Filter, n: GNode): boolean {
  if (f === "all") return true;
  if (n.kind === "card") return false;
  if (f === "waiting") return n.color === "purple" || !!n.waiting;
  if (f === "behind") return n.merged === "unmerged" && (n.behind ?? 0) > 0;
  if (f === "conflict") return n.color === "red" || (n.conflicts ?? 0) > 0;
  return !n.card;
}

function dropText(n: GNode, t: DropTarget): string {
  const hasCard = n.kind === "card" || !!n.card;
  if (t.kind === "planet") return t.planet.kind === "unreserved" ? "松手：取消预约" : hasCard ? `松手：预约到 ${t.planet.title}` : `松手：建卡并预约到 ${t.planet.title}`;
  if (t.kind === "card") return `松手：绑定到 ${t.node.card.id}`;
  return `松手：排进合并单「并入」（不执行合并）`;
}

/** 顶部"宇宙"：所有项目一字排开，点一下切过去 */
function Universe({ projects }: { projects: ProjectsData }) {
  const cur = currentProject();
  if (projects.projects.length < 2) return null;
  return (
    <div class="universe">
      {projects.projects.map((p) => (
        <button class={`galaxy-chip${p.name === cur ? " on" : ""}`} onClick={() => p.name !== cur && switchProject(p.name, "galaxy")} title={p.repos.map((r) => r.label).join(" · ")}>
          <span class="spiral" />
          <b>{p.name}</b>
          <span class="muted small">
            {p.repos.length} 仓库 · {p.open ?? 0} 项还欠
          </span>
        </button>
      ))}
    </div>
  );
}

function Legend() {
  return (
    <div class="galaxy-legend">
      {(Object.keys(STATE_TEXT) as StarColor[]).map((c) => (
        <span>
          <i style={{ background: COLOR[c] }} />
          {STATE_TEXT[c]}
        </span>
      ))}
      <span>
        <i class="halo-i" />
        最新（呼吸光晕）
      </span>
      <span>星点越大 = 自己的提交越多</span>
      <span>虚线 = 还没并进集成分支；亮实线 = 已汇入</span>
    </div>
  );
}

function Detail({ node, model, busy, onClose, onDrop }: { node: GNode; model: GalaxyModel; busy: boolean; onClose: () => void; onDrop: (t: DropTarget) => void }) {
  const card = node.kind === "card" ? node.card : node.card;
  const planets = model.planets.filter((p) => p.droppable);
  const conf = node.kind === "branch" ? model.confluences.find((c) => c.repo === node.repo) : model.confluences[0];
  const prompt =
    node.kind === "branch"
      ? `请在分支 ${node.branch} 的 worktree（${node.worktree ?? "目录未知，请先打开该分支的会话"}）里，把集成分支同步进来并解决冲突；两边功能都保留，解完 git add，不要 push。`
      : null;
  return (
    <aside class="detail">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>{node.kind === "branch" ? node.label : node.card.title}</h3>
      <p class="small">
        <span class="dot" style={{ background: COLOR[node.color] }} /> {STATE_TEXT[node.color]}
        {node.kind === "branch" && node.recent ? <span class="tag">第 {node.recent} 新</span> : null}
      </p>
      {node.kind === "branch" ? (
        <div class="kv small">
          <span>仓库</span>
          <span>{node.repoLabel}</span>
          <span>分支</span>
          <span>
            <code>{node.branch}</code>{" "}
            <button class="link" onClick={() => void copyText(node.branch)}>
              复制
            </button>
          </span>
          <span>最后提交</span>
          <span>
            {mdhm(node.lastAt)}（{ago(node.lastAt)}）
          </span>
          <span>提交</span>
          <span>
            自己的 ↑{node.ahead}
            {node.behind !== null ? ` · 落后基线 ↓${node.behind}` : ""}
            {node.conflicts !== null ? ` · 试合冲突 ${node.conflicts} 个文件` : ""}
          </span>
          {node.sessionTitle ? (
            <>
              <span>会话</span>
              <span>{node.sessionTitle}</span>
            </>
          ) : null}
        </div>
      ) : null}
      {node.kind === "branch" && node.waiting ? <p class="needs">等你：{node.waiting}</p> : null}
      <p class="small">{card ? `功能卡 ${card.id} · 预约 ${card.column === "__unreserved" ? "未预约" : card.column}` : "还没有功能卡：拖到版本行星，或用下面的按钮建卡。"}</p>
      {card?.nextStep && !(node.kind === "branch" && node.waiting) ? <p class="small muted">下一步：{card.nextStep}</p> : null}
      <div class="row-actions">
        <select
          disabled={busy}
          value=""
          onChange={(e) => {
            const k = (e.target as HTMLSelectElement).value;
            const p = planets.find((x) => x.key === k);
            if (p) onDrop({ kind: "planet", planet: p });
          }}
        >
          <option value="">{card ? "改预约到…" : "建卡并预约到…"}</option>
          {planets.map((p) => (
            <option value={p.key}>{p.title}</option>
          ))}
        </select>
        {conf ? (
          <button class="btn" disabled={busy} onClick={() => onDrop({ kind: "confluence", conf })}>
            排进合并单（并入）
          </button>
        ) : null}
        {prompt ? (
          <button class="btn" onClick={() => void copyText(prompt)}>
            复制给 Claude 会话
          </button>
        ) : null}
      </div>
      <p class="explain">手机上不方便拖时，用这里的下拉和按钮，效果相同。</p>
    </aside>
  );
}

/** 试合结果的一句话：索引文件冲突合流会自动"两边都保留"，只有其余文件才需要解 */
function conflictLine(conflicts: string[], union: string[]): string {
  if (!conflicts.length) return "试合无冲突";
  const u = new Set(union);
  const other = conflicts.filter((f) => !u.has(f));
  const auto = conflicts.length - other.length;
  if (!other.length) return `试合有 ${auto} 个索引文件冲突（${conflicts.slice(0, 3).join("、")}），合并时自动两边都保留，不用你处理`;
  return `试合有 ${other.length} 个文件需要解冲突（${other.slice(0, 3).join("、")}${other.length > 3 ? "…" : ""}）${auto ? `，另有 ${auto} 个索引文件自动两边保留` : ""}；合并时会交给 Claude 解，或你先在该分支的会话里解`;
}

function DecisionPanel({ d, root, onClose }: { d: ReleaseDecisionResult; root: string; onClose: () => void }) {
  const cmd = d.command || `"${root}/bin/heliu" 合并 ${d.milestone}`;
  return (
    <aside class="detail decision">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>
        {d.feature} 已排进 {d.milestone} 合并单
      </h3>
      <p class="small">
        「{d.title}」决定 = 并入{d.reservedTo ? `（顺手预约到了 ${d.reservedTo}）` : ""}。这一步只写合并单，没有执行合并。
      </p>
      <ul class="small">
        {d.items.map((i) => (
          <li>
            {i.branch ?? "（没有分支）"} · {i.state}
            {i.precheckState === "failed" ? " · 未能试合（合并时再试，或人工确认）" : i.precheckState === "checked" ? ` · ${conflictLine(i.conflicts, i.union)}` : ""}
            {i.detail ? ` · ${i.detail}` : ""}
          </li>
        ))}
      </ul>
      <p class="small">真正合并：在终端执行下面这条，看完摘要输入 yes 才开始，可以回滚。</p>
      <p>
        <code>{cmd}</code>{" "}
        <button class="btn" onClick={() => void copyText(cmd)}>
          复制
        </button>
      </p>
      <p class="explain">合并单：{d.file}</p>
    </aside>
  );
}
