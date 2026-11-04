/** @jsxImportSource preact */
/**
 * 看板（M10，替代旧「版本列」）：一列一个版本（里程碑按 milestones.yaml 顺序 + 未预约 + 已发布），列里是方块。
 * - 拖方块到别的列 = 改预约（PATCH /api/features/:id，只写台账）：先乐观更新（本地覆盖层），失败回滚；toast 带撤销。
 * - 列内按待办分组（等你拍板 → 撞了 → 能拼上 → 要先对齐 → 还在做 → 没动静 → 还没绑分支），已合入 / 已发布放最后；
 *   默认只展开前两个非空组，折叠状态按列记在 localStorage。
 * - 灯色、分组、列头计数一律来自服务端（card.light / card.group / 列头字段）；前端只做加总，不自己判断 git 事实。
 * - 看板只写台账与合并单（复制合并 Prompt 会刷新合并单），不执行任何 git 合并。
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BoardCard, BoardColumn, CodexTask, CodexTasksData, MergePromptData } from "../../src/board/api-types.ts";
import type { TodoGroupKey } from "../../src/types.ts";
import { useApp } from "../app.tsx";
import { isDragging, useDropTarget, type DragPayload, type DropVerdict } from "../dnd.ts";
import { ago, api, copyWhenReady, mdhm, store, useApi } from "../lib.ts";
import { MergedPanel, MergePromptPanel, type PromptState } from "../merge-flow.tsx";
import { Bar, Block, Dot, Empty, GroupHead, GROUPS, Icon, matchQuery, MILESTONE_TONE, modelOfCard, PageHead, Pill, Popover, type BarPart, type Tone } from "../ui.tsx";

const UNRESERVED = "__unreserved";
const DONE = "__done";
type Filter = "all" | TodoGroupKey;
type GroupKey = TodoGroupKey | typeof DONE;
/** 每列的分组展开状态：只记用户点过的组；没点过的按默认（前两个非空组展开） */
type OpenState = Record<string, boolean>;

/** 页头筛选芯片（顺序 = 处理优先级） */
const FILTER_KEYS: TodoGroupKey[] = ["blocked", "conflict", "mergeable", "behind"];
const BUCKETS: Array<{ key: GroupKey; human: string; tone: Tone; hint: string }> = [
  ...GROUPS,
  { key: DONE, human: "已合入 / 已发布", tone: "green", hint: "台账状态已是已合入 / 已进主线 / 已发布，不计入还欠" },
];

const groupOf = (c: BoardCard): GroupKey => (c.done ? DONE : (c.group ?? "active"));
const hasFailed = (c: BoardCard): boolean => c.bindings.some((b) => b.precheckState === "failed");
const cardMatches = (q: string, c: BoardCard): boolean => matchQuery(q, c.title, c.id, ...c.bindings.map((b) => b.branch), ...c.bindings.map((b) => b.label));
const passFilter = (f: Filter, c: BoardCard): boolean => f === "all" || (!c.done && c.group === f);

const openKey = (col: string) => `heliu.kb.open.${col}`;
function readOpen(col: string): OpenState {
  try {
    const v = JSON.parse(store.get(openKey(col)) ?? "{}") as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "boolean")) as OpenState;
  } catch {
    return {};
  }
}
const allOpen = (v: boolean): OpenState => Object.fromEntries(BUCKETS.map((b) => [b.key, v]));

/* ───────────── 乐观更新：本地覆盖层 ───────────── */

/** 一次还没被服务端数据接管的移动；saved = 已写入台账（等下一份数据到了就撤掉覆盖） */
interface Move {
  from: string;
  to: string;
  saved: boolean;
  seq: number;
}

/** 列头计数随乐观移动加减——只做加总，口径仍是服务端给的 owed / mergeable / conflict / waiting / precheckFailed */
function shiftCounts(col: BoardColumn, c: BoardCard, d: 1 | -1): void {
  if (c.done) return;
  const add = (n: number) => Math.max(0, n + d);
  col.owed = add(col.owed);
  if (c.group === "mergeable") col.mergeable = add(col.mergeable);
  if (c.group === "blocked") col.waiting = add(col.waiting);
  if (c.group === "conflict" && col.conflict !== null) col.conflict = add(col.conflict);
  if (hasFailed(c)) col.precheckFailed = add(col.precheckFailed);
}

