/** @jsxImportSource preact */
/**
 * 星图（M7）：宇宙星河风格的分支关系图。
 * - 纵横：横轴 = 最后提交时间（越右越新），纵轴 = 仓库泳道；每条泳道底部是主线与集成分支两条"星河主流"。
 * - 星点 = 功能分支；颜色 = 状态灯；最亮会呼吸的三颗 = 最新的分支；蓝色虚边 = 还没有功能卡的"流浪星"。
 * - 右侧行星 = 版本；细线 = 星座线（功能卡预约到哪一版）。
 * - 拖拽（Pointer Events，鼠标与触屏都行）：拖动时牵出一条发光线段，可放的目标会亮。
 *   分支 → 版本行星：改预约（没卡就建卡）；分支 → 小卡星：绑定；任意 → 合流点：排进合并单「并入」并显示试合结果。
 *   全部只写台账 / 合并单；真正的 git 合并仍在终端 heliu 合并 <版本>，输入 yes 才执行。
 * M8：
 * - 每条泳道按类型分行，默认收成星团（数量 · 状态分布 · 最新时间），点行头或星团展开；搜索 / 筛选时自动展开命中的行。
 * - 形状 = 类型（修复 ◆ 功能 ● 调研 ▲ 文档 ■ 工程 ⬢ 其他 ○），颜色 = 状态。拖星点到左侧行头 = 改类型。
 * - 拖版本行星到合流点 = 合并这一版：刷新合并单，把合并 Prompt 复制到剪贴板（Prompt 不含 --yes，不替你合并）。
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FeaturesData, MergePromptData, ProjectsData, ReleaseDecisionResult } from "../src/board/api-types.ts";
import { FEATURE_TYPES, OTHER_MODULE, TYPE_GLYPH, classifyText, inferModule, type FeatureType } from "../src/core/classify.ts";
import type { ReconcileReport } from "../src/types.ts";
import { buildGalaxy, hitConfluence, hitTarget, rowKeyOf, type DropTarget, type GBranch, type GConfluence, type GNode, type GPlanet, type GRow, type GalaxyModel, type StarColor } from "./galaxy-model.ts";
import { ago, api, copyText, copyWhenReady, currentProject, mdhm, store, switchProject, useApi } from "./lib.ts";
import { MergedPanel, MergePromptPanel, PromptBlock, type PromptState } from "./merge-flow.tsx";

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
  /** 拖的是星点 / 小卡星；或者（M8）是版本行星 */
  node: GNode | null;
  planet: GPlanet | null;
  sx: number;
  sy: number;
  x: number;
  y: number;
  moved: boolean;
  target: DropTarget | null;
  /** 拖行星时命中的合流点 */
  conf: GConfluence | null;
}

/** 类型形状（以 0,0 为中心）：修复 ◆、调研 ▲、文档 ■、工程 ⬢；功能 ● 与其他 ○ 用圆 */
export function shapePath(t: FeatureType, r: number): string | null {
  const f = (n: number) => n.toFixed(2);
  if (t === "修复") {
    const k = r * 1.3;
    return `M0,${f(-k)} L${f(k)},0 L0,${f(k)} L${f(-k)},0 Z`;
  }
  if (t === "调研") {
    const k = r * 1.35;
    return `M0,${f(-k)} L${f(k * 0.92)},${f(k * 0.62)} L${f(-k * 0.92)},${f(k * 0.62)} Z`;
  }
  if (t === "文档") {
    const k = r * 0.92;
    return `M${f(-k)},${f(-k)} H${f(k)} V${f(k)} H${f(-k)} Z`;
  }
  if (t === "工程") {
    const k = r * 1.12;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const a = (Math.PI / 3) * i + Math.PI / 6;
      return `${f(Math.cos(a) * k)},${f(Math.sin(a) * k)}`;
    });
    return `M${pts.join(" L")} Z`;
  }
  return null;
}

