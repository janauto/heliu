/** @jsxImportSource preact */
/**
 * 时间线（M10，甘特 / WBS）：左栏 = 仓库 → 模块 → 方块的树，右侧 = 时间轴；每一块画一条「活跃区间」。
 * - 布局全部来自 web/timeline-model.ts（纯函数，有测试）；这里只渲染、管折叠 / 筛选 / 拖放。
 * - 颜色只读服务端 card.light；没卡的分支固定蓝「还没登记」。起点是近似的条画虚线边并在提示里写明，不假装精确。
 * - 拖条（或左栏方块）到上面的版本芯片 = 预约（PATCH /api/features/:id）；没卡的分支 = 登记成卡并预约（POST /api/features）；
 *   拖卡到左栏的模块行 = 改模块。只写台账，不碰 git；每次松手 toast 说明写了什么，改卡的给「撤销」。
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BoardCard } from "../../src/board/api-types.ts";
import { OTHER_MODULE } from "../../src/core/classify.ts";
import type { FeatureView, LedgerMilestone } from "../../src/types.ts";
import { milestoneLabel, useApp } from "../app.tsx";
import { dragProps, useDropTarget, type DragPayload } from "../dnd.ts";
import { api, mdhm, store } from "../lib.ts";
import {
  RANGES,
  axisWidth,
  buildTimeline,
  countByTone,
  flattenRows,
  isRange,
  mmdd,
  moduleKey,
  parseDay,
  repoKey,
  todayScrollLeft,
  withCardPatch,
  type TLItem,
  type TLModuleNode,
  type TLRange,
  type TLRepoNode,
  type TLRow,
  type TLTone,
} from "../timeline-model.ts";
import { Bar, Block, Empty, HUMAN, Icon, MILESTONE_TONE, PageHead, Pill, Seg, matchQuery, modelOfBranch, modelOfCard, type BarPart, type BlockModel, type Tone } from "../ui.tsx";

const RANGE_KEY = "heliu.tl.range";
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);

type Filter = "all" | TLTone;
const FILTERS: Array<{ key: Filter; label: string; tone?: Tone }> = [
  { key: "all", label: "全部" },
  { key: "purple", label: HUMAN.purple, tone: "purple" },
  { key: "red", label: HUMAN.red, tone: "red" },
  { key: "green", label: HUMAN.green, tone: "green" },
  { key: "yellow", label: HUMAN.yellow, tone: "yellow" },
  { key: "blue", label: HUMAN.blue, tone: "blue" },
];
/** 模块行分布条的颜色顺序（最需要人的在前） */
const TONE_ORDER: TLTone[] = ["purple", "red", "yellow", "green", "gray", "blue"];

/** 没卡的分支被拖起时带的数据：登记成卡要用 */
interface BranchDrag {
  repo: string;
  repoLabel: string;
  branch: FeatureView;
  title: string;
  type: string;
  module: string;
}
type CardPatch = Partial<Pick<BoardCard, "module" | "moduleSource" | "milestone" | "column">>;

