/** @jsxImportSource preact */
/**
 * 版本列（主视图）：列 = 里程碑（milestones.yaml 顺序）+ 未预约 + 已发布；卡片 = 功能卡。
 * 灯色与组名来自服务端（M2 待办分组函数 + --precheck），前端不另写一套规则。
 * 拖拽卡片到另一列 = 改预约（PATCH /api/features/:id，只写台账）。
 */
import { useState } from "preact/hooks";
import type { BaselineData, BoardCard, BoardColumn, CardBinding, FeaturesData, SyncView } from "../src/board/api-types.ts";
import type { LedgerMilestone } from "../src/types.ts";
import { ago, api, copyText, mdhm, MERGED_TEXT, SESSION_STATUS_TEXT, useApi } from "./lib.ts";
import { claudePrompt, type PromptMode } from "./prompt.ts";

const UNRESERVED = "__unreserved";

export function BoardPage({ tick, precheck, onChanged }: { tick: number; precheck: boolean; onChanged: () => void }) {
  const feats = useApi<FeaturesData>(`/api/features?precheck=${precheck ? 1 : 0}`, [tick]);
  const ms = useApi<{ milestones: LedgerMilestone[]; next: string | null }>("/api/milestones", [tick]);
  const [toast, setToast] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<{ card: BoardCard; data: BaselineData | null; error: string | null } | null>(null);
  const [sync, setSync] = useState<{ data: SyncView | null; error: string | null; busy: boolean } | null>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast((x) => (x === t ? null : x)), 3500);
  };
  const changed = () => {
    feats.reload();
    ms.reload();
    onChanged();
  };
  const patch = async (card: BoardCard, body: Record<string, unknown>, okText: string) => {
    try {
      await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body });
      flash(okText);
      changed();
    } catch (e) {
      flash(`没改成：${(e as Error).message}`);
    }
  };
  const reserve = (card: BoardCard, target: string | null) => {
    const name = target ?? "未预约";
    void patch(card, { milestone: target }, `已把 ${card.id} 改到 ${name}（已写入台账）`);
  };
  const openBaseline = async (card: BoardCard) => {
    setBaseline({ card, data: null, error: null });
    try {
      const r = await api<BaselineData>(`/api/features/${encodeURIComponent(card.id)}/baseline`);
      setBaseline({ card, data: r.data, error: null });
    } catch (e) {
      setBaseline({ card, data: null, error: (e as Error).message });
    }
  };
  const runSync = async (dry: boolean) => {
    setSync({ data: sync?.data ?? null, error: null, busy: true });
    try {
      const r = await api<SyncView>("/api/sync", { method: "POST", body: { dry_run: dry } });
      setSync({ data: r.data, error: null, busy: false });
      if (!dry) {
        flash(`已登记 ${r.data.created.length} 张草稿卡`);
        changed();
      }
    } catch (e) {
      setSync({ data: null, error: (e as Error).message, busy: false });
    }
  };

  const data = feats.env?.data;
  const milestones = ms.env?.data.milestones ?? [];
  if (feats.error && !data) return <p class="err">读取功能卡失败：{feats.error}</p>;
  if (!data) return <p class="muted">正在对账并试合（merge-tree 在临时区进行，不碰仓库）…</p>;

  return (
    <div>
      <NewIdea milestones={milestones} next={data.next} onDone={(t) => (flash(t), changed())} onError={(t) => flash(t)} />
      <div class="legend">
        {data.groups.map((g) => (
          <span title={g.hint}>
            <span class={`dot ${g.light}`} /> {g.title}
          </span>
        ))}
        <span>↑ 自己的提交 · ↓ 落后基线的提交</span>
        <span>绿灯 = 试合无冲突 ≠ 已验收；若落后基线，合并前请评估是否先同步</span>
        <span>拖卡片到另一列 = 改预约</span>
        {data.abandoned ? <span>另有 {data.abandoned} 张已放弃（不显示）</span> : null}
      </div>
      {data.broken.length ? <p class="err small">有 {data.broken.length} 个卡片文件读不出来：{data.broken.join("、")}</p> : null}
      <div class="cols">
        {data.columns.map((col) => (
          <Column
            col={col}
            data={data}
            milestones={milestones}
            dragId={dragId}
            over={over === col.key}
            onDragState={setDragId}
            onOver={(on) => setOver(on ? col.key : null)}
            onDrop={(id) => {
              setOver(null);
              setDragId(null);
              const card = data.columns.flatMap((c) => c.cards).find((c) => c.id === id);
              if (!card || card.column === col.key) return;
              if (!col.droppable) return flash(col.dropHint ?? "这一列不接受预约");
              reserve(card, col.key === UNRESERVED ? null : col.key);
            }}
            reserve={reserve}
            patch={patch}
            openBaseline={openBaseline}
            flash={flash}
          />
        ))}
      </div>
      <p class="muted small">
        台账位置：<span class="mono">{data.ledgerDir}</span>。还有分支没建卡？{" "}
        <button class="btn small" onClick={() => runSync(true)}>
          把现有分支登记成卡（先预览）
        </button>
      </p>
      {sync ? <SyncModal sync={sync} onRun={() => runSync(false)} onClose={() => setSync(null)} /> : null}
      {baseline ? <BaselineModal b={baseline} onClose={() => setBaseline(null)} /> : null}
      {toast ? <div class="toast">{toast}</div> : null}
    </div>
  );
}

