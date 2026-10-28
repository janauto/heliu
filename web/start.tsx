/** @jsxImportSource preact */
/**
 * 「开始」页（M6）：五步上手。
 * ① 环境检查 ② 接入项目（向导）③ 把现有分支登记成卡 ④ 开始日常使用 ⑤ 终端命令。
 * 全部操作只写 heliu 注册表与台账；被管理仓库零写入；合并只给可复制的终端命令，不在页面里执行。
 */
import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { DetectData, DoctorData, OnboardResult, ProjectsData, ProjectSummary, SyncView } from "../src/board/api-types.ts";
import type { DoctorCheck } from "../src/types.ts";
import { api, copyText, currentProject, mdhm, secs, store, switchProject, useApi } from "./lib.ts";
import type { Tab } from "./main.tsx";

const TUTORIAL_URL = "https://github.com/janauto/heliu/blob/main/docs/%E6%95%99%E7%A8%8B.md";

export function StartPage({ projects, reloadProjects, go }: { projects: ProjectsData; reloadProjects: () => void; go: (t: Tab) => void }) {
  const cur = currentProject();
  const curSummary = projects.projects.find((p) => p.name === cur) ?? null;
  return (
    <div class="start">
      <div class="panel hero">
        <h1>欢迎使用合流</h1>
        <p>
          合流帮你记住：每个 Claude 会话在做哪个功能、这个功能打算进哪一版、离合并还差什么。
          <b>git 是事实，台账是承诺，看板是对账单。</b>
        </p>
        <p class="muted small">
          下面五步做完就能日常使用。所有操作只写合流自己的数据目录，不改你的仓库；合并要在终端里输入 yes 才会执行。{" "}
          <a href={TUTORIAL_URL} target="_blank" rel="noreferrer">
            看完整教程
          </a>
        </p>
      </div>

      <Step n={1} title="检查环境" hint="确认 git、bun、写保护沙箱、桌面会话数据都能读到。">
        <DoctorPanel />
      </Step>

      <Step n={2} title="接入项目" hint="把一个 git 仓库交给合流管理。一个项目可以包含多个仓库（比如文档仓、固件仓、App 仓）。" done={projects.projects.length > 0}>
        <ProjectList projects={projects} go={go} />
        <AddWizard projects={projects} onAdded={reloadProjects} go={go} />
      </Step>

      <Step n={3} title="把现有分支登记成卡" hint="已经在 worktree 里做着的分支，一次性登记成功能卡，默认预约到下一版。" done={!!curSummary && (curSummary.features ?? 0) > 0}>
        {cur ? <SyncPanel project={cur} onDone={reloadProjects} go={go} /> : <p class="muted">先在第 2 步接入或选一个项目。</p>}
      </Step>

      <Step n={4} title="开始日常使用" hint="平时只有四个动作。">
        {cur ? <DailyPanel project={cur} summary={curSummary} go={go} onAdded={reloadProjects} /> : <p class="muted">先在第 2 步接入或选一个项目。</p>}
      </Step>

      <Step n={5} title="终端命令（合并一版要用）" hint="看板只预演合并；真正执行在终端里输入 yes 才开始，并且可以回滚。">
        <Commands root={projects.heliuRoot} project={cur} />
      </Step>
    </div>
  );
}

function Step({ n, title, hint, done, children }: { n: number; title: string; hint: string; done?: boolean; children: ComponentChildren }) {
  return (
    <section class="step" id={`step-${n}`}>
      <div class={`step-n${done ? " done" : ""}`}>{done ? "✓" : n}</div>
      <div class="step-body">
        <h2>{title}</h2>
        <p class="muted small">{hint}</p>
        {children}
      </div>
    </section>
  );
}

/* ───────────── ① 环境检查 ───────────── */

const ICON: Record<DoctorCheck["level"], string> = { ok: "✓", warn: "!", fail: "✗" };
const ENV_IDS = new Set(["git", "git-ahead-behind", "bun", "sandbox", "headless-claude"]);
const DATA_IDS = new Set(["desktop-sessions", "git-worktrees-json", "running-sessions", "registry", "registry-icloud"]);

