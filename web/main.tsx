/** @jsxImportSource preact */
/**
 * 合流看板前端入口：顶栏（数据时间 · 用时 · 刷新）+ 一眼条 + 五个页签。
 * 每 30 秒自动刷新（服务端对账结果缓存 20 秒），也可以手动刷新。
 */
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { OverviewData, ProjectsData } from "../src/board/api-types.ts";
import type { ReconcileReport } from "../src/types.ts";
import { BoardPage } from "./board.tsx";
import { api, currentProject, hms, secs, setCurrentProject, store, switchProject, useApi } from "./lib.ts";
import { OverviewPage } from "./overview.tsx";
import { HygienePage, SessionsPage } from "./pages.tsx";
import { ReleasePage } from "./release.tsx";
import { GalaxyPage } from "./galaxy.tsx";
import { StartPage } from "./start.tsx";
import { StructurePage } from "./structure.tsx";

export type Tab = "start" | "overview" | "structure" | "galaxy" | "board" | "hygiene" | "sessions" | "release";
const TABS: Array<{ key: Tab; title: string }> = [
  { key: "start", title: "开始" },
  { key: "overview", title: "总览" },
  { key: "structure", title: "结构" },
  { key: "galaxy", title: "星图" },
  { key: "board", title: "版本列" },
  { key: "hygiene", title: "卫生" },
  { key: "sessions", title: "会话" },
  { key: "release", title: "合并预演" },
];
const REFRESH_MS = 30_000;

