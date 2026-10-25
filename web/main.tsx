/** @jsxImportSource preact */
/**
 * 合流看板前端入口：顶栏（数据时间 · 用时 · 刷新）+ 一眼条 + 五个页签。
 * 每 30 秒自动刷新（服务端对账结果缓存 20 秒），也可以手动刷新。
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { OverviewData } from "../src/board/api-types.ts";
import type { ReconcileReport } from "../src/types.ts";
import { BoardPage } from "./board.tsx";
import { api, hms, secs, useApi } from "./lib.ts";
import { OverviewPage } from "./overview.tsx";
import { HygienePage, SessionsPage } from "./pages.tsx";
import { ReleasePage } from "./release.tsx";

export type Tab = "overview" | "board" | "hygiene" | "sessions" | "release";
const TABS: Array<{ key: Tab; title: string }> = [
  { key: "overview", title: "总览" },
  { key: "board", title: "版本列" },
  { key: "hygiene", title: "卫生" },
  { key: "sessions", title: "会话" },
  { key: "release", title: "合并预演" },
];
const REFRESH_MS = 30_000;

function tabFromHash(): Tab {
  const h = location.hash.replace(/^#\/?/, "") as Tab;
  return TABS.some((t) => t.key === h) ? h : "overview";
}

function App() {
  const [tab, setTab] = useState<Tab>(tabFromHash());
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(timer);
    };
  }, []);
  const go = (t: Tab) => {
    location.hash = `/${t}`;
    setTab(t);
    window.scrollTo(0, 0);
  };
  // 冲突检查（试合）：页面打开后自动检查一次，之后自动刷新都带上；顶栏可「重新检查」。用户不必记 --precheck。
  const [pc, setPc] = useState<{ state: "off" | "checking" | "on"; at: string | null; error: string | null }>({ state: "off", at: null, error: null });
  const check = async (fresh: boolean) => {
    setPc((s) => ({ ...s, state: "checking", error: null }));
    try {
      const r = await api<ReconcileReport>(`/api/status?precheck=1${fresh ? "&fresh=1" : ""}`);
      setPc({ state: "on", at: r.meta?.scannedAt ?? null, error: null });
      if (fresh) setTick((t) => t + 1);
    } catch (e) {
      setPc((s) => ({ ...s, state: s.at ? "on" : "off", error: (e as Error).message }));
    }
  };
  useEffect(() => {
    void check(false);
  }, []);
  const precheck = pc.state === "on" || (pc.state === "checking" && !!pc.at);
  const status = useApi<ReconcileReport>("/api/status", [tick]);
  const overview = useApi<OverviewData>(`/api/overview?precheck=${precheck ? 1 : 0}`, [tick]);
  const refresh = () => setTick((t) => t + 1);
  const meta = status.env?.meta;
  const ov = overview.env?.data;
  const projectName = status.env?.project?.name ?? overview.env?.project?.name ?? "";
  useEffect(() => {
    document.title = projectName ? `合流看板 · ${projectName}` : "合流看板";
  }, [projectName]);

  return (
    <div>
      <header class="top">
        <div class="top-row">
          <div class="brand">
            合流看板<small>{projectName}</small>
          </div>
          <span class="datatime" title="对账结果在服务端缓存 20 秒；页面每 30 秒自动刷新">
            {meta ? `数据时间 ${hms(meta.scannedAt)} · 用时 ${secs(meta.scanMs)}` : status.error ? "数据加载失败" : "正在扫描…"}
            {status.loading || overview.loading ? " · 刷新中" : ""}
          </span>
          <button class="btn" onClick={refresh} disabled={status.loading}>
            刷新
          </button>
        </div>
        <nav class="tabs">
          {TABS.map((t) => (
            <button class={`tab${tab === t.key ? " on" : ""}`} onClick={() => go(t.key)}>
              {t.title}
              {t.key === "sessions" && ov && ov.waiting > 0 ? <span class="badge">{ov.waiting}</span> : null}
              {t.key === "hygiene" && ov && ov.hygieneWarnings > 0 ? <span class="badge">{ov.hygieneWarnings}</span> : null}
            </button>
          ))}
        </nav>
        <NextLine ov={ov ?? null} pc={pc} onCheck={() => void check(pc.state === "on")} />
      </header>
      {ov ? <Strip ov={ov} go={go} /> : null}
      <main>
        {status.error ? <p class="err">读取对账失败：{status.error}</p> : null}
        {tab === "overview" ? <OverviewPage tick={tick} status={status.env?.data ?? null} overview={ov ?? null} go={go} /> : null}
        {tab === "board" ? <BoardPage tick={tick} precheck={precheck} onChanged={refresh} /> : null}
        {tab === "hygiene" ? <HygienePage tick={tick} /> : null}
        {tab === "sessions" ? <SessionsPage tick={tick} /> : null}
        {tab === "release" ? <ReleasePage tick={tick} /> : null}
      </main>
    </div>
  );
}

/** 顶部固定一行：下一版是谁 · 冲突检查到哪了 · 自动顺延的现状（如实写：M4 才有） */
function NextLine({ ov, pc, onCheck }: { ov: OverviewData | null; pc: { state: "off" | "checking" | "on"; at: string | null; error: string | null }; onCheck: () => void }) {
  const next = ov?.next;
  const s = ov?.precheckSummary;
  return (
    <div class="nextline">
      <span>
        下一版 = <b>{next ? next.id : "（还没有规划中的版本）"}</b>
        {next ? `（${next.status}）` : ""}
      </span>
      <span>
        · 冲突：
        {pc.state === "checking" ? (
          <span class="muted">检查中…</span>
        ) : pc.state === "on" ? (
          <>
            {/* 三态：有卡没试合出结果时不说「已检查」 */}
            {s && s.requested && s.failed > 0 ? (
              <span class="warn">
                {s.status === "failed" ? "未完成" : "部分完成"}（{s.failed} 张未能试合：{s.firstError ?? "原因未知"}）
              </span>
            ) : (
              <>已检查 {hms(ov?.precheckAt ?? pc.at)}</>
            )}{" "}
            <button class="link" onClick={onCheck} title="重新用 merge-tree 试合（临时区进行，不碰仓库）">
              重新检查
            </button>
          </>
        ) : (
          <>
            未检查{" "}
            <button class="link" onClick={onCheck} title="用 merge-tree 试合（临时区进行，不碰仓库）">
              点击检查
            </button>
          </>
        )}
        {pc.error ? <span class="err small"> {pc.error}</span> : null}
      </span>
      <span class="muted">· 自动顺延：当前版本尚未实现，M4 提供</span>
    </div>
  );
}

/** 一眼条：每页顶部都看得到 集成分支 N 天未并回 / 本地无远端引用 / 等你处理 */
function Strip({ ov, go }: { ov: OverviewData; go: (t: Tab) => void }) {
  return (
    <div class="strip">
      {ov.integrations.map((i) => (
        <span class={`chip${(i.days ?? 0) >= 3 ? " red" : ""}`} onClick={() => go("overview")} title={`集成分支 ${i.branch}`}>
          {i.repoLabel}集成分支 <b>{i.days ?? "?"}</b> 天未并回（领先主线 {i.ahead ?? "?"} 个提交）
        </span>
      ))}
      <span class="chip" onClick={() => go("overview")} title="只基于本地已有的远端引用（heliu 从不 fetch）">
        本地无远端引用 <b>{ov.neverPushed}</b> 个分支
      </span>
      <span class={`chip${ov.waiting ? " purple" : ""}`} onClick={() => go("sessions")}>
        等你处理 <b>{ov.waiting}</b> 个会话
      </span>
    </div>
  );
}

render(<App />, document.getElementById("app")!);