export function TimelineView() {
  const app = useApp();
  const [range, setRangeState] = useState<TLRange>(() => {
    const v = store.get(RANGE_KEY);
    return isRange(v) ? v : "1m";
  });
  const setRange = (r: TLRange) => {
    store.set(RANGE_KEY, r);
    setRangeState(r);
  };
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [hover, setHover] = useState<string | null>(null);

  /* 乐观更新：松手后先按新值画，数据刷新后丢掉；请求失败也丢掉（= 回滚） */
  const [over, setOver] = useState<Record<string, CardPatch>>({});
  useEffect(() => setOver({}), [app.features]);
  const feats = useMemo(() => Object.entries(over).reduce((f, [id, p]) => withCardPatch(f, id, p), app.features), [app.features, over]);

  /* 时间轴宽度：量可视区，范围短时每天更宽、放不下就横向滚动 */
  const bodyRef = useRef<HTMLDivElement>(null);
  const cornerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(0);
  const leftW = () => cornerRef.current?.offsetWidth ?? 260;

  const now = useMemo(() => new Date(), [app.tick, app.status, app.features]);
  const width = axisWidth(range, Math.max(320, (visible || 1100) - leftW()), now);
  const model = useMemo(
    () => buildTimeline(app.status, feats, { now, range, width, modules: feats?.modules, milestones: app.milestones.length ? app.milestones : undefined }),
    [app.status, feats, now, range, width, app.milestones],
  );
  const nothing = !model.items.length && !model.counts.entries && !model.tree.some((n) => n.error);
  const hasBody = !!app.project && !!app.features && !nothing;
  useEffect(() => {
    const el = bodyRef.current;
    if (!hasBody || !el) return;
    const measure = () => setVisible(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasBody]);

  /* 方块模型：页面现算（与看板 / 详情同一个 modelOfCard / modelOfBranch） */
  const blocks = useMemo(() => {
    const out = new Map<string, BlockModel>();
    for (const it of model.items) {
      if (it.card) out.set(it.key, modelOfCard(it.card, { next: app.next }));
      else if (it.branch) out.set(it.key, modelOfBranch(it.branch, { id: it.repo, label: it.repoLabel }, feats?.modules));
    }
    return out;
  }, [model, app.next]);

  /* 搜索（标题栏）+ 颜色筛选 */
  const q = app.query.trim();
  const byQuery = (it: TLItem) =>
    matchQuery(q, it.title, it.card?.id, it.repoLabel, it.module, it.branch?.branch, ...(it.card?.bindings.map((b) => b.branch) ?? []), ...(it.card?.bindings.map((b) => b.label) ?? []));
  const queried = q ? model.items.filter(byQuery) : model.items;
  const tones = countByTone(queried);
  const filtering = !!q || filter !== "all";
  const keep = filtering ? (it: TLItem) => (filter === "all" || it.tone === filter) && byQuery(it) : undefined;
  const flat = useMemo(() => flattenRows(model.tree, { collapsed, keep }), [model, collapsed, q, filter]);

  /* 回到今天：今天落在可视时间轴 80% 处 */
  const toToday = (smooth: boolean) => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ left: todayScrollLeft(model.todayX, el.clientWidth, leftW()), behavior: smooth ? "smooth" : "auto" });
  };
  // 第一次量到宽度、或换了范围：把今天放到 80% 处；同一范围里的数据刷新不动用户的滚动位置
  const scrolledFor = useRef<TLRange | null>(null);
  useEffect(() => {
    if (!visible || !hasBody || scrolledFor.current === range) return;
    scrolledFor.current = range;
    toToday(false);
  }, [range, visible, hasBody]);

  /* 深链 #/timeline/F-0041：展开所在组、滚到那一行、选中 */
  const linked = useRef<string | null>(null);
  useEffect(() => {
    const sub = app.sub;
    if (!sub || linked.current === sub) return;
    const it = model.items.find((x) => x.key === sub || x.card?.id === sub);
    if (!it) return;
    linked.current = sub;
    setFilter("all");
    setCollapsed((s) => {
      const n = new Set(s);
      n.delete(repoKey(it.repo));
      n.delete(moduleKey(it.repo, it.module));
      return n;
    });
    // 等两帧再选中：切页时外壳会先清空选中（main.tsx 的 [tab] effect 在子组件之后跑）
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        pick(it);
        const row = bodyRef.current?.querySelector(`[data-row="${CSS.escape(it.key)}"]`) as HTMLElement | null;
        row?.scrollIntoView({ block: "center" });
        const el = bodyRef.current;
        if (el) el.scrollTo({ left: Math.max(0, it.x1 - (el.clientWidth - leftW()) * 0.6) });
      }),
    );
  }, [app.sub, model]);

  const toggle = (key: string) =>
    setCollapsed((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  /* 选中 */
  const selKey = app.selected ? (app.selected.kind === "card" ? app.selected.card.id : `${app.selected.repo}|${app.selected.branch.branch}`) : null;
  const pick = (it: TLItem) => {
    if (it.card) app.select({ kind: "card", card: it.card });
    else if (it.branch) app.select({ kind: "branch", repo: it.repo, repoLabel: it.repoLabel, branch: it.branch, main: it.main ?? "", integration: it.integration });
  };
  const payloadOf = (it: TLItem): DragPayload | null => {
    if (it.card) return { kind: "card", id: it.card.id, label: it.card.id, data: it.card };
    if (!it.branch) return null;
    const m = blocks.get(it.key);
    const data: BranchDrag = { repo: it.repo, repoLabel: it.repoLabel, branch: it.branch, title: it.title, type: m?.type ?? "功能", module: m?.module ?? it.module };
    return { kind: "branch", id: it.key, label: it.title, data };
  };

  /* 写台账：改卡（乐观 + 撤销）/ 从分支建卡 */
  const patchCard = async (card: BoardCard, body: Record<string, unknown>, optimistic: CardPatch, okText: string, undo: { body: Record<string, unknown>; text: string }) => {
    setOver((o) => ({ ...o, [card.id]: { ...o[card.id], ...optimistic } }));
    try {
      await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body });
      app.toast(okText, {
        undo: async () => {
          try {
            await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body: undo.body });
            app.toast(`已撤销：${card.id} ${undo.text}`);
          } catch (e) {
            app.toast(`没撤销成：${msg(e)}`, { kind: "err" });
          } finally {
            app.reloadFeatures();
            app.refresh();
          }
        },
      });
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      setOver((o) => {
        const n = { ...o };
        delete n[card.id];
        return n;
      });
      app.toast(`没改成：${msg(e)}`, { kind: "err" });
    }
  };
  const reserve = (card: BoardCard, ms: LedgerMilestone) => {
    const name = milestoneLabel(ms.id, app.milestones, app.next);
    // 原值（撤销用）：与详情面板同一口径
    const back = card.milestone === "next" ? (app.next ?? null) : card.column === "__unreserved" ? null : card.milestone;
    const backName = back ? milestoneLabel(back, app.milestones, app.next) : "未预约";
    void patchCard(card, { milestone: ms.id }, { milestone: ms.id, column: ms.id }, `${card.id} → ${name}（已写入台账）`, { body: { milestone: back }, text: `改回${backName}` });
  };
  const register = async (b: BranchDrag, ms: LedgerMilestone) => {
    const name = milestoneLabel(ms.id, app.milestones, app.next);
    try {
      const r = await api<{ feature: { id: string; title: string }; milestoneCreated: string | null }>("/api/features", {
        body: { title: b.title, milestone: ms.id, bind: { repo: b.repo, branch: b.branch.branch }, type: b.type, module: b.module },
      });
      app.toast(`已登记 ${r.data.feature.id}「${r.data.feature.title}」，预约到 ${name}（已写入台账；可在详情里改预约）`);
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      app.toast(`没登记成：${msg(e)}`, { kind: "err" });
    }
  };
  const moveModule = (card: BoardCard, module: string) => {
    const back = card.moduleSource === "card" ? card.module : null;
    void patchCard(card, { module }, { module, moduleSource: "card" }, `${card.id} 模块 → ${module}（已写入台账）`, { body: { module: back }, text: `模块改回${back ?? "推测"}` });
  };

  /* ───────────── 渲染 ───────────── */

  const head = (
    <PageHead icon="timeline" title="时间线" desc="每一块什么时候在动、里程碑在哪；把条拖到上面的版本芯片 = 预约。">
      <Seg options={RANGES.map((r) => ({ value: r.value, label: r.label }))} value={range} onChange={setRange} />
      <button class="btn small" onClick={() => toToday(true)} title="把今天放回时间轴右侧">
        <Icon name="calendar" size={15} />
        回到今天
      </button>
    </PageHead>
  );

  if (!app.project) {
    return (
      <div class="page wide tl-page">
        {head}
        <Empty icon="start" title="还没有选项目" hint="先在「开始」里接入或选择一个项目。">
          <button class="btn primary" onClick={() => app.go("start")}>
            去「开始」
          </button>
        </Empty>
      </div>
    );
  }
  if (!app.features && app.featuresError) {
    return (
      <div class="page wide tl-page">
        {head}
        <div class="err">功能卡没拿到：{app.featuresError}</div>
      </div>
    );
  }
  if (!app.features) {
    return (
      <div class="page wide tl-page">
        {head}
        <div class="tl-skeleton" aria-busy="true" aria-label="正在加载时间线">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div class="tl-sk-row">
              <span class="skeleton" style={`width:${i % 3 === 0 ? 140 : 200}px`} />
              <span class="skeleton" style={`margin-left:${60 + ((i * 97) % 300)}px;width:${120 + ((i * 53) % 220)}px`} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  const chips = app.milestones.filter((m) => m.status !== "已发布");
  const inWindowMs = model.milestones.filter((m) => m.inWindow);
  const W = model.width;

  return (
    <div class="page wide tl-page">
      {head}

      <div class="tl-toolbar">
        <div class="fchips" role="group" aria-label="按状态筛选">
          {FILTERS.map((f) => {
            const n = f.key === "all" ? queried.length : (tones[f.key] ?? 0);
            return (
              <button class={`fchip${filter === f.key ? " on" : ""}${f.tone ? ` tone-${f.tone}` : ""}`} disabled={f.key !== "all" && !n && filter !== f.key} onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}>
                {f.label} <b>{n}</b>
              </button>
            );
          })}
        </div>
        {!app.status ? (
          <span class="tl-note">{app.statusError ? `分支数据没拿到（${app.statusError}）：先只画功能卡` : "分支数据还在加载：先画功能卡"}</span>
        ) : null}
      </div>

      <div class="tl-ms-chips" aria-label="版本芯片：把条拖上来 = 预约">
        <span class="tl-ms-lead">
          <Icon name="arrow" size={14} />
          拖到版本上 = 预约
        </span>
        {chips.length ? (
          chips.map((m) => <VersionChip key={m.id} ms={m} onReserve={reserve} onRegister={register} onLocate={(x) => locate(bodyRef.current, x, leftW())} line={model.milestones.find((l) => l.id === m.id) ?? null} />)
        ) : (
          <span class="muted small">还没有未发布的版本：在看板里新建一个版本后就能拖上来预约。</span>
        )}
      </div>

      {nothing ? (
        <Empty icon="timeline" title="还没有可以画的方块" hint="登记一张功能卡，或在被管理的仓库里开一条分支，它就会出现在这里。" />
      ) : (
        <>
          <div class="tl-body" ref={bodyRef} onPointerLeave={() => setHover(null)}>
            <div class="tl-grid" style={`width:calc(var(--tl-left) + ${W}px)`}>
              <div class="tl-head">
                <div class="tl-corner" ref={cornerRef}>
                  <span>
                    WBS · <b>{flat.shown}</b> 块
                  </span>
                  <button
                    class="btn ghost xs"
                    onClick={() => setCollapsed((s) => (s.size ? new Set() : new Set(model.tree.map((n) => repoKey(n.repo)))))}
                    title={collapsed.size ? "全部展开" : "全部收起"}
                  >
                    {collapsed.size ? "全部展开" : "全部收起"}
                  </button>
                </div>
                <div class="tl-scale" style={`width:${W}px`}>
                  {model.ticks.map((t) =>
                    t.kind === "today" ? (
                      <span class="tl-tick today" style={`left:${t.x}px`}>
                        今天
                      </span>
                    ) : t.label ? (
                      <span class={`tl-tick${t.major ? " major" : ""}`} style={`left:${t.x}px`} title={mdhm(new Date(t.t).toISOString())}>
                        {t.label}
                      </span>
                    ) : null,
                  )}
                  {inWindowMs.map((m) => (
                    <span class="tl-ms-label" style={`left:${Math.max(36, Math.min(W - 36, m.x))}px`} title={`${m.id}${m.title !== m.id ? ` ${m.title}` : ""} · 目标日期 ${mmdd(m.date.getTime())} · ${m.status}`}>
                      <Pill tone={MILESTONE_TONE[m.status] ?? "accent"}>
                        {m.id} · {mmdd(m.date.getTime())}
                      </Pill>
                    </span>
                  ))}
                </div>
              </div>

              <div class="tl-rows" style={flat.rows.length ? `height:${flat.height}px` : undefined}>
                <div class="tl-lines" style={`width:${W}px;height:${Math.max(flat.height, 120)}px`} aria-hidden="true">
                  {model.ticks.map((t) => (t.kind === "today" ? null : <i class={`tl-gridline${t.major ? " major" : ""}`} style={`left:${t.x}px`} />))}
                  {inWindowMs.map((m) => (
                    <i class={`tl-ms tone-${MILESTONE_TONE[m.status] ?? "accent"}`} style={`left:${m.x}px`} />
                  ))}
                  {model.todayX >= 0 && model.todayX <= W ? <i class="tl-today" style={`left:${model.todayX}px`} /> : null}
                </div>
                {flat.rows.length ? (
                  flat.rows.map((r) => (
                    <Row
                      key={r.key}
                      r={r}
                      width={W}
                      hover={hover === r.key}
                      onHover={setHover}
                      selKey={selKey}
                      blocks={blocks}
                      onToggle={toggle}
                      onPick={pick}
                      payloadOf={payloadOf}
                      onModuleDrop={moveModule}
                      onSessions={() => app.go("sessions")}
                    />
                  ))
                ) : (
                  <div class="tl-none">
                    <Empty inline icon="filter" title="没有符合筛选的方块" hint={q ? `搜索「${q}」` : undefined}>
                      <button
                        class="btn small"
                        onClick={() => {
                          setFilter("all");
                          app.setQuery("");
                        }}
                      >
                        清除筛选
                      </button>
                    </Empty>
                  </div>
                )}
              </div>
            </div>
          </div>
          <p class="tl-legend">
            <span>
              <i class="lg-bar" />条 = 从最早到最后一次可见活动
            </span>
            <span>
              <i class="lg-bar approx" />虚线边 = 起点为近似（最早可见活动）
            </span>
            <span>
              <i class="lg-dot" />只有一个时间点
            </span>
            <span>
              <i class="lg-dot hollow" />还没有活动记录（画在现在）
            </span>
            <span>
              <b>←</b> 起点或最后活动早于时间窗
            </span>
            <span>
              <i class="lg-ms" />版本目标日期
            </span>
          </p>
        </>
      )}
    </div>
  );
}