function tabFromHash(fallback: Tab): Tab {
  const h = location.hash.replace(/^#\/?/, "").split("/")[0] as Tab;
  return TABS.some((t) => t.key === h) ? h : fallback;
}

/** 选当前项目：地址 ?project= > 上次选的 > 看板默认 > 只有一个项目时就它 */
function pickProject(pd: ProjectsData): string | null {
  const names = new Set(pd.projects.filter((p) => !p.error).map((p) => p.name));
  const url = new URLSearchParams(location.search).get("project");
  for (const n of [url, store.get("heliu.project"), pd.default]) if (n && names.has(n)) return n;
  return names.size === 1 ? [...names][0]! : null;
}

/** M6 外壳：先读项目列表、定当前项目，再渲染看板（没有项目时只有「开始」可用） */
function Root() {
  const projects = useApi<ProjectsData>("/api/projects", []);
  if (!projects.env) {
    return projects.error ? <p class="err boot">读取项目列表失败：{projects.error}</p> : <p class="boot">正在载入…</p>;
  }
  const pd = projects.env.data;
  const cur = pickProject(pd);
  setCurrentProject(cur);
  if (cur) store.set("heliu.project", cur);
  return <App projects={pd} reloadProjects={projects.reload} />;
}

function App({ projects, reloadProjects }: { projects: ProjectsData; reloadProjects: () => void }) {
  const cur = currentProject();
  // 第一次打开、或还没有项目时落在「开始」；之后默认总览
  const firstVisit = !store.get("heliu.seenStart");
  const [tab, setTab] = useState<Tab>(tabFromHash(!cur || firstVisit ? "start" : "overview"));
  useEffect(() => {
    if (tab === "start") store.set("heliu.seenStart", "1");
  }, [tab]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash(cur ? "overview" : "start"));
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(() => setTick((t) => t + 1), REFRESH_MS);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(timer);
    };
  }, []);
  const go = (t: Tab) => {
    if (!cur && t !== "start") return;
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
    if (cur) void check(false);
  }, []);
  const precheck = pc.state === "on" || (pc.state === "checking" && !!pc.at);
  const status = useApi<ReconcileReport>(cur ? "/api/status" : null, [tick]);
  const overview = useApi<OverviewData>(cur ? `/api/overview?precheck=${precheck ? 1 : 0}` : null, [tick]);
  const refresh = () => setTick((t) => t + 1);
  const meta = status.env?.meta;
  const ov = overview.env?.data;
  const projectName = cur ?? "";
  useEffect(() => {
    document.title = projectName ? `合流看板 · ${projectName}` : "合流看板";
  }, [projectName]);

  return (
    <div>
      <header class="top">
        <div class="top-row">
          <div class="brand">
            <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
              <defs>
                <linearGradient id="mark-g" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="#19b4e6" />
                  <stop offset="55%" stop-color="#6a5af6" />
                  <stop offset="100%" stop-color="#e35dc0" />
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="10" fill="url(#mark-g)" />
              <path d="M7 9 C 13 9, 14 16, 19 16 L 25 16" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" />
              <path d="M7 23 C 13 23, 14 16, 19 16" stroke="#fff" stroke-opacity="0.75" stroke-width="2.4" fill="none" stroke-linecap="round" />
              <circle cx="25" cy="16" r="2.6" fill="#fff" />
            </svg>
            合流<small>版本台账 · heliu</small>
          </div>
          <ProjectSwitcher projects={projects} cur={cur} go={go} />
          <span class="datatime" title="对账结果在服务端缓存 20 秒；页面每 30 秒自动刷新">
            {!cur ? "还没有选项目" : meta ? `数据时间 ${hms(meta.scannedAt)} · 用时 ${secs(meta.scanMs)}` : status.error ? "数据加载失败" : "正在扫描…"}
            {status.loading || overview.loading ? " · 刷新中" : ""}
          </span>
          <button
            class="btn"
            onClick={() => {
              refresh();
              reloadProjects();
            }}
            disabled={status.loading}
          >
            ↻ 刷新
          </button>
        </div>
        <nav class="tabs">
          {TABS.map((t) => (
            <button class={`tab${tab === t.key ? " on" : ""}`} onClick={() => go(t.key)} disabled={!cur && t.key !== "start"} aria-label={t.title} title={!cur && t.key !== "start" ? "先在「开始」里接入或选择一个项目" : undefined}>
              {t.title}
              {t.key === "sessions" && ov && ov.waiting > 0 ? <span class="badge">{ov.waiting}</span> : null}
              {t.key === "hygiene" && ov && ov.hygieneWarnings > 0 ? <span class="badge">{ov.hygieneWarnings}</span> : null}
            </button>
          ))}
        </nav>
        {cur ? <NextLine ov={ov ?? null} pc={pc} onCheck={() => void check(pc.state === "on")} /> : null}
      </header>
      {ov && tab !== "start" && tab !== "galaxy" ? <Strip ov={ov} go={go} /> : null}
      <main>
        {status.error && tab !== "start" ? <p class="err">读取对账失败：{status.error}</p> : null}
        {tab === "start" ? <StartPage projects={projects} reloadProjects={reloadProjects} go={go} /> : null}
        {tab === "overview" ? <OverviewPage tick={tick} status={status.env?.data ?? null} overview={ov ?? null} go={go} /> : null}
        {tab === "structure" ? <StructurePage tick={tick} status={status.env?.data ?? null} precheck={precheck} onChanged={refresh} /> : null}
        {tab === "galaxy" ? <GalaxyPage tick={tick} status={status.env?.data ?? null} precheck={precheck} onChanged={refresh} projects={projects} /> : null}
        {tab === "board" ? <BoardPage tick={tick} precheck={precheck} onChanged={refresh} /> : null}
        {tab === "hygiene" ? <HygienePage tick={tick} /> : null}
        {tab === "sessions" ? <SessionsPage tick={tick} /> : null}
        {tab === "release" ? <ReleasePage tick={tick} /> : null}
      </main>
    </div>
  );
}

/** 顶栏项目切换：切换 = 记住选择并带 ?project= 重新载入；最后一项跳到「开始」的接入向导 */
function ProjectSwitcher({ projects, cur, go }: { projects: ProjectsData; cur: string | null; go: (t: Tab) => void }) {
  const names = projects.projects.map((p) => p.name);
  const onChange = (el: HTMLSelectElement) => {
    const v = el.value;
    el.value = cur ?? ""; // 受控下拉：选完「接入新项目」后显示回当前项目
    if (v === "__add__") {
      go("start");
      location.hash = "/start/add";
      setTimeout(() => window.dispatchEvent(new Event("heliu:open-add")), 50);
      return;
    }
    if (v && v !== cur) switchProject(v);
  };
  return (
    <select class="proj-switch" value={cur ?? ""} onChange={(e) => onChange(e.target as HTMLSelectElement)} title="切换项目">
      {!cur ? <option value="">选择项目…</option> : null}
      {names.map((n) => (
        <option value={n}>{n}</option>
      ))}
      <option value="__add__">＋ 接入新项目…</option>
    </select>
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
      <span class="muted">· 顺延：在终端执行「heliu 合并 某版本」时处理（看板只预演）</span>
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

render(<Root />, document.getElementById("app")!);
