/** @jsxImportSource preact */
/**
 * 右侧详情（M10）：点任意方块滑入。功能卡 → 人话 + 事实、改预约 / 类型 / 模块 / 状态、每条绑定的分支事实与可复制指令、
 * 同步基线预演、排进合并单；没卡的分支 → 分支事实 + 一键登记为功能卡。所有写操作只写台账 / 合并单。
 */
import { useEffect, useState } from "preact/hooks";
import type { BaselineData, BoardCard, CardBinding, ReleaseDecisionResult } from "../src/board/api-types.ts";
import { FEATURE_TYPES } from "../src/core/classify.ts";
import { FEATURE_STATUSES } from "../src/types.ts";
import { milestoneLabel, useApp, type Selection } from "./app.tsx";
import { ago, api, copyText, mdhm, MERGED_TEXT, SESSION_STATUS_TEXT } from "./lib.ts";
import { claudePrompt } from "./prompt.ts";
import { Chip, CopyBtn, Icon, Pill, glyphOf, MILESTONE_TONE, modelOfBranch, modelOfCard, type Tone } from "./ui.tsx";

export function Inspector() {
  const app = useApp();
  const sel = app.selected;
  // 关闭时保留上一份内容做滑出动画
  const [last, setLast] = useState<Selection | null>(sel);
  useEffect(() => {
    if (sel) setLast(sel);
  }, [sel]);
  const show = sel ?? last;
  return (
    <aside class={`inspector${sel ? " open" : ""}`} aria-hidden={!sel} aria-label="方块详情">
      {show ? show.kind === "card" ? <CardDetail key={show.card.id} card={show.card} /> : <BranchDetail key={`${show.repo}|${show.branch.branch}`} sel={show} /> : null}
    </aside>
  );
}

/* ───────────── 功能卡 ───────────── */

