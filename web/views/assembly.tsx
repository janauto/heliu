/** @jsxImportSource preact */
/**
 * 合流装配（M10，替代旧「合并预演」页）：像拼积木一样把这一版的方块按顺序摆上「合流轨道」，看每一块能不能拼上、先合谁后合谁。
 * - 数据只来自 GET /api/release/preview（与 heliu 合并 <版本> --预演 同一个合并单构建器）：档位 / 冲突 / 落后都是服务端事实，前端不自己判断 git。
 * - 写只走 POST /api/release/decision（拖进轨道 = 并入；开关 = 并入 / 待定 / 不并 / 顺延）、/api/release/plan、/api/release/prompt，
 *   以及 merge-flow.tsx 封装的 /api/merged。全部只写台账与合并单文件，页面任何地方都不执行 git 合并（M4：合并只在终端 yes 后执行）。
 */
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { BoardCard, Light, MergePromptData, ReleaseDecisionResult, ReleaseItem, ReleasePlanResult, ReleasePreview, ReleaseTier } from "../../src/board/api-types.ts";
import { useApp, type AppState } from "../app.tsx";
import { useDropTarget, type DragPayload } from "../dnd.ts";
import { api, copyWhenReady, hms, useApi } from "../lib.ts";
import { MergedPanel, MergePromptPanel, type PromptState } from "../merge-flow.tsx";
import { Block, Empty, GroupHead, Icon, matchQuery, modelOfCard, PageHead, Pill, Seg, Stat, type BlockChip, type BlockModel, type SegOption, type Tone } from "../ui.tsx";

/* ───────────── 档位（顺序 = 左栏分堆顺序） ───────────── */

interface TierDef {
  key: ReleaseTier;
  human: string;
  tone: Tone;
  light: Light;
  hint: string;
}
const TIERS: TierDef[] = [
  { key: "clean", human: "能拼上", tone: "green", light: "green", hint: "试合无冲突：默认并入" },
  { key: "in_integration", human: "已在集成分支", tone: "green", light: "green", hint: "绑定分支已被集成分支包含：执行时跳过" },
  { key: "conflict", human: "撞了", tone: "red", light: "red", hint: "试合有冲突文件：并入前要先解" },
  { key: "precheck_failed", human: "没试出来", tone: "yellow", light: "yellow", hint: "没得到试合结果：不算无冲突，也不自动顺延（默认待定）" },
  { key: "unfinished", human: "还没做完", tone: "gray", light: "gray", hint: "会话等你回答 / 正在运行，或卡片还是「想法 / 开发中」：默认顺延" },
  { key: "unmergeable", human: "拼不上", tone: "gray", light: "gray", hint: "分支不存在、仓库未配置集成分支等：合并时没法执行，默认顺延" },
];
const TIER: Record<ReleaseTier, TierDef> = Object.fromEntries(TIERS.map((t) => [t.key, t])) as Record<ReleaseTier, TierDef>;

/* ───────────── 决定（字面值 = 合并单 decision：并入 / 顺延 / 等它 / 不并 / 待定） ───────────── */

const DECISION_OPTS: Array<SegOption<string>> = [
  { value: "并入", label: "并入", tone: "green", title: "本次合入" },
  { value: "待定", label: "待定", tone: "yellow", title: "还没决定：执行时跳过，不并入也不顺延，留在本版（本版先不收尾）" },
  { value: "不并", label: "不并", tone: "gray", title: "不合：执行时把卡片改为未预约" },
  { value: "顺延", label: "顺延", tone: "accent", title: "不合：执行时把卡片挪到下一版，并记「从本版顺延」" },
];
/** 「等它」只在当前决定就是它时出现（多半是终端 heliu release set 改的），免得开关一个都没选中 */
const WAIT_OPT: SegOption<string> = { value: "等它", label: "等它", tone: "purple", title: "本次不合也不顺延：本版先不收尾，等它好了重新预演" };
const DEC_TONE: Record<string, Tone> = { 并入: "green", 待定: "yellow", 不并: "gray", 顺延: "accent", 等它: "purple" };