/** 点版本芯片：把它的目标日期线滚进可视区 */
function locate(el: HTMLDivElement | null, x: number, left: number) {
  if (!el) return;
  el.scrollTo({ left: Math.max(0, x - (el.clientWidth - left) / 2), behavior: "smooth" });
}

/* ───────────── 版本芯片（落点） ───────────── */

const targetOf = (ms: LedgerMilestone): number | null => parseDay(ms.target_date);

function VersionChip({
  ms,
  line,
  onReserve,
  onRegister,
  onLocate,
}: {
  ms: LedgerMilestone;
  line: { x: number; inWindow: boolean } | null;
  onReserve: (c: BoardCard, ms: LedgerMilestone) => void;
  onRegister: (b: BranchDrag, ms: LedgerMilestone) => Promise<void>;
  onLocate: (x: number) => void;
}) {
  const app = useApp();
  const name = milestoneLabel(ms.id, app.milestones, app.next);
  const col = app.features?.columns.find((c) => c.key === ms.id) ?? null;
  const blocked = col && !col.droppable ? (col.dropHint ?? `${name} 现在不能再预约（${ms.status}）`) : null;
  const ref = useDropTarget({
    canDrop: (p) => {
      if (p.kind === "card") {
        const c = p.data as BoardCard;
        if (c.column === ms.id || (c.milestone === "next" && app.next === ms.id)) return { ok: false, hint: "已经在这一版" };
        if (c.done) return { ok: false, hint: "已完成的卡不再改预约" };
        if (blocked) return { ok: false, hint: blocked };
        return { ok: true, hint: `放到这里：预约到 ${name}` };
      }
      if (p.kind === "branch") {
        if (blocked) return { ok: false, hint: blocked };
        return { ok: true, hint: `放到这里：登记成功能卡并预约到 ${name}` };
      }
      return null;
    },
    onDrop: (p) => {
      if (p.kind === "card") onReserve(p.data as BoardCard, ms);
      else if (p.kind === "branch") return onRegister(p.data as BranchDrag, ms);
    },
  });
  const isNext = app.next === ms.id;
  return (
    <div
      class={`tl-chip${isNext ? " next" : ""}`}
      ref={ref}
      role="button"
      tabIndex={0}
      title={`${name} · ${ms.status}${ms.target_date ? ` · 目标日期 ${ms.target_date}` : " · 还没定目标日期"}${line && !line.inWindow ? "（不在当前时间窗里）" : ""}`}
      onClick={() => line && line.inWindow && onLocate(line.x)}
      onKeyDown={(e) => {
        if ((e.key === "Enter" || e.key === " ") && line && line.inWindow) {
          e.preventDefault();
          onLocate(line.x);
        }
      }}
    >
      <b class="name">{name}</b>
      <Pill tone={MILESTONE_TONE[ms.status] ?? "gray"}>{isNext ? "下一版" : ms.status}</Pill>
      <span class="meta">
        {targetOf(ms) !== null ? `目标 ${mmdd(targetOf(ms)!)}` : "没定日期"}
        {col ? ` · 还欠 ${col.owed}` : ""}
      </span>
    </div>
  );
}

