/** @jsxImportSource preact */
/**
 * 今天（M10，替代旧「总览」）：第一眼 10 秒看懂——下一版还欠多少、几块能拼上、几块等你；现在先做哪一件；最近动了哪些方块。
 * - 数字一律来自服务端（overview / features 的 owed、group、light），这里只做加总，不自己判断 git 事实。
 * - 「下一版」大方块是落点：把「最近动的」方块拖进来 = 预约到下一版（PATCH /api/features/:id，只写台账），toast 带撤销。
 * - 「我有个新点子…」= POST /api/features {title, milestone:"next"}，只写台账（没有规划中的版本时服务端会建 vNext）。
 */
import { useEffect, useState } from "preact/hooks";
import type { BoardCard } from "../../src/board/api-types.ts";
import type { TodoGroupKey } from "../../src/types.ts";
import { milestoneLabel, useApp, type Tab } from "../app.tsx";
import { useDropTarget } from "../dnd.ts";
import { api } from "../lib.ts";
import { Bar, Block, Dot, Empty, GROUPS, Icon, MILESTONE_TONE, PageHead, Pill, matchQuery, modelOfCard, type Tone } from "../ui.tsx";

/** 下一版分段条的五段：颜色 = 人话；keys = 服务端 group；pick = 点图例时带给看板的筛选（灰段不筛） */
const PARTS: Array<{ tone: Tone; label: string; keys: TodoGroupKey[]; pick: TodoGroupKey | null; hint: string }> = [
  { tone: "green", label: "能拼上", keys: ["mergeable"], pick: "mergeable", hint: GROUPS.find((g) => g.key === "mergeable")!.hint },
  { tone: "yellow", label: "要先对齐", keys: ["behind"], pick: "behind", hint: GROUPS.find((g) => g.key === "behind")!.hint },
  { tone: "red", label: "撞了", keys: ["conflict"], pick: "conflict", hint: GROUPS.find((g) => g.key === "conflict")!.hint },
  { tone: "purple", label: "等你拍板", keys: ["blocked"], pick: "blocked", hint: GROUPS.find((g) => g.key === "blocked")!.hint },
  { tone: "gray", label: "还在做", keys: ["active", "stale", "unbound"], pick: null, hint: "开发中、很久没动静，或还没绑分支" },
];

const RECENT_N = 6;
const msg = (e: unknown): string => (e as Error)?.message ?? String(e);