function DoctorPanel() {
  const [full, setFull] = useState(false);
  const d = useApi<DoctorData>(`/api/doctor${full ? "?full=1" : ""}`, [full]);
  const data = d.env?.data;
  const groups: Array<[string, DoctorCheck[]]> = data
    ? [
        ["运行环境", data.checks.filter((c) => ENV_IDS.has(c.id))],
        ["桌面会话与注册表", data.checks.filter((c) => DATA_IDS.has(c.id))],
        ["已接入的项目", data.checks.filter((c) => !ENV_IDS.has(c.id) && !DATA_IDS.has(c.id))],
      ]
    : [];
  return (
    <div class="panel">
      {d.error ? <p class="err">环境检查失败：{d.error}</p> : null}
      {!data ? <p class="muted">正在检查…</p> : null}
      {data ? (
        <>
          <p class={data.counts.fail ? "err" : "ok"}>
            {data.counts.fail
              ? `有 ${data.counts.fail} 项需要处理（标 ✗ 的那几行），其余 ${data.counts.ok} 项正常、${data.counts.warn} 项提醒。`
              : data.counts.warn
                ? `可以用了。${data.counts.ok} 项正常，${data.counts.warn} 项提醒（提醒不影响使用）。`
                : `一切正常（${data.counts.ok} 项）。`}
            <span class="muted small"> 用时 {secs(data.ms)}</span>
          </p>
          {groups.map(([title, list]) => (list.length ? <CheckGroup title={title} list={list} /> : null))}
          <div class="toolbar">
            <button class="btn" onClick={() => d.reload()} disabled={d.loading}>
              {d.loading ? "检查中…" : "重新检查"}
            </button>
            {!data.full ? (
              <button class="btn" onClick={() => setFull(true)} disabled={d.loading} title="会真的调用一次无头 claude，最长约 20 秒">
                完整检查（含无头 claude，约 20 秒）
              </button>
            ) : null}
          </div>
          <p class="explain">
            「无头 claude」只在合并遇到普通文件冲突、需要 Claude 帮忙解冲突时才用到。显示未登录时，在终端执行一次 <code>claude login</code> 即可。
          </p>
        </>
      ) : null}
    </div>
  );
}

/** 一组检查：提醒与失败直接列出；正常的收成一行「N 项正常」，点开再看（信息不挤在一起） */
function CheckGroup({ title, list }: { title: string; list: DoctorCheck[] }) {
  const [open, setOpen] = useState(false);
  const bad = list.filter((c) => c.level !== "ok");
  const good = list.filter((c) => c.level === "ok");
  const shown = open ? list : bad;
  return (
    <div class="checks">
      <h3>{title}</h3>
      <ul>
        {shown.map((c) => (
          <li class={`lv-${c.level}`}>
            <span class="ic">{ICON[c.level]}</span>
            <span>{c.message}</span>
          </li>
        ))}
        {good.length ? (
          <li class="lv-ok fold">
            <span class="ic">{ICON.ok}</span>
            <span>
              {open ? "" : `${good.length} 项正常 `}
              <button class="link" onClick={() => setOpen((o) => !o)}>
                {open ? "收起正常项" : "展开看看"}
              </button>
            </span>
          </li>
        ) : null}
      </ul>
    </div>
  );
}

/* ───────────── ② 已接入的项目 + 接入向导 ───────────── */

function ProjectList({ projects, go }: { projects: ProjectsData; go: (t: Tab) => void }) {
  const cur = currentProject();
  if (!projects.projects.length) return <p class="muted">还没有接入任何项目。用下面的向导接入第一个。</p>;
  return (
    <div class="proj-list">
      {projects.projects.map((p) => (
        <ProjectCard p={p} current={p.name === cur} go={go} />
      ))}
    </div>
  );
}

function ProjectCard({ p, current, go }: { p: ProjectSummary; current: boolean; go: (t: Tab) => void }) {
  return (
    <div class={`panel proj${current ? " on" : ""}`}>
      <div class="proj-h">
        <b>{p.name}</b>
        {current ? <span class="badge next">当前</span> : null}
      </div>
      {p.error ? <p class="err small">{p.error}</p> : null}
      <ul class="proj-repos">
        {p.repos.map((r) => (
          <li>
            <span class="badge repo">{r.label}</span> 主线 <code>{r.main}</code> · 集成 {r.integration ? <code>{r.integration}</code> : <span class="muted">未设</span>}
            {r.icloud ? <span class="tag">iCloud</span> : null}
            {!r.exists ? <span class="warn"> · 路径不存在</span> : null}
          </li>
        ))}
      </ul>
      <p class="small muted">
        {p.features === null ? "台账还没建" : `功能卡 ${p.features} 张 · 还欠 ${p.open ?? 0} 项`}
        {p.next ? ` · 下一版 ${p.next}` : ""}
      </p>
      <div class="toolbar">
        {current ? (
          <button class="btn primary" onClick={() => go("overview")}>
            打开总览
          </button>
        ) : (
          <button class="btn primary" onClick={() => switchProject(p.name, "overview")}>
            打开这个项目
          </button>
        )}
        {!current ? (
          <button class="btn" onClick={() => switchProject(p.name, "start")}>
            设为当前
          </button>
        ) : null}
      </div>
    </div>
  );
}