/* ───────────── 一行（左栏 + 时间轴，同一个 DOM 行 = 天然对齐） ───────────── */

interface RowProps {
  r: TLRow;
  width: number;
  hover: boolean;
  onHover: (k: string | null) => void;
  selKey: string | null;
  blocks: Map<string, BlockModel>;
  onToggle: (key: string) => void;
  onPick: (it: TLItem) => void;
  payloadOf: (it: TLItem) => DragPayload | null;
  onModuleDrop: (c: BoardCard, module: string) => void;
  onSessions: () => void;
}

function Row(p: RowProps) {
  const { r } = p;
  const cls = [`tl-row`, `k-${r.kind}`];
  if (p.hover) cls.push("hover");
  if (r.kind === "item" && p.selKey === r.item.key) cls.push("selected");
  return (
    <div class={cls.join(" ")} style={`height:${r.h}px`} data-row={r.key} onPointerEnter={() => p.onHover(r.key)}>
      {r.kind === "repo" ? <RepoHead r={r} onToggle={p.onToggle} /> : null}
      {r.kind === "module" ? <ModuleHead r={r} onToggle={p.onToggle} onDrop={p.onModuleDrop} /> : null}
      {r.kind === "entries" ? (
        <div class="tl-left tl-entries" title="这些分支没有自己的提交（多半只是桌面会话的入口），不画成工作条">
          <span class="glyph">◌</span>
          <span class="name">会话入口 {r.count}</span>
          {r.waiting ? <Pill tone="purple">等你 {r.waiting}</Pill> : null}
          <button class="link small" onClick={p.onSessions}>
            看会话
          </button>
        </div>
      ) : null}
      {r.kind === "item" ? <ItemLeft it={r.item} m={p.blocks.get(r.item.key)} selected={p.selKey === r.item.key} onPick={p.onPick} payloadOf={p.payloadOf} /> : null}
      <div class="tl-right" style={`width:${p.width}px`}>
        {r.kind === "item" ? <Track it={r.item} m={p.blocks.get(r.item.key)} selected={p.selKey === r.item.key} onPick={p.onPick} payloadOf={p.payloadOf} width={p.width} /> : null}
        {r.kind === "module" || (r.kind === "repo" && !r.open) ? <Summary items={r.items} /> : null}
      </div>
    </div>
  );
}

