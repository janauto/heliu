/** @jsxImportSource preact */
/**
 * F-0004 检查更新：标题栏右侧的小药丸。
 * - GitHub 主线有新版本 → 「有新版本」，点开看差几个提交、能不能一键更新；点「更新」并确认后才下载、快进代码目录。
 * - 磁盘上的代码比正在运行的新（刚更新过、或在终端 git pull 过）→ 「重启后生效」，给出重启的办法。
 * - 已是最新、查不到 GitHub：不显示（查不到的原因在 heliu update 里看）。
 * 只作用于合流自己的代码目录，不碰被管理的仓库。
 */
import { useEffect, useState } from "preact/hooks";
import type { UpdateData, UpdateRunData } from "../src/board/api-types.ts";
import type { UpdateResult } from "../src/core/selfupdate-types.ts";
import { api } from "./lib.ts";
import { Icon, Popover } from "./ui.tsx";

const RECHECK_MS = 30 * 60_000;
const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

interface AppBridge {
  version?: string;
  /** 新版 App 外壳：页面可以请 App 重启它自己起的看板 */
  restartBoard?: () => void;
}
const appBridge = (): AppBridge | null => ((window as unknown as { __HELIU_APP__?: AppBridge }).__HELIU_APP__ ?? null);

/** 怎么让新代码生效：App 能直接重启就给按钮，否则写清楚去哪里点 */
function RestartHint({ shellChanged }: { shellChanged: boolean }) {
  const bridge = appBridge();
  return (
    <div class="upd-restart">
      {bridge?.restartBoard ? (
        <button class="btn primary small" onClick={() => bridge.restartBoard?.()}>
          <Icon name="refresh" size={14} />
          重启看板
        </button>
      ) : bridge ? (
        <p class="tiny">正在运行的看板还是旧代码：在 App 菜单「显示 → 重启看板服务」（⌥⌘R）后生效。</p>
      ) : (
        <p class="tiny">正在运行的看板还是旧代码：在运行 heliu board 的终端按 Ctrl+C，再重新运行 heliu board。</p>
      )}
      {shellChanged ? <p class="tiny muted">App 外壳（app/macos）也改了：退出 App 后在代码目录运行 scripts/build-app.sh --install 重新打包。</p> : null}
    </div>
  );
}

function ResultView({ r }: { r: UpdateResult }) {
  return (
    <>
      <p>
        已更新 {short(r.from)} → {short(r.to)}，{r.count} 个提交
      </p>
      <ul class="upd-commits">
        {r.commits.slice(0, 6).map((c) => (
          <li key={c.sha}>
            <code>{short(c.sha)}</code> {c.subject}
          </li>
        ))}
        {r.count > 6 ? <li class="muted">…还有 {r.count - 6} 个</li> : null}
      </ul>
      {r.depsInstalled === true ? <p class="tiny muted">依赖清单变了，已运行 bun install。</p> : null}
      {r.depsInstalled === false ? <p class="tiny bad">{r.depsError}</p> : null}
    </>
  );
}

export function UpdatePill() {
  const [d, setD] = useState<UpdateData | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<"check" | "run" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const load = async (fresh: boolean) => {
    try {
      const env = await api<UpdateData>(`/api/update${fresh ? "?fresh=1" : ""}`);
      setD(env.data);
    } catch {
      /* 看板旧了没有这个接口、或一时问不到：不打扰 */
    }
  };
  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), RECHECK_MS);
    return () => clearInterval(t);
  }, []);
  if (!d) return null;
  const c = d.check;
  const fresh = c.state === "behind" || c.state === "diverged";
  if (!d.needsRestart && !d.updating && !fresh) return null;

  const recheck = async () => {
    setBusy("check");
    setErr(null);
    await load(true);
    setBusy(null);
  };
  const run = async () => {
    if (!confirm(`从 GitHub 下载 ${c.main}，并把合流代码目录快进过去？\n${c.root}\n依赖变了会运行 bun install。不碰被管理的仓库，不 push。`)) return;
    setBusy("run");
    setErr(null);
    try {
      await api<UpdateRunData>("/api/update/run", { body: {} });
    } catch (e) {
      setErr((e as Error).message);
    }
    await load(true);
    setBusy(null);
  };

  const label = d.updating || busy === "run" ? "正在更新…" : d.needsRestart ? "重启后生效" : "有新版本";
  const tone = d.needsRestart ? "green" : c.canRun ? "blue" : "yellow";
  return (
    <div class="theme-wrap upd-wrap">
      <button class="pc-pill upd-pill" data-popover-anchor onClick={() => setOpen((o) => !o)} title="合流本身的更新（GitHub 主线）">
        <i class={`dot tone-${tone}`} />
        <span class="txt">{label}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} class="upd-pop">
        {d.needsRestart ? (
          <>
            <div class="title">更新已下载，重启后生效</div>
            <div class="upd-body">
              {d.last ? <ResultView r={d.last} /> : <p>代码目录已经是 {short(d.onDisk)}，正在运行的看板还是 {short(d.running)}。</p>}
              <RestartHint shellChanged={!!d.last?.shellChanged} />
            </div>
          </>
        ) : (
          <>
            <div class="title">GitHub 主线有新版本</div>
            <div class="upd-body">
              <p>
                {c.behind === null ? "本机还没下载这些提交，个数要更新时才知道" : `本机落后 ${c.behind} 个提交`}
                <span class="muted tiny">
                  {" "}
                  · 本机 {c.main} {short(c.local)} · GitHub {short(c.remoteSha)}
                </span>
              </p>
              {c.blockers.length ? (
                <ul class="upd-blockers">
                  {c.blockers.map((b) => (
                    <li key={b} class="tiny">
                      {b}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="tiny muted">更新会从 GitHub 下载 {c.main}，快进合流代码目录；依赖变了会运行 bun install。不碰被管理的仓库，不 push。</p>
              )}
              {err ? <p class="tiny bad">{err}</p> : null}
              <div class="upd-actions">
                <button class="btn primary small" disabled={!c.canRun || !!busy || d.updating} onClick={() => void run()}>
                  {busy === "run" ? "正在更新…" : "更新"}
                </button>
                <button class="btn ghost small" disabled={!!busy} onClick={() => void recheck()}>
                  {busy === "check" ? "检查中…" : "再检查"}
                </button>
              </div>
              <p class="tiny muted">检查于 {new Date(c.checkedAt).toLocaleTimeString("zh-CN", { hour12: false })} · 代码目录 {c.root}</p>
            </div>
          </>
        )}
      </Popover>
    </div>
  );
}