function Shape({ type, r, fill, cls }: { type: FeatureType; r: number; fill: string; cls: string }) {
  const d = shapePath(type, r);
  if (d) return <path d={d} class={cls} fill={fill} />;
  if (type === "其他") return <circle r={r} class={`${cls} hollow`} fill={fill} fill-opacity={0.25} stroke={fill} stroke-width={1.6} />;
  return <circle r={r} class={cls} fill={fill} />;
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
  const fdata = features.env?.data ?? null;
  const [showMerged, setShowMerged] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // M8：展开了哪些类型行（按项目记住）
  const expKey = `heliu.galaxy.expanded.${currentProject() ?? ""}`;
  const [expanded, setExpandedRaw] = useState<Set<string>>(() => {
    try {
      const v = JSON.parse(store.get(expKey) ?? "[]") as unknown;
      return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    } catch {
      return new Set();
    }
  });
  const setExpanded = (f: (s: Set<string>) => Set<string>) =>
    setExpandedRaw((s) => {
      const n = f(s);
      store.set(expKey, JSON.stringify([...n]));
      return n;
    });
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const [selPlanet, setSelPlanet] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [decision, setDecision] = useState<{ d: ReleaseDecisionResult; prompt: PromptState } | null>(null);
  const [mergeP, setMergeP] = useState<{ title: string; st: PromptState } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [intro, setIntro] = useState(true);
  const [hoverPlanet, setHoverPlanet] = useState<string | null>(null);
  const [hoverRow, setHoverRow] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [focus, setFocus] = useState<string | null>(() => focusFromHash());

  const q = query.trim().toLowerCase();
  const inFilter = (n: GNode) => filterHit(filter, n);
  const matches = (n: GNode) => {
    if (!inFilter(n)) return false;
    if (!q) return true;
    const hay = n.kind === "branch" ? `${n.label} ${n.branch} ${n.card?.id ?? ""} ${n.sessionTitle ?? ""} ${n.type}` : `${n.card.title} ${n.card.id} ${n.type}`;
    return hay.toLowerCase().includes(q);
  };

  // 先按用户展开的行建模；搜索 / 筛选时，把有命中的行也展开（不改用户的记忆）
  const opts = { width: Math.max(width, 900), now: Date.now(), showMerged, collapsed };
  const base: GalaxyModel | null = useMemo(() => (status ? buildGalaxy(status, fdata, { ...opts, expanded }) : null), [status, features.env, width, showMerged, collapsed, expanded]);
  const model: GalaxyModel | null = useMemo(() => {
    if (!base || !status || (filter === "all" && !q)) return base;
    const extra = new Set(expanded);
    for (const b of base.all) if (matches(b)) extra.add(b.row);
    return extra.size === expanded.size ? base : buildGalaxy(status, fdata, { ...opts, expanded: extra });
  }, [base, filter, q]);
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

  /** 展开某颗星所在的行并选中它（最新标签、结构页跳转都走这里） */
  const reveal = (key: string) => {
    const m = modelRef.current;
    if (!m) return;
    const rk = rowKeyOf(m, key);
    if (rk && !m.rows.find((r) => r.key === rk)?.expanded) setExpanded((s) => new Set(s).add(rk));
    // 所在仓库泳道被折叠了：一并展开，否则星点不会画出来
    const repo = m.all.find((b) => b.key === key)?.repo;
    if (repo)
      setCollapsed((s) => {
        if (!s.has(repo)) return s;
        const n = new Set(s);
        n.delete(repo);
        return n;
      });
    setSel(key);
  };
  // 从结构页跳过来：#/galaxy/focus/<key>
  useEffect(() => {
    if (!focus || !model) return;
    const target = model.all.find((b) => b.key === focus) ?? model.nodes.find((n) => n.key === focus);
    setFocus(null);
    history.replaceState(null, "", `${location.pathname}${location.search}#/galaxy`);
    if (!target) return;
    reveal(target.key);
    setTimeout(() => {
      const el = wrapRef.current;
      if (el) el.scrollTo({ top: Math.max(0, target.y - 160), left: Math.max(0, target.x - el.clientWidth / 2), behavior: "smooth" });
    }, 120);
  }, [focus, model]);

  const stars = useMemo(() => {
    const h = model?.height ?? 800;
    const w = model?.width ?? 1200;
    const r = rng(7);
    return Array.from({ length: Math.round((w * h) / 5200) }, (_, i) => ({ x: r() * w, y: r() * h, s: r() < 0.08 ? 1.6 : r() < 0.3 ? 1.1 : 0.7, tw: i % 7 === 0, d: (r() * 6).toFixed(2) }));
  }, [model?.width, model?.height]);

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
      if (d.planet) setDrag({ ...d, x: p.x, y: p.y, moved, conf: moved ? hitConfluence(m, p.x, p.y) : null });
      else if (d.node) setDrag({ ...d, x: p.x, y: p.y, moved, target: moved ? hitTarget(m, p.x, p.y, d.node) : null });
    };
    const up = () => {
      const d = dragRef.current;
      if (!d) return;
      setDrag(null);
      if (!d.moved) {
        if (d.planet) {
          const k = d.planet.key;
          setSelPlanet((s) => (s === k ? null : k));
          setSel(null);
        } else if (d.node) {
          const k = d.node.key;
          setSel((s) => (s === k ? null : k));
          setSelPlanet(null);
        }
        return;
      }
      // 松手这一刻就要交出剪贴板写入（浏览器只在用户手势里允许），所以 drop / mergeVersion 的开头都是同步的
      if (d.planet && d.conf) mergeVersion(d.planet);
      else if (d.node && d.target) void drop(d.node, d.target);
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
    setDrag({ node: n, planet: null, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false, target: null, conf: null });
  };
  const startPlanetDrag = (pl: GPlanet, e: PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const p = pt(e);
    setDrag({ node: null, planet: pl, sx: p.x, sy: p.y, x: p.x, y: p.y, moved: false, target: null, conf: null });
  };

  const cardIdOf = (n: GNode): string | null => (n.kind === "card" ? n.card.id : (n.card?.id ?? null));

  /** 没卡的分支：先建卡（绑定该分支），返回新卡号 */
  const ensureCard = async (n: GBranch, milestone: string | null, extra: { type?: string | null; module?: string | null } = {}): Promise<string> => {
    const r = await api<{ feature: { id: string; title: string; milestone: string | null } }>("/api/features", { body: { bind: { repo: n.repo, branch: n.branch }, milestone, ...extra } });
    return r.data.feature.id;
  };

  /** 拖版本行星到合流点（或在行星详情里点按钮）：刷新合并单、复制合并 Prompt。必须在手势里同步调用。 */
  const mergeVersion = (pl: GPlanet) => {
    if (pl.kind !== "milestone") {
      setToast("只有规划中的版本能合并：拖一个版本行星（不是「未预约」或已发布）到合流点");
      return;
    }
    const req = api<MergePromptData>("/api/release/prompt", { body: { milestone: pl.key } });
    const copied = copyWhenReady(req.then((r) => r.data.prompt));
    setMergeP({ title: pl.title, st: { data: null, copied: null, error: null } });
    setSelPlanet(null);
    setBusy(true);
    req
      .then(async (r) => {
        const ok = await copied;
        setMergeP({ title: pl.title, st: { data: r.data, copied: ok, error: null } });
        setToast(ok ? `已复制 ${pl.title} 的合并 Prompt（只预演，不执行合并）` : `${pl.title} 的合并 Prompt 已生成：点「复制 Prompt」`);
        onChanged();
      })
      .catch((e: Error) => setMergeP({ title: pl.title, st: { data: null, copied: false, error: e.message } }))
      .finally(() => setBusy(false));
  };

  /** 改类型 / 模块：有卡就改卡；没卡的分支先建卡（未预约） */
  const classifyNode = async (n: GNode, patch: { type?: string | null; module?: string | null }) => {
    setBusy(true);
    try {
      let id = cardIdOf(n);
      let created = false;
      if (id) await api(`/api/features/${id}`, { method: "PATCH", body: patch });
      else if (n.kind === "branch") {
        id = await ensureCard(n, null, patch);
        created = true;
      }
      const what = patch.type !== undefined ? `类型 → ${patch.type ?? "按推测"}` : `模块 → ${patch.module ?? "按推测"}`;
      setToast(`${created ? `已建卡 ${id}（未预约）` : id}：${what}（已写入台账）`);
      onChanged();
    } catch (e) {
      setToast(`没成功：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const drop = async (n: GNode, t: DropTarget) => {
    if (t.kind === "confluence") {
      // 排进合并单「并入」，再生成这一版的合并 Prompt；剪贴板写入在这一刻同步交出
      const chain = (async () => {
        let id = cardIdOf(n);
        if (!id && n.kind === "branch") id = await ensureCard(n, "next");
        if (!id) throw new Error("这颗星没有功能卡");
        const d = await api<ReleaseDecisionResult>("/api/release/decision", { body: { feature: id } });
        const p = await api<MergePromptData>("/api/release/prompt", { body: { milestone: d.data.milestone } });
        return { d: d.data, p: p.data };
      })();
      const copied = copyWhenReady(chain.then((x) => x.p.prompt));
      setBusy(true);
      try {
        const r = await chain;
        const ok = await copied;
        setDecision({ d: r.d, prompt: { data: r.p, copied: ok, error: null } });
        setToast(`${r.d.feature} 已排进 ${r.d.milestone} 合并单：并入${ok ? "；合并 Prompt 已复制" : ""}（未执行合并）`);
        onChanged();
      } catch (e) {
        setToast(`没成功：${(e as Error).message}`);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (t.kind === "row") {
      await classifyNode(n, { type: t.row.type });
      setExpanded((s) => new Set(s).add(`${n.kind === "branch" ? n.repo : t.row.repo}|${t.row.type}`));
      return;
    }
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
      }
      onChanged();
    } catch (e) {
      setToast(`没成功：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleRow = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  if (!status) return <p class="muted">正在对账…</p>;
  // 功能卡还没到时先不画：否则会短暂把所有分支都画成「没卡」，计数也是 0 张功能卡
  if (!fdata && !features.error) return <p class="muted">正在读取功能卡…</p>;
  if (!model) return null;
  const selNode = model.nodes.find((n) => n.key === sel) ?? null;
  const selP = model.planets.find((p) => p.key === selPlanet) ?? null;
  const related = new Set<string>();
  if (selNode) {
    related.add(selNode.key);
    for (const l of model.links) if (l.from === selNode.key) related.add(l.to);
  }
  const planetHL = drag?.target?.kind === "planet" ? drag.target.planet.key : null;
  const confHL = drag?.target?.kind === "confluence" ? drag.target.conf.key : drag?.conf ? drag.conf.key : null;
  const cardHL = drag?.target?.kind === "card" ? drag.target.node.key : null;
  const rowHL = drag?.target?.kind === "row" ? drag.target.row.key : null;
  const dragging = !!drag?.moved;
  const draggingPlanet = dragging && !!drag?.planet;
  const draggingType = drag?.node?.type ?? null;
  const latest = model.latest.map((k) => model.all.find((n) => n.key === k)).filter((n): n is GBranch => !!n);
  const allOpen = model.rows.length > 0 && model.rows.every((r) => r.expanded);
  const filtering = filter !== "all" || !!q;
  const rowHit = (r: GRow) => !filtering || model.all.some((b) => b.row === r.key && matches(b));
  const modules = fdata?.modules ?? [];

  return (
    <div class="galaxy-page">
      <div class="galaxy-bar">
        <Universe projects={projects} />
        <input type="text" value={query} placeholder="搜分支 / 功能 / 卡号 / 类型" onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        <label class="chk">
          <input type="checkbox" checked={showMerged} onChange={(e) => setShowMerged((e.target as HTMLInputElement).checked)} />
          显示已进主线
        </label>
        <button class="btn small" onClick={() => setExpanded(() => (allOpen ? new Set() : new Set(model.rows.map((r) => r.key))))} title="星团 = 同一类型的分支收在一起">
          {allOpen ? "全部收起" : "全部展开"}
        </button>
        <button class="btn small" onClick={() => setSyncOpen(true)} title="在别处合并了分支？重新对账，把台账状态补上（先列出，你勾选后才写）">
          刚合并完？同步一下
        </button>
        <span class="galaxy-meta">
          {model.counts.branches} 颗分支星 · {model.rows.length} 个星团 · {model.counts.unbound} 颗没卡 · {model.counts.cards} 张功能卡
        </span>
      </div>
      <div class="galaxy-tools">
        <div class="filters" role="group" aria-label="筛选星点">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? model.all.length : model.all.filter((x) => filterHit(f.key, x)).length;
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
              <button class="pill" onClick={() => reveal(n.key)} title={`${n.repoLabel} · ${n.branch}`}>
                {short(n.label, 14)} · {ago(n.lastAt)}
              </button>
            ))}
          </span>
        ) : null}
      </div>

      <Legend />
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
            <linearGradient id="cluster-band" x1="0" x2="1">
              <stop offset="0%" stop-color="#8aa0ff" stop-opacity="0.02" />
              <stop offset="100%" stop-color="#8aa0ff" stop-opacity="0.14" />
            </linearGradient>
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

          {/* M8 类型行：左侧行头（点击展开 / 收起；拖星点到这里 = 改类型） + 展开行的底带 */}
          <g class="rows">
            {model.rows.map((r) => {
              const dim = filtering && !rowHit(r);
              const total = r.count;
              let acc = 0;
              return (
                <g class={`row${r.expanded ? " open" : ""}${dim ? " dim" : ""}${rowHL === r.key ? " hot" : ""}${dragging && !draggingPlanet && draggingType !== r.type ? " can" : ""}`}>
                  {r.expanded ? <rect x={model.xL - 4} y={r.y0} width={model.xR - model.xL + 30} height={r.y1 - r.y0} rx={12} class="row-band" /> : null}
                  <g class="row-head" onClick={() => toggleRow(r.key)} onPointerEnter={() => setHoverRow(r.key)} onPointerLeave={() => setHoverRow((h) => (h === r.key ? null : h))}>
                    <title>{`${r.type}：${r.count} 条分支。点一下${r.expanded ? "收起" : "展开"}；把星点拖到这里 = 改成「${r.type}」`}</title>
                    <rect x={14} y={r.y - 15} width={model.xL - 26} height={30} rx={9} class="row-head-bg" />
                    <text x={22} y={r.y + 1} class="row-name">
                      <tspan class="caret">{r.expanded ? "▾" : "▸"}</tspan>
                      <tspan class={`glyph c-${dominantOf(r)}`} dx={4}>
                        {r.glyph}
                      </tspan>
                      <tspan dx={5}>{r.type}</tspan>
                    </text>
                    <text x={model.xL - 18} y={r.y + 1} text-anchor="end" class="row-count">
                      {r.count}
                    </text>
                    {/* 状态分布条 */}
                    <g transform={`translate(22, ${r.y + 7})`}>
                      {(Object.keys(COLOR) as StarColor[]).map((c) => {
                        const n = r.colors[c] ?? 0;
                        if (!n) return null;
                        const w = ((model.xL - 52) * n) / total;
                        const x = acc;
                        acc += w;
                        return <rect x={x} y={0} width={Math.max(1.5, w - 1)} height={3} rx={1.5} fill={COLOR[c]} />;
                      })}
                    </g>
                  </g>
                </g>
              );
            })}
          </g>

          {/* 流线：星点 / 星团汇入主流 */}
          <g class="flows">
            {model.flows.map((f) => (
              <path d={f.d} class={`flow ${f.cls}${f.cluster ? " cf" : ""}${sel && sel !== f.node ? " dim" : ""}${hoverRow === f.node ? " hover" : ""}`} />
            ))}
          </g>

          {/* 星座线：功能卡 → 版本（收起的星团合成一条，越粗代表越多） */}
          <g class="links">
            {model.links.map((l) => (
              <path
                d={l.d}
                class={`link${sel === l.from || hoverPlanet === l.to || selPlanet === l.to || hoverRow === l.from ? " on" : ""}`}
                stroke={COLOR[l.color]}
                style={l.count && l.count > 1 ? { strokeWidth: `${Math.min(4, 0.8 + Math.log2(l.count))}px` } : undefined}
              />
            ))}
          </g>

          {/* 收起的星团：成员在时间轴上的小点 + 范围带 + 类型形状 + 说明 */}
          <g class="clusters">
            {model.rows.map((r) => {
              const c = r.cluster;
              if (!c) return null;
              const dim = filtering && !rowHit(r);
              return (
                <g
                  class={`cluster c-${c.color}${dim ? " dim" : ""}${hoverRow === r.key ? " hover" : ""}`}
                  onClick={() => toggleRow(r.key)}
                  onPointerEnter={() => setHoverRow(r.key)}
                  onPointerLeave={() => setHoverRow((h) => (h === r.key ? null : h))}
                >
                  <title>{`${r.type} · ${r.count} 条：点一下展开成星点`}</title>
                  <rect x={c.x0 - 12} y={r.y - 9} width={c.x1 - c.x0 + 24} height={18} rx={9} class="cluster-band" />
                  {c.dots.map((d) => (
                    <circle cx={d.x} cy={r.y + d.dy} r={2.3} fill={COLOR[d.color]} class="cluster-dot" />
                  ))}
                  <g transform={`translate(${c.x1}, ${r.y})`}>
                    {r.hasNewest ? <circle r={17} class="cluster-halo" /> : null}
                    <circle r={18} fill={`url(#star-${c.color})`} class="glow" />
                    <Shape type={r.type} r={9} fill={COLOR[c.color]} cls="cluster-core" />
                    <text y={3.5} text-anchor="middle" class="cluster-n">
                      {r.count}
                    </text>
                  </g>
                  {c.labelSide ? (
                    <text x={c.labelX} y={c.labelY} text-anchor={c.labelSide === "r" ? "start" : "end"} class={`cluster-label${r.hasNewest ? " newest" : ""}${c.labelSide === "b" ? " below" : ""}`}>
                      {c.labelText}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>

          {/* 版本行星（M8：拖到合流点 = 合并这一版，复制合并 Prompt） */}
          {model.planets.map((p) => (
            <g
              class={`planet${p.droppable ? " drop" : ""}${planetHL === p.key ? " hot" : ""}${related.has(p.key) || selPlanet === p.key ? " rel" : ""}${dragging && !draggingPlanet && p.droppable ? " can" : ""}${p.kind === "milestone" ? " grab" : ""}${drag?.planet?.key === p.key && dragging ? " lifted" : ""}`}
              transform={`translate(${p.x},${p.y})`}
              onPointerEnter={() => setHoverPlanet(p.key)}
              onPointerLeave={() => setHoverPlanet((h) => (h === p.key ? null : h))}
              onPointerDown={(e) => startPlanetDrag(p, e as unknown as PointerEvent)}
            >
              <title>{`${p.title}：还欠 ${p.owed} 项。把星点拖到这里 = 预约；${p.kind === "milestone" ? "把这颗行星拖到「合流点」= 合并这一版（复制合并 Prompt）；" : ""}点一下看详情。`}</title>
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
            <g class={`conf${confHL === c.key ? " hot" : ""}${dragging ? " can" : ""}${draggingPlanet ? " merge" : ""}`} transform={`translate(${c.x},${c.y})`}>
              <circle r={13} class="conf-ring" />
              <circle r={6} class="conf-core" />
              <text y={-20} text-anchor="middle" class="conf-label">
                {draggingPlanet ? "合流点 · 松手合并" : "合流点"}
              </text>
            </g>
          ))}

          {/* 星点（展开行里的分支 + 没分支的小卡星）：颜色 = 状态，形状 = 类型 */}
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
                  <title>{isB ? `${n.label}\n${n.type} · ${n.repoLabel} · ${n.branch}\n${STATE_TEXT[n.color]} · 最后提交 ${mdhm(n.lastAt)}` : `${n.card.id} ${n.card.title}（${n.type}，还没关联分支）`}</title>
                  {isB && n.recent ? <circle r={n.r + 9} class="halo" /> : null}
                  <circle r={n.r * 2.2} fill={`url(#star-${n.color})`} class="glow" />
                  <Shape type={n.type} r={n.r} fill={COLOR[n.color]} cls="core" />
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
              <line x1={drag.planet?.x ?? drag.node?.x ?? 0} y1={drag.planet?.y ?? drag.node?.y ?? 0} x2={drag.x} y2={drag.y} class={drag.target || drag.conf ? "ok" : ""} />
              <circle cx={drag.x} cy={drag.y} r={7} class={drag.target || drag.conf ? "ok" : ""} />
              <text x={drag.x + 12} y={drag.y - 10} class="drag-tip">
                {drag.planet
                  ? drag.conf
                    ? `松手：合并 ${drag.planet.title}（复制合并 Prompt，不执行合并）`
                    : "拖到「合流点」= 合并这一版"
                  : drag.node && drag.target
                    ? dropText(drag.node, drag.target)
                    : "拖到行星 / 小卡星 / 合流点 / 左侧类型行"}
              </text>
            </g>
          ) : null}
        </svg>
      </div>

      <p class="galaxy-hint">
        点左侧类型行或星团 = 展开 / 收起 · 拖星点到版本行星 = 改预约（没卡会自动建卡）· 拖到小卡星 = 绑定分支 · 拖到左侧类型行 = 改类型 · 拖到「合流点」= 排进合并单并入 · <b>拖版本行星到「合流点」= 合并这一版</b>：复制合并 Prompt，真正合并仍在终端输入 yes
      </p>

      {selNode ? <Detail node={selNode} model={model} busy={busy} modules={modules} onClose={() => setSel(null)} onDrop={(t) => void drop(selNode, t)} onClassify={(patch) => void classifyNode(selNode, patch)} /> : null}
      {selP && !selNode ? <PlanetDetail p={selP} busy={busy} onClose={() => setSelPlanet(null)} onMerge={() => mergeVersion(selP)} onSync={() => setSyncOpen(true)} /> : null}
      {decision ? <DecisionPanel d={decision.d} prompt={decision.prompt} root={projects.heliuRoot} onClose={() => setDecision(null)} /> : null}
      {mergeP && !decision ? <MergePromptPanel st={mergeP.st} title={mergeP.title} onClose={() => setMergeP(null)} onSync={() => { setMergeP(null); setSyncOpen(true); }} /> : null}
      {syncOpen ? <MergedPanel onClose={() => setSyncOpen(false)} onChanged={onChanged} /> : null}
      {toast ? <div class="toast">{toast}</div> : null}
    </div>
  );
}

/** 行头的形状用哪种颜色：最需要人的状态优先 */
function dominantOf(r: GRow): StarColor {
  for (const c of ["purple", "red", "yellow", "green", "blue", "gray"] as StarColor[]) if ((r.colors[c] ?? 0) > 0) return c;
  return "gray";
}

/** 结构页跳过来时地址是 #/galaxy/focus/<key> */
function focusFromHash(): string | null {
  const m = /^#\/?galaxy\/focus\/(.+)$/.exec(location.hash);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
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
  if (t.kind === "row") return `松手：类型改成「${t.row.type}」${hasCard ? "" : "（会建卡）"}`;
  return `松手：排进合并单「并入」并复制合并 Prompt（不执行合并）`;
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
      <span class="sep">形状 = 类型：</span>
      {FEATURE_TYPES.map((t) => (
        <span class="shape-i">
          <b>{TYPE_GLYPH[t]}</b>
          {t}
        </span>
      ))}
      <span>
        <i class="halo-i" />
        最新（呼吸光晕）
      </span>
      <span>星团 = 同一类分支收在一起，数字是条数、小点是每条的时间</span>
      <span>虚线 = 还没并进集成分支；亮实线 = 已汇入</span>
    </div>
  );
}

function Detail({
  node,
  model,
  busy,
  modules,
  onClose,
  onDrop,
  onClassify,
}: {
  node: GNode;
  model: GalaxyModel;
  busy: boolean;
  modules: Array<{ name: string; keywords: string[] }>;
  onClose: () => void;
  onDrop: (t: DropTarget) => void;
  onClassify: (patch: { type?: string | null; module?: string | null }) => void;
}) {
  const card = node.kind === "card" ? node.card : node.card;
  // 模块：卡片上的（用户定的 / 服务端推测的）；没卡的分支按同一套词典在这里推测
  const guessModule = card ? card.module : inferModule(classifyText([node.kind === "branch" ? node.label : "", node.kind === "branch" ? node.sessionTitle : null, node.kind === "branch" ? node.branch : null]), modules.length ? modules : undefined);
  const moduleNames = [...new Set([...modules.map((m) => m.name), OTHER_MODULE, guessModule])];
  const typeFixed = card?.typeSource === "card";
  const moduleFixed = card?.moduleSource === "card";
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
      <div class="classify small">
        <label>
          类型
          <select
            disabled={busy}
            value={typeFixed ? node.type : ""}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              onClassify({ type: v || null });
            }}
          >
            <option value="">{typeFixed ? "按推测（取消手动）" : `${TYPE_GLYPH[node.type]} ${node.type}（推测）`}</option>
            {FEATURE_TYPES.map((t) => (
              <option value={t}>{`${TYPE_GLYPH[t]} ${t}`}</option>
            ))}
          </select>
        </label>
        <label>
          模块
          <select
            disabled={busy}
            value={moduleFixed ? (card?.module ?? "") : ""}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              onClassify({ module: v || null });
            }}
          >
            <option value="">{moduleFixed ? "按推测（取消手动）" : `${guessModule}（推测）`}</option>
            {moduleNames.map((m) => (
              <option value={m}>{m}</option>
            ))}
          </select>
        </label>
        {!card ? <span class="muted">改了会顺手建卡</span> : null}
      </div>
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
          <button class="btn" disabled={busy} onClick={() => onDrop({ kind: "confluence", conf })} title="排进合并单「并入」，并复制这一版的合并 Prompt（不执行合并）">
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

