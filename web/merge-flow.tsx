/** @jsxImportSource preact */
/**
 * M8 合并闭环（星图、结构页、合并预演页共用）：
 * - PromptBlock / MergePromptPanel：拖版本行星到合流点后，显示已复制的 Prompt、合并单计数与终端命令。
 * - MergedPanel：「刚合并完？同步一下」——重新对账，列出"分支已被集成分支 / 主线包含、台账还没改"的卡，勾选后才写。
 * 都不执行 git 合并（ADR-4）：真正合并仍是终端里的 heliu 合并 <版本>，看完摘要输入 yes 才开始。
 */
import { useEffect, useState } from "preact/hooks";
import type { MergePromptData, MergedData } from "../src/board/api-types.ts";
import { api, copyText, MERGED_TEXT } from "./lib.ts";

export interface PromptState {
  data: MergePromptData | null;
  /** null = 还在生成；true / false = 自动复制成没成功 */
  copied: boolean | null;
  error: string | null;
}

export function PromptBlock({ st }: { st: PromptState }) {
  if (st.error) return <p class="err small">没能生成合并 Prompt：{st.error}</p>;
  if (!st.data) return <p class="copied muted">正在刷新合并单、生成 Prompt…</p>;
  const d = st.data;
  const c = d.counts;
  const facts = [
    `新合入 ${c.newMerge}`,
    `已在集成分支 ${c.inIntegration}`,
    c.conflict ? `有冲突 ${c.conflict}` : "",
    c.precheckFailed ? `未能试合 ${c.precheckFailed}` : "",
    c.deferred ? `顺延 ${c.deferred}` : "",
    c.waiting ? `等你 ${c.waiting}` : "",
  ].filter(Boolean);
  return (
    <div class="prompt-block">
      <p class={`copied ${st.copied ? "ok" : "warn"}`}>
        {st.copied === null ? "正在复制…" : st.copied ? "✓ 合并 Prompt 已复制：粘贴到任意 Claude 会话即可" : "自动复制没成功：点下面的「复制 Prompt」"}
      </p>
      <p class="small">
        {d.milestone} 合并单：{facts.join(" · ")}
      </p>
      <textarea readOnly rows={7} value={d.prompt} aria-label="合并 Prompt" onFocus={(e) => (e.target as HTMLTextAreaElement).select()} />
      <div class="row-actions">
        <button class="btn primary small" onClick={() => void copyText(d.prompt)}>
          复制 Prompt
        </button>
        <button class="btn small" onClick={() => void copyText(d.previewCommand)} title={d.previewCommand}>
          复制预演命令
        </button>
        <button class="btn small" onClick={() => void copyText(d.command)} title={d.command}>
          复制合并命令
        </button>
      </div>
      <p class="explain">Prompt 只让 Claude 预演、讲清楚，不替你合并。真正合并：在终端运行合并命令，看完摘要输入 yes 才开始，可以回滚。合并完回来点「刚合并完？同步一下」。</p>
    </div>
  );
}

export function MergePromptPanel({ st, title, onClose, onSync }: { st: PromptState; title: string; onClose: () => void; onSync: () => void }) {
  return (
    <aside class="detail decision" aria-label="合并 Prompt">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>合并 {title}</h3>
      <PromptBlock st={st} />
      <p>
        <button class="btn small" onClick={onSync}>
          刚合并完？同步一下
        </button>
      </p>
    </aside>
  );
}

/** 「刚合并完？同步一下」：先列出建议，勾选确认后才写台账 */
export function MergedPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [st, setSt] = useState<{ loading: boolean; data: MergedData | null; error: string | null }>({ loading: true, data: null, error: null });
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<MergedData | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<MergedData>("/api/merged")
      .then((r) => {
        setSt({ loading: false, data: r.data, error: null });
        setPick(new Set(r.data.suggestions.map((s) => s.id)));
      })
      .catch((e: Error) => setSt({ loading: false, data: null, error: e.message }));
  }, []);
  const write = async () => {
    setBusy(true);
    try {
      const r = await api<MergedData>("/api/merged", { body: { ids: [...pick] } });
      setDone(r.data);
      onChanged();
    } catch (e) {
      setSt((s) => ({ ...s, error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };
  const toggle = (id: string) =>
    setPick((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const list = st.data?.suggestions ?? [];
  return (
    <aside class="detail decision merged" aria-label="同步合并结果">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>同步合并结果</h3>
      {st.loading ? <p class="small muted">正在重新对账（只读 git，几秒到一分钟）…</p> : null}
      {st.error ? <p class="err small">{st.error}</p> : null}
      {done ? (
        <>
          <p class="copied ok">✓ 已更新 {done.changed.length} 张卡（只改了台账）</p>
          <ul class="small">
            {done.changed.map((c) => (
              <li>
                <b>{c.id}</b> {c.title}：{c.from} → {c.to}
              </li>
            ))}
          </ul>
          <button class="btn small" onClick={onClose}>
            好的
          </button>
        </>
      ) : st.data && !list.length ? (
        <>
          <p class="small">没有要同步的：分支已被集成分支 / 主线包含的卡，台账里都已记录。</p>
          <p class="explain">只看有自己提交的分支；还没有提交的分支不算"已合入"。</p>
        </>
      ) : list.length ? (
        <>
          <p class="small">
            这些卡的分支已经合进去了，台账还是旧状态。勾选要更新的（已选 {pick.size} / {list.length}）：{" "}
            <button class="link" onClick={() => setPick(pick.size === list.length ? new Set() : new Set(list.map((s) => s.id)))}>
              {pick.size === list.length ? "全不选" : "全选"}
            </button>
          </p>
          <ul class="sync-list">
            {list.map((s) => (
              <li>
                <label class="chk">
                  <input type="checkbox" checked={pick.has(s.id)} onChange={() => toggle(s.id)} />
                  <span>
                    <b>{s.id}</b> {s.title}
                    <span class="sync-to">
                      {s.from} → <b>{s.to}</b>
                    </span>
                    <span class="sync-br">{s.branches.map((b) => `${b.repoLabel} · ${b.branch} · ${MERGED_TEXT[b.mergedState] ?? b.mergedState}`).join("；")}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div class="row-actions">
            <button class="btn primary small" disabled={busy || !pick.size} onClick={() => void write()}>
              {busy ? "写入中…" : `写入台账（${pick.size} 张）`}
            </button>
            <button class="btn small" onClick={onClose}>
              先不改
            </button>
          </div>
          <p class="explain">只改台账里的卡片状态，不碰仓库；只会往前改，不会把「已进主线」改回「已合入」。</p>
        </>
      ) : null}
    </aside>
  );
}
