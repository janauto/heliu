/** @jsxImportSource preact */
/**
 * M9「跨仓配对」面板（结构页打开）：会话开在一个仓库、真实改动在别的仓库的 worktree 时，
 * 按本机对话记录给出「把那条分支绑到会话的卡」的建议——强档默认勾选，确认后才写台账（只加绑定 / 建卡，不碰仓库）。
 * 分析对话记录是显式动作（后台跑，可看进度）；平时打开只读缓存里的结果。
 */
import { useEffect, useState } from "preact/hooks";
import type { PairingsData } from "../src/board/api-types.ts";
import type { PairGroup, PairSuggestion } from "../src/core/pairing-types.ts";
import { ago, api } from "./lib.ts";

interface ApplyResult {
  bound: Array<{ key: string; card: string; repoLabel: string; branch: string }>;
  created: Array<{ id: string; title: string; milestone: string | null; branches: string[] }>;
  skipped: Array<{ key: string; reason: string }>;
}

const TIER: Record<PairSuggestion["tier"], { text: string; cls: string }> = {
  strong: { text: "强", cls: "t-green" },
  medium: { text: "中", cls: "t-yellow" },
  weak: { text: "弱", cls: "t-gray" },
};

export function PairingPanel({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<PairingsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<Set<string>>(new Set());
  const [showWeak, setShowWeak] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<ApplyResult | null>(null);

  const load = async (keepPick = false) => {
    try {
      const r = await api<PairingsData>("/api/pairings");
      setData(r.data);
      setError(null);
      if (!keepPick && r.data.report) setPick(new Set(r.data.report.groups.flatMap((g) => g.items).filter((i) => i.checked).map((i) => i.key)));
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  // 后台分析中：每秒看一次进度，跑完重新读建议
  const running = !!data?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [running]);

  const analyze = async (force: boolean) => {
    try {
      await api("/api/pairings/analyze", { body: { force } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const write = async () => {
    setBusy(true);
    try {
      const r = await api<ApplyResult>("/api/pairings", { body: { keys: [...pick] } });
      setDone(r.data);
      onChanged();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = (k: string) =>
    setPick((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  const rep = data?.report ?? null;
  const job = data?.job ?? null;
  const groups = rep?.groups ?? [];
  const weakCount = groups.flatMap((g) => g.items).filter((i) => i.tier === "weak" && i.target.kind !== "other").length;
  const visible = (g: PairGroup) => g.items.filter((i) => showWeak || i.tier !== "weak" || i.target.kind === "other");

  return (
    <aside class="detail decision merged pairing" aria-label="跨仓配对">
      <button class="menu-btn" onClick={onClose} aria-label="关闭">
        ×
      </button>
      <h3>跨仓配对</h3>
      <p class="small">会话开在一个仓库（多是文档仓），真正的代码改在别的仓库的 worktree 里。这里按本机对话记录，建议把那条分支也绑到会话的卡上——这样等你回答、合并、落后都在同一张卡上。</p>
      {error ? <p class="err small">{error}</p> : null}
      {!data ? <p class="small muted">正在读取…</p> : null}

      {running ? (
        <p class="copied muted">
          正在分析对话记录：{job!.done} / {job!.total || "?"} 份（只读，只提取路径与次数）…
        </p>
      ) : job?.error ? (
        <p class="err small">分析没完成：{job.error}</p>
      ) : null}

      {data && !data.analyzedAt && !running ? (
        <>
          <p class="small">还没分析过。先分析一次（首次约几秒到一分钟，之后只看有变化的文件）：</p>
          <p>
            <button class="btn primary small" onClick={() => void analyze(false)}>
              分析对话记录
            </button>
          </p>
        </>
      ) : null}

      {done ? (
        <div class="pair-done">
          <p class="copied ok">✓ 已写进台账：绑定 {done.bound.length} 条{done.created.length ? `，新建 ${done.created.length} 张卡` : ""}（没有碰任何仓库）</p>
          <ul class="small">
            {done.created.map((c) => (
              <li>
                新建 <b>{c.id}</b> {c.title}：{c.branches.join("、")}
              </li>
            ))}
            {done.bound
              .filter((b) => !done.created.some((c) => c.id === b.card))
              .map((b) => (
                <li>
                  <b>{b.card}</b> 绑定 {b.repoLabel} {b.branch}
                </li>
              ))}
            {done.skipped.map((s) => (
              <li class="muted">跳过：{s.reason}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {rep && data?.analyzedAt ? (
        <>
          <p class="small">
            上次分析 {ago(data.analyzedAt)} ·{" "}
            <button class="link" disabled={running} onClick={() => void analyze(false)}>
              重新分析
            </button>
            <br />
            建议：强 {rep.counts.strong} · 中 {rep.counts.medium}
            {rep.counts.other ? ` · 已绑在别的卡 ${rep.counts.other}（只提示）` : ""}
            {rep.counts.paired ? ` · 已配好 ${rep.counts.paired}` : ""}
            {weakCount ? (
              <>
                {" · "}
                <button class="link" onClick={() => setShowWeak((v) => !v)}>
                  {showWeak ? "收起弱证据" : `更多弱证据（${weakCount}）`}
                </button>
              </>
            ) : null}
          </p>
          {!groups.some((g) => visible(g).length) ? <p class="small">没有要配对的：会话没有在别的仓库的 worktree 里改过东西，或者都已经配好了。</p> : null}
          <div class="pair-groups">
            {groups.map((g) => {
              const items = visible(g);
              if (!items.length) return null;
              return (
                <section class="pair-group">
                  <p class="pg-head">
                    <b>{g.title}</b>
                    {g.status === "blocked" ? <span class="tag t-purple">等你回答</span> : g.status === "running" ? <span class="tag">运行中</span> : null}
                    <span class="muted small">
                      {" "}
                      会话在 {g.repoLabel}
                      {g.branch ? ` ${g.branch}` : ""} → {g.card ? `${g.card.id}「${g.card.title}」` : "还没有卡：确认时用会话标题建卡（预约下一版）"}
                    </span>
                  </p>
                  <ul class="sync-list">
                    {items.map((i) => (
                      <li>
                        <label class="chk">
                          <input type="checkbox" disabled={i.target.kind === "other"} checked={pick.has(i.key)} onChange={() => toggle(i.key)} />
                          <span>
                            <span class={`tag ${i.target.kind === "other" ? "t-gray" : TIER[i.tier].cls}`}>{i.target.kind === "other" ? "已有卡" : TIER[i.tier].text}</span> <b>{i.repoLabel}</b> <code>{i.branch}</code>
                            <span class="sync-br">依据：{i.evidence}</span>
                            {i.target.kind === "other" ? <span class="sync-br">这条分支已经绑在 {i.target.id}「{i.target.title}」上：如果是同一件事，请手动处理（不会自动合卡）</span> : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
          {rep.notes.length ? (
            <div class="small">
              <p class="muted">另外（不是建议，只是事实）：</p>
              <ul>
                {rep.notes.map((n) => (
                  <li>
                    会话「{n.title}」{n.text}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class="row-actions sticky">
            <button class="btn primary small" disabled={busy || !pick.size} onClick={() => void write()}>
              {busy ? "写入中…" : `绑定所选（${pick.size} 条）`}
            </button>
            <button class="btn small" onClick={onClose}>
              先不改
            </button>
          </div>
        </>
      ) : null}
      <p class="explain">
        依据是建议不是事实：worktree 现在检出的分支可能后来换过；仓库主目录常切换分支，只算弱证据。{(data?.privacy ?? []).join("")}
      </p>
    </aside>
  );
}