function DecisionPanel({ d, prompt, root, onClose }: { d: ReleaseDecisionResult; prompt: PromptState; root: string; onClose: () => void }) {
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
            {i.detail ? ` · ${i.decision === "并入" ? i.detail.replace(/或把决定改成「并入」/g, "").replace(/（\s*）/g, "") : i.detail}` : ""}
          </li>
        ))}
      </ul>
      {prompt.data || prompt.error ? (
        <PromptBlock st={prompt} />
      ) : (
        <>
          <p class="small">真正合并：在终端执行下面这条，看完摘要输入 yes 才开始，可以回滚。</p>
          <p>
            <code>{cmd}</code>{" "}
            <button class="btn" onClick={() => void copyText(cmd)}>
              复制
            </button>
          </p>
        </>
      )}
      <p class="explain">合并单：{d.file}</p>
    </aside>
  );
}

/** M8：点版本行星看到的详情——合并这一版（复制 Prompt）、合并后同步 */
function PlanetDetail({ p, busy, onClose, onMerge, onSync }: { p: GPlanet; busy: boolean; onClose: () => void; onMerge: () => void; onSync: () => void }) {
  return (
    <aside class="detail">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>
        {p.title}
        {p.isNext ? <span class="badge next">下一版</span> : null}
      </h3>
      <p class="small">
        {p.kind === "released" ? "已发布" : p.kind === "unreserved" ? `还没预约到任何版本的功能：${p.owed} 项` : `还欠 ${p.owed} 项`}
        {p.waiting ? ` · 等你 ${p.waiting}` : ""}
        {p.conflict ? ` · 有冲突 ${p.conflict}` : ""}
      </p>
      {p.kind === "milestone" ? (
        <>
          <div class="row-actions">
            <button class="btn primary" disabled={busy} onClick={onMerge}>
              合并这一版（复制 Prompt）
            </button>
            <button class="btn" onClick={onSync}>
              刚合并完？同步一下
            </button>
          </div>
          <p class="explain">也可以直接把这颗行星拖到「合流点」。复制的 Prompt 只让 Claude 预演并讲清楚，真正合并在终端输入 yes 才开始。</p>
        </>
      ) : (
        <p class="explain">把星点拖到这里可以改预约。</p>
      )}
    </aside>
  );
}