function CardDetail({ card }: { card: BoardCard }) {
  const app = useApp();
  const m = modelOfCard(card, { next: app.next });
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(card.title);
  const [baseline, setBaseline] = useState<{ data: BaselineData | null; error: string | null } | null>(null);
  const [decision, setDecision] = useState<{ busy: boolean; result: ReleaseDecisionResult | null; error: string | null }>({ busy: false, result: null, error: null });

  const patch = async (body: Record<string, unknown>, okText: string, undoBody?: Record<string, unknown>) => {
    try {
      await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body });
      app.toast(okText, {
        undo: undoBody
          ? async () => {
              try {
                await api(`/api/features/${encodeURIComponent(card.id)}`, { method: "PATCH", body: undoBody });
                app.toast(`已撤销：${card.id} 改回去了`);
              } catch (e) {
                app.toast(`没撤销成：${(e as Error).message}`, { kind: "err" });
              } finally {
                app.reloadFeatures();
                app.refresh();
              }
            }
          : undefined,
      });
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      app.toast(`没改成：${(e as Error).message}`, { kind: "err" });
    }
  };
  const reserveTo = (v: string) => {
    const target = v === "__unreserved" ? null : v;
    const name = target ? milestoneLabel(target, app.milestones, app.next) : "未预约";
    void patch({ milestone: target }, `${card.id} → ${name}（已写入台账）`, { milestone: card.milestone === "next" ? (app.next ?? null) : (card.column === "__unreserved" ? null : card.milestone) });
  };
  const openBaseline = async () => {
    setBaseline({ data: null, error: null });
    try {
      const r = await api<BaselineData>(`/api/features/${encodeURIComponent(card.id)}/baseline`);
      setBaseline({ data: r.data, error: null });
    } catch (e) {
      setBaseline({ data: null, error: (e as Error).message });
    }
  };
  const enqueue = async () => {
    setDecision({ busy: true, result: null, error: null });
    try {
      const r = await api<ReleaseDecisionResult>("/api/release/decision", { body: { feature: card.id, decision: "并入" } });
      setDecision({ busy: false, result: r.data, error: null });
      app.toast(`已把 ${card.id} 排进 ${r.data.milestone} 的合并单（并入）`);
      app.refresh();
    } catch (e) {
      setDecision({ busy: false, result: null, error: (e as Error).message });
    }
  };
  const modules = app.features?.modules ?? [];
  const reservable = app.milestones.filter((x) => x.status !== "已发布");
  const currentMs = card.column === "__unreserved" ? "__unreserved" : card.column === "__released" ? (card.milestone ?? "__unreserved") : card.column;
  const tone = (m.light === "blue" ? "blue" : m.light) as Tone;

  return (
    <>
      <div class={`insp-head tone-${tone}`}>
        <div style="min-width:0;flex:1">
          <div class="row" style="gap:8px">
            <span class={`block-type${card.typeSource === "guess" ? " guess" : ""}`}>
              <b class="glyph">{glyphOf(card.type)}</b>
              {card.type}
            </span>
            <span class="block-id">{card.id}</span>
            <Pill tone={card.done ? "green" : "gray"} outline>
              {card.status}
            </Pill>
          </div>
          <h2>
            {renaming ? (
              <input
                type="text"
                value={title}
                autoFocus
                onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && title.trim() && title.trim() !== card.title) {
                    setRenaming(false);
                    void patch({ title: title.trim() }, `已改名：${title.trim()}`, { title: card.title });
                  } else if (e.key === "Escape") {
                    setRenaming(false);
                    setTitle(card.title);
                  }
                }}
                onBlur={() => setRenaming(false)}
              />
            ) : (
              <span onDblClick={() => setRenaming(true)} title="双击改名">
                {card.title}
              </span>
            )}
          </h2>
          <div class="meta">
            <span>{m.repoLabel ?? "没绑分支"}</span>
            <span>·</span>
            <span>最后活动 {card.lastActivityAt ? `${mdhm(card.lastActivityAt)}（${ago(card.lastActivityAt)}）` : "—"}</span>
            <button class="link tiny" onClick={() => setRenaming(true)}>
              改名
            </button>
          </div>
        </div>
        <button class="icon-btn x" onClick={() => app.select(null)} aria-label="关闭详情" title="关闭（Esc）">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div class="insp-body">
        <section class={`insp-section tone-${tone}`}>
          <div class="insp-human">
            <div class="h">
              <i class="dot big" />
              {m.human}
            </div>
            {m.fact ? <div class="f">{m.fact}</div> : null}
            {card.light === "purple" && card.needsAction?.trim() && card.needsAction.trim() !== m.fact ? <div class="f">{card.needsAction.trim()}</div> : null}
          </div>
          {m.chips.length ? (
            <div class="row" style="margin-top:10px">
              {m.chips.map((c) => (
                <Chip tone={c.tone} title={c.title}>
                  {c.text}
                </Chip>
              ))}
            </div>
          ) : null}
          {card.suggestStatus && card.suggestion ? (
            <div class="insp-sugg" style="margin-top:12px">
              <span>
                <b>建议：</b>
                {card.suggestion}
              </span>
              <button class="btn small primary" onClick={() => void patch({ status: card.suggestStatus }, `${card.id} 已标为${card.suggestStatus}（已写入台账）`, { status: card.status })}>
                标为{card.suggestStatus}
              </button>
            </div>
          ) : null}
        </section>

        <section class="insp-section">
          <h3>台账</h3>
          <div class="kv2">
            <span>预约</span>
            <select value={currentMs} onChange={(e) => reserveTo((e.target as HTMLSelectElement).value)} disabled={card.column === "__released"} title={card.column === "__released" ? "已发布的卡不再改预约" : "改预约 = 只写台账"}>
              <option value="__unreserved">未预约</option>
              {reservable.map((x) => (
                <option value={x.id}>
                  {x.id}
                  {x.id === app.next ? "（下一版）" : ""} · {x.status}
                </option>
              ))}
              {card.column !== "__unreserved" && card.column !== "__released" && !reservable.some((x) => x.id === card.column) ? <option value={card.column}>{card.column}</option> : null}
            </select>
            <span>类型</span>
            <select
              value={card.typeSource === "card" ? card.type : "__guess"}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                void patch({ type: v === "__guess" ? null : v }, v === "__guess" ? `${card.id} 类型回到推测` : `${card.id} 类型改为 ${v}`, { type: card.typeSource === "card" ? card.type : null });
              }}
            >
              <option value="__guess">推测：{card.type}</option>
              {FEATURE_TYPES.map((t) => (
                <option value={t}>
                  {glyphOf(t)} {t}
                </option>
              ))}
            </select>
            <span>模块</span>
            <select
              value={card.moduleSource === "card" ? card.module : "__guess"}
              onChange={(e) => {
                const v = (e.target as HTMLSelectElement).value;
                void patch({ module: v === "__guess" ? null : v }, v === "__guess" ? `${card.id} 模块回到推测` : `${card.id} 模块改为 ${v}`, { module: card.moduleSource === "card" ? card.module : null });
              }}
            >
              <option value="__guess">推测：{card.module}</option>
              {[...modules.map((x) => x.name), "其他"].filter((v, i, a) => a.indexOf(v) === i).map((name) => (
                <option value={name}>{name}</option>
              ))}
              {card.moduleSource === "card" && !modules.some((x) => x.name === card.module) && card.module !== "其他" ? <option value={card.module}>{card.module}</option> : null}
            </select>
            <span>状态</span>
            <select value={card.status} onChange={(e) => void patch({ status: (e.target as HTMLSelectElement).value }, `${card.id} 状态改为 ${(e.target as HTMLSelectElement).value}`, { status: card.status })} title="台账状态是承诺，不会被 git 自动改；这里改 = 你说了算">
              {FEATURE_STATUSES.map((s) => (
                <option value={s}>{s}</option>
              ))}
            </select>
            <span>验收</span>
            <span class="v">{card.acceptance}</span>
            {card.rolledFrom.length ? (
              <>
                <span>顺延</span>
                <span class="v">从 {card.rolledFrom.join(" → ")} 顺延而来</span>
              </>
            ) : null}
          </div>
        </section>

        <section class="insp-section">
          <h3>
            分支 <span class="right">{card.bindings.length ? `${card.bindings.length} 条` : "还没绑"}</span>
          </h3>
          {card.bindings.length ? card.bindings.map((b) => <BindingCard b={b} />) : <p class="muted small">这张卡还没有绑定分支，进不了合并单。在下面选一条分支绑上；也可以在「更多 → 星图」里把分支星点拖到这张卡的小卡星上，或在该分支的 Claude 会话里说「这条分支对应 {card.id}」。</p>}
          {!card.done ? <BindPicker card={card} /> : null}
        </section>

        <section class="insp-section">
          <h3>动作</h3>
          <div class="insp-actions">
            <button class="btn" onClick={() => void openBaseline()} disabled={!card.bindings.length}>
              <Icon name="sync" size={16} /> 看同步基线预演
            </button>
            <button class="btn" onClick={() => void enqueue()} disabled={decision.busy || card.done || !card.bindings.length} title="写进这一版的合并单（决定 = 并入）；不执行 git 合并">
              <Icon name="assembly" size={16} /> {decision.busy ? "排入中…" : "排进合并单（并入）"}
            </button>
            {decision.result ? (
              <p class="hint ok">
                {decision.result.message}
                <br />
                <CopyBtn text={decision.result.command} label="复制终端命令" />
              </p>
            ) : null}
            {decision.error ? <p class="hint bad">{decision.error}</p> : null}
            <button class="btn ghost" onClick={() => app.go("kanban", card.id)}>
              <Icon name="kanban" size={16} /> 在看板里定位
            </button>
            <button class="btn ghost" onClick={() => app.go("timeline", card.id)}>
              <Icon name="timeline" size={16} /> 在时间线里定位
            </button>
            <p class="hint">以上都只写合流自己的台账 / 合并单。真正的 git 合并在终端：heliu 合并 {app.next ?? "<版本>"}，看完摘要输入 yes 才开始。</p>
          </div>
        </section>
      </div>
      <div class="insp-foot">{card.file}</div>
      {baseline ? <BaselineModal card={card} b={baseline} onClose={() => setBaseline(null)} /> : null}
    </>
  );
}

