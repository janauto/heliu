/** @jsxImportSource preact */
/**
 * 合流 · 积木工作台（M10）入口：标题栏 / 左侧栏 / 工作台 / 右侧详情 / 状态栏。
 * - 数据集中加载一次（status / overview / features / milestones），各视图通过 useApp() 共用，30 秒自动刷新（服务端缓存 20 秒）。
 * - 冲突检查（试合）打开页面后自动做一次，之后刷新都带上；标题栏可「重新检查」。
 * - 所有写操作仍只写台账 / 合并单；合并在终端执行。
 */
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { FeaturesData, OverviewData, ProjectsData } from "../src/board/api-types.ts";
import type { LedgerMilestone, ReconcileReport } from "../src/types.ts";
import { AppCtx, tabDef, tabFromHash, type AppState, type PcState, type Selection, type Tab, type ToastOpts } from "./app.tsx";
import { GalaxyPage } from "./galaxy.tsx";
import { Inspector } from "./inspector.tsx";
import { api, currentProject, hms, secs, setCurrentProject, store, switchProject, useApi } from "./lib.ts";
import { HygienePage, SessionsPage } from "./pages.tsx";
import { StartPage } from "./start.tsx";
import { StructurePage } from "./structure.tsx";
import { Icon, Popover } from "./ui.tsx";
import { AssemblyView } from "./views/assembly.tsx";
import { HomeView } from "./views/home.tsx";
import { KanbanView } from "./views/kanban.tsx";
import { TimelineView } from "./views/timeline.tsx";

export type { Tab } from "./app.tsx";

const REFRESH_MS = 30_000;
type Theme = "auto" | "light" | "dark";

/** 选当前项目：地址 ?project= > 上次选的 > 看板默认 > 只有一个项目时就它 */
function pickProject(pd: ProjectsData): string | null {
  const names = new Set(pd.projects.filter((p) => !p.error).map((p) => p.name));
  const url = new URLSearchParams(location.search).get("project");
  for (const n of [url, store.get("heliu.project"), pd.default]) if (n && names.has(n)) return n;
  return names.size === 1 ? [...names][0]! : null;
}

function applyTheme(t: Theme): void {
  const el = document.documentElement;
  if (t === "auto") delete el.dataset.theme;
  else el.dataset.theme = t;
}

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

interface ToastItem {
  id: number;
  text: string;
  kind: "ok" | "err" | "info";
  undo?: () => void | Promise<void>;
}

