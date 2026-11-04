/**
 * F-0004 合流自更新：看 GitHub 主线有没有新版本，用户点「更新」后把合流自己的代码目录快进过去。
 *
 * 只作用于合流自己的代码目录（看板 / App 运行的那份代码，默认 HELIU_ROOT），不经过 src/core/git.ts：
 * 那是被管理仓库的只读白名单，fetch / merge 在那里一律拒绝，这里也不放宽它。
 *
 * - check（只读）：`git ls-remote <远端> refs/heads/<主线>` 问 GitHub 主线在哪，和本机主线比；不写任何引用。
 * - run（用户确认后才执行）：前提是代码目录停在主线上、跟踪文件没有改动（查不清也算不满足）、
 *   本机主线没有 GitHub 上没有的提交。顺序：fetch → merge --ff-only → 依赖清单变了就 bun install →
 *   报告 App 外壳（app/macos）是否也变了（变了要重新打包，这里不替用户打包）。
 *
 * 这是 ADR-4「绝不自动 fetch」的唯一例外：只在用户点了更新之后、只快进、只碰合流自己的代码目录。
 * 合流代码目录也可以同时登记成被管理项目，那边的对账仍然只读；这里的写入只发生在用户确认的这一次。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { UpdateCheck, UpdateResult } from "./selfupdate-types.ts";

export type { UpdateCheck, UpdateCommit, UpdateResult, UpdateState } from "./selfupdate-types.ts";

export const UPDATE_MAIN = "main";
export const UPDATE_REMOTE = "origin";
const LS_REMOTE_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 8_000;
const FETCH_TIMEOUT_MS = 120_000;
const INSTALL_TIMEOUT_MS = 300_000;
/** 依赖清单：其中任何一个变了就 bun install */
const DEP_FILES = new Set(["package.json", "bun.lock", "bun.lockb"]);
/** App 外壳代码：变了要重新打包 App 才生效 */
const SHELL_PREFIX = "app/macos/";

export class UpdateError extends Error {}

interface Run {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** 起一个进程，带超时；不抛异常 */
async function spawn(cmd: string[], cwd: string, timeoutMs: number, env: Record<string, string> = {}): Promise<Run> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      cwd,
      env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: String(e), timedOut: false };
  }
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { stdout, stderr, code: await proc.exited };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((r) => {
    timer = setTimeout(() => r("timeout"), timeoutMs);
  });
  const r = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  if (r === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    done.catch(() => undefined);
    return { ok: false, code: null, stdout: "", stderr: `超时（${Math.round(timeoutMs / 1000)} 秒）`, timedOut: true };
  }
  return { ok: r.code === 0, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: false };
}

const git = (root: string, args: string[], timeoutMs = STATUS_TIMEOUT_MS, env: Record<string, string> = {}) =>
  spawn(["git", "-C", root, ...args], root, timeoutMs, env);

const firstLine = (s: string) => s.trim().split("\n")[0] ?? "";
const short = (sha: string | null) => (sha ? sha.slice(0, 7) : "?");

async function revParse(root: string, ref: string): Promise<string | null> {
  const r = await git(root, ["rev-parse", "-q", "--verify", `${ref}^{commit}`]);
  return r.ok ? r.stdout.trim() || null : null;
}

async function count(root: string, range: string): Promise<number | null> {
  const r = await git(root, ["rev-list", "--count", range]);
  const n = Number(r.stdout.trim());
  return r.ok && Number.isInteger(n) ? n : null;
}

/** 跟踪文件有没有改动（不看未跟踪文件：快进碰上同名未跟踪文件时 git 自己会拒绝）；查不清返回 null */
async function trackedDirty(root: string): Promise<boolean | null> {
  const r = await git(root, ["status", "--porcelain", "--untracked-files=no"], STATUS_TIMEOUT_MS, { GIT_OPTIONAL_LOCKS: "0" });
  if (!r.ok) return null;
  return r.stdout.trim().length > 0;
}

export interface CheckOptions {
  remote?: string;
  main?: string;
  now?: () => Date;
}

