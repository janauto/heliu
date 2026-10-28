/** @jsxImportSource preact */
/**
 * 「结构」页（M8）：整机功能一页看完。
 * ① 现在该决定的：等你 / 冲突 / 已合入待确认 / 可合并 / 落后 / 还没建卡——点一下列出来，逐条跳去处理。
 * ② 模块 × 类型矩阵：整机由哪些部分组成、每部分在做修复还是功能迭代。点格子定位到模块。
 * ③ 模块卡：进度、各状态数、最需要决定的三项；展开看全部并改类型 / 模块（改一次就写进卡片，推测不再覆盖）。
 * 只是汇总 + 下钻，不另做第二个看板；写操作只有"改类型 / 模块"（没卡的分支会顺手建卡）与合并后同步。
 * M9：会话入口（没有自己提交的分支）不计入任何一类，页脚单列；「跨仓配对」把会话和它在别的仓库真正改的分支连到同一张卡；
 * 某个仓库多半只是会话入口时，建议给它改个如实的名字（只改 project.yaml 那一行，确认后才改）。
 */
import { useMemo, useState } from "preact/hooks";
import type { FeaturesData, PairingsData } from "../src/board/api-types.ts";
import { FEATURE_TYPES, OTHER_MODULE, TYPE_GLYPH, type FeatureType } from "../src/core/classify.ts";
import type { ReconcileReport } from "../src/types.ts";
import { ago, api, useApi } from "./lib.ts";
import { MergedPanel } from "./merge-flow.tsx";
import { PairingPanel } from "./pairing.tsx";
import { buildStructure, STATES, stateMeta, type SItem, type SModule, type SState, type StructureModel } from "./structure-model.ts";