/** 服务端列 + 本地移动 → 页面上画的列（不改原数据） */
function applyMoves(columns: BoardColumn[], moves: Record<string, Move>): BoardColumn[] {
  const ids = Object.keys(moves);
  if (!ids.length) return columns;
  const cols = columns.map((c) => ({ ...c, cards: c.cards.slice() }));
  for (const id of ids) {
    const mv = moves[id];
    if (!mv) continue;
    const to = cols.find((c) => c.key === mv.to);
    const from = cols.find((c) => c.cards.some((x) => x.id === id));
    if (!to || !from || from === to) continue;
    const i = from.cards.findIndex((x) => x.id === id);
    const card = from.cards[i];
    if (!card) continue;
    from.cards.splice(i, 1);
    // 放在目标列最前面：落位后一眼能看到（组内顺序等服务端数据回来再按它的排）
    to.cards.unshift({ ...card, column: to.key, milestone: to.kind === "unreserved" ? null : to.key });
    shiftCounts(from, card, -1);
    shiftCounts(to, card, 1);
  }
  return cols;
}

/** 要滚到并点亮的方块（深链 / 新登记）；strict = 找不到就提示（深链），否则等数据刷新后再找 */
interface Focus {
  id: string;
  select: boolean;
  strict: boolean;
  /** 找不到时已经重拉过一次 features */
  reloaded?: boolean;
  at: number;
}

interface NewFeatureData {
  feature: { id: string; title: string; milestone: string | null };
  milestoneCreated: string | null;
}

/* ───────────── 页面 ───────────── */