function RepoHead({ r, onToggle }: { r: Extract<TLRow, { kind: "repo" }>; onToggle: (k: string) => void }) {
  const n: TLRepoNode = r.node;
  return (
    <div class="tl-left tl-repo">
      <button class={`tl-toggle${r.open ? "" : " closed"}`} onClick={() => onToggle(r.key)} aria-expanded={r.open} disabled={!!n.error} title={n.error ? undefined : r.open ? "收起" : "展开"}>
        <Icon name="chevron" size={14} class="chev" />
        <Icon name={n.pseudo ? "info" : "folder"} size={15} />
        <span class="name">{n.label}</span>
      </button>
      {n.error ? (
        <span class="tl-err" title={n.error}>
          不可达：{n.error}
        </span>
      ) : (
        <span class="badge">{r.count} 块</span>
      )}
    </div>
  );
}

function ModuleHead({ r, onToggle, onDrop }: { r: Extract<TLRow, { kind: "module" }>; onToggle: (k: string) => void; onDrop: (c: BoardCard, module: string) => void }) {
  const m: TLModuleNode = r.node;
  const ref = useDropTarget({
    canDrop: (p) => {
      if (p.kind !== "card") return null;
      const c = p.data as BoardCard;
      if (c.done) return null;
      if ((c.module || OTHER_MODULE) === m.module) return { ok: false, hint: "已经在这个模块" };
      return { ok: true, hint: `放到这里：模块改成「${m.module}」` };
    },
    onDrop: (p) => onDrop(p.data as BoardCard, m.module),
  });
  const parts: BarPart[] = TONE_ORDER.map((t) => ({ tone: t, n: r.tones[t] ?? 0, label: HUMAN[t] }));
  return (
    <div class="tl-left tl-module" ref={ref}>
      <button class={`tl-toggle${r.open ? "" : " closed"}`} onClick={() => onToggle(r.key)} aria-expanded={r.open} title={`模块：${m.module}（把功能卡拖到这里 = 改模块）`}>
        <Icon name="chevron" size={13} class="chev" />
        <span class="name">{m.module}</span>
        <span class="n">{r.count}</span>
      </button>
      <span class="tl-mbar">
        <Bar thin parts={parts} />
      </span>
    </div>
  );
}

