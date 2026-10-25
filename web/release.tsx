/** @jsxImportSource preact */
/**
 * 合并预演（只读）：选里程碑 → 按建议顺序（已进集成 → 无冲突 → 有冲突 → 未完成）列出每条的试合结果。
 * 「生成合并单草稿」只把预演写成 <台账>/releases/<里程碑>.md，不执行任何合并（M4）。
 */
import { useEffect, useState } from "preact/hooks";
import type { ReleasePlanResult, ReleasePreview } from "../src/board/api-types.ts";
import type { LedgerMilestone } from "../src/types.ts";
import { api, hms, MERGED_TEXT, useApi } from "./lib.ts";

export function ReleasePage({ tick }: { tick: number }) {
  const ms = useApi<{ milestones: LedgerMilestone[]; next: string | null }>("/api/milestones", [tick]);
  const [sel, setSel] = useState<string | null>(null);
  const list = ms.env?.data.milestones ?? [];
  useEffect(() => {
    if (!sel && ms.env) setSel(ms.env.data.next ?? list[0]?.id ?? null);
  }, [ms.env]);
  const pv = useApi<ReleasePreview>(sel ? `/api/release/preview?milestone=${encodeURIComponent(sel)}` : null, [tick]);
  const [plan, setPlan] = useState<{ busy: boolean; result: ReleasePlanResult | null; error: string | null }>({ busy: false, result: null, error: null });
  const [openFiles, setOpenFiles] = useState<Set<string>>(new Set());
  const d = pv.env?.data;

  const makePlan = async () => {
    if (!sel) return;
    setPlan({ busy: true, result: null, error: null });
    try {
      const r = await api<ReleasePlanResult>("/api/release/plan", { method: "POST", body: { milestone: sel } });
      setPlan({ busy: false, result: r.data, error: null });
    } catch (e) {
      setPlan({ busy: false, result: null, error: (e as Error).message });
    }
  };
  const toggle = (k: string) =>
    setOpenFiles((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <div>
      <div class="banner">
        <b>仅预演，不会执行合并（M4）。</b>试合用 merge-tree 在临时对象区进行，不改任何分支、不碰工作目录。
      </div>
      <div class="toolbar">
        <span>里程碑：</span>
        <select value={sel ?? ""} onChange={(e) => setSel((e.currentTarget as HTMLSelectElement).value)}>
          {list.map((m) => (
            <option value={m.id}>
              {m.id}
              {m.id === ms.env?.data.next ? "（下一版）" : ""} · {m.status}
            </option>
          ))}
        </select>
        {d ? <span class="muted small">试合于 {hms(d.generatedAt)} · 用时 {(d.scanMs / 1000).toFixed(1)}s</span> : null}
      </div>
      {!list.length && ms.env ? <p class="muted">还没有里程碑：在「版本列」登记一个新点子会自动建 vNext。</p> : null}
      {pv.error ? <p class="err">{pv.error}</p> : null}
      {sel && !d && !pv.error ? <p class="muted">正在试合…</p> : null}
      {d ? (
        <div>
          <div class="counts">
            <span class="chip">
              共 <b>{d.items.length}</b> 项
            </span>
            <span class="chip">
              已进集成 <b>{d.counts.in_integration}</b>
            </span>
            <span class="chip">
              无冲突 <b>{d.counts.clean}</b>
            </span>
            <span class={`chip${d.counts.conflict ? " red" : ""}`}>
              有冲突 <b>{d.counts.conflict}</b>
            </span>
            <span class={`chip${d.counts.precheck_failed ? " yellow" : ""}`} title="试合没得到结果：不算无冲突，也不自动顺延">
              未能试合 <b>{d.counts.precheck_failed}</b>
            </span>
            <span class="chip">
              未完成 <b>{d.counts.unfinished}</b>（预计顺延）
            </span>
          </div>
          <p class="muted small">
            顺序规则：已进集成（已在集成分支，执行时跳过）→ 试合无冲突（合入）→ 有冲突（冲突少的在前，需解冲突）→ 未能试合（没得到试合结果，请重新试合或人工确认，不自动顺延）→ 未完成（等你回答 / 尚无提交 / 尚未关联开发分支，建议顺延）。
          </p>
          <table class="rel">
            <thead>
              <tr>
                <th>顺序</th>
                <th>功能</th>
                <th>分支</th>
                <th>三档状态</th>
                <th>试合冲突</th>
                <th>建议动作</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((x) => (
                <tr>
                  <td data-k="顺序">{x.order}</td>
                  <td data-k="功能">
                    <b>{x.title}</b> <span class="muted small">{x.id} · 台账 {x.status}</span>
                    <div class={`tier ${x.tier} small`}>{x.tierText}</div>
                    <div class="muted small">{x.reason}</div>
                  </td>
                  <td data-k="分支">
                    {x.bindings.length ? (
                      x.bindings.map((b) => (
                        <div class="small">
                          <span class="badge repo">{b.repoLabel}</span> <span class="mono">{b.branch}</span>
                        </div>
                      ))
                    ) : (
                      <span class="muted">（无）</span>
                    )}
                  </td>
                  <td data-k="三档状态">
                    {x.bindings.map((b) => (
                      <div class="small">{b.exists ? (b.mergedState ? MERGED_TEXT[b.mergedState] : "—") : "分支不存在"}</div>
                    ))}
                  </td>
                  <td data-k="试合冲突">
                    {x.bindings.map((b) => {
                      const k = `${x.id}|${b.repo}|${b.branch}`;
                      if (b.precheckState === "failed") return <div class="small warn">未能试合（{b.precheckError ?? "原因未知"}）</div>;
                      if (b.conflictFiles === null) return <div class="small muted">—</div>;
                      if (b.conflictFiles === 0) return <div class="small ok">0</div>;
                      return (
                        <div class="small">
                          <button class="btn small" onClick={() => toggle(k)}>
                            {b.conflictFiles} 个文件 {openFiles.has(k) ? "▴" : "▾"}
                          </button>
                          {openFiles.has(k) ? (
                            <ul class="files">
                              {b.conflicts.map((f) => (
                                <li class="mono">{f}</li>
                              ))}
                            </ul>
                          ) : null}
                        </div>
                      );
                    })}
                  </td>
                  <td data-k="建议动作" class="act">
                    {x.actionText}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!d.items.length ? <p class="muted">{d.milestone.id} 还没有待合入的功能。</p> : null}

          <h2>预计顺延（{d.deferred.length}）</h2>
          <div class="panel">
            {d.deferred.length ? (
              <ul class="files">
                {d.items
                  .filter((x) => x.tier === "unfinished")
                  .map((x) => (
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
          {d.suggestions.length ? (
            <>
              <h2>台账状态建议（{d.suggestions.length}）</h2>
              <div class="panel">
                <ul class="files">
                  {d.suggestions.map((s) => (
                    <li>{s.text}</li>
                  ))}
                </ul>
                <p class="muted small">只是建议，heliu 不会自动改台账状态。</p>
              </div>
            </>
          ) : null}

          <h2>合并单草稿</h2>
          <div class="panel">
            <p>
              把上面的预演写成 <span class="mono">releases/{d.milestone.id}.md</span>（机器可读的 frontmatter + 人读表格，默认决定：已进集成/无冲突且台账「待合并」= 并入，其余无冲突、有冲突、未能试合 = 待定，未完成 = 顺延）。
              <b>不会执行任何合并。</b>
            </p>
            <button class="btn primary" onClick={makePlan} disabled={plan.busy || !d.items.length}>
              {plan.busy ? "生成中…" : "生成合并单草稿"}
            </button>
            {plan.result ? (
              <p class="ok">
                已写入：<span class="mono">{plan.result.file}</span>（{plan.result.items} 项，预计顺延 {plan.result.deferred}）
                {plan.result.backup ? (
                  <>
                    <br />
                    <span class="muted small">旧草稿已备份到 {plan.result.backup}</span>
                  </>
                ) : null}
              </p>
            ) : null}
            {plan.error ? <p class="err">{plan.error}</p> : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