/** 关联开发分支（Codex 第 2 轮遗留 1）：列出本项目里还没绑到任何卡的功能分支，选一条绑到这张卡（只写台账） */
function BindPicker({ card }: { card: BoardCard }) {
  const app = useApp();
  const [open, setOpen] = useState(!card.bindings.length);
  const [repo, setRepo] = useState<string>("");
  const [branch, setBranch] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const bound = new Set<string>();
  for (const col of app.features?.columns ?? []) for (const c of col.cards) for (const b of c.bindings) bound.add(`${b.repo}|${b.branch}`);
  const repos = (app.status?.repos ?? [])
    .filter((r) => r.reachable)
    .map((r) => ({
      id: r.id,
      label: r.label,
      branches: r.branches
        .filter((f) => f.role === "feature" && !bound.has(`${r.id}|${f.branch}`))
        .sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "")),
    }))
    .filter((r) => r.branches.length);
  const total = repos.reduce((a, r) => a + r.branches.length, 0);
  const curRepo = repos.find((r) => r.id === repo) ?? repos[0] ?? null;
  const bind = async () => {
    if (!curRepo || !branch) return;
    setBusy(true);
    try {
      await api(`/api/features/${encodeURIComponent(card.id)}/bind`, { body: { repo: curRepo.id, branch } });
      app.toast(`已把 ${curRepo.label} 的 ${branch} 绑到 ${card.id}（已写入台账）`);
      setBranch("");
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      app.toast(`没绑成：${(e as Error).message}`, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  if (!open) {
    return (
      <button class="link small insp-bind-toggle" onClick={() => setOpen(true)} disabled={!app.status}>
        <Icon name="plus" size={13} /> 再关联一条开发分支{total ? `（还有 ${total} 条没登记的分支）` : ""}
      </button>
    );
  }
  return (
    <div class="insp-bind">
      <div class="insp-bind-head">
        <b>关联开发分支</b>
        <span class="muted tiny">{!app.status ? "分支数据还在加载…" : total ? `还没绑卡的功能分支 ${total} 条（主线 / 集成分支不在内）` : "所有功能分支都已经绑了卡"}</span>
      </div>
      {total ? (
        <div class="insp-bind-row">
          {repos.length > 1 ? (
            <select class="small" value={curRepo?.id ?? ""} onChange={(e) => { setRepo((e.target as HTMLSelectElement).value); setBranch(""); }} aria-label="仓库">
              {repos.map((r) => (
                <option value={r.id}>
                  {r.label}（{r.branches.length}）
                </option>
              ))}
            </select>
          ) : null}
          <select class="small" value={branch} onChange={(e) => setBranch((e.target as HTMLSelectElement).value)} aria-label="分支">
            <option value="">选一条分支…</option>
            {curRepo?.branches.map((f) => (
              <option value={f.branch} title={f.branch}>
                {f.label && f.label !== f.branch ? `${f.label} · ${f.branch}` : f.branch}
                {f.lastCommitAt ? `（${ago(f.lastCommitAt)}）` : ""}
              </option>
            ))}
          </select>
          <button class="btn small primary" onClick={() => void bind()} disabled={busy || !branch} title="只写台账：把这条分支记到这张卡的 bindings 里">
            {busy ? "绑定中…" : "绑定"}
          </button>
        </div>
      ) : null}
      <p class="tiny muted">绑定 = 只写台账，不动仓库。绑了分支，这张卡才会出现在合并单里、时间线上才有条。</p>
    </div>
  );
}

function BindingCard({ b }: { b: CardBinding }) {
  const app = useApp();
  const behindMain = b.vsMain?.behind ?? null;
  const behindInteg = b.vsIntegration?.behind ?? null;
  const behind = behindInteg ?? behindMain ?? 0;
  const [files, setFiles] = useState(false);
  return (
    <div class="bind-card">
      <div class="br">
        <span class="badge repo">{b.repoLabel}</span>
        <code title={b.branch}>{b.label && b.label !== b.branch ? b.label : b.branch}</code>
        {b.label && b.label !== b.branch ? <span class="muted tiny mono">{b.branch}</span> : null}
        {!b.exists ? <Pill tone="gray">分支不在本地</Pill> : null}
      </div>
      <div class="facts">
        {b.mergedState ? <Chip tone={b.mergedState === "unmerged" ? "gray" : "green"}>{MERGED_TEXT[b.mergedState] ?? b.mergedState}</Chip> : null}
        {b.vsMain ? (
          <Chip tone={behindMain ? "yellow" : "gray"} title={`相对主线 ${b.main}`}>
            主线 ↑{b.vsMain.ahead} ↓{b.vsMain.behind}
          </Chip>
        ) : null}
        {b.vsIntegration && b.integration ? (
          <Chip tone={behindInteg ? "yellow" : "gray"} title={`相对集成分支 ${b.integration}`}>
            集成 ↑{b.vsIntegration.ahead} ↓{b.vsIntegration.behind}
          </Chip>
        ) : null}
        {b.precheckState === "failed" ? (
          <Chip tone="yellow" title={b.precheckError ?? "原因未知"}>
            没试出来
          </Chip>
        ) : b.conflictFiles === null ? (
          b.precheckState === "skipped" ? <Chip tone="gray">冲突未检查</Chip> : null
        ) : b.conflictFiles === 0 ? (
          <Chip tone="green" title={`试合目标 ${b.precheckTarget ?? ""}`}>
            试合无冲突
          </Chip>
        ) : (
          <Chip tone="red" onClick={() => setFiles((f) => !f)} title="点开看冲突文件">
            {b.conflictFiles} 个文件撞了 {files ? "▴" : "▾"}
          </Chip>
        )}
        {b.session ? (
          <Chip tone={b.session.status === "blocked" ? "purple" : "gray"} title={b.session.title ?? b.session.id}>
            会话 {SESSION_STATUS_TEXT[b.session.status ?? "unknown"] ?? b.session.status}
          </Chip>
        ) : null}
      </div>
      {files && b.conflicts.length ? (
        <ul class="files">
          {b.conflicts.map((f) => (
            <li class="mono">{f}</li>
          ))}
        </ul>
      ) : null}
      {b.lastCommitAt ? <div class="path">最后提交 {mdhm(b.lastCommitAt)}（{ago(b.lastCommitAt)}）</div> : null}
      {b.worktree ? <div class="path">{b.worktree}</div> : null}
      <div class="actions">
        {behind > 0 ? <CopyBtn text={claudePrompt("sync", b)} label="复制「同步基线」指令" /> : null}
        {(b.conflictFiles ?? 0) > 0 ? <CopyBtn text={claudePrompt("conflict", b)} label="复制「解冲突」指令" /> : null}
        <CopyBtn text={b.branch} label="复制分支名" />
        {b.worktree ? <CopyBtn text={b.worktree} label="复制目录" /> : null}
        {b.session ? <CopyBtn text={b.session.id} label="复制会话 ID" /> : null}
        {b.session?.link ? (
          <a class="btn small" href={b.session.link}>
            打开会话
          </a>
        ) : null}
      </div>
      {b.session?.needsAction?.trim() ? (
        <div class="insp-session" style="margin-top:8px">
          <div class="needs">
            <b>会话需要你：</b>
            {b.session.needsAction.trim()}
          </div>
        </div>
      ) : null}
      {(behind > 0 || (b.conflictFiles ?? 0) > 0) && app.project ? <p class="tiny muted" style="margin-top:6px">指令复制后粘贴到该分支的 Claude 会话里；合流自己不会执行。</p> : null}
    </div>
  );
}

function BaselineModal({ card, b, onClose }: { card: BoardCard; b: { data: BaselineData | null; error: string | null }; onClose: () => void }) {
  return (
    <div class="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <h3>
          同步基线（预演）· {card.id} {card.title}
        </h3>
        <p class="explain">
          <b>只预演，不执行：</b>用 merge-tree 在临时对象区试合「主线 / 集成分支 → 本分支」，只列冲突文件，不改任何分支或目录。
        </p>
        {b.error ? <p class="err">{b.error}</p> : null}
        {!b.data && !b.error ? <p class="muted">试合中…</p> : null}
        {b.data?.bindings.map((x) => (
          <div class="panel tight" style="margin-top:12px">
            <div class="row">
              <span class="badge repo">{x.repoLabel}</span> <code>{x.branch}</code>
              {!x.exists ? <span class="muted small">分支在本地不存在</span> : null}
            </div>
            {x.checks.map((c) => (
              <div class="base-check">
                <span>
                  把<b>{c.base === "main" ? "主线" : "集成分支"}</b> <code>{c.baseBranch}</code> 合入本分支 <span class="muted small">（本分支落后它 {c.behind ?? "?"} 个提交{c.behind === 0 ? "，已是最新" : ""}）</span>
                  {c.conflicts.length ? (
                    <ul class="files" style="margin:6px 0 0;padding-left:16px;font-size:12px">
                      {c.conflicts.map((f) => (
                        <li class="mono">{f}</li>
                      ))}
                    </ul>
                  ) : null}
                </span>
                <span class={`r ${c.error ? "bad" : c.conflictFiles === 0 ? "ok" : "bad"}`}>{c.error ? `未完成（${c.error}）` : c.conflictFiles === 0 ? "无冲突" : `${c.conflictFiles} 个文件撞了`}</span>
              </div>
            ))}
          </div>
        ))}
        {b.data ? <p class="muted small" style="margin-top:12px">用时 {(b.data.elapsedMs / 1000).toFixed(1)}s。真要同步请在该分支的会话里自己执行（或用桌面应用的同步按钮）。</p> : null}
        <div class="modal-foot">
          <button class="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────────── 没卡的分支 ───────────── */

function BranchDetail({ sel }: { sel: Extract<Selection, { kind: "branch" }> }) {
  const app = useApp();
  const f = sel.branch;
  const m = modelOfBranch(f, { id: sel.repo, label: sel.repoLabel }, app.features?.modules);
  const [busy, setBusy] = useState(false);
  const [ms, setMs] = useState<string>(app.next ?? "next");
  const register = async () => {
    setBusy(true);
    try {
      const r = await api<{ feature: { id: string; title: string }; milestoneCreated: string | null }>("/api/features", {
        body: { title: f.label || f.branch, milestone: ms === "__unreserved" ? null : ms, bind: { repo: sel.repo, branch: f.branch }, type: m.type, module: m.module },
      });
      app.toast(`已登记 ${r.data.feature.id}「${r.data.feature.title}」${ms === "__unreserved" ? "" : `，预约 ${milestoneLabel(ms, app.milestones, app.next)}`}${r.data.milestoneCreated ? `（顺手建了 ${r.data.milestoneCreated}）` : ""}`);
      app.select(null);
      app.reloadFeatures();
      app.refresh();
    } catch (e) {
      app.toast(`没登记成：${(e as Error).message}`, { kind: "err" });
    } finally {
      setBusy(false);
    }
  };
  const s = f.sessions[0] ?? null;
  return (
    <>
      <div class="insp-head tone-blue">
        <div style="min-width:0;flex:1">
          <div class="row" style="gap:8px">
            <span class="block-type guess">
              <b class="glyph">{glyphOf(m.type)}</b>
              {m.type}（推测）
            </span>
            <Pill tone="blue">还没登记</Pill>
          </div>
          <h2>{m.title}</h2>
          <div class="meta">
            <span class="badge repo">{sel.repoLabel}</span>
            <code>{f.branch}</code>
          </div>
        </div>
        <button class="icon-btn x" onClick={() => app.select(null)} aria-label="关闭详情" title="关闭（Esc）">
          <Icon name="close" size={16} />
        </button>
      </div>
      <div class="insp-body">
        <section class="insp-section tone-blue">
          <div class="insp-human">
            <div class="h">
              <i class="dot big" />
              还没登记成功能卡
            </div>
            <div class="f">登记后它就会出现在看板和时间线里，能预约到某一版、排进合并单。{m.fact ? ` ${m.fact}。` : ""}</div>
          </div>
          <div class="row" style="margin-top:12px">
            <select value={ms} onChange={(e) => setMs((e.target as HTMLSelectElement).value)} class="small">
              <option value="next">预约到下一版{app.next ? `（${app.next}）` : ""}</option>
              {app.milestones
                .filter((x) => x.status !== "已发布" && x.id !== app.next)
                .map((x) => (
                  <option value={x.id}>预约到 {x.id}</option>
                ))}
              <option value="__unreserved">先不预约</option>
            </select>
            <button class="btn primary small" onClick={() => void register()} disabled={busy || f.role !== "feature"} title={f.role !== "feature" ? "主线 / 集成分支不能建卡" : "只写台账"}>
              <Icon name="plus" size={14} /> {busy ? "登记中…" : "登记为功能卡"}
            </button>
          </div>
        </section>
        <section class="insp-section">
          <h3>分支事实</h3>
          <div class="kv2">
            <span>三档</span>
            <span class="v">{MERGED_TEXT[f.mergedState] ?? f.mergedState}</span>
            <span>相对主线</span>
            <span class="v">{f.vsMain ? `领先 ${f.vsMain.ahead} · 落后 ${f.vsMain.behind}` : "—"}</span>
            <span>相对集成</span>
            <span class="v">{f.vsIntegration ? `领先 ${f.vsIntegration.ahead} · 落后 ${f.vsIntegration.behind}` : sel.integration ? "—" : "仓库未配置集成分支"}</span>
            <span>试合</span>
            <span class="v">{f.precheck ? (f.precheck.error ? `未能试合（${f.precheck.error}）` : f.precheck.conflictFiles === 0 ? "无冲突" : `${f.precheck.conflictFiles} 个文件撞了`) : "未检查"}</span>
            <span>最后提交</span>
            <span class="v">
              {f.lastCommitAt ? `${mdhm(f.lastCommitAt)}（${ago(f.lastCommitAt)}）` : "—"}
              {f.lastCommitSubject ? <span class="muted small"> · {f.lastCommitSubject}</span> : null}
            </span>
            <span>远端引用</span>
            <span class="v">{f.pushed ? `有（${f.upstream ?? "同名远端分支"}）` : "本地无远端引用"}</span>
            {f.worktree ? (
              <>
                <span>目录</span>
                <span class="v mono tiny">{f.worktree.path}</span>
              </>
            ) : null}
          </div>
          {f.precheck?.conflicts.length ? (
            <ul class="files" style="margin:8px 0 0;padding-left:16px;font-size:12px">
              {f.precheck.conflicts.map((x) => (
                <li class="mono">{x}</li>
              ))}
            </ul>
          ) : null}
        </section>
        {s ? (
          <section class="insp-section">
            <h3>
              会话 <span class="right">{f.sessions.length > 1 ? `共 ${f.sessions.length} 个` : ""}</span>
            </h3>
            <div class="insp-session">
              <div>
                <b>{s.title ?? "无标题会话"}</b> <Pill tone={s.status === "blocked" ? "purple" : "gray"}>{SESSION_STATUS_TEXT[s.status] ?? s.status}</Pill>
              </div>
              <div class="muted small">最后活动 {mdhm(s.lastActivityAt)}（{ago(s.lastActivityAt)}）</div>
              {s.needsAction?.trim() ? (
                <div class="needs">
                  <b>需要你：</b>
                  {s.needsAction.trim()}
                </div>
              ) : null}
              <div class="row">
                <CopyBtn text={s.sessionId} label="复制会话 ID" />
              </div>
            </div>
          </section>
        ) : null}
        <section class="insp-section">
          <h3>动作</h3>
          <div class="insp-actions">
            <button class="btn" onClick={() => void copyText(f.branch).then((ok) => ok && app.toast(`已复制分支名 ${f.branch}`))}>
              <Icon name="copy" size={16} /> 复制分支名
            </button>
            <p class="hint">合流只读你的仓库：这里不会 checkout、不会删分支。</p>
          </div>
        </section>
      </div>
    </>
  );
}

export const MS_TONE = MILESTONE_TONE;