export function HomeView() {
  const app = useApp();
  const ov = app.overview;
  const feats = app.features;

  /* 下一版：id 先看里程碑接口，没到再看 features / overview 带的 */
  const nextId = app.next ?? feats?.next ?? ov?.next?.id ?? null;
  const nextKnown = !!app.next || !!feats || !!ov;
  const nextMs = nextId ? (app.milestones.find((m) => m.id === nextId) ?? null) : null;
  const nextStatus = nextMs?.status ?? feats?.nextStatus ?? ov?.next?.status ?? null;
  const nextName = nextId ? milestoneLabel(nextId, app.milestones, app.next) : null;

  /* 乐观更新：刚拖进下一版的卡，在数据刷新前先显示成下一版 */
  const [moved, setMoved] = useState<Record<string, true>>({});
  useEffect(() => setMoved({}), [feats]);

  const reserve = async (card: BoardCard) => {
    if (!nextId) return;
    // 原值（撤销用）：与详情面板同一口径
    const back = card.milestone === "next" ? (app.next ?? null) : card.column === "__unreserved" ? null : card.milestone;
    const backName = back ? milestoneLabel(back, app.milestones, app.next) : "未预约";
    setMoved((o) => ({ ...o, [card.id]: true }));
    try {
      await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body: { milestone: nextId } });
      app.toast(`${card.id} → ${nextName ?? nextId}（已写入台账）`, {
        undo: async () => {
          try {
            await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body: { milestone: back } });
            app.toast(`已撤销：${card.id} 改回${backName}`);
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
      setMoved((o) => {
        const n = { ...o };
        delete n[card.id];
        return n;
      });
      app.toast(`没改成：${msg(e)}`, { kind: "err" });
    }
  };

  const dropRef = useDropTarget({
    canDrop: (p) => {
      if (p.kind !== "card") return null;
      const card = p.data as BoardCard;
      if (!nextId) return { ok: false, hint: "还没有规划中的版本" };
      if (card.column === nextId || moved[card.id]) return { ok: false, hint: "已经在这一版里了" };
      if (card.done || card.column === "__released") return { ok: false, hint: "已完成的卡不再改预约" };
      return { ok: true, hint: `放到这里：预约到 ${nextName ?? nextId}` };
    },
    onDrop: (p) => reserve(p.data as BoardCard),
  });

  if (!app.project) {
    return (
      <div class="page hm">
        <PageHead icon="home" title="今天" desc="下一版还欠多少、现在先做哪一件" />
        <Empty icon="start" title="还没有选项目" hint="先在「开始」里接入或选择一个项目。">
          <button class="btn primary" onClick={() => app.go("start")}>
            去「开始」
          </button>
        </Empty>
      </div>
    );
  }

  /* 下一版的计数：还欠 = overview 列头口径；分段 = 下一版列里未完成的卡按 group 加总 */
  const ovNext = ov?.columns.find((c) => c.isNext) ?? null;
  const fNext = feats?.columns.find((c) => c.isNext) ?? null;
  const owed = ovNext?.owed ?? fNext?.owed ?? null;
  const conflictCount = ovNext ? ovNext.conflict : fNext ? fNext.conflict : null;
  const unchecked = !app.precheck || conflictCount === null;
  const precheckFailed = ovNext?.precheckFailed ?? fNext?.precheckFailed ?? 0;
  const parts = PARTS.map((p) => ({
    ...p,
    n: fNext ? fNext.cards.filter((c) => !c.done && c.group !== null && p.keys.includes(c.group)).length : 0,
  }));

  /* 最近动的：全部未完成的卡按最后活动倒序；标题栏搜索同样过滤 */
  const recent = feats
    ? feats.columns
        .flatMap((c) => c.cards)
        .filter((c) => !c.done && !!c.lastActivityAt)
        .filter((c) => matchQuery(app.query, c.title, c.id, ...c.bindings.map((b) => b.branch), ...c.bindings.map((b) => b.label)))
        .sort((a, b) => Date.parse(b.lastActivityAt!) - Date.parse(a.lastActivityAt!))
        .slice(0, RECENT_N)
    : null;

  return (
    <div class="page hm">
      {app.featuresError ? <p class="err hm-err">读取功能卡失败：{app.featuresError}</p> : null}
      <PageHead
        icon="home"
        title="今天"
        desc={
          <>
            <b class="hm-proj">{app.project}</b> · 下一版还欠多少、现在先做哪一件
          </>
        }
      />

      {/* ① 下一版大方块（同时是落点） */}
      <section class={`panel hm-next${nextId ? "" : " none"}`} ref={dropRef} aria-label="下一版">
        <span class="hm-studs" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <div class="hm-next-main">
          <div class="hm-next-head">
            <Pill brand>下一版</Pill>
            {!nextKnown ? (
              <span class="skeleton hm-sk-title" />
            ) : nextId ? (
              <>
                <h2 class="hm-next-id">{nextId}</h2>
                {nextMs?.title && nextMs.title !== nextMs.id ? <span class="hm-next-title">{nextMs.title}</span> : null}
                {nextStatus ? (
                  <Pill tone={MILESTONE_TONE[nextStatus] ?? "gray"} outline>
                    {nextStatus}
                  </Pill>
                ) : null}
                {nextMs?.target_date ? (
                  <span class="hm-next-date" title="里程碑的目标日期（台账 milestones.yaml）">
                    <Icon name="calendar" size={15} />
                    目标 {nextMs.target_date}
                  </span>
                ) : null}
              </>
            ) : (
              <h2 class="hm-next-id hm-none">还没有规划中的版本</h2>
            )}
          </div>

          {!nextKnown ? (
            <div class="hm-next-body">
              <span class="skeleton hm-sk-num" />
              <div class="hm-progress">
                <span class="skeleton hm-sk-bar" />
                <span class="skeleton hm-sk-line" />
              </div>
            </div>
          ) : nextId ? (
            <>
              <div class="hm-next-body">
                {owed === null ? (
                  <span class="skeleton hm-sk-num" />
                ) : (
                  <div
                    class="stat clickable hm-owed"
                    role="button"
                    tabIndex={0}
                    title="还欠 = 预约到这一版、台账状态还是 想法 / 开发中 / 待合并 的功能卡。点开看板"
                    onClick={() => app.go("kanban")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        app.go("kanban");
                      }
                    }}
                  >
                    <span class="k hm-owed-k">还欠</span>
                    <span class="v">
                      {owed}
                      <small>块</small>
                    </span>
                  </div>
                )}
                <div class="hm-progress">
                  {fNext ? (
                    <>
                      <Bar parts={parts} thick title="比例 = 张数；颜色来自服务端的灯色 / 分组" />
                      <div class="bar-legend hm-legend">
                        {parts.map((p) => {
                          const unk = p.tone === "red" && unchecked;
                          return (
                            <button
                              type="button"
                              onClick={() => app.go("kanban", p.pick ? `g:${p.pick}` : null)}
                              title={unk ? "还没做冲突检查（试合），不知道哪些撞了；标题栏「冲突检查」可以检查" : `${p.hint}。点开看板${p.pick ? "只看这一组" : ""}`}
                            >
                              <Dot tone={p.tone} />
                              {p.label}
                              {unk ? <span class="hm-unk">未检查</span> : <b>{p.n}</b>}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <>
                      <span class="skeleton hm-sk-bar" />
                      <span class="skeleton hm-sk-line" />
                    </>
                  )}
                  {unchecked || precheckFailed > 0 ? (
                    <p class="hm-facts">
                      {unchecked ? <span>冲突还没检查：「撞了」暂时不知道几块</span> : null}
                      {precheckFailed > 0 ? <span class="warn">{precheckFailed} 块没试出来（不算无冲突）</span> : null}
                    </p>
                  ) : null}
                </div>
              </div>
              <p class="hm-drop-tip">
                <Icon name="grip" size={15} />
                把下面「最近动的」方块拖到这里 = 预约到 {nextName}（只写台账）
              </p>
            </>
          ) : (
            <p class="hm-none-hint">下面登记一个新点子时，会自动建一个「vNext」作为下一版；也可以先去看板看看各版本。</p>
          )}
        </div>
        <div class="hm-next-side">
          {nextId ? (
            <>
              <button class="btn brand hm-cta" onClick={() => app.go("assembly")}>
                去装配 <Icon name="arrow" size={17} />
              </button>
              <button class="btn hm-cta2" onClick={() => app.go("kanban")}>
                <Icon name="kanban" size={16} /> 看看板
              </button>
            </>
          ) : (
            <button class="btn primary hm-cta" onClick={() => app.go("kanban")}>
              去看板 <Icon name="arrow" size={17} />
            </button>
          )}
        </div>
      </section>

      {/* ② 我有个新点子… */}
      <IdeaBox nextName={nextName} />

      {/* ③ 现在最该做的 */}
      <div class="section-title">
        <h2>现在最该做的</h2>
        {ov ? <span class="count">{ov.actions.length}</span> : null}
      </div>
      {!ov ? (
        <div class="hm-actions">
          <span class="skeleton hm-sk-row" />
          <span class="skeleton hm-sk-row" />
        </div>
      ) : ov.actions.length ? (
        <ol class="hm-actions">
          {ov.actions.map((a, i) => (
            <ActionRow text={a} n={i + 1} />
          ))}
        </ol>
      ) : (
        <Empty inline icon="check" title="暂时没有需要马上处理的事" />
      )}
      <p class="hm-note">箭头前是事实，箭头后是建议；heliu 不会替你执行任何 git 写操作。</p>

      {/* ④ 最近动的 */}
      <div class="section-title">
        <h2>最近动的</h2>
        {recent && recent.length ? <span class="count">{recent.length}</span> : null}
        <span class="right">{nextId ? `按住拖到上面的「下一版」= 预约到 ${nextName}` : "点一块看详情"}</span>
      </div>
      {!recent ? (
        <div class="hm-recent">
          <span class="skeleton hm-sk-block" />
          <span class="skeleton hm-sk-block" />
          <span class="skeleton hm-sk-block" />
        </div>
      ) : recent.length ? (
        <div class="hm-recent block-list-enter">
          {recent.map((card) => {
            const base = modelOfCard(card, { next: app.next });
            const m = moved[card.id] && nextId ? { ...base, milestone: nextId } : base;
            return (
              <Block
                key={card.id}
                m={m}
                density="card"
                selected={app.selected?.kind === "card" && app.selected.card.id === card.id}
                onClick={() => app.select({ kind: "card", card })}
                drag={{ payload: { kind: "card", id: card.id, label: card.id, data: card } }}
                title="点开看详情；按住拖到「下一版」= 预约"
              />
            );
          })}
        </div>
      ) : (
        <Empty
          inline
          icon={app.query.trim() ? "search" : "clock"}
          title={app.query.trim() ? `没有匹配「${app.query.trim()}」的方块` : "最近还没有动静"}
          hint={app.query.trim() ? "清空标题栏的搜索再看看。" : "绑定了分支或会话的功能卡有了提交 / 会话活动，就会出现在这里。"}
        />
      )}

      {/* ⑤ 健康 */}
      <div class="section-title">
        <h2>健康</h2>
        <span class="right">只看本地已有的引用；heliu 从不 fetch</span>
      </div>
      <Health />
    </div>
  );
}

/* ───────────── 我有个新点子… ───────────── */

function IdeaBox({ nextName }: { nextName: string | null }) {
  const app = useApp();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const off = !app.project;
  const submit = async (e: Event) => {
    e.preventDefault();
    const t = title.trim();
    if (!t || busy || off) return;
    setBusy(true);
    try {
      const r = await api<{ feature: { id: string; title: string; milestone: string | null }; milestoneCreated: string | null }>("/api/features", {
        method: "POST",
        body: { title: t, milestone: "next" },
      });
      const f = r.data.feature;
      setTitle("");
      const where = f.milestone ? milestoneLabel(f.milestone, app.milestones, app.next) : "未预约";
      app.toast(`已登记 ${f.id}，预约 ${where}${r.data.milestoneCreated ? `（新建了版本 ${r.data.milestoneCreated}）` : ""}`);
      app.reloadFeatures();
      app.refresh();
    } catch (err) {
      app.toast(`没登记成：${msg(err)}`, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form class="hm-idea" onSubmit={(e) => void submit(e)}>
        <Icon name="spark" size={20} class="hm-idea-icon" />
        <input
          type="text"
          value={title}
          placeholder="我有个新点子…（一句话就行，回车登记）"
          aria-label="新点子：一句话写需求"
          disabled={off || busy}
          maxLength={200}
          onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setTitle("");
          }}
        />
        <button class="btn primary" type="submit" disabled={off || busy || !title.trim()}>
          {busy ? "登记中…" : "登记到下一版"}
        </button>
      </form>
      <p class="hm-idea-note">只写台账：新建一张「想法」状态的功能卡，预约到{nextName ? ` ${nextName}` : "下一版"}。</p>
    </>
  );
}

/* ───────────── 现在最该做的：一句一个方块行 ───────────── */

/** 句子 → 该去哪一页。顺序有讲究：跨仓配对句里含「会话」、独立分支句里含「集成分支」，所以先判断它们 */
function actionTarget(a: string): { tab: Tab; sub: string | null; label: string } {
  if (a.includes("跨仓配对")) return { tab: "structure", sub: "pairing", label: "去配对" };
  if (a.includes("独立分支")) return { tab: "kanban", sub: null, label: "去看板" };
  if (a.includes("集成分支")) return { tab: "assembly", sub: null, label: "去装配" };
  if (a.includes("会话")) return { tab: "sessions", sub: null, label: "去会话页" };
  if (a.includes("卫生")) return { tab: "hygiene", sub: null, label: "去卫生页" };
  return { tab: "kanban", sub: null, label: "去看板" };
}

function ActionRow({ text, n }: { text: string; n: number }) {
  const app = useApp();
  const k = text.indexOf("→");
  const fact = k >= 0 ? text.slice(0, k).trim() : text;
  const sugg = k >= 0 ? text.slice(k + 1).trim() : "";
  const t = actionTarget(text);
  return (
    <li class="hm-action">
      <span class="hm-num" aria-hidden="true">
        {n}
      </span>
      <p class="hm-action-text">
        <span class="hm-fact">{fact}</span>
        {sugg ? (
          <>
            <span class="hm-arrow">→</span>
            <span class="hm-sugg">{sugg}</span>
          </>
        ) : null}
      </p>
      <button class="btn small" onClick={() => app.go(t.tab, t.sub)}>
        {t.label} <Icon name="chevron-right" size={14} />
      </button>
    </li>
  );
}

/* ───────────── 健康小行：口径全部沿用 OverviewData ───────────── */

function Health() {
  const app = useApp();
  const ov = app.overview;
  if (!ov) {
    return (
      <div class="hm-health">
        <span class="skeleton hm-sk-pill" />
        <span class="skeleton hm-sk-pill" />
        <span class="skeleton hm-sk-pill" />
      </div>
    );
  }
  return (
    <div class="hm-health">
      {ov.integrations.length ? (
        ov.integrations.map((i) => {
          const red = i.days !== null && i.days >= 3;
          return (
            <div
              class={`hm-hitem tone-${red ? "red" : "gray"}`}
              title={`${i.branch}：比主线多 ${i.ahead ?? "?"} 个提交，还没合回主线${red ? "（≥3 天，标红）" : ""}`}
            >
              <Dot tone={red ? "red" : "gray"} />
              <span>
                {i.repoLabel}集成分支 <b>{i.days ?? "?"}</b> 天未并回
                <span class="hm-sub">（领先主线 {i.ahead ?? "?"} 个提交）</span>
              </span>
            </div>
          );
        })
      ) : (
        <div class="hm-hitem tone-gray" title="没有「存在且还没并回主线」的集成分支（也可能是仓库没配置集成分支）">
          <Dot tone="gray" />
          <span>没有未并回的集成分支</span>
        </div>
      )}
      <div class="hm-hitem tone-gray" title="本地找不到同名远端分支引用：可能从没推送过，也可能只是没 fetch（heliu 从不 fetch，不等于远端一定没有）">
        <Dot tone="gray" />
        <span>
          本地无远端引用 <b>{ov.neverPushed}</b> 个分支
        </span>
      </div>
      {ov.waiting > 0 ? (
        <button type="button" class="hm-hitem tone-purple" onClick={() => app.go("sessions")} title="会话停下来等你回答；点开会话页">
          <Dot tone="purple" />
          <span>
            等你处理 <b>{ov.waiting}</b> 个会话
          </span>
          <Icon name="chevron-right" size={14} class="hm-chev" />
        </button>
      ) : (
        <button type="button" class="hm-hitem tone-gray" onClick={() => app.go("sessions")} title="点开会话页">
          <Dot tone="gray" />
          <span>没有会话在等你</span>
          <Icon name="chevron-right" size={14} class="hm-chev" />
        </button>
      )}
      {ov.hygieneWarnings > 0 ? (
        <button type="button" class="hm-hitem tone-yellow" onClick={() => app.go("hygiene")} title="该清理的 worktree 与分支（只建议，不动手）；点开卫生页">
          <Dot tone="yellow" />
          <span>
            卫生警告 <b>{ov.hygieneWarnings}</b> 条
          </span>
          <Icon name="chevron-right" size={14} class="hm-chev" />
        </button>
      ) : null}
    </div>
  );
}