/** 只读：GitHub 主线 vs 本机主线 */
export async function checkUpdate(root: string, opts: CheckOptions = {}): Promise<UpdateCheck> {
  const remote = opts.remote ?? UPDATE_REMOTE;
  const main = opts.main ?? UPDATE_MAIN;
  const base: UpdateCheck = {
    root,
    remote,
    main,
    branch: null,
    local: null,
    remoteSha: null,
    state: "unknown",
    behind: null,
    ahead: null,
    dirty: null,
    canRun: false,
    blockers: [],
    checkedAt: (opts.now?.() ?? new Date()).toISOString(),
    error: null,
  };
  const top = await git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (!top.ok || top.stdout.trim() !== "true") return { ...base, error: `${root} 不是 git 仓库，没法按 GitHub 主线更新` };

  const [branchR, local] = await Promise.all([git(root, ["symbolic-ref", "--short", "-q", "HEAD"]), revParse(root, `refs/heads/${main}`)]);
  const branch = branchR.ok ? branchR.stdout.trim() || null : null;
  const ls = await git(root, ["ls-remote", "--exit-code", remote, `refs/heads/${main}`], LS_REMOTE_TIMEOUT_MS);
  const remoteSha = ls.ok ? (ls.stdout.trim().split(/\s+/)[0] ?? null) : null;
  const out: UpdateCheck = { ...base, branch, local };
  if (!remoteSha) {
    const why = ls.timedOut ? ls.stderr : ls.code === 2 ? `${remote} 上没有 ${main} 分支` : firstLine(ls.stderr) || "原因不明";
    return { ...out, error: `问不到 GitHub 主线（${remote}/${main}）：${why}` };
  }
  out.remoteSha = remoteSha;
  if (!local) return { ...out, error: `本机没有 ${main} 分支` };
  if (local === remoteSha) return { ...out, state: "latest", behind: 0, ahead: 0 };

  const known = await revParse(root, remoteSha);
  if (known) {
    out.behind = await count(root, `${local}..${remoteSha}`);
    out.ahead = await count(root, `${remoteSha}..${local}`);
    if (out.behind === null || out.ahead === null) return { ...out, error: "数不出本机和 GitHub 差几个提交" };
    out.state = out.behind > 0 && out.ahead > 0 ? "diverged" : out.behind > 0 ? "behind" : "ahead";
  } else {
    // GitHub 上的新提交本机还没下载：本机主线有没有自己的提交，用已有的远端引用估一下（不 fetch）
    const tracking = await revParse(root, `refs/remotes/${remote}/${main}`);
    out.ahead = tracking ? await count(root, `${tracking}..${local}`) : null;
    out.state = out.ahead && out.ahead > 0 ? "diverged" : "behind";
  }
  if (out.state !== "behind" && out.state !== "diverged") return out;

  out.dirty = await trackedDirty(root);
  const b: string[] = [];
  if (branch !== main) b.push(`代码目录现在在 ${branch ?? "游离 HEAD"} 上，不在 ${main}：一键更新只快进 ${main}`);
  if (out.dirty === true) b.push("代码目录有没提交的改动（跟踪文件）：先提交或收起再更新");
  if (out.dirty === null) b.push("查不清代码目录有没有改动（iCloud 可能在下载文件）：稍后再检查");
  if (out.state === "diverged") b.push(`本机 ${main} 有${out.ahead ? ` ${out.ahead} 个` : ""}提交不在 GitHub 上：没法快进，要在终端自己合并`);
  out.blockers = b;
  out.canRun = b.length === 0;
  return out;
}

export interface RunOptions extends CheckOptions {
  /** bun 可执行文件（默认当前进程） */
  bun?: string;
  /** 跳过 bun install（测试用） */
  skipInstall?: boolean;
  /** 每次执行追加一行记录的文件 */
  auditFile?: string;
}