function NewIdea({ milestones, next, onDone, onError }: { milestones: LedgerMilestone[]; next: string | null; onDone: (t: string) => void; onError: (t: string) => void }) {
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("next");
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      const r = await api<{ feature: { id: string; title: string; milestone: string | null } }>("/api/features", {
        method: "POST",
        body: { title, milestone: target === UNRESERVED ? null : target },
      });
      setTitle("");
      onDone(`已登记 ${r.data.feature.id}「${r.data.feature.title}」→ ${r.data.feature.milestone ?? "未预约"}`);
    } catch (err) {
      onError(`没登记成：${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form class="toolbar" onSubmit={submit}>
      <input type="text" placeholder="新点子：用一句话写需求，如「让背夹支持闹钟」" value={title} onInput={(e) => setTitle((e.currentTarget as HTMLInputElement).value)} />
      <select value={target} onChange={(e) => setTarget((e.currentTarget as HTMLSelectElement).value)} aria-label="预约到">
        <option value="next">预约到下一版{next ? `（${next}）` : ""}</option>
        {milestones
          .filter((m) => m.status === "规划中")
          .map((m) => (
            <option value={m.id}>预约到 {m.id}</option>
          ))}
        <option value={UNRESERVED}>先不预约</option>
      </select>
      <button class="btn primary" type="submit" disabled={busy || !title.trim()}>
        登记
      </button>
    </form>
  );
}

interface ColumnProps {
  col: BoardColumn;
  data: FeaturesData;
  milestones: LedgerMilestone[];
  dragId: string | null;
  over: boolean;
  onDragState: (id: string | null) => void;
  onOver: (on: boolean) => void;
  onDrop: (id: string) => void;
  reserve: (card: BoardCard, target: string | null) => void;
  patch: (card: BoardCard, body: Record<string, unknown>, okText: string) => Promise<void>;
  openBaseline: (card: BoardCard) => void;
  flash: (t: string) => void;
}

function Column(p: ColumnProps) {
  const { col, data } = p;
  const titles = new Map(data.groups.map((g) => [g.key, g.title]));
  const dragging = !!p.dragId;
  const cls = `col${p.over && col.droppable ? " drop" : ""}${dragging && !col.droppable ? " nodrop" : ""}`;
  // 卡片已按 M2 分组优先级排好；这里只在组变化处插小标题
  const rows: preact.JSX.Element[] = [];
  let lastGroup: string | null | undefined;
  for (const card of col.cards) {
    const g = groupKey(card);
    if (g !== lastGroup && col.kind !== "released") {
      const n = col.cards.filter((c) => groupKey(c) === g).length;
      const name = g === "__done" ? "已完成（不计入还欠）" : `${titles.get(card.group!) ?? g}${card.group === "mergeable" && card.note ? ` · ${card.note}` : ""}`;
      rows.push(<div class="grp">{`${name} · ${n}`}</div>);
      lastGroup = g;
    }
    rows.push(<Card {...p} card={card} />);
  }
  return (
    <section
      class={cls}
      onDragOver={(e) => {
        if (!dragging) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = col.droppable ? "move" : "none";
        if (!p.over) p.onOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) p.onOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        const id = e.dataTransfer?.getData("text/plain");
        if (id) p.onDrop(id);
      }}
    >
      <div class="col-h">
        <div class="t">
          {col.title} {col.isNext ? <span class="badge next">下一版</span> : null}
          {col.milestone && col.milestone.status !== "规划中" ? <span class="badge">{col.milestone.status}</span> : null}
        </div>
        {col.milestone?.title ? <div class="muted small">{col.milestone.title}</div> : null}
        {col.kind === "released" ? (
          <div class="owed muted">已发布 {col.cards.length} 项</div>
        ) : (
          <div class="owed">
            还欠 <b>{col.owed}</b> 项 · 可合 <b>{col.mergeable}</b> · 冲突 <b>{col.conflict ?? "未检查"}</b>
            {col.precheckFailed > 0 ? (
              <span class="warn" title={col.precheckSummary?.firstError ?? ""}>
                {" "}
                · 未能试合 <b>{col.precheckFailed}</b>
              </span>
            ) : null}{" "}
            · 等你 <b>{col.waiting}</b>
          </div>
        )}
      </div>
      {rows.length ? rows : <div class="empty">{col.kind === "unreserved" ? "没有未预约的卡（拖卡片到这里 = 取消预约）" : "还没有卡片"}</div>}
    </section>
  );
}

/** 组小标题的分组键：M2 组名；可合并再按细分（已进主线 / 已进集成分支 / 试合无冲突）分开 */
function groupKey(c: BoardCard): string {
  if (c.done) return "__done";
  if (c.group === "mergeable") return `mergeable:${c.note ?? ""}`;
  return c.group ?? "__none";
}

function Card(p: ColumnProps & { card: BoardCard }) {
  const { card } = p;
  const [open, setOpen] = useState(false);
  const cls = `card ${card.light}${card.variant === "merged-pending" ? " merged" : ""}${card.done ? " done" : ""}${p.dragId === card.id ? " dragging" : ""}`;
  return (
    <article
      class={cls}
      draggable
      onDragStart={(e) => {
        e.dataTransfer?.setData("text/plain", card.id);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
        p.onDragState(card.id);
      }}
      onDragEnd={() => {
        p.onDragState(null);
        p.onOver(false);
      }}
    >
      <div class={`light ${card.light}`}>
        <span class={`dot ${card.light}`} /> {card.lightText}
      </div>
      <div class="title">{card.title}</div>
      {card.nextStep ? <div class="next">{card.nextStep}</div> : null}
      {card.tags.length ? (
        <div class="tags">
          {card.tags.map((t) => (
            <span class={`tag ${t.kind}`}>{t.text}</span>
          ))}
        </div>
      ) : null}
      <div class="card-foot">
        {card.suggestStatus ? (
          <button class="btn small primary" title={card.suggestion ?? ""} onClick={() => void p.patch(card, { status: card.suggestStatus }, `${card.id} 已标为${card.suggestStatus}（已写入台账）`)}>
            标为{card.suggestStatus}
          </button>
        ) : null}
        <button class="expand" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          {open ? "收起 ▴" : "展开 ▾ 分支 · 提交数 · 操作"}
        </button>
      </div>
      {open ? <CardDetails {...p} /> : null}
    </article>
  );
}

function CardDetails(p: ColumnProps & { card: BoardCard }) {
  const { card } = p;
  const planned = p.milestones.filter((m) => m.status === "规划中");
  const others = p.milestones.filter((m) => m.status !== "规划中" && m.status !== "已发布");
  const onPick = (v: string) => {
    if (!v) return;
    if (v === "__new") {
      const name = window.prompt("新版本名（如 v1.3）：");
      if (name && name.trim()) p.reserve(card, name.trim());
      return;
    }
    p.reserve(card, v === UNRESERVED ? null : v);
  };
  return (
    <div class="menu">
      <div class="muted small">
        {card.id} · 台账：{card.status} · 验收：{card.acceptance}
        {card.rolledFrom.length ? ` · 从 ${card.rolledFrom[card.rolledFrom.length - 1]} 顺延` : ""}
        {card.lastActivityAt ? ` · 最后活动 ${mdhm(card.lastActivityAt)}（${ago(card.lastActivityAt)}）` : ""}
      </div>
      {card.bindings.length === 0 ? <div class="muted small">还没关联开发分支</div> : null}
      {card.bindings.map((b) => (
        <BindingRow b={b} flash={p.flash} prompt={promptMode(card)} />
      ))}
      {card.suggestion ? <div class="sugg">M2 建议：{card.suggestion}</div> : null}
      <div class="row">
        <span class="small">改预约：</span>
        <select value="" onChange={(e) => onPick((e.currentTarget as HTMLSelectElement).value)}>
          <option value="">（选一个版本）</option>
          {planned.map((m) => (
            <option value={m.id} disabled={m.id === card.column}>
              {m.id}
              {m.id === card.column ? "（当前）" : ""}
            </option>
          ))}
          {others.map((m) => (
            <option value={m.id} disabled>
              {m.id}（{m.status}，不接新预约）
            </option>
          ))}
          <option value={UNRESERVED} disabled={card.column === UNRESERVED}>
            未预约
          </option>
          <option value="__new">新版本…</option>
        </select>
      </div>
      <div class="row">
        <button
          class="btn small"
          onClick={() => {
            const t = window.prompt("新标题：", card.title);
            if (t && t.trim() && t.trim() !== card.title) void p.patch(card, { title: t.trim() }, `已改名为「${t.trim()}」`);
          }}
        >
          改名
        </button>
        <button
          class="btn small"
          onClick={() => {
            if (window.confirm(`把 ${card.id}「${card.title}」标记为已放弃？（只改台账状态，不动分支）`)) void p.patch(card, { status: "已放弃" }, `${card.id} 已标记为放弃`);
          }}
        >
          标记放弃
        </button>
        {card.bindings.some((b) => b.exists) ? (
          <button class="btn small" onClick={() => p.openBaseline(card)} title="试合主线/集成分支到本分支，只看冲突文件，不执行">
            同步基线（预演）
          </button>
        ) : null}
      </div>
      <div class="muted small">
        卡片文件：<span class="mono">{card.file}</span>
      </div>
    </div>
  );
}

function branchShown(b: CardBinding): string {
  return b.randomName && b.label ? b.label : b.branch;
}

/** 哪些卡给「复制给 Claude 会话」：需解冲突 → 合并进来；需同步基线（含可合并但落后的）→ 同步基线 */
function promptMode(card: BoardCard): PromptMode | null {
  if (card.group === "conflict") return "conflict";
  if (card.group === "behind" || (card.group === "mergeable" && card.tags.some((t) => t.kind === "behind"))) return "sync";
  return null;
}

function BindingRow({ b, flash, prompt }: { b: CardBinding; flash: (t: string) => void; prompt?: PromptMode | null }) {
  const copyBranch = () => void copyText(b.branch).then((ok) => ok && flash(`已复制分支名 ${b.branch}`));
  if (!b.exists) {
    return (
      <div class="bind">
        <span class="badge repo">{b.repoLabel}</span> <span class="br mono">{b.branch}</span> <span class="muted">· 分支在本地已不存在</span>
      </div>
    );
  }
  const base = b.integration ? "集成分支" : "主线";
  const behind = (b.integration ? b.vsIntegration?.behind : b.vsMain?.behind) ?? 0;
  const ahead = (b.integration ? b.vsIntegration?.ahead : b.vsMain?.ahead) ?? 0;
  return (
    <div class="bind">
      <div>
        <span class="badge repo">{b.repoLabel}</span>{" "}
        <span class="br" title={`分支：${b.branch}`}>
          {branchShown(b)}
          {b.randomName ? <span class="muted small">（随机名，悬停看原名）</span> : null}
        </span>
      </div>
      {b.randomName && b.label ? <div class="mono small muted br">{b.branch}</div> : null}
      <div class="nums">
        {b.vsMain ? (
          <>
            主线 <b>↑{b.vsMain.ahead}</b> <b>↓{b.vsMain.behind}</b>
          </>
        ) : null}
        {b.vsIntegration ? (
          <>
            {" "}
            · 集成 <b>↑{b.vsIntegration.ahead}</b> <b>↓{b.vsIntegration.behind}</b>
          </>
        ) : null}
        {b.mergedState ? <> · {MERGED_TEXT[b.mergedState]}</> : null}
      </div>
      <div class="explain">
        {behind > 0 ? `↓${behind} 落后${base} ${behind} 个提交` : `不落后${base}`}
        {ahead > 0 ? ` · ↑${ahead} 本分支有 ${ahead} 个${base}没有的提交` : ""}
        {b.conflictFiles !== null && b.conflictFiles > 0 ? ` · 试合到 ${b.precheckTarget} 冲突 ${b.conflictFiles} 个文件` : ""}
        {b.precheckState === "failed" ? ` · 未能试合（${b.precheckError ?? "原因未知"}），不代表无冲突` : ""}
      </div>
      {b.worktree ? <div class="explain br">目录：{b.worktree}</div> : null}
      {b.session ? (
        <div class="explain">
          会话：{b.session.title ?? b.session.id} · {SESSION_STATUS_TEXT[b.session.status ?? "unknown"] ?? b.session.status}
          {b.session.lastActivityAt ? ` · ${mdhm(b.session.lastActivityAt)}` : ""}
        </div>
      ) : null}
      <div class="row" style="margin-top:4px">
        <button class="btn small" onClick={copyBranch}>
          复制分支名
        </button>
        {prompt && b.mergedState === "unmerged" ? (
          <button
            class="btn small"
            title="只复制一段中文指令，粘贴到该分支的 Claude 会话里；看板不执行任何 git 操作"
            onClick={() => void copyText(claudePrompt(prompt, b)).then((ok) => ok && flash("已复制：粘贴到该分支的 Claude 会话里"))}
          >
            复制给 Claude 会话
          </button>
        ) : null}
        {b.session?.link ? (
          <a class="btn small" href={b.session.link}>
            打开会话
          </a>
        ) : b.session ? (
          <>
            <button class="btn small" disabled title="会话记录里没有 claude:// 链接">
              打开会话（无链接）
            </button>
            <button class="btn small" onClick={() => void copyText(b.session!.id).then((ok) => ok && flash("已复制会话 ID"))}>
              复制会话 ID
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}

function BaselineModal({ b, onClose }: { b: { card: BoardCard; data: BaselineData | null; error: string | null }; onClose: () => void }) {
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <h3>同步基线（预演）· {b.card.id} {b.card.title}</h3>
        <p class="banner small">
          <b>只预演，不执行：</b>用 merge-tree 在临时对象区试合「主线 / 集成分支 → 本分支」，只列冲突文件，不改任何分支或目录。
        </p>
        {b.error ? <p class="err">{b.error}</p> : null}
        {!b.data && !b.error ? <p class="muted">试合中…</p> : null}
        {b.data?.bindings.map((x) => (
          <div class="stack">
            <h3>
              <span class="badge repo">{x.repoLabel}</span> <span class="mono">{x.branch}</span>
            </h3>
            {!x.exists ? <p class="muted">分支在本地不存在</p> : null}
            {x.checks.map((c) => (
              <div class="panel">
                <div>
                  把 <b>{c.base === "main" ? "主线" : "集成分支"}</b> <span class="mono">{c.baseBranch}</span> 合入本分支：
                  {c.error ? (
                    <span class="err"> 未完成（{c.error}）</span>
                  ) : c.conflictFiles === 0 ? (
                    <span class="ok"> 无冲突</span>
                  ) : (
                    <span class="light red"> 冲突 {c.conflictFiles} 个文件</span>
                  )}
                </div>
                <div class="muted small">本分支落后它 {c.behind ?? "?"} 个提交{c.behind === 0 ? "（已是最新，无需同步）" : ""}</div>
                {c.conflicts.length ? (
                  <ul class="files">
                    {c.conflicts.map((f) => (
                      <li class="mono">{f}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        ))}
        {b.data ? <p class="muted small">用时 {(b.data.elapsedMs / 1000).toFixed(1)}s。真要同步请在该分支的会话里自己执行（或用桌面应用的同步按钮）。</p> : null}
        <button class="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}

function SyncModal({ sync, onRun, onClose }: { sync: { data: SyncView | null; error: string | null; busy: boolean }; onRun: () => void; onClose: () => void }) {
  const d = sync.data;
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <h3>把现有分支登记成功能卡</h3>
        <p class="muted small">只写台账：在 worktree 里开发、还没有功能卡、尚未合入主线的分支，各建一张草稿卡，预约到下一版。</p>
        {sync.error ? <p class="err">{sync.error}</p> : null}
        {sync.busy ? <p class="muted">处理中…</p> : null}
        {d ? (
          <div>
            <p>
              {d.dryRun ? "预览：将建" : "已建"} <b>{d.dryRun ? d.drafts.length : d.created.length}</b> 张草稿卡 → 预约 {d.milestone ?? "vNext（将自动创建）"}
            </p>
            <p class="muted small">
              跳过：已有功能卡 {d.skipped.hasCard} · 已进主线 {d.skipped.inMain} · 没有独立 worktree {d.skipped.noWorktree} · 主线/集成分支 {d.skipped.notFeature}
            </p>
            <ul class="files">
              {d.drafts.slice(0, 40).map((x) => (
                <li>
                  {x.id ? `${x.id} ` : ""}
                  {x.title} <span class="muted">· {x.repoLabel} · {x.branch}</span>
                </li>
              ))}
              {d.drafts.length > 40 ? <li class="muted">…还有 {d.drafts.length - 40} 条</li> : null}
            </ul>
            {d.dryRun && d.drafts.length ? (
              <button class="btn primary" onClick={onRun} disabled={sync.busy}>
                确认登记这 {d.drafts.length} 张
              </button>
            ) : null}{" "}
          </div>
        ) : null}
        <button class="btn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