function tipOf(it: TLItem, m: BlockModel | undefined): string {
  const lines = [it.title];
  if (m) lines.push(`${m.human}${m.fact ? `：${m.fact}` : ""}`);
  const startText = it.start ? `${it.startKind === "created" ? "创建" : "约"} ${mdhm(it.start.toISOString())}` : "没有起点";
  if (it.endKind === "none") lines.push("还没有可见活动：画在现在");
  else if (it.shape === "dot") lines.push(`只有一个时间点：${mdhm(it.end.toISOString())}`);
  else lines.push(`${startText} → ${mdhm(it.end.toISOString())}`);
  if (it.startKind === "approx" && it.shape === "bar") lines.push("起点为近似（最早可见活动）");
  if (it.outside) lines.push(`最后活动 ${mdhm(it.end.toISOString())}，早于时间窗`);
  else if (it.clippedLeft) lines.push("起点早于时间窗：从窗左边起画");
  return lines.join("\n");
}

function ItemLeft({ it, m, selected, onPick, payloadOf }: { it: TLItem; m: BlockModel | undefined; selected: boolean; onPick: (it: TLItem) => void; payloadOf: (it: TLItem) => DragPayload | null }) {
  if (!m) return <div class="tl-left tl-item" />;
  return (
    <div class="tl-left tl-item">
      <Block m={m} density="compact" selected={selected} onClick={() => onPick(it)} drag={{ payload: () => payloadOf(it) }} title={tipOf(it, m)} />
    </div>
  );
}