/** 这一项的决定开关：已在集成分支 → 只读（执行时跳过）；拼不上 → 「并入」禁用并写明原因；其余四个（或五个）都能切 */
function optsFor(x: ReleaseItem, dec: string): Array<SegOption<string>> {
  const base = dec === "等它" ? [...DECISION_OPTS, WAIT_OPT] : DECISION_OPTS;
  if (x.tier === "in_integration") return base.map((o) => ({ ...o, disabled: o.value !== dec, title: "已在集成分支，执行时跳过" }));
  if (x.tier === "unmergeable") {
    return base.map((o) => (o.value === "并入" && dec !== "并入" ? { ...o, disabled: true, title: `拼不上：${x.reason}。先补分支或配置集成分支，才能并入` } : o));
  }
  return base;
}

const itemKey = (x: ReleaseItem): string => `${x.order}|${x.id}|${x.bindings[0]?.repo ?? ""}|${x.bindings[0]?.branch ?? ""}`;
const firstSentence = (s: string): string => {
  const i = s.indexOf("。");
  return i >= 0 ? s.slice(0, i + 1) : s;
};
const onTrack = (x: ReleaseItem, decision: string): boolean => decision === "并入" || x.tier === "in_integration";

/** 方块上的事实芯片：全部取自预演（试合 / 落后 / 分支是否存在） */
function chipsOf(x: ReleaseItem): BlockChip[] {
  const chips: BlockChip[] = [];
  if (x.tier === "in_integration") chips.push({ text: "已在集成分支", tone: "green", title: "绑定分支已被集成分支包含：执行时跳过" });
  const conflicts = x.bindings.reduce((a, b) => a + (b.conflictFiles ?? 0), 0);
  if (conflicts > 0) chips.push({ text: `撞了 ${conflicts} 个文件`, tone: "red", title: "试合（merge-tree，临时对象区）发现的冲突文件数" });
  if (x.tier !== "in_integration") {
    let best: { n: number; of: string } | null = null;
    for (const b of x.bindings) {
      const n = b.behindIntegration ?? b.behindMain ?? 0;
      const of = b.behindIntegration !== null ? "集成分支" : "主线";
      if (n > 0 && (!best || n > best.n)) best = { n, of };
    }
    if (best) chips.push({ text: `落后 ${best.n}`, tone: "yellow", title: `落后${best.of} ${best.n} 个提交` });
  }
  const failed = x.bindings.find((b) => b.precheckState === "failed");
  if (failed) chips.push({ text: "没试出来", tone: "yellow", title: `请求了试合但没得到结果（${failed.precheckError ?? "原因未知"}）：不算无冲突` });
  if (x.bindings.some((b) => !b.exists)) chips.push({ text: "分支不存在", tone: "gray", title: "绑定的分支在本地找不到" });
  if (!x.bindings.length) chips.push({ text: "没绑分支", tone: "gray" });
  return chips;
}

/**
 * 合并单项 → 方块。有对应功能卡时整块用 modelOfCard：颜色、人话、事实、芯片与看板 / 时间线完全一致（同一张卡跨页不变色），
 * 只把仓库 / 分支换成这一项的绑定（多仓的卡一项一块）。找不到卡（看板数据还没到或卡已删）才按合并单档位构造。
 * 合并单档位（能拼上 / 撞了 / 还没做完 …）是另一个维度：用「档位：…」小胶囊单独标，不覆盖方块的颜色与人话。
 */
function modelOfItem(x: ReleaseItem, card: BoardCard | undefined, app: AppState, sel: string): BlockModel {
  const b = x.bindings[0] ?? null;
  if (card) {
    const m = modelOfCard(card, { next: app.next });
    return { ...m, key: itemKey(x), repoLabel: b ? b.repoLabel : m.repoLabel, branch: b ? b.branch : m.branch };
  }
  const t = TIER[x.tier];
  return {
    key: itemKey(x),
    id: x.id,
    title: x.title,
    type: "其他",
    typeGuess: true,
    module: "其他",
    light: t.light,
    human: t.human,
    fact: x.reason || null,
    repoLabel: b ? b.repoLabel : null,
    branch: b ? b.branch : null,
    milestone: sel,
    lastActivityAt: null,
    chips: chipsOf(x),
    variant: "normal",
    needsAction: null,
  };
}

/** 合并单档位标签：和方块的颜色 / 人话分开，title 是合并单原文（M4 状态名 + 依据） */
function TierPill({ x }: { x: ReleaseItem }) {
  return (
    <Pill tone="gray" outline class="as-tier" title={`合并单档位：${x.tierText} · ${x.reason}`}>
      档位：{TIER[x.tier].human}
    </Pill>
  );
}

/* ───────────── 页面 ───────────── */