export function KanbanView() {
  const app = useApp();
  const data = app.features;
  const [moves, setMoves] = useState<Record<string, Move>>({});
  const [filter, setFilter] = useState<Filter>("all");
  const [openMap, setOpenMap] = useState<Record<string, OpenState>>({});
  const [focus, setFocus] = useState<Focus | null>(null);
  const [mergeP, setMergeP] = useState<{ title: string; st: PromptState } | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const colsEl = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  const cols = useMemo(() => applyMoves(data?.columns ?? [], moves), [data, moves]);
  const colsRef = useRef(cols);
  colsRef.current = cols;

  // 新数据到了：已写入台账的移动交给服务端数据（覆盖层撤掉）；还在请求中的继续盖着
  useEffect(() => {
    setMoves((m) => {
      const keep = Object.entries(m).filter(([, v]) => !v.saved);
      return keep.length === Object.keys(m).length ? m : Object.fromEntries(keep);
    });
  }, [data]);

  const openOf = (k: string): OpenState => openMap[k] ?? readOpen(k);
  const setOpenOf = (k: string, v: OpenState) => {
    store.set(openKey(k), JSON.stringify(v));
    setOpenMap((m) => ({ ...m, [k]: v }));
  };

  const columnOf = (id: string): BoardColumn | null => colsRef.current.find((c) => c.cards.some((x) => x.id === id)) ?? null;
  const titleOf = (key: string): string => (key === UNRESERVED ? "未预约" : (colsRef.current.find((c) => c.key === key)?.title ?? key));
  const bodyFor = (key: string) => ({ milestone: key === UNRESERVED || colsRef.current.find((c) => c.key === key)?.kind === "unreserved" ? null : key });

  /** 改预约：先在本地挪过去，再 PATCH；成功 toast（可撤销）+ 重拉，失败回滚 */
  const moveCard = async (id: string, from: string, to: string, mode: "move" | "undo", undoable: boolean): Promise<void> => {
    const my = ++seq.current;
    const toName = titleOf(to);
    setMoves((m) => ({ ...m, [id]: { from, to, saved: false, seq: my } }));
    try {
      await api(`/api/features/${encodeURIComponent(id)}`, { method: "PATCH", body: bodyFor(to) });
      setMoves((m) => {
        const v = m[id];
        return v && v.seq === my ? { ...m, [id]: { ...v, saved: true } } : m;
      });
      if (mode === "undo") app.toast(`已撤销：${id} 回到 ${toName}（已写入台账）`);
      else if (undoable) app.toast(`${id} → ${toName}（已写入台账）`, { undo: () => moveCard(id, to, from, "undo", false) });
      else app.toast(`${id} → ${toName}（已写入台账）。原来的版本已不接新预约，所以不能撤回去`);
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      setMoves((m) => {
        if (m[id]?.seq !== my) return m;
        const n = { ...m };
        delete n[id];
        return n;
      });
      app.toast(`${mode === "undo" ? "没撤销成" : "没改成"}：${(e as Error).message}`, { kind: "err" });
    }
  };

  const verdict = (col: BoardColumn, p: DragPayload): DropVerdict | null => {
    if (p.kind !== "card") return null;
    const cur = columnOf(p.id)?.key ?? (p.data as BoardCard | null)?.column ?? null;
    if (cur === col.key) return { ok: false, hint: "已经在这一列" };
    if (!col.droppable) return { ok: false, hint: col.dropHint ?? "这一列不能放" };
    return { ok: true, hint: col.kind === "unreserved" ? "放到这里：取消预约" : `放到这里：预约到 ${col.title}` };
  };
  const drop = (col: BoardColumn, p: DragPayload) => {
    const fromCol = columnOf(p.id);
    const from = fromCol?.key ?? (p.data as BoardCard).column;
    if (from === col.key) return;
    // 原列已冻结 / 合并中：服务端不接回去，所以不给撤销
    void moveCard(p.id, from, col.key, "move", fromCol ? fromCol.droppable : true);
    // 落位反馈：目标列里它所在的组若是折叠的就展开，滚到它并回弹一下（不改选中）
    setFocus({ id: p.id, select: false, strict: false, at: Date.now() });
  };

  /* 深链：#/kanban/F-0041 → 滚到这张卡并选中；#/kanban/g:blocked → 筛选这一组。每个 sub 只处理一次 */
  const handledSub = useRef<string | null>(null);
  useEffect(() => {
    const sub = app.sub;
    if (!sub) {
      handledSub.current = null;
      return;
    }
    if (handledSub.current === sub) return;
    handledSub.current = sub;
    if (sub.startsWith("g:")) {
      const g = sub.slice(2);
      if (GROUPS.some((x) => x.key === g)) setFilter(g as TodoGroupKey);
      return;
    }
    setFocus({ id: sub, select: true, strict: true, at: Date.now() });
  }, [app.sub]);

  const scrollToCard = (id: string, card: BoardCard | null, tries = 0) => {
    const el = rootRef.current?.querySelector<HTMLElement>(`.kb-cols [data-key="${CSS.escape(id)}"]`);
    if (!el) {
      if (tries < 12) setTimeout(() => scrollToCard(id, card, tries + 1), 50);
      return;
    }
    el.scrollIntoView({ block: "center", inline: "nearest" });
    el.classList.add("landed");
    setTimeout(() => el.classList.remove("landed"), 420);
    if (card) app.select({ kind: "card", card });
  };
  useEffect(() => {
    if (!focus || !data) return;
    const col = cols.find((c) => c.cards.some((x) => x.id === focus.id));
    const card = col?.cards.find((x) => x.id === focus.id);
    if (!col || !card) {
      // 刚登记的卡可能还没进这次的 features 数据：先重拉一次、等后续刷新，15 秒后还没有才说没有
      if (Date.now() - focus.at > 15000) {
        if (focus.strict) app.toast(`看板里没有 ${focus.id}（可能已放弃，或不在这个项目里）`, { kind: "info" });
        setFocus(null);
      } else if (!focus.reloaded) {
        setFocus({ ...focus, reloaded: true });
        app.reloadFeatures();
      }
      return;
    }
    setFocus(null);
    if (!passFilter(filter, card)) setFilter("all");
    if (!cardMatches(app.query, card)) app.setQuery("");
    if (col.kind !== "released") {
      const o = openOf(col.key);
      const g = groupOf(card);
      if (o[g] !== true) setOpenOf(col.key, { ...o, [g]: true });
    }
    // 晚一拍：等折叠组展开渲染出来，也等切页时清掉选中的那一下先执行
    setTimeout(() => scrollToCard(focus.id, focus.select ? card : null), 30);
  }, [focus, cols]);

  /* 列菜单：复制合并 Prompt（必须在点击的同一轮里把 Promise 交给剪贴板） */
  const copyPrompt = (col: BoardColumn) => {
    const req = api<MergePromptData>("/api/release/prompt", { body: { milestone: col.key } });
    const copied = copyWhenReady(req.then((r) => r.data.prompt));
    setMergeP({ title: col.title, st: { data: null, copied: null, error: null } });
    req
      .then(async (r) => {
        const ok = await copied;
        setMergeP({ title: col.title, st: { data: r.data, copied: ok, error: null } });
        app.toast(ok ? `已复制 ${col.title} 的合并 Prompt（只预演，不执行合并）` : `${col.title} 的合并 Prompt 已生成：点「复制 Prompt」`);
        app.refresh();
      })
      .catch((e: Error) => setMergeP({ title: col.title, st: { data: null, copied: false, error: e.message } }));
  };

  /* 搜索 × 筛选 */
  const q = app.query;
  const qCards = useMemo(() => cols.flatMap((c) => c.cards).filter((c) => cardMatches(q, c)), [cols, q]);
  const countOf = (g: TodoGroupKey) => qCards.filter((c) => !c.done && c.group === g).length;
  const filtering = filter !== "all" || !!q.trim();
  const shown = qCards.filter((c) => passFilter(filter, c)).length;
  const pass = (c: BoardCard) => passFilter(filter, c) && cardMatches(q, c);
  const extra = filter !== "all" && !FILTER_KEYS.includes(filter) ? GROUPS.find((g) => g.key === filter) : undefined;
  const sel = app.selected?.kind === "card" ? app.selected.card.id : null;

  const onAdded = (id: string) => setFocus({ id, select: false, strict: false, at: Date.now() });
  const onBlank = (e: MouseEvent) => {
    if (!app.selected) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest(".block, button, input, select, textarea, a, form, .popover")) return;
    app.select(null);
  };

  const head = (
    <PageHead icon="kanban" title="看板" desc="一列一个版本；把方块拖到别的列就是预约（只写台账）。">
      {app.project ? (
        <>
          <div class="fchips kb-filters" role="group" aria-label="按状态筛选">
            <button class={`fchip${filter === "all" ? " on" : ""}`} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
              功能卡 <b>{qCards.length}</b>
            </button>
            {FILTER_KEYS.map((k) => {
              const g = GROUPS.find((x) => x.key === k)!;
              const n = countOf(k);
              const on = filter === k;
              // 没做冲突检查（试合）时，「撞了」不知道几块：写「未检查」而不是 0
              const unchecked = k === "conflict" && !app.precheck;
              return (
                <button
                  class={`fchip tone-${g.tone}${on ? " on" : ""}`}
                  aria-pressed={on}
                  disabled={unchecked || (!n && !on)}
                  title={unchecked ? "还没做冲突检查（试合）：点标题栏的「冲突检查」" : g.hint}
                  onClick={() => setFilter(on ? "all" : k)}
                >
                  <Dot tone={g.tone} />
                  {g.human} {unchecked ? <span class="tiny muted">未检查</span> : <b>{n}</b>}
                </button>
              );
            })}
            {extra ? (
              <button class={`fchip tone-${extra.tone} on`} aria-pressed={true} title={`${extra.hint}（点一下取消）`} onClick={() => setFilter("all")}>
                <Dot tone={extra.tone} />
                {extra.human} <b>{countOf(extra.key)}</b>
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
          <NewIdeaButton onAdded={onAdded} />
        </>
      ) : null}
    </PageHead>
  );

  if (!app.project) {
    return (
      <div class="page wide kb-page">
        {head}
        <Empty icon="kanban" title="还没有选项目" hint="先在「开始」里接入或选择一个项目，看板会按版本把方块排成列。">
          <button class="btn primary" onClick={() => app.go("start")}>
            去开始 / 接入
          </button>
        </Empty>
      </div>
    );
  }

  return (
    <div class="page wide kb-page" ref={rootRef}>
      {head}
      <CodexTasks project={app.project} tick={app.tick} />
      {app.featuresError ? <p class="err kb-err">读取功能卡失败：{app.featuresError}</p> : null}
      {data?.broken.length ? (
        <p class="err small kb-err">
          有 {data.broken.length} 个卡片文件读不出来：{data.broken.join("、")}
        </p>
      ) : null}
      {filtering && data ? (
        <p class="kb-note">
          <Icon name="filter" size={14} />
          <span>
            {filter !== "all" ? `只看「${GROUPS.find((g) => g.key === filter)?.human ?? filter}」` : "全部状态"}
            {q.trim() ? ` · 搜索「${q.trim()}」` : ""}：<b>{shown}</b> 个方块
          </span>
          <button
            class="link"
            onClick={() => {
              setFilter("all");
              if (q) app.setQuery("");
            }}
          >
            清除筛选
          </button>
        </p>
      ) : null}
      {!data ? (
        app.featuresError ? null : <KbSkeleton />
      ) : (
        <div class="kb-cols" ref={colsEl} onClick={onBlank}>
          {cols.map((col) => (
            <KbColumn
              key={col.key}
              col={col}
              pass={pass}
              filtering={filtering}
              open={openOf(col.key)}
              setOpen={(v) => setOpenOf(col.key, v)}
              selectedId={sel}
              verdict={verdict}
              drop={drop}
              onCopyPrompt={copyPrompt}
              onAdded={onAdded}
            />
          ))}
        </div>
      )}
      {data ? (
        <p class="kb-foot" title={data.ledgerDir}>
          看板只写台账（{data.ledgerDir}）{data.abandoned ? ` · 另有 ${data.abandoned} 张已放弃（不显示）` : ""} · 真正的 git 合并在终端：heliu 合并 &lt;版本&gt;，看完摘要输入 yes 才开始
        </p>
      ) : null}
      {mergeP ? (
        <MergePromptPanel
          st={mergeP.st}
          title={mergeP.title}
          onClose={() => setMergeP(null)}
          onSync={() => {
            setMergeP(null);
            setSyncOpen(true);
          }}
        />
      ) : null}
      {syncOpen ? (
        <MergedPanel
          onClose={() => setSyncOpen(false)}
          onChanged={() => {
            app.reloadFeatures();
            app.refresh();
          }}
        />
      ) : null}
    </div>
  );
}

/* ───────────── Codex 任务：自动读取，与功能卡台账分开 ───────────── */

const CODEX_STATUS: Record<CodexTask["status"], { label: string; tone: Tone }> = {
  running: { label: "正在进行", tone: "blue" },
  idle: { label: "本轮已结束", tone: "gray" },
  interrupted: { label: "已中断", tone: "yellow" },
  stale: { label: "状态待确认", tone: "yellow" },
  unknown: { label: "未知", tone: "gray" },
};

function CodexTasks({ project, tick }: { project: string; tick: number }) {
  const [poll, setPoll] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setPoll((n) => n + 1), 10_000);
    return () => clearInterval(timer);
  }, []);
  const result = useApi<CodexTasksData>(`/api/codex-tasks?project=${encodeURIComponent(project)}`, [tick, poll]);
  const data = result.env?.data;
  // 请求失败时不继续把上次的「正在进行」当作当前事实展示。
  const tasks = !result.error && data?.available ? data.tasks : [];
  const running = tasks.filter((t) => t.status === "running").length;

  return (
    <section class="kb-codex" aria-labelledby="kb-codex-title" aria-busy={result.loading}>
      <div class="kb-codex-head">
        <div>
          <h2 id="kb-codex-title">Codex 任务 {data?.available && !result.error ? <span class="kb-codex-count">{tasks.length}</span> : null}</h2>
          <p>本项目最近 50 个任务 · 每 10 秒自动更新 · 本轮结束不代表功能已完成</p>
          <p>状态来自本地会话记录；长时间没有新记录时标记为待确认。</p>
        </div>
        <div class="kb-codex-tools">
          {running ? <span class="kb-codex-running">{running} 项正在进行</span> : null}
          <button class="btn small" onClick={result.reload} disabled={result.loading} aria-label="刷新 Codex 任务">
            <Icon name="refresh" size={14} class={result.loading ? "spin" : ""} />
            {result.loading ? "更新中" : "刷新任务"}
          </button>
        </div>
      </div>
      {result.error ? (
        <p class="kb-codex-message err" role="status">读取 Codex 任务失败：{result.error}。当前状态未确认，将自动重试。</p>
      ) : !data ? (
        <p class="kb-codex-message" role="status">正在读取本项目的 Codex 任务…</p>
      ) : (
        <>
          {data.warning ? <p class="kb-codex-message warn" role="status">{data.warning}</p> : null}
          {!data.available ? (
            <p class="kb-codex-message">暂时无法读取 Codex 本地任务数据，恢复后会自动显示。</p>
          ) : tasks.length ? (
            <ul class="kb-codex-list" aria-label="本项目 Codex 任务">
              {tasks.map((task) => {
                const state = CODEX_STATUS[task.status] ?? CODEX_STATUS.unknown;
                const folder = task.cwd.split(/[\\/]/).filter(Boolean).pop() || task.cwd;
                return (
                  <li class="kb-codex-task" key={task.id} data-status={task.status}>
                    <div class="kb-codex-task-top">
                      <span class={`kb-codex-status tone-${state.tone}`}><Dot tone={state.tone} />{state.label}</span>
                      <time class="kb-codex-time" dateTime={task.lastActivityAt ?? undefined} title={task.lastActivityAt ? `最后活动：${mdhm(task.lastActivityAt)}` : "没有最后活动时间"}>
                        {task.lastActivityAt ? ago(task.lastActivityAt) : "活动时间未知"}
                      </time>
                    </div>
                    <h3>{task.title || "未命名任务"}</h3>
                    <div class="kb-codex-location">
                      <span class="kb-codex-repo">{task.repoLabel || task.repoId}</span>
                      <span class="kb-codex-folder" title={task.cwd}><Icon name="folder" size={13} />{folder || "工作目录未知"}</span>
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p class="kb-codex-message">还没有匹配本项目工作目录的 Codex 任务。任务出现后会自动显示；下方版本列仍管理已登记的功能卡。</p>
          )}
        </>
      )}
    </section>
  );
}

/* ───────────── 一列 ───────────── */

interface ColProps {
  col: BoardColumn;
  pass: (c: BoardCard) => boolean;
  filtering: boolean;
  open: OpenState;
  setOpen: (v: OpenState) => void;
  selectedId: string | null;
  verdict: (col: BoardColumn, p: DragPayload) => DropVerdict | null;
  drop: (col: BoardColumn, p: DragPayload) => void;
  onCopyPrompt: (col: BoardColumn) => void;
  onAdded: (id: string) => void;
}

function KbColumn(p: ColProps) {
  const app = useApp();
  const { col } = p;
  const ref = useDropTarget({ canDrop: (x) => p.verdict(col, x), onDrop: (x) => p.drop(col, x) });
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const released = col.kind === "released";
  const unreserved = col.kind === "unreserved";
  const isMs = col.kind === "milestone" && !!col.milestone;
  // 冻结 / 合并中的版本服务端不接新预约，登记也会被拒，所以和已发布列一样不给 ＋
  const canAdd = col.droppable && !released;

  // 迷你分段条：按本列卡的分组加总，done 的不算
  const live = col.cards.filter((c) => !c.done);
  const n = (g: TodoGroupKey) => live.filter((c) => c.group === g).length;
  const parts: BarPart[] = [
    { tone: "purple", n: n("blocked"), label: "等你拍板" },
    { tone: "red", n: n("conflict"), label: "撞了" },
    { tone: "green", n: n("mergeable"), label: "能拼上" },
    { tone: "yellow", n: n("behind"), label: "要先对齐" },
  ];
  parts.push({ tone: "gray", n: live.length - parts.reduce((a, x) => a + x.n, 0), label: "还在做 / 没动静 / 还没绑分支" });

  const visible = col.cards.filter(p.pass);
  const buckets = BUCKETS.map((b) => ({ ...b, cards: visible.filter((c) => groupOf(c) === b.key) })).filter((b) => b.cards.length);

  const pillText = released ? "已发布" : unreserved ? "未预约" : null;
  const pill = released ? (
    <Pill tone="green">已发布</Pill>
  ) : unreserved ? (
    <Pill tone="gray">未预约</Pill>
  ) : col.isNext ? (
    <Pill brand>下一版</Pill>
  ) : col.milestone ? (
    <Pill tone={MILESTONE_TONE[col.milestone.status] ?? "gray"}>{col.milestone.status}</Pill>
  ) : null;
  const sub = [
    col.milestone?.title && col.milestone.title !== col.key ? col.milestone.title : null,
    col.milestone?.target_date ? `目标 ${col.milestone.target_date}` : null,
    unreserved ? "还没定进哪一版" : null,
    released ? "已经发布的版本（只读）" : null,
  ].filter(Boolean);

  const padText = !col.cards.length
    ? released
      ? "还没有已发布的方块"
      : unreserved
        ? "没有未预约的方块：拖到这里 = 取消预约"
        : col.droppable
          ? "这一版还没有方块：把方块拖到这里，或点 ＋ 登记新点子"
          : (col.dropHint ?? "这一列不能放")
    : col.droppable
      ? unreserved
        ? "拖到这里 = 取消预约"
        : `拖到这里 = 预约到 ${col.title}`
      : (col.dropHint ?? "这一列不能放");

  const renderCard = (c: BoardCard) => (
    <Block
      key={c.id}
      m={modelOfCard(c, { next: app.next })}
      density="card"
      selected={p.selectedId === c.id}
      onClick={() => app.select({ kind: "card", card: c })}
      drag={c.done || released ? undefined : { payload: { kind: "card", id: c.id, label: c.title, data: c } }}
      title={c.done || released ? "已合入 / 已发布的方块不再改预约" : undefined}
      hideMilestone
    />
  );

  return (
    <section ref={ref} class={`kb-col kind-${col.kind}${col.isNext ? " is-next" : ""}${col.droppable ? "" : " locked"}`} aria-label={released ? `已发布：${col.cards.length} 项` : `${col.title}：还欠 ${col.owed}`}>
      <header class="kb-col-head">
        <div class="kb-col-title">
          {pillText ? <Dot tone={released ? "green" : "gray"} /> : null}
          <h2 title={col.title}>{col.title}</h2>
          {/* 标题已经写了「未预约 / 已发布」就不再重复一个同名胶囊 */}
          {pill && pillText !== col.title ? pill : null}
          <span class="kb-col-tools">
            {canAdd ? (
              <button
                class={`icon-btn${adding ? " on" : ""}`}
                onClick={() => setAdding((a) => !a)}
                title={unreserved ? "登记新点子（先不预约）" : `在 ${col.title} 登记新点子`}
                aria-label={unreserved ? "登记新点子（先不预约）" : `在 ${col.title} 登记新点子`}
                aria-expanded={adding}
              >
                <Icon name="plus" size={16} />
              </button>
            ) : null}
            {!released ? (
              <div class="kb-menu-wrap">
                <button class={`icon-btn${menu ? " on" : ""}`} data-popover-anchor onClick={() => setMenu((m) => !m)} aria-label={`${col.title} 列菜单`} aria-expanded={menu} title="更多">
                  <Icon name="more" size={16} />
                </button>
                <Popover open={menu} onClose={() => setMenu(false)} class="kb-menu">
                  {isMs ? (
                    <>
                      <button
                        class="item"
                        onClick={() => {
                          setMenu(false);
                          p.onCopyPrompt(col);
                        }}
                      >
                        <Icon name="copy" size={16} />
                        <span>
                          复制合并 Prompt<span class="sub">刷新合并单并复制；只预演，不执行合并</span>
                        </span>
                      </button>
                      <button
                        class="item"
                        onClick={() => {
                          setMenu(false);
                          app.go("assembly", col.key);
                        }}
                      >
                        <Icon name="assembly" size={16} />
                        <span>
                          在装配里打开<span class="sub">按合并顺序看这一版每块能不能拼上</span>
                        </span>
                      </button>
                      <div class="sep" />
                    </>
                  ) : null}
                  <button
                    class="item"
                    onClick={() => {
                      setMenu(false);
                      p.setOpen(allOpen(true));
                    }}
                  >
                    <Icon name="chevron" size={16} />
                    <span>展开全部分组</span>
                  </button>
                  <button
                    class="item"
                    onClick={() => {
                      setMenu(false);
                      p.setOpen(allOpen(false));
                    }}
                  >
                    <Icon name="chevron-right" size={16} />
                    <span>收起全部分组</span>
                  </button>
                </Popover>
              </div>
            ) : null}
          </span>
        </div>
        {sub.length ? <p class="kb-col-sub">{sub.join(" · ")}</p> : null}
        {released ? (
          <div class="kb-owed">
            <span class="num">{col.cards.length}</span>
            <span class="k">项已发布</span>
          </div>
        ) : (
          <>
            <div class="kb-owed" title="还欠 = 这一列里台账状态还没到「已合入」的方块数">
              <span class="k">还欠</span>
              <span class="num">{col.owed}</span>
            </div>
            <Bar thin parts={parts} title="按方块张数：等你拍板 / 撞了 / 能拼上 / 要先对齐 / 其他" />
            <p class="kb-col-facts">
              <span>
                能拼上 <b>{col.mergeable}</b>
              </span>
              <span class="sep">·</span>
              {col.conflict === null ? (
                <span title="还没做冲突检查：点标题栏的「冲突检查」">冲突未检查</span>
              ) : (
                <span>
                  撞了 <b>{col.conflict}</b>
                </span>
              )}
              <span class="sep">·</span>
              <span>
                等你 <b>{col.waiting}</b>
              </span>
              {col.precheckFailed > 0 ? (
                <>
                  <span class="sep">·</span>
                  <span class="warn" title={col.precheckSummary?.firstError ?? "请求了试合但没得到结果：不算无冲突"}>
                    没试出来 <b>{col.precheckFailed}</b>
                  </span>
                </>
              ) : null}
            </p>
          </>
        )}
      </header>
      <div class="kb-col-body">
        {adding ? (
          <IdeaForm
            milestone={unreserved ? null : col.key}
            hint={unreserved ? "先不预约 · 只写台账" : `预约到 ${col.title} · 只写台账`}
            onDone={p.onAdded}
            onCancel={() => setAdding(false)}
          />
        ) : null}
        {released ? (
          visible.length ? <div class="group-body">{visible.map(renderCard)}</div> : null
        ) : (
          buckets.map((b, i) => {
            const isOpen = p.open[b.key] ?? (p.filtering || i < 2);
            return (
              <div class="block-group" key={b.key}>
                <GroupHead tone={b.tone} title={b.human} n={b.cards.length} open={isOpen} hint={b.hint} onToggle={() => p.setOpen({ ...p.open, [b.key]: !isOpen })} />
                {isOpen ? <div class="group-body">{b.cards.map(renderCard)}</div> : null}
              </div>
            );
          })
        )}
        {!visible.length && col.cards.length ? <p class="kb-empty">没有符合的方块</p> : null}
        <div class={`kb-drop-pad${col.cards.length ? "" : " empty"}`} aria-hidden="true">
          <span>{padText}</span>
        </div>
      </div>
    </section>
  );
}

/* ───────────── 新点子 ───────────── */

function NewIdeaButton({ onAdded }: { onAdded: (id: string) => void }) {
  const app = useApp();
  const [open, setOpen] = useState(false);
  return (
    <div class="kb-idea-wrap">
      <button class="btn primary" data-popover-anchor onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Icon name="plus" size={16} /> 新点子
      </button>
      <Popover open={open} onClose={() => setOpen(false)} class="kb-idea-pop">
        <IdeaForm milestone={app.next ?? "next"} hint={`预约到下一版${app.next ? `（${app.next}）` : ""} · 只写台账`} onDone={onAdded} onCancel={() => setOpen(false)} />
      </Popover>
    </div>
  );
}

/** 一句话登记：回车 = POST /api/features {title, milestone}；milestone null = 先不预约（必须显式传，缺省服务端会预约到下一版） */
function IdeaForm({ milestone, hint, onDone, onCancel }: { milestone: string | null; hint: string; onDone: (id: string) => void; onCancel: () => void }) {
  const app = useApp();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy) return;
    setBusy(true);
    try {
      const r = await api<NewFeatureData>("/api/features", { body: { title: t, milestone } });
      const f = r.data.feature;
      app.toast(`已登记 ${f.id}，${f.milestone ? `预约 ${f.milestone}` : "先不预约"}${r.data.milestoneCreated ? `（顺手建了 ${r.data.milestoneCreated}）` : ""}（已写入台账）`);
      setTitle("");
      onDone(f.id);
      app.reloadFeatures();
      app.refresh();
    } catch (err) {
      app.toast(`没登记成：${(err as Error).message}`, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="kb-new" onSubmit={(e) => void submit(e)}>
      <input
        type="text"
        value={title}
        autoFocus
        placeholder="一句话写需求，回车登记"
        aria-label="新点子标题"
        onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onCancel();
          }
        }}
      />
      <div class="kb-new-foot">
        <span class="hint">{hint}</span>
        <button class="btn small ghost" type="button" onClick={onCancel}>
          取消
        </button>
        <button class="btn small primary" type="submit" disabled={busy || !title.trim()}>
          {busy ? "登记中…" : "登记"}
        </button>
      </div>
    </form>
  );
}

/* ───────────── 骨架 ───────────── */

function KbSkeleton() {
  return (
    <>
      <p class="kb-note">正在对账并试合（只读，merge-tree 在临时区进行，不碰仓库）…</p>
      <div class="kb-cols" aria-busy="true" aria-label="正在读取看板">
        {[3, 2, 1].map((k) => (
          <div class="kb-col kb-skel" key={k}>
            <div class="kb-col-head">
              <div class="skeleton kb-skel-title" />
              <div class="skeleton kb-skel-num" />
              <div class="skeleton kb-skel-bar" />
            </div>
            <div class="kb-col-body">
              {Array.from({ length: k }, (_, j) => (
                <div class="skeleton kb-skel-card" key={j} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