function Track({ it, m, selected, onPick, payloadOf, width }: { it: TLItem; m: BlockModel | undefined; selected: boolean; onPick: (it: TLItem) => void; payloadOf: (it: TLItem) => DragPayload | null; width: number }) {
  const tip = tipOf(it, m);
  const tone = it.tone;
  const common = {
    title: tip,
    role: "button" as const,
    tabIndex: -1,
    onClick: () => onPick(it),
    ...dragProps(() => payloadOf(it)),
  };
  if (it.outside) {
    return (
      <div class={`tl-stub tone-${tone}${selected ? " selected" : ""}`} {...common}>
        <i class="dot" />← {mmdd(it.end.getTime())}
      </div>
    );
  }
  if (it.shape === "dot") {
    const labelRoom = width - it.x1 > 140;
    return (
      <>
        <div class={`tl-dot tone-${tone}${it.endKind === "none" ? " hollow" : ""}${selected ? " selected" : ""}`} style={`left:${it.x1}px`} {...common} />
        {labelRoom ? (
          <span class="tl-dot-label" style={`left:${it.x1 + 12}px`}>
            {it.title}
          </span>
        ) : null}
      </>
    );
  }
  const w = Math.max(10, it.x1 - it.x0);
  const cls = ["tl-bar", `tone-${tone}`];
  if (it.startKind === "approx") cls.push("approx");
  if (it.clippedLeft) cls.push("clipped");
  if (selected) cls.push("selected");
  return (
    <div class={cls.join(" ")} style={`left:${it.x0}px;width:${w}px`} {...common}>
      {it.clippedLeft ? <span class="tl-clip">←</span> : null}
      {w >= 60 ? <span class="tl-bar-title">{m?.title ?? it.title}</span> : null}
    </div>
  );
}

/** 组行上的摘要条：组内条目在时间窗里的范围（淡色细条） */
function Summary({ items }: { items: TLItem[] }) {
  const inside = items.filter((i) => !i.outside);
  if (!inside.length) return null;
  const x0 = Math.min(...inside.map((i) => i.x0));
  const x1 = Math.max(...inside.map((i) => i.x1));
  return <i class="tl-summary" style={`left:${x0}px;width:${Math.max(6, x1 - x0)}px`} />;
}
