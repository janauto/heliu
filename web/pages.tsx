/** @jsxImportSource preact */
/** 卫生页（四类警告与提示 + 建议命令，只显示）与会话页（等你 / 运行中 / 已完成 / 已归档）。 */
import type { HygieneData } from "../src/board/api-types.ts";
import type { SessionView } from "../src/types.ts";
import { ago, copyText, mdhm, SESSION_STATUS_TEXT, useApi } from "./lib.ts";

export function HygienePage({ tick }: { tick: number }) {
  const h = useApi<HygieneData>("/api/hygiene", [tick]);
  const d = h.env?.data;
  if (h.error && !d) return <p class="err">读取卫生检查失败：{h.error}</p>;
  if (!d) return <p class="muted">正在检查…</p>;
  return (
    <div>
      <p class="muted">只报告，不动手：下面的「建议命令」只是写给你看的，heliu 不会执行；清理前请先人工确认。</p>
      {d.repos.map((r) => (
        <section>
          <h2>
            {r.label} <span class="muted small">警告 {r.warnings} · 提示 {r.infos}</span>
          </h2>
          {!r.reachable ? <p class="err">无法读取：{r.error ?? "不可达"}</p> : null}
          {r.reachable && !r.categories.some((c) => c.items.length) ? <p class="ok">未发现卫生问题</p> : null}
          <div class="stack">
            {r.categories
              .filter((c) => c.items.length)
              .map((c) => (
                <div class="panel">
                  <h3>
                    {c.title}（{c.items.reduce((a, x) => a + (x.count ?? 1), 0)} 个）
                  </h3>
                  <p class="muted small">{c.hint}</p>
                  {c.items.map((x) => (
                    <div class="issue">
                      <span class={`sev ${x.severity}`}>{x.severity === "warn" ? "警告" : "提示"}</span>
                      {x.message}
                      {x.suggestion ? (
                        <>
                          <pre class="cmd">{x.suggestion}</pre>
                          <button class="btn small" onClick={() => void copyText(x.suggestion!)}>
                            复制命令
                          </button>
                        </>
                      ) : null}
                    </div>
                  ))}
                </div>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}

const GROUPS: Array<{ key: string; title: string; hint: string; test: (s: SessionView) => boolean }> = [
  { key: "blocked", title: "等你", hint: "会话停下来等你回答（会话最后记录的请求，可能已过期）", test: (s) => s.status === "blocked" },
  { key: "running", title: "运行中", hint: "进程在跑（含在线空闲）", test: (s) => s.status === "running" || s.status === "online" },
  { key: "done", title: "已完成", hint: "已完成或待验收", test: (s) => s.status === "completed" || s.status === "review_ready" },
  { key: "archived", title: "已归档", hint: "在桌面应用里归档了", test: (s) => s.status === "archived" },
  { key: "other", title: "无状态记录", hint: "会话 JSON 里没有状态摘要，无法判断", test: (s) => s.status === "unknown" },
];

export function SessionsPage({ tick }: { tick: number }) {
  const r = useApi<{ total: number; sessions: SessionView[] }>("/api/sessions", [tick]);
  const d = r.env?.data;
  if (r.error && !d) return <p class="err">读取会话失败：{r.error}</p>;
  if (!d) return <p class="muted">正在读取桌面会话…</p>;
  return (
    <div>
      <p class="muted">
        本项目共 {d.total} 个桌面会话：{GROUPS.map((g) => `${g.title} ${d.sessions.filter(g.test).length}`).join(" · ")}
      </p>
      {GROUPS.map((g) => {
        const list = d.sessions.filter(g.test);
        if (!list.length && g.key === "other") return null;
        return (
          <section>
            <h2>
              {g.title}（{list.length}） <span class="muted small">{g.hint}</span>
            </h2>
            <div class="panel">
              {list.length ? list.map((s) => <SessionRow s={s} full={g.key === "blocked"} />) : <p class="empty">无</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function SessionRow({ s, full }: { s: SessionView; full: boolean }) {
  const branch = s.linkedBranch ?? s.branch;
  const how = s.branchLink === "branch" ? "记录" : s.branchLink === "written" ? "写入" : s.branchLink === "worktree" ? "目录" : "";
  return (
    <div class="sess">
      <div class="t">{s.title ?? "无标题会话"}</div>
      <div class="muted small">
        {SESSION_STATUS_TEXT[s.status] ?? s.status} · 最后活动 {mdhm(s.lastActivityAt)}（{ago(s.lastActivityAt)}） · {s.repo}
        {branch ? ` · 分支 ${branch}${how ? `（${how}）` : ""}` : " · 无分支"}
        {s.prs.length ? ` · PR ${s.prs.map((p) => `#${p.number ?? "?"}`).join(", ")}` : ""}
      </div>
      {branch && s.dirBranch && s.dirBranch !== branch ? <div class="muted small">目录现在在 {s.dirBranch} 上（目录被复用，以记录的分支为准）</div> : null}
      {full ? (
        <div class="needs">
          <b>需要你：</b>
          {s.needsAction?.trim() || s.statusDetail?.trim() || "（会话未写明需要什么）"}
        </div>
      ) : null}
    </div>
  );
}