function App({ projects, reloadProjects }: { projects: ProjectsData; reloadProjects: () => void }) {
  const cur = currentProject();
  const firstVisit = !store.get("heliu.seenStart");
  const initial = tabFromHash(!cur || firstVisit ? "start" : "home");
  const [tab, setTab] = useState<Tab>(initial.tab);
  const [sub, setSub] = useState<string | null>(initial.sub);
  useEffect(() => {
    if (tab === "start") store.set("heliu.seenStart", "1");
  }, [tab]);
  const [tick, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  useEffect(() => {
    const onHash = () => {
      const h = tabFromHash(cur ? "home" : "start");
      setTab(h.tab);
      setSub(h.sub);
    };
    window.addEventListener("hashchange", onHash);
    const timer = setInterval(refresh, REFRESH_MS);
    return () => {
      window.removeEventListener("hashchange", onHash);
      clearInterval(timer);
    };
  }, []);
  const go = (t: Tab, s: string | null = null) => {
    if (!cur && t !== "start") return;
    location.hash = s ? `/${t}/${encodeURIComponent(s)}` : `/${t}`;
    setTab(t);
    setSub(s);
    mainRef.current?.scrollTo(0, 0);
  };

  /* 冲突检查（试合） */
  const [pc, setPc] = useState<PcState>({ state: "off", at: null, error: null });
  const check = async (fresh: boolean) => {
    setPc((s) => ({ ...s, state: "checking", error: null }));
    try {
      const r = await api<ReconcileReport>(`/api/status?precheck=1${fresh ? "&fresh=1" : ""}`);
      setPc({ state: "on", at: r.meta?.scannedAt ?? null, error: null });
      if (fresh) refresh();
    } catch (e) {
      setPc((s) => ({ ...s, state: s.at ? "on" : "off", error: (e as Error).message }));
    }
  };
  useEffect(() => {
    if (cur) void check(false);
  }, []);
  const precheck = pc.state === "on" || (pc.state === "checking" && !!pc.at);

  /* 集中加载 */
  const status = useApi<ReconcileReport>(cur ? "/api/status" : null, [tick]);
  const overview = useApi<OverviewData>(cur ? `/api/overview?precheck=${precheck ? 1 : 0}` : null, [tick, precheck]);
  const features = useApi<FeaturesData>(cur ? `/api/features?precheck=${precheck ? 1 : 0}` : null, [tick, precheck]);
  const ms = useApi<{ milestones: LedgerMilestone[]; next: string | null }>(cur ? "/api/milestones" : null, [tick]);

  /* 搜索、主题、toast、选中 */
  const [query, setQuery] = useState("");
  const [theme, setThemeState] = useState<Theme>((store.get("heliu.theme") as Theme | null) ?? "auto");
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = (t: Theme) => {
    store.set("heliu.theme", t);
    setThemeState(t);
  };
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const toastSeq = useRef(0);
  const toast = (text: string, opts: ToastOpts = {}) => {
    const id = ++toastSeq.current;
    setToasts((l) => [...l.slice(-2), { id, text, kind: opts.kind ?? "ok", undo: opts.undo }]);
    setTimeout(() => setToasts((l) => l.filter((x) => x.id !== id)), opts.ms ?? (opts.undo ? 6500 : 4000));
  };
  const [selected, setSelected] = useState<Selection | null>(null);
  const select = (s: Selection | null) => setSelected(s);
  // 数据刷新后，选中的卡用新数据替换（灯色 / 预约会变）
  useEffect(() => {
    if (!selected || selected.kind !== "card" || !features.env) return;
    for (const col of features.env.data.columns) {
      const c = col.cards.find((x) => x.id === selected.card.id);
      if (c) {
        if (c !== selected.card) setSelected({ kind: "card", card: c });
        return;
      }
    }
  }, [features.env]);
  useEffect(() => {
    if (!sub) setSelected(null);
  }, [tab]);
  const searchRef = useRef<HTMLInputElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const inField = (e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]");
      if ((e.key === "/" && !inField) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (e.key === "Escape" && !inField) setSelected(null);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const meta = status.env?.meta ?? null;
  const ov = overview.env?.data ?? null;
  const projectName = cur ?? "";
  useEffect(() => {
    document.title = projectName ? `合流 · ${projectName} · ${tabDef(tab).title}` : "合流";
  }, [projectName, tab]);

  const state: AppState = {
    project: cur,
    projects,
    reloadProjects,
    tab,
    sub,
    go,
    tick,
    refresh,
    precheck,
    pc,
    check: (fresh) => void check(fresh),
    query,
    setQuery,
    status: status.env?.data ?? null,
    statusError: status.error,
    statusLoading: status.loading,
    meta,
    overview: ov,
    features: features.env?.data ?? null,
    featuresError: features.error,
    featuresLoading: features.loading,
    reloadFeatures: () => {
      features.reload();
      ms.reload();
    },
    milestones: ms.env?.data.milestones ?? [],
    next: ms.env?.data.next ?? null,
    toast,
    selected,
    select,
    theme,
    setTheme,
  };
  const loading = status.loading || overview.loading || features.loading;
  const busy = loading && (status.env || features.env) ? true : false;

  return (
    <AppCtx.Provider value={state}>
      <div class={`app${selected ? " has-inspector" : ""}`}>
        <header class="titlebar">
          <div class="brand">
            <BrandMark />
            合流<small>heliu</small>
          </div>
          <ProjectSwitcher projects={projects} cur={cur} go={go} />
          <div class="search" role="search">
            <Icon name="search" size={16} />
            <input
              ref={searchRef}
              type="text"
              value={query}
              placeholder={cur ? "搜方块：标题 / 卡号 / 分支…" : "先接入一个项目"}
              disabled={!cur}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  (e.target as HTMLInputElement).blur();
                }
              }}
              aria-label="搜索方块"
            />
            {query ? (
              <button class="clear" onClick={() => setQuery("")} aria-label="清空搜索">
                <Icon name="close" size={12} />
              </button>
            ) : (
              <span class="kbd">/</span>
            )}
          </div>
          <div class="title-right">
            {cur ? <PcPill pc={pc} ov={ov} onCheck={() => void check(pc.state === "on")} /> : null}
            <ThemeMenu theme={theme} setTheme={setTheme} />
            <button
              class={`icon-btn${busy ? " spinning" : ""}`}
              title="刷新（对账结果在服务端缓存 20 秒；页面每 30 秒自动刷新）"
              aria-label="刷新"
              disabled={!cur || loading}
              onClick={() => {
                refresh();
                reloadProjects();
              }}
            >
              <Icon name="refresh" size={17} />
            </button>
          </div>
        </header>

        <nav class="sidebar" aria-label="页面">
          <NavGroup title="工作" keys={["home", "kanban", "timeline", "assembly"]} tab={tab} go={go} cur={cur} ov={ov} />
          <NavGroup title="了解" keys={["structure", "sessions", "hygiene"]} tab={tab} go={go} cur={cur} ov={ov} />
          <div class="grow" />
          <NavGroup title="更多" keys={["start", "galaxy"]} tab={tab} go={go} cur={cur} ov={ov} />
          <div class="nav-foot">
            <span>v0.5.0</span>
            <a href="https://github.com/janauto/heliu/blob/main/docs/教程.md" target="_blank" rel="noreferrer" title="打开使用教程（GitHub）">
              教程
            </a>
          </div>
        </nav>

        <main class="main" ref={mainRef}>
          {status.error && tab !== "start" ? (
            <div class="page">
              <p class="err">读取对账失败：{status.error}</p>
            </div>
          ) : null}
          {tab === "start" ? (
            <div class="page">
              <StartPage projects={projects} reloadProjects={reloadProjects} go={go} />
            </div>
          ) : null}
          {tab === "home" ? <HomeView /> : null}
          {tab === "kanban" ? <KanbanView /> : null}
          {tab === "timeline" ? <TimelineView /> : null}
          {tab === "assembly" ? <AssemblyView /> : null}
          {tab === "structure" ? (
            <div class="page">
              <StructurePage tick={tick} status={status.env?.data ?? null} precheck={precheck} onChanged={refresh} />
            </div>
          ) : null}
          {tab === "sessions" ? (
            <div class="page">
              <SessionsPage tick={tick} />
            </div>
          ) : null}
          {tab === "hygiene" ? (
            <div class="page">
              <HygienePage tick={tick} />
            </div>
          ) : null}
          {tab === "galaxy" ? (
            <div class="page wide">
              <GalaxyPage tick={tick} status={status.env?.data ?? null} precheck={precheck} onChanged={refresh} projects={projects} />
            </div>
          ) : null}
        </main>

        <Inspector />

        <footer class="statusbar">
          {cur ? (
            <>
              <span class="dot tone-green" style={meta ? "" : "background:var(--gray)"} />
              <span>{meta ? `数据时间 ${hms(meta.scannedAt)} · 用时 ${secs(meta.scanMs)}${meta.cached ? " · 缓存" : ""}` : status.error ? "数据加载失败" : "正在扫描…"}</span>
              {loading ? <span>· 刷新中</span> : null}
            </>
          ) : (
            <span>还没有选项目</span>
          )}
          <span class="grow" />
          <span title="所有页面只写合流自己的台账与合并单；真正的 git 合并在终端 heliu 合并 <版本> 里输入 yes 才执行">只读被管理仓库 · 不 push · 合并在终端执行</span>
        </footer>

        <div class="toasts" aria-live="polite">
          {toasts.map((t) => (
            <div class={`toast ${t.kind}`} key={t.id}>
              <Icon name={t.kind === "err" ? "alert" : t.kind === "ok" ? "check" : "info"} size={16} />
              <span class="t">{t.text}</span>
              {t.undo ? (
                <button
                  onClick={() => {
                    setToasts((l) => l.filter((x) => x.id !== t.id));
                    void t.undo!();
                  }}
                >
                  撤销
                </button>
              ) : null}
              <button class="x" onClick={() => setToasts((l) => l.filter((x) => x.id !== t.id))} aria-label="关闭">
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </AppCtx.Provider>
  );
}

function BrandMark() {
  return (
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="mark-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#19b4e6" />
          <stop offset="55%" stop-color="#3f62ff" />
          <stop offset="100%" stop-color="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#mark-g)" />
      <path d="M7 9 C 13 9, 14 16, 19 16 L 25 16" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" />
      <path d="M7 23 C 13 23, 14 16, 19 16" stroke="#fff" stroke-opacity="0.75" stroke-width="2.4" fill="none" stroke-linecap="round" />
      <circle cx="25" cy="16" r="2.6" fill="#fff" />
    </svg>
  );
}

function NavGroup({ title, keys, tab, go, cur, ov }: { title: string; keys: Tab[]; tab: Tab; go: (t: Tab) => void; cur: string | null; ov: OverviewData | null }) {
  return (
    <div class="nav-group">
      <div class="nav-title">{title}</div>
      {keys.map((k) => {
        const d = tabDef(k);
        const badge = k === "sessions" && ov && ov.waiting > 0 ? { n: ov.waiting, tone: "purple" } : k === "hygiene" && ov && ov.hygieneWarnings > 0 ? { n: ov.hygieneWarnings, tone: "yellow" } : null;
        return (
          <button class={`nav-item${tab === k ? " on" : ""}`} data-key={k} onClick={() => go(k)} disabled={!cur && k !== "start"} title={!cur && k !== "start" ? "先在「开始」里接入或选择一个项目" : d.desc} aria-current={tab === k ? "page" : undefined}>
            <Icon name={d.icon} size={18} />
            <span class="label">{d.title}</span>
            {badge ? <span class={`badge tone-${badge.tone}`}>{badge.n}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/** 项目切换：按钮 + 弹出列表（项目名 · N 仓库 · 还欠 N）；最后一项去「开始」的接入向导 */
function ProjectSwitcher({ projects, cur, go }: { projects: ProjectsData; cur: string | null; go: (t: Tab) => void }) {
  const [open, setOpen] = useState(false);
  const p = projects.projects.find((x) => x.name === cur) ?? null;
  const pick = (name: string) => {
    setOpen(false);
    if (name !== cur) switchProject(name);
  };
  return (
    <div class="proj-wrap">
      <button class="proj-btn" data-popover-anchor onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="切换项目">
        <Icon name="folder" size={16} />
        <span class="name">{cur ?? "选择项目…"}</span>
        {p ? <span class="sub">{p.repos.length} 仓库</span> : null}
        <Icon name="chevron" size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div class="title">项目</div>
        {projects.projects.map((x) => (
          <button class={`item${x.name === cur ? " on" : ""}`} role="menuitem" onClick={() => pick(x.name)} disabled={!!x.error} title={x.error ?? x.source}>
            <Icon name={x.name === cur ? "check" : "folder"} size={16} />
            <span>
              {x.name}
              <span class="sub">
                {x.error ? x.error : `${x.repos.length} 个仓库${x.open !== null ? ` · 还欠 ${x.open}` : ""}${x.next ? ` · 下一版 ${x.next}` : ""}`}
              </span>
            </span>
          </button>
        ))}
        <div class="sep" />
        <button
          class="item"
          role="menuitem"
          onClick={() => {
            setOpen(false);
            go("start");
            location.hash = "/start/add";
            setTimeout(() => window.dispatchEvent(new Event("heliu:open-add")), 50);
          }}
        >
          <Icon name="plus" size={16} />
          接入新项目…
        </button>
      </Popover>
    </div>
  );
}

/** 冲突检查胶囊：未检查 → 点击检查 / 检查中 / 已检查 HH:MM:SS → 重新检查；部分失败如实写 */
function PcPill({ pc, ov, onCheck }: { pc: PcState; ov: OverviewData | null; onCheck: () => void }) {
  const s = ov?.precheckSummary;
  if (pc.state === "checking") {
    return (
      <span class="pc-pill checking" title="正在用 merge-tree 试合（临时区进行，不碰仓库）">
        <i class="dot tone-yellow" />
        <span class="txt">检查冲突中…</span>
      </span>
    );
  }
  if (pc.state === "on") {
    const partial = s && s.requested && s.failed > 0;
    return (
      <span class="pc-pill" title={partial ? `${s.failed} 张卡未能试合：${s.firstError ?? "原因未知"}` : "试合结果：每张卡的「撞了 / 能拼上」就是从这里来的"}>
        <i class={`dot tone-${partial ? "yellow" : "green"}`} />
        <span class="txt">{partial ? `冲突${s.status === "failed" ? "未完成" : "部分完成"}` : `冲突已检查 ${hms(ov?.precheckAt ?? pc.at)}`}</span>
        <button class="link" onClick={onCheck}>
          重新检查
        </button>
        {pc.error ? <span class="bad tiny">{pc.error}</span> : null}
      </span>
    );
  }
  return (
    <span class="pc-pill" title="用 merge-tree 试合，看每一块能不能拼上（临时区进行，不碰仓库）">
      <i class="dot tone-gray" />
      <span class="txt">冲突未检查</span>
      <button class="link" onClick={onCheck}>
        点击检查
      </button>
      {pc.error ? <span class="bad tiny">{pc.error}</span> : null}
    </span>
  );
}

function ThemeMenu({ theme, setTheme }: { theme: Theme; setTheme: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  const items: Array<{ k: Theme; t: string; icon: "auto" | "sun" | "moon" }> = [
    { k: "auto", t: "跟随系统", icon: "auto" },
    { k: "light", t: "浅色", icon: "sun" },
    { k: "dark", t: "深色", icon: "moon" },
  ];
  const curIcon = items.find((i) => i.k === theme)?.icon ?? "auto";
  return (
    <div class="theme-wrap">
      <button class="icon-btn" data-popover-anchor onClick={() => setOpen((o) => !o)} title="外观：跟随系统 / 浅色 / 深色" aria-label="外观">
        <Icon name={curIcon} size={17} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div class="title">外观</div>
        {items.map((i) => (
          <button
            class={`item${theme === i.k ? " on" : ""}`}
            role="menuitemradio"
            aria-checked={theme === i.k}
            onClick={() => {
              setTheme(i.k);
              setOpen(false);
            }}
          >
            <Icon name={i.icon} size={16} />
            {i.t}
          </button>
        ))}
      </Popover>
    </div>
  );
}


render(<Root />, document.getElementById("app")!);