interface PlanState {
  busy: boolean;
  result: ReleasePlanResult | null;
  error: string | null;
}

export function AssemblyView() {
  const app = useApp();

  /* 版本：候选 = 未发布的里程碑；默认 = 地址里的 #/assembly/<版本>，否则下一版 */
  const cands = app.milestones.filter((m) => m.status !== "已发布");
  const subId = app.sub === "next" ? app.next : app.sub;
  const sel = cands.find((m) => m.id === subId)?.id ?? cands.find((m) => m.id === app.next)?.id ?? cands[0]?.id ?? null;

  const pv = useApi<ReleasePreview>(app.project && sel ? `/api/release/preview?milestone=${encodeURIComponent(sel)}` : null, [app.tick, sel]);
  const d = pv.env && sel && pv.env.data.milestone.id === sel ? pv.env.data : null;

  /* 乐观更新：卡号 → 刚改的决定（合并单按卡号改，同一张卡的每个绑定项一起变）；新的预演到了就以服务端为准 */
  const [over, setOver] = useState<Record<string, string>>({});
  const overRef = useRef(over);
  overRef.current = over;
  const pending = useRef(new Map<string, number>());
  const seq = useRef(0);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    setOver((o) => {
      const keep: Record<string, string> = {};
      for (const [k, v] of Object.entries(o)) if (pending.current.has(k)) keep[k] = v;
      return keep;
    });
  }, [pv.env]);

  const [plan, setPlan] = useState<PlanState>({ busy: false, result: null, error: null });
  const [mp, setMp] = useState<PromptState | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const [closed, setClosed] = useState<Set<ReleaseTier>>(new Set(["in_integration"]));
  /** 左栏点开的那一行（触屏没有 hover：点一下显示决定开关） */
  const [rowOpen, setRowOpen] = useState<string | null>(null);
  useEffect(() => {
    setPlan({ busy: false, result: null, error: null });
    setMp(null);
    setOver({});
    setOpenFiles(new Set());
  }, [sel]);

  const cardOf = useMemo(() => {
    const m = new Map<string, BoardCard>();
    for (const col of app.features?.columns ?? []) for (const c of col.cards) m.set(c.id, c);
    return m;
  }, [app.features]);

  const items = d?.items ?? [];
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const eff = (x: ReleaseItem): string => over[x.id] ?? x.decision;

  /** 改决定：先本地改，再写合并单；失败回滚。undo = toast 里的「撤销」把决定改回去 */
  const decide = async (x: ReleaseItem, decision: string, opts: { undoable?: boolean } = {}) => {
    if (!sel) return;
    const id = x.id;
    // 用最新一次预演里的这一项比较（撤销时 x 可能已是旧数据）
    const cur = itemsRef.current.find((i) => i.id === id && i.tier !== "in_integration") ?? x;
    const before = overRef.current[id] ?? cur.decision;
    if (before === decision) return;
    const prevOver = overRef.current[id];
    const my = ++seq.current;
    pending.current.set(id, my);
    setOver((o) => ({ ...o, [id]: decision }));
    setBusy((b) => ({ ...b, [id]: true }));
    // 卡片写的是 next 字面量、选的又正是下一版：不带 milestone（服务端按 next 解析到同一版），免得顺手把 next 改成固定版本号
    const card = cardOf.get(id);
    const body: Record<string, string> = { feature: id, decision };
    if (!(card && card.milestone === "next" && sel === app.next)) body.milestone = sel;
    try {
      const r = await api<ReleaseDecisionResult>("/api/release/decision", { body });
      if (pending.current.get(id) === my) pending.current.delete(id);
      app.toast(firstSentence(r.data.message), opts.undoable === false ? {} : { undo: () => void decide(x, before, { undoable: false }) });
      pv.reload();
      app.refresh();
    } catch (e) {
      if (pending.current.get(id) === my) {
        pending.current.delete(id);
        setOver((o) => {
          const n = { ...o };
          if (prevOver === undefined) delete n[id];
          else n[id] = prevOver;
          return n;
        });
      }
      app.toast(`没改成：${(e as Error).message}`, { kind: "err" });
    } finally {
      if (!pending.current.has(id)) setBusy((b) => ({ ...b, [id]: false }));
    }
  };

  /* 整条轨道是落点：拖方块进来 = 决定改成「并入」 */
  const dropRef = useDropTarget(
    d
      ? {
          canDrop: (p: DragPayload) => {
            if (p.kind !== "card") return null;
            const x = (p.data as ReleaseItem | undefined) ?? items.find((i) => i.id === p.id);
            if (!x || !items.some((i) => i.id === x.id)) return { ok: false, hint: `不在 ${sel} 的合并单里` };
            if (x.tier === "unmergeable") return { ok: false, hint: `拼不上：${x.reason || "分支不存在或仓库未配置集成分支"}` };
            if (onTrack(x, eff(x))) return { ok: false, hint: "已经在轨道上" };
            return { ok: true, hint: "放到这里：排进合并单（并入）" };
          },
          onDrop: (p: DragPayload) => {
            const x = (p.data as ReleaseItem | undefined) ?? items.find((i) => i.id === p.id);
            if (x) void decide(x, "并入");
          },
        }
      : null,
  );

  /** M8：复制这一版的合并 Prompt；剪贴板写入必须在点击这一刻交出（Safari） */
  const copyPrompt = () => {
    if (!sel) return;
    const req = api<MergePromptData>("/api/release/prompt", { body: { milestone: sel } });
    const copied = copyWhenReady(req.then((r) => r.data.prompt));
    setMp({ data: null, copied: null, error: null });
    req
      .then(async (r) => {
        setMp({ data: r.data, copied: await copied, error: null });
        pv.reload();
      })
      .catch((e: Error) => setMp({ data: null, copied: false, error: e.message }));
  };
  const makePlan = async () => {
    if (!sel) return;
    setPlan({ busy: true, result: null, error: null });
    try {
      const r = await api<ReleasePlanResult>("/api/release/plan", { method: "POST", body: { milestone: sel } });
      setPlan({ busy: false, result: r.data, error: null });
      pv.reload();
    } catch (e) {
      setPlan({ busy: false, result: null, error: (e as Error).message });
    }
  };
  const toggleFiles = (k: string) =>
    setOpenFiles((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const toggleTier = (t: ReleaseTier) =>
    setClosed((s) => {
      const n = new Set(s);
      if (n.has(t)) n.delete(t);
      else n.add(t);
      return n;
    });

  const head = (tools: boolean) => (
    <PageHead icon="assembly" title="合流装配" desc="把这一版的方块按顺序摆上轨道：每一块能不能拼上、先合谁后合谁。只排单，不合并。">
      {tools && cands.length ? (
        <>
          <label class="as-ms">
            版本
            <select class="small" value={sel ?? ""} onChange={(e) => app.go("assembly", (e.currentTarget as HTMLSelectElement).value)} aria-label="选择要装配的版本">
              {cands.map((m) => (
                <option value={m.id}>
                  {m.id}
                  {m.title && m.title !== m.id ? ` ${m.title}` : ""}
                  {m.id === app.next ? "（下一版）" : ""} · {m.status}
                </option>
              ))}
            </select>
          </label>
          <button class="btn small" onClick={() => setSyncOpen(true)} title="在别处合并了分支？重新对账，把台账状态补上（先列出，你勾选后才写）">
            <Icon name="sync" size={15} />
            刚合并完？同步一下
          </button>
        </>
      ) : null}
    </PageHead>
  );
  const panels = (
    <>
      {mp ? (
        <MergePromptPanel
          st={mp}
          title={sel ?? ""}
          onClose={() => setMp(null)}
          onSync={() => {
            setMp(null);
            setSyncOpen(true);
          }}
        />
      ) : null}
      {syncOpen ? (
        <MergedPanel
          onClose={() => setSyncOpen(false)}
          onChanged={() => {
            pv.reload();
            app.refresh();
          }}
        />
      ) : null}
    </>
  );

  /* ── 前置空态 ── */
  if (!app.project) {
    return (
      <div class="page as-page">
        {head(false)}
        <Empty icon="start" title="还没有选项目" hint="先在「开始」里接入或选择一个项目。">
          <button class="btn primary" onClick={() => app.go("start")}>
            去「开始」
          </button>
        </Empty>
      </div>
    );
  }
  const msLoading = !app.milestones.length && !app.features && !app.featuresError;
  if (msLoading) {
    return (
      <div class="page as-page">
        {head(false)}
        <Skeleton />
      </div>
    );
  }
  if (!sel) {
    return (
      <div class="page as-page">
        {head(false)}
        <Empty
          icon="assembly"
          title={app.milestones.length ? "没有未发布的里程碑" : "还没有里程碑"}
          hint={app.milestones.length ? "已发布的版本不再装配：在看板或「今天」登记一个新点子会自动建 vNext。" : "在看板或「今天」登记一个新点子会自动建 vNext。"}
        >
          <button class="btn primary" onClick={() => app.go("kanban")}>
            去看板
          </button>
        </Empty>
        {panels}
      </div>
    );
  }

  /* ── 派生 ── */
  const q = app.query;
  const hit = (x: ReleaseItem) => matchQuery(q, x.title, x.id, ...x.bindings.map((b) => b.branch));
  const shown = items.filter(hit);
  const track = shown.filter((x) => onTrack(x, eff(x)));
  const trackAll = items.filter((x) => onTrack(x, eff(x)));
  const deferredIds = [...new Set(items.filter((x) => eff(x) === "顺延").map((x) => x.id))];
  const deferredItems = items.filter((x) => eff(x) === "顺延");
  const isSel = (id: string) => app.selected?.kind === "card" && app.selected.card.id === id;
  /* 看板同一列（key = 版本 id）：用来对照「撞了」的两个口径、找没绑分支的卡 */
  const col = app.features?.columns.find((c) => c.key === sel) ?? null;
  const boardConflict = app.features?.precheck && col ? col.cards.filter((c) => c.group === "conflict").length : null;
  const planConflict = d?.counts.conflict ?? 0;
  const basisDiff = boardConflict !== null && boardConflict !== planConflict;
  const basisText = `分堆按合并单档位，和看板按卡片分组口径不同：会话等你回答 / 正在运行、或卡片还是「想法 / 开发中」的，即使试合有冲突也归到「还没做完」；分支不存在、仓库没配集成分支的归到「拼不上」；合并单还按「卡 × 分支」一项一算。`;
  const unbound = col ? col.cards.filter((c) => !c.done && !c.bindings.length) : [];
  const pick = (id: string) => {
    const c = cardOf.get(id);
    if (c) app.select(isSel(id) ? null : { kind: "card", card: c });
  };

  return (
    <div class="page as-page">
      {head(true)}

      <div class="as-notice" role="note">
        <Icon name="alert" size={18} />
        <div>
          <p>
            <b>仅预演，不会执行合并（M4）。</b>试合用 merge-tree 在临时对象区进行，不改任何分支、不碰工作目录。真正合并：在终端运行 <code>heliu 合并 {sel}</code>
            ，看完摘要输入 yes 才开始。
          </p>
          {d?.warnings.map((w) => (
            <p class="as-warn">
              <b>注意：</b>
              {w}
            </p>
          ))}
        </div>
      </div>

      {d ? (
        <p class="as-meta">
          <span>试合于 {hms(d.generatedAt)}</span>
          <span class="sep">·</span>
          <span>用时 {(d.scanMs / 1000).toFixed(1)}s</span>
          <span class="sep">·</span>
          <span>
            与 <span class="mono">heliu 合并 {d.milestone.id} --预演</span> 同一套规则（同一个合并单构建器）
          </span>
          {pv.loading ? (
            <>
              <span class="sep">·</span>
              <span>正在重新试合…</span>
            </>
          ) : null}
        </p>
      ) : null}

      {pv.error ? <p class="err">读取合并预演失败：{pv.error}</p> : null}

      {!d && !pv.error ? (
        <Skeleton />
      ) : d ? (
        <>
          <div class="as-body">
            {/* ── 左栏：这一版的方块，按档分堆 ── */}
            <aside class="as-bins" aria-label="这一版的方块">
              <div class="as-col-head">
                <h2>这一版的方块</h2>
                <span class="count">{shown.length}</span>
              </div>
              <p class="as-col-hint">按住方块拖到右边的轨道 = 并入；鼠标移到一行上（或 Tab 到它、点一下）就能直接改决定。都只写合并单文件。</p>
              {basisDiff ? (
                <p class="as-basis">
                  {basisText}所以这里的「撞了 {planConflict}」{planConflict < (boardConflict ?? 0) ? "比" : "和"}看板的「撞了 {boardConflict}」{planConflict < (boardConflict ?? 0) ? "少" : "不一样"}。
                </p>
              ) : null}
              {!items.length ? (
                <Empty inline icon="info" title={`${d.milestone.id} 还没有待合入的功能。`} hint="预约到这一版、还没合入的功能卡会出现在这里。" />
              ) : !shown.length ? (
                <Empty inline icon="search" title={`没有匹配「${q.trim()}」的方块`} />
              ) : (
                TIERS.map((t) => {
                  const list = shown.filter((x) => x.tier === t.key);
                  if (!list.length) return null;
                  const open = !closed.has(t.key);
                  return (
                    <div class="block-group as-bin">
                      <GroupHead tone={t.tone} title={t.human} n={list.length} open={open} onToggle={() => toggleTier(t.key)} hint={t.hint} />
                      {open ? (
                        <div class="group-body">
                          <p class="hint">{t.hint}</p>
                          {list.map((x) => {
                            const dec = eff(x);
                            const placed = onTrack(x, dec);
                            const skip = x.tier === "in_integration";
                            const k = itemKey(x);
                            const changed = dec !== x.defaultDecision;
                            return (
                              <div class={`as-row${placed ? " placed" : ""}${rowOpen === k ? " open" : ""}${isSel(x.id) ? " sel" : ""}`} key={k}>
                                <Block
                                  m={modelOfItem(x, cardOf.get(x.id), app, sel)}
                                  density="compact"
                                  selected={isSel(x.id)}
                                  onClick={() => {
                                    setRowOpen(rowOpen === k ? null : k);
                                    pick(x.id);
                                  }}
                                  title={`${x.title}\n档位：${x.tierText} · ${x.reason}\n建议：${x.actionText}`}
                                  drag={placed ? undefined : { payload: { kind: "card", id: x.id, label: x.title, data: x } }}
                                />
                                <div class="as-row-sub">
                                  <TierPill x={x} />
                                  <Pill tone={DEC_TONE[dec] ?? "gray"} class="as-dec-pill" title={changed ? `默认是「${x.defaultDecision}」，合并单里已改成「${dec}」` : "默认决定"}>
                                    决定：{dec}
                                    {skip ? "（执行时跳过）" : placed ? " · 在轨道上" : ""}
                                    {changed ? " · 已改" : ""}
                                  </Pill>
                                  <span class="as-row-seg" role="group" aria-label={`${x.id} 的决定`}>
                                    <Seg
                                      small
                                      tone
                                      value={dec}
                                      options={optsFor(x, dec)}
                                      onChange={(v) => {
                                        if (!skip) void decide(x, v);
                                      }}
                                    />
                                  </span>
                                  {busy[x.id] ? <span class="as-busy">写入中…</span> : null}
                                </div>
                                {x.tier === "unmergeable" ? <p class="as-row-why">拼不上：{x.reason}</p> : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
              {unbound.length ? (
                <div class="as-unbound">
                  <p>
                    <b>还有 {unbound.length} 张卡没绑分支</b>：合并单里它们只能是「拼不上（没有绑定分支）」，不能并入，默认顺延。要让它们进这一版，先给它绑分支（在时间线或星图里把一条「还没登记」的分支拖到它上面）；要把它们挪走，在看板里改预约。
                  </p>
                  <div class="as-unbound-list">
                    {unbound.slice(0, 5).map((c) => (
                      <Block key={c.id} m={modelOfCard(c, { next: app.next })} density="mini" selected={isSel(c.id)} onClick={() => app.select(isSel(c.id) ? null : { kind: "card", card: c })} title={`${c.id} ${c.title}：点开看详情`} />
                    ))}
                  </div>
                  <div class="as-unbound-foot">
                    {unbound.length > 5 ? <span class="tiny muted">另外 {unbound.length - 5} 张在看板里看</span> : <span />}
                    <button class="btn xs" onClick={() => app.go("kanban")}>
                      去看板改预约
                    </button>
                  </div>
                </div>
              ) : null}
            </aside>

            {/* ── 右栏：合流轨道 ── */}
            <section class="as-main" aria-label="合流轨道">
              <div class="as-col-head">
                <h2>合流轨道</h2>
                <span class="count">{track.length}</span>
                <span class="right">从上到下 = 合并顺序</span>
              </div>
              <p class="as-col-hint">
                顺序：已进集成（执行时跳过）→ 无冲突 → 有冲突（只有 union 文件的在前，再按冲突文件数）→ 未能试合 → 未完成 → 无法合并。右边的开关改决定，同样只写合并单。
              </p>
              <div class="as-track" ref={dropRef}>
                {track.map((x) => {
                  const dec = eff(x);
                  const skip = x.tier === "in_integration";
                  const t = TIER[x.tier];
                  const k = itemKey(x);
                  const files = x.bindings.filter((b) => b.conflicts.length > 0);
                  const nFiles = files.reduce((a, b) => a + b.conflicts.length, 0);
                  return (
                    <div class={`as-slot${skip ? " skip" : ""}`} key={k}>
                      <span class={`as-node tone-${t.tone}`} title={`合并单第 ${x.order} 项`}>
                        {x.order}
                      </span>
                      <Block m={modelOfItem(x, cardOf.get(x.id), app, sel)} density="card" selected={isSel(x.id)} onClick={() => pick(x.id)} />
                      <div class="as-ctl">
                        <TierPill x={x} />
                        <span class="k">决定</span>
                        <Seg
                          small
                          tone
                          value={dec}
                          options={optsFor(x, dec)}
                          onChange={(v) => {
                            if (!skip) void decide(x, v);
                          }}
                        />
                        {skip ? <span class="as-skip-note">跳过：已在集成分支</span> : null}
                        {busy[x.id] ? <span class="as-busy">正在写入合并单…</span> : null}
                        {!skip && dec !== x.defaultDecision ? <span class="as-changed">默认是「{x.defaultDecision}」，已改成「{dec}」</span> : null}
                        <p class="as-advice">
                          <b>建议：</b>
                          {x.actionText}
                        </p>
                        {nFiles ? (
                          <>
                            <button class="btn xs as-files-btn" onClick={() => toggleFiles(k)} aria-expanded={openFiles.has(k)}>
                              撞了的 {nFiles} 个文件 {openFiles.has(k) ? "▴" : "▾"}
                            </button>
                            {openFiles.has(k) ? (
                              <ul class="as-files">
                                {files.flatMap((b) => [
                                  ...(files.length > 1 ? [<li class="repo" key={`${b.repo}|${b.branch}`}>{`${b.repoLabel} · ${b.branch}`}</li>] : []),
                                  ...b.conflicts.map((f) => <li key={`${b.repo}|${b.branch}|${f}`}>{f}</li>),
                                ])}
                              </ul>
                            ) : null}
                          </>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
                {!track.length ? (
                  <div class="as-track-empty">
                    <b>{trackAll.length ? `轨道上没有匹配「${q.trim()}」的方块` : "轨道还是空的"}</b>
                    {trackAll.length ? "清空标题栏的搜索就能看到全部。" : "把左边「能拼上」的方块拖到这里，就排进了合并单。"}
                  </div>
                ) : (
                  <div class="as-drop-line" aria-hidden="true">
                    拖方块到这里 = 并入
                  </div>
                )}
                <div class="as-conf-row">
                  <span class="as-conf" title="合流点：轨道上的方块按顺序合进各仓库的集成分支（在终端执行）">
                    <Icon name="arrow" size={18} />
                  </span>
                  <div class="as-conf-text">
                    <span class="t">合流点</span>
                    {d.repos.length ? (
                      d.repos.map((r) => (
                        <span class={`r${r.integration ? "" : " none"}`} title={r.integration ? `${r.repoLabel} 的集成分支` : "未配置集成分支，或配置的集成分支在本地不存在（见顶部提示）"}>
                          {r.repoLabel} → {r.integration ? <span class="mono">{r.integration}</span> : "未配置集成分支"}
                        </span>
                      ))
                    ) : (
                      <span class="r muted">这一版的合并单还没有涉及任何仓库</span>
                    )}
                  </div>
                </div>
              </div>

              {/* ── 预计顺延 · 合并单文件（事实，折叠） ── */}
              <details class="as-more">
                <summary>
                  预计顺延 <span class="n">{deferredIds.length}</span>
                  <span class="faint">·</span>
                  合并单文件
                  <Icon name="chevron" size={14} class="chev" />
                </summary>
                <div class="as-more-body">
                  <div class="panel tight">
                    <h3>
                      预计顺延 <span class="n">{deferredIds.length}</span>
                    </h3>
                    {deferredItems.length ? (
                      <ul>
                        {deferredItems.map((x) => (
                          <li>
                            {x.id} {x.title}：<span class="muted">{x.reason}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p class="muted">无</p>
                    )}
                    <p class="muted small">顺延 = 合并时没合完的功能挪到下一版并标「从 {d.milestone.id} 顺延」（由终端 heliu 合并 执行，不会静默丢弃）。</p>
                  </div>
                  <div class="panel tight">
                    <h3>合并单</h3>
                    <p class="small">
                      <span class="mono">{d.plan.file}</span>：
                      {d.plan.exists
                        ? d.plan.format === "board"
                          ? "现在是旧版看板草稿（不能直接执行），生成合并单时会先备份再覆盖。"
                          : `已存在 · ${d.plan.status ?? "草稿"}${d.plan.kept ? ` · 决定里保留了你改过的 ${d.plan.kept} 项` : ""}`
                        : "还没有。"}
                    </p>
                    <p class="small muted">
                      「生成合并单」= 在终端运行 <span class="mono">heliu 合并 {d.milestone.id} --预演</span>：写同一个文件、同一格式（保留你改过的决定），之后可以 <span class="mono">heliu release set</span> 改决定、
                      <span class="mono">heliu 合并 {d.milestone.id}</span> 在终端里逐条确认执行。<b>看板不会执行任何合并。</b>
                    </p>
                  </div>
                </div>
              </details>
            </section>
          </div>

          {/* ── 底部常驻条 ── */}
          <div class="as-dock">
            <div class="as-dock-in">
              <div class="as-dock-row">
                <div class="as-dock-stats">
                  <Stat sm n={trackAll.length} label="块在轨道上" tone="accent" title="决定为「并入」的项，加上已在集成分支（执行时跳过）的项" />
                  <Stat
                    sm
                    n={d.counts.conflict}
                    label="撞了"
                    tone={d.counts.conflict ? "red" : undefined}
                    title={`合并单档位口径：这一版里归到「撞了」的项数（不论决定，按卡 × 分支计）。${basisText}${boardConflict !== null ? `看板按卡片分组是「撞了 ${boardConflict}」。` : ""}`}
                  />
                  <Stat sm n={d.counts.precheck_failed} label="没试出来" tone={d.counts.precheck_failed ? "yellow" : undefined} title="这一版里请求了试合但没得到结果的项数：不算无冲突" />
                  <Stat sm n={deferredIds.length} label="预计顺延" title="决定为「顺延」的卡数" />
                </div>
                <div class="as-dock-acts">
                  <button class="btn" onClick={() => void makePlan()} disabled={plan.busy || !items.length} title="把这次预演写成合并单文件（保留你改过的决定），不执行合并">
                    {plan.busy ? "生成中…" : d.plan.exists && d.plan.format !== "board" ? "刷新合并单" : "生成合并单"}
                  </button>
                  <button class="btn primary" onClick={copyPrompt} title="刷新合并单，并把交给 Claude 会话的合并 Prompt 复制到剪贴板（不执行合并）">
                    <Icon name="copy" size={15} />
                    复制合并 Prompt
                  </button>
                </div>
              </div>
              {plan.result ? (
                <p class="as-dock-res ok">
                  已写入：<span class="mono">{plan.result.file}</span>（{plan.result.items} 项 · 状态 {plan.result.status} · 预计顺延 {plan.result.deferred} 张卡
                  {plan.result.kept ? ` · 保留了你改过的 ${plan.result.kept} 项决定` : ""}）
                  {plan.result.backup ? <span class="muted"> 旧的看板草稿已备份到 {plan.result.backup}</span> : null}
                </p>
              ) : null}
              {plan.error ? <p class="as-dock-res bad">没生成成：{plan.error}</p> : null}
              <p class="as-dock-rule">
                <b>
                  看板只排单，不执行合并：在终端运行 <span class="mono">heliu 合并 {d.milestone.id}</span>，看完摘要输入 yes 才开始。
                </b>
              </p>
            </div>
          </div>
        </>
      ) : null}
      {panels}
    </div>
  );
}

/** 加载中：左边几行、右边一条带槽位的轨道 */
function Skeleton() {
  return (
    <div class="as-body" aria-busy="true" aria-label="正在试合">
      <aside class="as-bins">
        <div class="as-col-head">
          <h2>这一版的方块</h2>
        </div>
        <div class="group-body" style="gap:8px">
          {[0, 1, 2, 3].map(() => (
            <div class="skeleton as-skel sm" />
          ))}
        </div>
      </aside>
      <section class="as-main">
        <div class="as-col-head">
          <h2>合流轨道</h2>
          <span class="right">正在试合（只读，临时对象区）…</span>
        </div>
        <div class="as-track">
          {[0, 1, 2].map(() => (
            <div class="as-slot">
              <span class="skeleton as-skel-node" />
              <div class="skeleton as-skel" />
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