type Focus = { state: SState } | { module: string; type: FeatureType | null } | null;

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function StructurePage({ tick, status, precheck, onChanged }: { tick: number; status: ReconcileReport | null; precheck: boolean; onChanged: () => void }) {
  const features = useApi<FeaturesData>(`/api/features?precheck=${precheck ? 1 : 0}`, [tick]);
  const fdata = features.env?.data ?? null;
  const model = useMemo(() => (status && fdata ? buildStructure(status, fdata) : null), [status, features.env]);
  const [focus, setFocus] = useState<Focus>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [syncOpen, setSyncOpen] = useState(false);
  // 从总览「N 条跨仓配对建议待确认」点过来（#/structure/pairing）时直接打开配对面板
  const [pairOpen, setPairOpenRaw] = useState(() => location.hash.includes("structure/pairing"));
  const setPairOpen = (v: boolean) => {
    setPairOpenRaw(v);
    if (!v && location.hash.includes("structure/pairing")) history.replaceState(null, "", "#/structure");
  };
  const pairings = useApi<PairingsData>("/api/pairings", [tick, pairOpen]);
  const pd = pairings.env?.data ?? null;
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  if (features.error && !fdata) return <p class="err">读取功能卡失败：{features.error}</p>;
  if (!model || !fdata) return <p class="muted">正在汇总…</p>;
  const moduleNames = [...new Set([...fdata.modules.map((m) => m.name), ...model.modules.map((m) => m.name), OTHER_MODULE])];

  const classify = async (it: SItem, patch: { type?: string | null; module?: string | null }) => {
    setBusy(true);
    try {
      let id = it.cardId;
      if (id) await api(`/api/features/${id}`, { method: "PATCH", body: patch });
      else if (it.bind) id = `已建卡 ${(await api<{ feature: { id: string } }>("/api/features", { body: { bind: it.bind, ...patch } })).data.feature.id}`;
      setToast(`${id ?? ""}「${short(it.title, 16)}」：${patch.type !== undefined ? `类型 → ${patch.type ?? "按推测"}` : `模块 → ${patch.module ?? "按推测"}`}`);
      onChanged();
    } catch (e) {
      setToast(`没成功：${(e as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 3600);
    }
  };
  const toModule = (name: string, type: FeatureType | null) => {
    setFocus({ module: name, type });
    setOpen((s) => new Set(s).add(name));
    setTimeout(() => document.getElementById(`mod-${name}`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  const decideKeys = STATES.filter((s) => s.decide && model.decisions[s.key]?.length);
  const focusState = focus && "state" in focus ? focus.state : null;
  const entriesTotal = model.entries.reduce((n, e) => n + e.count, 0);
  const pairedTotal = model.entries.reduce((n, e) => n + e.paired, 0);
  const pairPending = pd?.report ? pd.report.counts.strong + pd.report.counts.medium : null;
  const rename = async () => {
    const h = model.renameHint;
    if (!h) return;
    setBusy(true);
    try {
      const r = await api<{ from: string; to: string }>("/api/project/label", { body: { repo: h.repo, label: h.suggested } });
      setToast(`已把「${r.data.from}」改名为「${r.data.to}」（只改了 project.yaml 里那一行）`);
      onChanged();
    } catch (e) {
      setToast(`没改成：${(e as Error).message}`);
    } finally {
      setBusy(false);
      setTimeout(() => setToast(null), 4200);
    }
  };

  return (
    <div class="structure">
      <div class="st-head">
        <div>
          <h2>整机结构</h2>
          <p class="explain">
            {model.total} 项（{fdata.columns.reduce((n, c) => n + c.cards.length, 0)} 张功能卡 + 没建卡的分支），按「模块 × 类型」收纳。类型、模块是推测的，改一次就记在卡片上；模块词典{fdata.modulesSource === "file" ? "来自台账目录的 modules.yaml" : "是内置的，可在台账目录放 modules.yaml 改"}。
          </p>
        </div>
        <button class="btn" onClick={() => setSyncOpen(true)} title="在别处合并了分支？重新对账，把台账状态补上（先列出，你勾选后才写）">
          刚合并完？同步一下
        </button>
      </div>

      {/* ① 现在该决定的 */}
      <section class="panel decide">
        <h3>现在该决定的</h3>
        {decideKeys.length || entriesTotal ? (
          <div class="dchips">
            {decideKeys.map((s) => (
              <button
                class={`dchip t-${s.tone}${focusState === s.key ? " on" : ""}`}
                onClick={() => {
                  setFocus(focusState === s.key ? null : { state: s.key });
                  if (s.key === "merged") setSyncOpen(true);
                }}
                title={s.hint}
              >
                <b>{model.decisions[s.key]!.length}</b>
                {s.title}
              </button>
            ))}
            {entriesTotal || pd?.analyzedAt ? (
              <button class={`dchip t-blue${pairOpen ? " on" : ""}`} onClick={() => setPairOpen(true)} title="会话开在一个仓库、真实改动在别的仓库：按本机对话记录，把那条分支配到会话的卡上（建议，确认后才写台账）">
                <b>{pairPending === null ? "?" : pairPending}</b>
                跨仓配对{pairPending === null ? "（先分析）" : ""}
              </button>
            ) : null}
          </div>
        ) : (
          <p class="small muted">没有需要你决定的：都在开发中或已完成。</p>
        )}
        {focusState ? <DecisionList state={focusState} items={model.decisions[focusState] ?? []} onSync={() => setSyncOpen(true)} /> : <p class="explain">点上面的数字，列出这一类的全部条目；每条都能跳到星图里定位。</p>}
        {entriesTotal ? (
          <p class="small muted entries-note">
            另有 {entriesTotal} 条会话入口分支
            {pairedTotal ? `（${pairedTotal} 已配对）` : ""}：它们没有自己的提交，只是会话开出来的入口（{model.entries.map((e) => `${e.repoLabel} ${e.count}`).join("、")}）；除了会话正在等你的那几条（算进「等你回答」），不计入上面任何一类。
            {model.renameHint ? (
              <>
                {" "}
                {model.renameHint.allSessions} 个会话里 {model.renameHint.sessions} 个都开在「{model.renameHint.label}」，它的 {model.renameHint.branches} 条分支里有 {model.renameHint.entries} 条只是会话入口：它更像「会话入口 + 文档」，建议改名为「{model.renameHint.suggested}」：{" "}
                <button class="link" disabled={busy} onClick={() => void rename()} title="只改 project.yaml 里这个仓库的 label 一行，手写注释保留">
                  改名
                </button>
              </>
            ) : null}
          </p>
        ) : null}
      </section>

      {/* ② 模块 × 类型 */}
      <section class="panel">
        <h3>模块 × 类型</h3>
        <div class="matrix-wrap">
          <table class="matrix">
            <thead>
              <tr>
                <th>模块</th>
                {model.types.map((t) => (
                  <th>
                    <span class="glyph">{TYPE_GLYPH[t]}</span>
                    {t}
                  </th>
                ))}
                <th class="col-prog">进度</th>
              </tr>
            </thead>
            <tbody>
              {model.modules.map((m) => (
                <tr>
                  <th>
                    <button class="link" onClick={() => toModule(m.name, null)}>
                      {m.name}
                    </button>
                  </th>
                  {model.types.map((t) => {
                    const c = model.matrix[m.name]?.[t];
                    const max = Math.max(...model.modules.flatMap((x) => Object.values(model.matrix[x.name] ?? {}).map((v) => v?.n ?? 0)), 1);
                    return (
                      <td>
                        {c ? (
                          <button
                            class={`cell${c.hot ? " hot" : ""}`}
                            style={{ "--a": String(0.1 + 0.6 * (c.n / max)) }}
                            onClick={() => toModule(m.name, t)}
                            title={`${m.name} · ${t}：${c.n} 项${c.hot ? `，其中 ${c.hot} 项等你回答或有冲突` : ""}`}
                          >
                            {c.n}
                            {c.hot ? <i /> : null}
                          </button>
                        ) : (
                          <span class="cell empty">·</span>
                        )}
                      </td>
                    );
                  })}
                  <td class="col-prog">
                    <Progress m={m} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p class="explain">数字 = 条数（功能卡 + 没建卡的分支），颜色越深越多；带小红点 = 里面有等你回答或有冲突的。进度 = 台账状态已合入（含已进主线、已发布）/ 全部，不等于已验收。</p>
      </section>

      {/* ③ 模块卡 */}
      <div class="mods">
        {model.modules.map((m) => (
          <ModuleCard
            m={m}
            model={model}
            focus={focus}
            expanded={open.has(m.name)}
            busy={busy}
            moduleNames={moduleNames}
            onToggle={() =>
              setOpen((s) => {
                const n = new Set(s);
                if (n.has(m.name)) n.delete(m.name);
                else n.add(m.name);
                return n;
              })
            }
            onClassify={(it, p) => void classify(it, p)}
            onClearFocus={() => setFocus(null)}
          />
        ))}
      </div>

      {syncOpen ? <MergedPanel onClose={() => setSyncOpen(false)} onChanged={onChanged} /> : null}
      {pairOpen && !syncOpen ? <PairingPanel onClose={() => setPairOpen(false)} onChanged={onChanged} /> : null}
      {toast ? <div class="toast">{toast}</div> : null}
    </div>
  );
}

function Progress({ m }: { m: SModule }) {
  const total = m.open + m.done;
  const pct = total ? Math.round((m.done / total) * 100) : 0;
  return (
    <span class="prog" title={`台账已合入（含已进主线、已发布）${m.done} / 全部 ${total}；不等于已验收`}>
      <span class="bar">
        <span style={{ width: `${pct}%` }} />
      </span>
      <span class="small muted">
        {m.done}/{total}
      </span>
    </span>
  );
}

const toGalaxy = (key: string) => {
  location.hash = `/galaxy/focus/${encodeURIComponent(key)}`;
};

function ItemLine({ it, showModule }: { it: SItem; showModule?: boolean }) {
  const s = stateMeta(it.state);
  return (
    <div class={`item s-${it.state}`}>
      <span class={`glyph t-${s.tone}`} title={it.type}>
        {TYPE_GLYPH[it.type]}
      </span>
      <span class="item-main">
        <span class="item-t">
          {it.cardId ? <code>{it.cardId}</code> : null} {short(it.title, 40)}
        </span>
        <span class="item-sub">
          <span class={`tag t-${s.tone}`}>{s.title}</span>
          {it.alsoMerged ? <span class="tag t-green" title="分支已被集成分支 / 主线包含，台账还没改；「同步一下」会列出它"> 分支已合入</span> : null}
          {it.behind > 0 && it.state !== "behind" && it.state !== "done" && it.state !== "merged" ? <span class="tag t-yellow" title="还没合并的分支落后基线的提交数"> 落后 ↓{it.behind}</span> : null}
          {showModule ? <span class="muted"> {it.module} ·</span> : null}
          <span class="muted"> {it.milestone ? `预约 ${it.milestone}` : it.cardId ? "未预约" : it.repos.join("、")}</span>
          {it.lastAt ? <span class="muted"> · {ago(it.lastAt)}</span> : null}
        </span>
        {it.nextStep && it.state !== "done" ? <span class="item-next">{short(it.nextStep, 72)}</span> : null}
      </span>
      {it.state !== "done" ? (
        <button class="btn small" onClick={() => toGalaxy(it.key)} title="跳到星图并定位到这颗星">
          星图里看
        </button>
      ) : null}
    </div>
  );
}

function DecisionList({ state, items, onSync }: { state: SState; items: SItem[]; onSync: () => void }) {
  const s = stateMeta(state);
  return (
    <div class="dlist">
      <p class="small">
        <b>{s.title}</b> · {items.length} 项 · {s.hint}
        {state === "merged" ? (
          <>
            {" "}
            <button class="link" onClick={onSync}>
              同步一下
            </button>
          </>
        ) : null}
      </p>
      {items.map((it) => (
        <ItemLine it={it} showModule />
      ))}
    </div>
  );
}

function ModuleCard({
  m,
  model,
  focus,
  expanded,
  busy,
  moduleNames,
  onToggle,
  onClassify,
  onClearFocus,
}: {
  m: SModule;
  model: StructureModel;
  focus: Focus;
  expanded: boolean;
  busy: boolean;
  moduleNames: string[];
  onToggle: () => void;
  onClassify: (it: SItem, p: { type?: string | null; module?: string | null }) => void;
  onClearFocus: () => void;
}) {
  const fType = focus && "module" in focus && focus.module === m.name ? focus.type : null;
  const fState = focus && "state" in focus ? focus.state : null;
  const dim = fState ? !m.items.some((i) => i.state === fState) : focus && "module" in focus ? focus.module !== m.name : false;
  const list = m.items.filter((i) => (!fType || i.type === fType) && (!fState || i.state === fState));
  void model;
  return (
    <section class={`panel mod${dim ? " dim" : ""}`} id={`mod-${m.name}`}>
      <div class="mod-h">
        <h3>{m.name}</h3>
        <Progress m={m} />
      </div>
      <div class="mod-types">
        {FEATURE_TYPES.filter((t) => m.byType[t]).map((t) => (
          <span class={`tchip${fType === t ? " on" : ""}`}>
            <b>{TYPE_GLYPH[t]}</b> {t} {m.byType[t]}
          </span>
        ))}
      </div>
      <div class="mod-states">
        {STATES.filter((s) => m.byState[s.key]).map((s) => (
          <span class={`sdot t-${s.tone}`} title={s.hint}>
            <i />
            {s.title} {m.byState[s.key]}
          </span>
        ))}
      </div>
      {!expanded ? (
        m.top.length ? (
          <div class="mod-top">
            <p class="grp">最需要决定</p>
            {m.top.map((it) => (
              <ItemLine it={it} />
            ))}
          </div>
        ) : (
          <p class="small muted">这个模块没有要你决定的。</p>
        )
      ) : (
        <div class="mod-all">
          <p class="grp">
            {fType || fState ? `筛选：${[fType, fState ? stateMeta(fState).title : null].filter(Boolean).join(" · ")}（${list.length} 项）` : `全部 ${m.items.length} 项`}
            {fType || fState ? (
              <>
                {" "}
                <button class="link" onClick={onClearFocus}>
                  清除筛选
                </button>
              </>
            ) : null}
          </p>
          {list.map((it) => (
            <div class="item-edit">
              <ItemLine it={it} />
              <div class="classify small">
                <select disabled={busy} value={it.typeSource === "card" ? it.type : ""} onChange={(e) => onClassify(it, { type: (e.target as HTMLSelectElement).value || null })} aria-label="类型">
                  <option value="">{it.typeSource === "card" ? "按推测（取消手动）" : `${TYPE_GLYPH[it.type]} ${it.type}（推测）`}</option>
                  {FEATURE_TYPES.map((t) => (
                    <option value={t}>{`${TYPE_GLYPH[t]} ${t}`}</option>
                  ))}
                </select>
                <select disabled={busy} value={it.moduleSource === "card" ? it.module : ""} onChange={(e) => onClassify(it, { module: (e.target as HTMLSelectElement).value || null })} aria-label="模块">
                  <option value="">{it.moduleSource === "card" ? "按推测（取消手动）" : `${it.module}（推测）`}</option>
                  {moduleNames.map((n) => (
                    <option value={n}>{n}</option>
                  ))}
                </select>
                {!it.cardId ? <span class="muted">改了会顺手建卡</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}
      <button class="link mod-toggle" onClick={onToggle}>
        {expanded ? "收起" : `展开全部 ${m.items.length} 项（可改类型 / 模块）`}
      </button>
    </section>
  );
}