/** 用户确认后执行：fetch → 快进 → 依赖变了就 bun install。前提不满足就抛 UpdateError，什么都不改 */
export async function runUpdate(root: string, opts: RunOptions = {}): Promise<UpdateResult> {
  const c = await checkUpdate(root, opts);
  if (c.error) throw new UpdateError(c.error);
  if (c.state === "latest" || c.state === "ahead") throw new UpdateError(`已经是最新（本机 ${c.main} 在 ${short(c.local)}，GitHub 在 ${short(c.remoteSha)}）`);
  if (!c.canRun) throw new UpdateError(`没有更新：${c.blockers.join("；")}`);
  const from = c.local!;

  const f = await git(root, ["fetch", "--no-tags", c.remote, `refs/heads/${c.main}`], FETCH_TIMEOUT_MS);
  if (!f.ok) throw new UpdateError(`从 GitHub 下载失败：${f.timedOut ? f.stderr : firstLine(f.stderr) || "原因不明"}（代码目录没有改动）`);
  const to = await revParse(root, "FETCH_HEAD");
  if (!to) throw new UpdateError("下载完了却读不到 GitHub 主线的提交（代码目录没有改动）");

  // 下载之后再核一遍：HEAD 还在主线上、还是原来那个提交、能快进、跟踪文件没改动
  const [branchR, head] = await Promise.all([git(root, ["symbolic-ref", "--short", "-q", "HEAD"]), revParse(root, "HEAD")]);
  if (branchR.stdout.trim() !== c.main || head !== from) throw new UpdateError("检查之后代码目录换了分支或提交：请重新检查（代码目录没有改动）");
  const anc = await git(root, ["merge-base", "--is-ancestor", from, to]);
  if (!anc.ok) throw new UpdateError(`本机 ${c.main} 有提交不在 GitHub 上，没法快进：请在终端自己合并（代码目录没有改动）`);
  const dirty = await trackedDirty(root);
  if (dirty !== false) throw new UpdateError(dirty ? "代码目录有没提交的改动：先提交或收起再更新（代码目录没有改动）" : "查不清代码目录有没有改动：稍后再试（代码目录没有改动）");

  const m = await git(root, ["merge", "--ff-only", "--no-stat", "-q", to], FETCH_TIMEOUT_MS);
  if (!m.ok) throw new UpdateError(`快进失败：${firstLine(m.stderr) || "原因不明"}（git 拒绝时不会改动文件）`);

  const [diff, log, n] = await Promise.all([
    git(root, ["diff", "--name-only", "--no-renames", from, to]),
    git(root, ["log", "--format=%H%x09%s", "-n", "30", `${from}..${to}`]),
    count(root, `${from}..${to}`),
  ]);
  const files = diff.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
  const commits = log.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("\t");
      return { sha: l.slice(0, i), subject: l.slice(i + 1) };
    });
  const depsChanged = files.some((p) => DEP_FILES.has(p));
  let depsInstalled: boolean | null = null;
  let depsError: string | null = null;
  if (depsChanged && !opts.skipInstall) {
    const i = await spawn([opts.bun ?? process.execPath, "install"], root, INSTALL_TIMEOUT_MS);
    depsInstalled = i.ok;
    if (!i.ok) depsError = `bun install 失败：${i.timedOut ? i.stderr : firstLine(i.stderr) || firstLine(i.stdout) || "原因不明"}；可在代码目录手动运行 bun install`;
  }
  const result: UpdateResult = {
    root,
    from,
    to,
    count: n ?? commits.length,
    commits,
    files: files.length,
    depsChanged,
    depsInstalled,
    depsError,
    shellChanged: files.some((p) => p.startsWith(SHELL_PREFIX)),
    finishedAt: (opts.now?.() ?? new Date()).toISOString(),
  };
  if (opts.auditFile) {
    try {
      mkdirSync(dirname(opts.auditFile), { recursive: true });
      appendFileSync(opts.auditFile, `${result.finishedAt}\t${root}\t${short(from)} → ${short(to)}\t${result.count} 个提交${depsInstalled === false ? "\tbun install 失败" : ""}\n`);
    } catch {
      /* 记录写不了不影响更新本身 */
    }
  }
  return result;
}

/** 正在运行的代码对应哪个提交（看板启动时记下；之后磁盘上的代码被更新了就提示重启） */
export async function headOf(root: string): Promise<string | null> {
  return revParse(root, "HEAD");
}

/* ───────────── 中文渲染（CLI 用） ───────────── */

export function renderCheck(c: UpdateCheck): string {
  const lines = [`合流 · 检查更新 · 代码目录 ${c.root}`];
  if (c.error) {
    lines.push(`  查不到：${c.error}`);
    return lines.join("\n");
  }
  const where = `本机 ${c.main} ${short(c.local)} · GitHub ${c.remote}/${c.main} ${short(c.remoteSha)}`;
  if (c.state === "latest") lines.push(`  已是最新（${where}）`);
  else if (c.state === "ahead") lines.push(`  本机比 GitHub 新 ${c.ahead} 个提交，不用更新（${where}）`);
  else {
    lines.push(`  GitHub 主线有新版本：${c.behind === null ? "本机还没下载这些提交，个数要更新时才知道" : `本机落后 ${c.behind} 个提交`}（${where}）`);
    if (c.blockers.length) for (const b of c.blockers) lines.push(`  · 不能一键更新：${b}`);
    else lines.push(`  更新：heliu update --yes（从 GitHub 下载 ${c.main} 并快进代码目录；依赖变了会 bun install；不碰被管理的仓库）`);
  }
  return lines.join("\n");
}

export function renderResult(r: UpdateResult): string {
  const lines = [`已更新：${short(r.from)} → ${short(r.to)}，${r.count} 个提交，${r.files} 个文件`];
  for (const c of r.commits.slice(0, 10)) lines.push(`  · ${short(c.sha)} ${c.subject}`);
  if (r.commits.length > 10) lines.push(`  …还有 ${r.count - 10} 个`);
  if (r.depsInstalled === true) lines.push("  依赖清单变了，已运行 bun install");
  if (r.depsInstalled === false) lines.push(`  ${r.depsError}`);
  lines.push("  正在运行的看板还是旧代码：重启看板后生效（合流 App：菜单 显示 → 重启看板服务，⌥⌘R）");
  if (r.shellChanged) lines.push("  App 外壳（app/macos）也改了：退出 App 后运行 scripts/build-app.sh --install 重新打包");
  return lines.join("\n");
}