type Phase = "input" | "review" | "done";

function AddWizard({ projects, onAdded, go }: { projects: ProjectsData; onAdded: () => void; go: (t: Tab) => void }) {
  const [open, setOpen] = useState(projects.projects.length === 0 || location.hash === "#/start/add");
  const [phase, setPhase] = useState<Phase>("input");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [det, setDet] = useState<DetectData | null>(null);
  const [name, setName] = useState("");
  const [main, setMain] = useState("");
  const [remote, setRemote] = useState("");
  const [integ, setInteg] = useState("");
  const [result, setResult] = useState<OnboardResult | null>(null);
  // 顶栏「＋ 接入新项目…」：展开向导并滚过来
  useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setTimeout(() => document.getElementById("add")?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
    };
    window.addEventListener("heliu:open-add", onOpen);
    return () => window.removeEventListener("heliu:open-add", onOpen);
  }, []);

  const reset = () => {
    setPhase("input");
    setDet(null);
    setResult(null);
    setErr(null);
  };

  const detect = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<DetectData>("/api/projects/detect", { body: { path } });
      const d = r.data;
      setDet(d);
      setName(d.suggestedName);
      setMain(d.detection.main);
      setRemote(d.detection.remote ?? "");
      setInteg(d.detection.integration ?? "");
      setPhase("review");
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!det) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<OnboardResult>("/api/projects", {
        body: { path: det.detection.root, name: name.trim(), main: main.trim() || undefined, remote: remote || undefined, integration: integ },
      });
      setResult(r.data);
      setPhase("done");
      // 还没有当前项目时，刚接入的这个就是当前项目（第 3、4 步立刻可用）
      if (!currentProject()) store.set("heliu.project", r.data.project.name);
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div class="toolbar">
        <button class="btn" onClick={() => setOpen(true)}>
          ＋ 接入新项目 / 给项目再加一个仓库
        </button>
      </div>
    );
  }

  const existing = det ? det.existingProjects.includes(name.trim()) : false;
  return (
    <div class="panel wizard" id="add">
      <h3>接入向导</h3>
      <ol class="wiz-steps">
        <li class={phase === "input" ? "on" : "done"}>填路径</li>
        <li class={phase === "review" ? "on" : phase === "done" ? "done" : ""}>确认检测结果</li>
        <li class={phase === "done" ? "on" : ""}>完成</li>
      </ol>
      {err ? <p class="err">{err}</p> : null}

      {phase === "input" ? (
        <>
          <label class="field">
            <span>仓库路径</span>
            <input
              type="text"
              value={path}
              placeholder="/Users/你的用户名/……/你的仓库"
              onInput={(e) => setPath((e.target as HTMLInputElement).value)}
              onKeyDown={(e) => e.key === "Enter" && path.trim() && void detect()}
            />
          </label>
          <p class="explain">在 Finder 里选中仓库文件夹，按 ⌥⌘C（Option + Command + C）复制路径，粘贴到这里。检测只读，不会改你的仓库。</p>
          <div class="toolbar">
            <button class="btn primary" onClick={() => void detect()} disabled={busy || !path.trim()}>
              {busy ? "检测中…" : "检测"}
            </button>
            {projects.projects.length ? (
              <button class="btn" onClick={() => setOpen(false)}>
                收起
              </button>
            ) : null}
          </div>
        </>
      ) : null}

      {phase === "review" && det ? (
        <>
          <div class="kv">
            <span>仓库</span>
            <span>
              <code>{det.detection.root}</code>
              {det.detection.icloud ? <span class="tag">iCloud</span> : null}
            </span>
            <span>规模</span>
            <span>
              {det.detection.branches} 个分支{det.detection.worktrees !== null ? ` · ${det.detection.worktrees} 个 worktree` : ""}
              {det.detection.head ? ` · 主目录在 ${det.detection.head}` : ""}
            </span>
          </div>
          {det.detection.icloud ? <p class="explain">仓库在 iCloud 上：合流默认不检查工作区文件改动（会触发下载），其他功能照常。</p> : null}

          <label class="field">
            <span>项目名</span>
            <input type="text" list="heliu-projects" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
            <datalist id="heliu-projects">
              {det.existingProjects.map((n) => (
                <option value={n} />
              ))}
            </datalist>
          </label>
          <p class="explain">
            {existing
              ? `会加入已有项目「${name.trim()}」，成为它的又一个仓库（适合把固件仓、App 仓并进同一个项目）。`
              : `会新建项目「${name.trim() || "?"}」。想并进已有项目，就把名字改成那个项目的名字。`}
          </p>

          <label class="field">
            <span>主线分支</span>
            <input type="text" value={main} onInput={(e) => setMain((e.target as HTMLInputElement).value)} />
          </label>
          <p class="explain">
            {det.detection.mainWhy}
            {!det.detection.mainExists ? "（本地没有这个分支，请改成你的主线）" : ""}
          </p>

          <label class="field">
            <span>远端</span>
            <select value={remote} onChange={(e) => setRemote((e.target as HTMLSelectElement).value)}>
              <option value="">不设</option>
              {det.detection.remotes.map((r) => (
                <option value={r}>{r}</option>
              ))}
            </select>
          </label>
          <p class="explain">只用来对比本地已有的远端引用；合流从不 fetch、不 push。</p>

          <fieldset class="field cand">
            <legend>集成分支</legend>
            <p class="explain">集成分支 = 你平时把各个功能合到一起的那条分支。合流「合并一版」时就往这里合。没有的话选「不设」，以后可以再加。</p>
            {det.detection.candidates.map((c) => (
              <label class="radio">
                <input type="radio" name="integ" checked={integ === c.branch} onChange={() => setInteg(c.branch)} />
                <span>
                  <code>{c.branch}</code>
                  {c.byName ? <span class="tag">名字像</span> : null}
                  {c.checkedOut ? <span class="tag">主目录正在用</span> : null}
                  <br />
                  <span class="muted small">
                    领先主线 {c.ahead} 个提交 · 包含 {c.contains} 条未合并分支{c.lastCommitAt ? ` · 最后提交 ${mdhm(c.lastCommitAt)}` : ""}
                  </span>
                </span>
              </label>
            ))}
            <OtherBranch det={det} main={main} integ={integ} setInteg={setInteg} />
            <label class="radio">
              <input type="radio" name="integ" checked={integ === ""} onChange={() => setInteg("")} />
              <span>不设（以后需要再加）</span>
            </label>
            <p class="explain">猜测依据：{det.detection.integrationWhy}</p>
          </fieldset>

          {det.detection.warnings.length ? (
            <ul class="warn small">
              {det.detection.warnings.map((w) => (
                <li>{w}</li>
              ))}
            </ul>
          ) : null}
          <p class="explain">台账：{det.ledgerNote}（{det.ledgerDir}）</p>
          <div class="toolbar">
            <button class="btn primary" onClick={() => void save()} disabled={busy || !name.trim()}>
              {busy ? "接入中…" : existing ? "加入这个项目" : "确认接入"}
            </button>
            <button class="btn" onClick={reset} disabled={busy}>
              重新填路径
            </button>
          </div>
        </>
      ) : null}

      {phase === "done" && result ? (
        <>
          <p class="ok">
            {result.created ? "已新建" : "已更新"}项目「{result.project.name}」：加入仓库 {result.repo.label}（主线 {result.repo.main}
            {result.repo.integration ? `，集成 ${result.repo.integration}` : "，未设集成分支"}）。
          </p>
          <p class="explain">
            台账{result.ledger.created ? "已建立" : "已存在"}：{result.ledger.dir}
          </p>
          {!result.repo.integration ? (
            <p class="explain">没设集成分支：合并一版时这个仓库的卡会默认顺延。以后有了集成分支，再接入一次这个仓库、选上它即可（显示名和台账都会保留）。</p>
          ) : null}
          <h3>顺手把这个仓库里正在做的分支登记成卡</h3>
          <SyncPanel project={result.project.name} onDone={onAdded} go={go} />
          <div class="toolbar">
            <button class="btn primary" onClick={() => switchProject(result.project.name, "overview")}>
              打开「{result.project.name}」的看板
            </button>
            <button class="btn" onClick={reset}>
              再接入一个
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

/** 「其他分支」：候选里没有（比如集成分支刚建、还和主线同一个提交）时，从全部本地分支里手选 */
function OtherBranch({ det, main, integ, setInteg }: { det: DetectData; main: string; integ: string; setInteg: (v: string) => void }) {
  const cands = new Set(det.detection.candidates.map((c) => c.branch));
  const others = det.localBranches.filter((b) => b.name !== main.trim() && !cands.has(b.name));
  if (!others.length) return null;
  const picked = integ !== "" && !cands.has(integ);
  return (
    <label class="radio">
      <input type="radio" name="integ" checked={picked} onChange={() => setInteg(others[0]!.name)} />
      <span>
        其他分支：
        <select value={picked ? integ : ""} onChange={(e) => setInteg((e.target as HTMLSelectElement).value)} onFocus={() => !picked && setInteg(others[0]!.name)}>
          {!picked ? <option value="">选一个本地分支…</option> : null}
          {others.map((b) => (
            <option value={b.name}>
              {b.name}
              {b.lastCommitAt ? `（${mdhm(b.lastCommitAt)}）` : ""}
            </option>
          ))}
        </select>
        <br />
        <span class="muted small">候选里没有你的集成分支时用这里（比如它刚建好、还和主线指向同一个提交）。</span>
      </span>
    </label>
  );
}

/* ───────────── ③ 把现有分支登记成卡 ───────────── */

function SyncPanel({ project, onDone, go }: { project: string; onDone: () => void; go: (t: Tab) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [preview, setPreview] = useState<SyncView | null>(null);
  const [done, setDone] = useState<SyncView | null>(null);
  const q = `/api/sync?project=${encodeURIComponent(project)}`;
  const run = async (dry: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<SyncView>(q, { body: { dry_run: dry } });
      if (dry) setPreview(r.data);
      else {
        setDone(r.data);
        onDone();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (done) {
    return (
      <div class="panel">
        <p class="ok">已登记 {done.created.length} 张草稿卡，预约到 {done.milestone ?? "下一版"}。</p>
        <p class="explain">卡片标题取自会话标题；想改名、换版本，到「版本列」里展开卡片操作。</p>
        {project === currentProject() ? (
          <button class="btn" onClick={() => go("board")}>
            去版本列看看
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div class="panel">
      {err ? <p class="err">{err}</p> : null}
      {!preview ? (
        <>
          <p>先预览：看看「{project}」里有多少条正在做、还没有卡片的分支。预览不写任何东西。</p>
          <button class="btn primary" onClick={() => void run(true)} disabled={busy}>
            {busy ? "扫描中…" : "预览能登记多少张"}
          </button>
        </>
      ) : preview.drafts.length === 0 ? (
        <>
          <p class="ok">没有需要登记的分支。</p>
          <p class="explain">
            已有卡片 {preview.skipped.hasCard} 条 · 已进主线 {preview.skipped.inMain} 条 · 没有 worktree {preview.skipped.noWorktree} 条（这些都不需要建卡）。新点子可以在第 4 步直接登记。
          </p>
        </>
      ) : (
        <>
          <p>
            可以登记 <b>{preview.drafts.length}</b> 张草稿卡，预约到 <b>{preview.milestone ?? "vNext（会自动新建）"}</b>。
          </p>
          <ul class="drafts">
            {preview.drafts.slice(0, 12).map((d) => (
              <li>
                <b>{d.title}</b> <span class="muted small">· {d.repoLabel} · {d.branch} · {d.status}</span>
              </li>
            ))}
          </ul>
          {preview.drafts.length > 12 ? <p class="muted small">…还有 {preview.drafts.length - 12} 张</p> : null}
          <p class="explain">
            跳过：已有卡片 {preview.skipped.hasCard} · 已进主线 {preview.skipped.inMain} · 没有 worktree {preview.skipped.noWorktree}
          </p>
          <div class="toolbar">
            <button class="btn primary" onClick={() => void run(false)} disabled={busy}>
              {busy ? "登记中…" : `登记这 ${preview.drafts.length} 张`}
            </button>
            <button class="btn" onClick={() => setPreview(null)} disabled={busy}>
              先不登记
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/* ───────────── ④ 日常使用 ───────────── */

const SAY = ["我有个新点子：让背夹支持闹钟，先并行做着", "下一版还欠什么？", "这个预约到 1.3", "我现在在做哪个功能？", "帮我把现有分支都登记一下"];

function DailyPanel({ project, summary, go, onAdded }: { project: string; summary: ProjectSummary | null; go: (t: Tab) => void; onAdded: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ feature: { id: string; milestone: string | null }; milestoneCreated: string | null }>("/api/features", { body: { title: title.trim() } });
      setMsg(`已登记 ${r.data.feature.id}「${title.trim()}」，预约到 ${r.data.feature.milestone ?? "（未预约）"}${r.data.milestoneCreated ? `（新建了 ${r.data.milestoneCreated}）` : ""}`);
      setTitle("");
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="daily">
      <div class="panel">
        <h3>1. 有了新点子</h3>
        <p class="small">最省事：在 Claude 会话里直接说。合流的 hook 会提醒 Claude 自动登记。也可以在这里登记：</p>
        <div class="toolbar">
          <input type="text" value={title} placeholder="一句话需求，如「让背夹支持闹钟」" onInput={(e) => setTitle((e.target as HTMLInputElement).value)} onKeyDown={(e) => e.key === "Enter" && title.trim() && void add()} />
          <button class="btn primary" onClick={() => void add()} disabled={busy || !title.trim()}>
            登记
          </button>
        </div>
        {msg ? <p class="ok small">{msg}</p> : null}
        {err ? <p class="err small">{err}</p> : null}
        <p class="explain">登记到「{project}」，默认预约下一版。</p>
      </div>
      <div class="panel">
        <h3>2. 这一版还欠什么</h3>
        <p class="small">{summary && summary.open !== null ? `「${project}」现在还欠 ${summary.open} 项${summary.next ? `，下一版是 ${summary.next}` : ""}。` : "看每个版本还差哪些功能。"}</p>
        <p class="explain">版本列里每版一列，卡片按「等你回答 / 有冲突 / 可合并 / 落后需同步」分组。拖卡片到另一列 = 改预约。</p>
        <button class="btn" onClick={() => go("board")}>
          打开版本列
        </button>
      </div>
      <div class="panel">
        <h3>3. 合并一版</h3>
        <p class="small">先在「合并预演」里看会合哪些、哪些顺延；确认后到终端执行（第 5 步有命令）。</p>
        <p class="explain">没做完的功能会自动顺延到下一版并标出来，不会悄悄丢掉。</p>
        <button class="btn" onClick={() => go("release")}>
          打开合并预演
        </button>
      </div>
      <div class="panel">
        <h3>4. 在 Claude 会话里这样说</h3>
        <ul class="say">
          {SAY.map((s) => (
            <li>
              <span>「{s}」</span>
              <button class="link" onClick={() => void copyText(s)}>
                复制
              </button>
            </li>
          ))}
        </ul>
        <p class="explain">需要先装好合流插件（在合流目录运行一次 <code>scripts/install.sh</code>）。装好后新开会话，输入 /heliu 能看到它。</p>
      </div>
    </div>
  );
}

/* ───────────── ⑤ 终端命令 ───────────── */

function Commands({ root, project }: { root: string; project: string | null }) {
  const bin = `"${root}/bin/heliu"`;
  const p = project ? ` --project ${/\s/.test(project) ? JSON.stringify(project) : project}` : " --project <项目名>";
  const rows: Array<[string, string]> = [
    ["合并 · 预演（只看不做，生成合并单）", `${bin} 合并 下一版 --预演${p}`],
    ["合并 · 改某张卡的决定（并入 / 顺延 / 等它 / 不并）", `${bin} release set 下一版 F-0001 顺延${p}`],
    ["合并 · 演练（在克隆上完整走一遍，真仓库不动）", `${bin} 演练 下一版${p}`],
    ["合并 · 执行（会再列一遍摘要，输入 yes 才开始）", `${bin} 合并 下一版${p}`],
    ["合并 · 反悔（按记录把引用指回去）", `${bin} 回滚 下一版${p}`],
    ["打开看板（以后也可以双击仓库里的「合流看板.command」）", `${bin} board`],
  ];
  return (
    <div class="panel">
      <table class="cmds">
        <tbody>
          {rows.map(([what, cmd]) => (
            <tr>
              <td>{what}</td>
              <td>
                <code>{cmd}</code>
              </td>
              <td>
                <button class="btn" onClick={() => void copyText(cmd)}>
                  复制
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="explain">「下一版」可以换成具体版本号，如 v1.2。合流从不 push：合并完成后推不推、什么时候推，由你决定。</p>
    </div>
  );
}
