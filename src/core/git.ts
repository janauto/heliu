/**
 * 只读 git 访问层（ADR-4）。
 *
 * 硬约束：
 * - 被管理仓库绝对只读：子命令白名单 + 参数级检查，越界直接抛 GitForbiddenError。
 * - 每次调用带超时（默认 8000ms），超时返回 {timedOut: true}，不抛异常、不挂起。
 * - 固定注入 GIT_OPTIONAL_LOCKS=0 / --no-optional-locks，status 不回写 index。
 * - 同一仓库并发 ≤4 个 git 进程。
 * - merge-tree 必须在「对象隔离区」里跑：新对象写进临时目录，真实对象库只作为 alternates 读取。
 * - macOS 上每条 git 命令都包在 sandbox-exec 里，对被管理仓库路径 deny file-write*：
 *   即使 git 内部想「刷新」已有对象/pack 的 mtime（merge-tree 写出已存在的树时会这么做），
 *   系统也会拒绝，git 退而把对象写进隔离区。这是白名单之外的第二道、操作系统级的只读保证。
 * - M4 另有显式的写模式运行器 runGitWrite（文件末尾）：独立白名单、必带审计日志与原因，
 *   与只读运行器互不复用校验，避免只读路径被意外放宽。
 */
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_TIMEOUT_MS = 8000;
export const MAX_CONCURRENCY_PER_REPO = 4;

export interface GitResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface RunGitOptions {
  timeoutMs?: number;
  /** 额外环境变量（merge-tree 的对象隔离区由 createObjectQuarantine 提供） */
  env?: Record<string, string>;
  /** 并发限流的分组键，默认按 cwd；同一仓库的多个 worktree 应传仓库根路径 */
  limitKey?: string;
  /** 视为成功的非 0 退出码（如 merge-tree 冲突=1、merge-base --is-ancestor 否=1） */
  okExitCodes?: number[];
  /** 沙箱内禁止写入的路径（默认 cwd）；被管理仓库根、common dir、外置 worktree 都应列入 */
  protect?: string[];
}

export class GitForbiddenError extends Error {
  constructor(args: readonly string[], reason: string) {
    super(`heliu 只读纪律拒绝执行 \`git ${args.join(" ")}\`：${reason}`);
    this.name = "GitForbiddenError";
  }
}

/** 允许的子命令（其余一律拒绝） */
export const ALLOWED_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "for-each-ref",
  "rev-list",
  "merge-base",
  "merge-tree",
  "worktree",
  "log",
  "symbolic-ref",
  "rev-parse",
  "diff",
  "status",
  "show-ref",
  "branch",
  "config",
  "remote",
  "cat-file",
  "version",
]);

const BRANCH_WRITE_FLAGS = [
  "-d", "-D", "--delete", "-m", "-M", "--move", "-c", "-C", "--copy",
  "-f", "--force", "-u", "--set-upstream-to", "--unset-upstream",
  "--edit-description", "-t", "--track", "--no-track", "--create-reflog",
];
const CONFIG_READ_MODES = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "get", "list"];
const CONFIG_WRITE_FLAGS = [
  "--add", "--unset", "--unset-all", "--replace-all", "--edit", "-e",
  "--rename-section", "--remove-section", "set", "unset", "edit", "rename-section", "remove-section",
];

function hasFlag(rest: readonly string[], flags: readonly string[]): boolean {
  return rest.some((a) => flags.some((f) => a === f || (f.startsWith("--") && a.startsWith(f + "="))));
}

/**
 * 校验参数是否落在只读白名单内。不通过直接抛 GitForbiddenError。
 * 导出供测试与调用方预检。
 */
export function assertReadOnly(args: readonly string[], env?: Record<string, string>): void {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) {
    throw new GitForbiddenError(args, "第一个参数必须是子命令（全局选项由 heliu 统一注入）");
  }
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    throw new GitForbiddenError(args, `子命令 ${sub} 不在只读白名单内`);
  }
  const rest = args.slice(1);
  // 任何子命令都不允许把结果写进文件
  if (rest.some((a) => a === "--output" || a.startsWith("--output="))) {
    throw new GitForbiddenError(args, "禁止 --output 写文件");
  }
  switch (sub) {
    case "worktree":
      if (rest[0] !== "list") throw new GitForbiddenError(args, "worktree 只允许 list");
      return;
    case "branch":
      if (!rest.includes("--list") && !rest.includes("-l")) {
        throw new GitForbiddenError(args, "branch 只允许 --list 形式");
      }
      if (hasFlag(rest, BRANCH_WRITE_FLAGS)) throw new GitForbiddenError(args, "branch 不允许改动类选项");
      return;
    case "config": {
      const first = rest[0];
      if (!first || !CONFIG_READ_MODES.includes(first)) {
        throw new GitForbiddenError(args, "config 只允许 --get / --get-all / --get-regexp / --list");
      }
      if (hasFlag(rest, CONFIG_WRITE_FLAGS)) throw new GitForbiddenError(args, "config 不允许写入类选项");
      return;
    }
    case "remote":
      if (rest.length === 0) return;
      if (rest.length === 1 && (rest[0] === "-v" || rest[0] === "--verbose")) return;
      if (rest[0] === "get-url") return; // 只打印 URL，纯读
      throw new GitForbiddenError(args, "remote 只允许列出名字、-v 或 get-url");
    case "symbolic-ref": {
      if (hasFlag(rest, ["-d", "--delete", "-m"])) throw new GitForbiddenError(args, "symbolic-ref 不允许删除/改写");
      const positional = rest.filter((a) => !a.startsWith("-"));
      if (positional.length > 1) throw new GitForbiddenError(args, "symbolic-ref 只允许读取形式（一个参数）");
      return;
    }
    case "merge-tree":
      if (!rest.includes("--write-tree")) throw new GitForbiddenError(args, "merge-tree 只允许 --write-tree 模式");
      if (!env?.GIT_OBJECT_DIRECTORY) {
        throw new GitForbiddenError(args, "merge-tree 必须在对象隔离区内执行（缺 GIT_OBJECT_DIRECTORY）");
      }
      return;
    case "diff":
      if (hasFlag(rest, ["--ext-diff", "--textconv"])) throw new GitForbiddenError(args, "diff 不允许外部 diff/textconv");
      return;
    case "cat-file":
      if (hasFlag(rest, ["--filters", "--textconv"])) throw new GitForbiddenError(args, "cat-file 不允许 filters/textconv");
      return;
    default:
      // for-each-ref / rev-list / merge-base / log / rev-parse / status / show-ref / version：纯读
      return;
  }
}

/** 注入在子命令前的全局选项：关闭可选锁、fsmonitor、自动 gc/maintenance，路径不转义 */
const GLOBAL_ARGS = [
  "--no-pager",
  "--no-optional-locks",
  "-c", "core.fsmonitor=false",
  "-c", "core.quotePath=false",
  "-c", "gc.auto=0",
  "-c", "maintenance.auto=false",
  "-c", "color.ui=never",
];

/** 继承环境时剥掉会把 git 指到别处的变量 */
const STRIPPED_ENV = [
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_PREFIX",
];

function buildEnv(extra?: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.includes(k)) env[k] = v;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_PAGER = "cat";
  env.PAGER = "cat";
  return { ...env, ...(extra ?? {}) };
}

/** 子命令级的安全注入：diff/log 关掉外部 diff 与 textconv */
function injectSafety(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  if (sub === "diff") return [sub, "--no-ext-diff", "--no-textconv", ...rest];
  if (sub === "log") return [sub, "--no-ext-diff", ...rest];
  return [...args];
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
let sandboxProbe: boolean | null = null;

/** sandbox-exec 是否可用（只探测一次；非 macOS 或已处于不允许嵌套的沙箱时为 false） */
export function sandboxAvailable(): boolean {
  if (sandboxProbe === null) {
    sandboxProbe = false;
    if (process.platform === "darwin" && process.env.HELIU_NO_SANDBOX !== "1" && existsSync(SANDBOX_EXEC)) {
      try {
        const r = Bun.spawnSync({ cmd: [SANDBOX_EXEC, "-p", "(version 1)(allow default)", "/usr/bin/true"], stdout: "ignore", stderr: "ignore" });
        sandboxProbe = r.exitCode === 0;
      } catch {
        sandboxProbe = false;
      }
    }
  }
  return sandboxProbe;
}

/** 生成 deny file-write* 的沙箱配置；同时写入 realpath、NFC、NFD 三种形式，避免 Unicode 规范化不一致漏防 */
export function sandboxProfile(paths: readonly string[]): string {
  return `(version 1)(allow default)(deny file-write* ${subpathRules(paths)})`;
}

/** 路径的 realpath / NFC / NFD 三种形式，拼成 SBPL 的 (subpath …) 列表 */
function subpathRules(paths: readonly string[]): string {
  const uniq = new Set<string>();
  for (const p of paths) {
    if (!p) continue;
    const forms = [p];
    try {
      forms.push(realpathSync(p));
    } catch {
      /* 不存在的路径只用原样 */
    }
    for (const f of forms) {
      const clean = f.replace(/\/+$/, "") || "/";
      uniq.add(clean);
      uniq.add(clean.normalize("NFC"));
      uniq.add(clean.normalize("NFD"));
    }
  }
  const esc = (x: string) => x.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return [...uniq].map((x) => `(subpath "${esc(x)}")`).join(" ");
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    // 名额由 release 直接移交，不经过递减，避免瞬时超额
    await new Promise<void>((resolve) => this.queue.push(resolve));
  }
  release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.active--;
  }
}

const semaphores = new Map<string, Semaphore>();
function semaphoreFor(key: string): Semaphore {
  let s = semaphores.get(key);
  if (!s) {
    s = new Semaphore(MAX_CONCURRENCY_PER_REPO);
    semaphores.set(key, s);
  }
  return s;
}

/** 调用统计（报告里展示 git 调用数与超时数） */
export interface GitStats {
  calls: number;
  timeouts: number;
}
const statsByKey = new Map<string, GitStats>();
export function gitStats(key: string): GitStats {
  let s = statsByKey.get(key);
  if (!s) {
    s = { calls: 0, timeouts: 0 };
    statsByKey.set(key, s);
  }
  return s;
}

/**
 * 运行一条只读 git 命令。
 * 不抛异常（白名单违规除外）：进程起不来、超时都以 ok=false 返回。
 */
export async function runGit(cwd: string, args: readonly string[], opts: RunGitOptions = {}): Promise<GitResult> {
  assertReadOnly(args, opts.env);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = opts.limitKey ?? cwd;
  const sem = semaphoreFor(key);
  const stats = gitStats(key);
  const protect = opts.protect ?? [cwd];
  const sandboxed = sandboxAvailable() && protect.length > 0;
  if (args[0] === "merge-tree" && !sandboxed) {
    // 没有操作系统级写保护时不做试合：git 可能刷新真实对象库里已有对象/pack 的 mtime
    return { ok: false, code: null, stdout: "", stderr: "无法建立写保护沙箱（sandbox-exec 不可用），已跳过 merge-tree 预检", timedOut: false, durationMs: 0 };
  }
  const gitCmd = ["git", ...GLOBAL_ARGS, "-C", cwd, ...injectSafety(args)];
  const cmd = sandboxed ? [SANDBOX_EXEC, "-p", sandboxProfile(protect), ...gitCmd] : gitCmd;
  await sem.acquire();
  const started = performance.now();
  try {
    stats.calls++;
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn({
        cmd,
        env: buildEnv(opts.env),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return { ok: false, code: null, stdout: "", stderr: String(e), timedOut: false, durationMs: 0 };
    }
    const done = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout as ReadableStream).text(),
        new Response(proc.stderr as ReadableStream).text(),
      ]);
      const code = await proc.exited;
      return { stdout, stderr, code };
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    const r = await Promise.race([done, timeout]);
    if (timer) clearTimeout(timer);
    const durationMs = Math.round(performance.now() - started);
    if (r === "timeout") {
      stats.timeouts++;
      try {
        proc.kill("SIGKILL");
      } catch {
        /* 进程可能已退出 */
      }
      proc.unref();
      done.catch(() => undefined);
      return { ok: false, code: null, stdout: "", stderr: `超时（${timeoutMs}ms）`, timedOut: true, durationMs };
    }
    const okCodes = opts.okExitCodes ?? [];
    return {
      ok: r.code === 0 || okCodes.includes(r.code),
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr,
      timedOut: false,
      durationMs,
    };
  } finally {
    sem.release();
  }
}

/** 按行切分（去掉末尾空行） */
export function lines(stdout: string): string[] {
  const out = stdout.split("\n");
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** 解析 `git version 2.50.1 (Apple Git-155)` */
export function parseGitVersion(text: string): [number, number, number] | null {
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

export function versionAtLeast(v: readonly number[] | null, min: readonly number[]): boolean {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    const a = v[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

let cachedVersion: Promise<[number, number, number] | null> | null = null;
export function gitVersion(): Promise<[number, number, number] | null> {
  if (!cachedVersion) {
    cachedVersion = runGit(tmpdir(), ["version"], { timeoutMs: 4000, protect: [] }).then((r) =>
      r.ok ? parseGitVersion(r.stdout) : null,
    );
  }
  return cachedVersion;
}

/**
 * merge-tree 的对象隔离区：GIT_OBJECT_DIRECTORY 指向临时目录，
 * 真实对象库作为 alternates 只读引用。试合产生的树/blob 只落在临时目录，用完即删。
 */
export interface ObjectQuarantine {
  env: Record<string, string>;
  dir: string;
  dispose(): void;
}
export function createObjectQuarantine(commonDir: string): ObjectQuarantine {
  const dir = mkdtempSync(join(tmpdir(), "heliu-objects-"));
  mkdirSync(join(dir, "info"));
  mkdirSync(join(dir, "pack"));
  return {
    dir,
    env: {
      GIT_OBJECT_DIRECTORY: dir,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir, "objects"),
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/* ───────────────────────── M4：写模式运行器（唯一允许写被管理仓库的入口） ───────────────────────── */

/**
 * 写模式允许的子命令。其余（push / fetch / pull / branch / gc / clean / rebase / stash …）一律拒绝。
 * merge-tree 不在只读白名单的「写」形态里：执行合并时树对象要真正落进目标仓库对象库，所以在这里放行。
 */
export const WRITE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "merge-tree",
  "commit-tree",
  "update-ref",
  "tag",
  "worktree",
  "merge",
  "merge-file",
  "add",
  "commit",
  "clone",
  "write-tree",
  "read-tree",
  "checkout",
  "reset",
]);

/** 明确拒绝的子命令（报更清楚的错误） */
const NEVER_SUBCOMMANDS = new Set(["push", "fetch", "pull", "branch", "gc", "prune", "repack", "clean", "rebase", "stash", "remote", "config", "filter-branch", "replace", "notes", "update-index", "rm", "mv"]);

/** 写模式沙箱：先 deny 再 allow（SBPL 后写的规则优先，实测确认） */
export interface WritePolicy {
  /** 禁止写入：被管理仓库的根目录（含用户的工作目录与 worktree） */
  deny: string[];
  /** 在 deny 之内重新放开：目标仓库的 common dir（对象库/引用）、heliu 缓存目录 */
  allow: string[];
}

export interface RunGitWriteOptions {
  /** 为什么执行（写进审计日志） */
  reason: string;
  /** 审计日志文件：<台账>/releases/<里程碑>.log；每次调用先写一行再执行 */
  auditLog: string;
  /** heliu 缓存根（临时 worktree / 演练克隆所在，~/.cache/heliu）；会动工作区的子命令只允许在这里 */
  cacheRoot: string;
  /** update-ref / tag 允许触碰的完整引用名（refs/heads/<集成>、refs/tags/<里程碑>、可选 refs/heads/<主线>） */
  allowRefs?: readonly string[];
  policy?: WritePolicy;
  /** 没有沙箱时拒绝执行（演练必须：否则 git 会刷新真实对象库里已有对象的 mtime） */
  requireSandbox?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
  okExitCodes?: number[];
}

const ZERO_SHA = /^0{40}$|^0{64}$/;
const SHA_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

function positionals(rest: readonly string[], valueFlags: readonly string[] = []): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") {
      out.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith("-")) {
      if (valueFlags.includes(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** realpath；路径尚不存在（如 clone 目标）时取最近的已存在祖先的 realpath 再拼回剩余部分 */
function realish(x: string): string {
  let head = x.replace(/\/+$/, "") || "/";
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try {
      const r = realpathSync(head);
      return [r, ...tail.reverse()].join("/").replace(/\/+/g, "/").normalize("NFC").replace(/\/+$/, "") || "/";
    } catch {
      const up = dirname(head);
      if (up === head) break;
      tail.push(head.slice(up.length).replace(/^\/+/, ""));
      head = up;
    }
  }
  return x.normalize("NFC").replace(/\/+$/, "");
}

function under(p: string, root: string): boolean {
  if (!p.startsWith("/")) return false;
  const a = realish(p);
  const b = realish(root);
  return a === b || a.startsWith(b + "/");
}

/**
 * 写模式参数校验（不通过抛 GitForbiddenError）。规则：
 * - 子命令必须在 WRITE_SUBCOMMANDS；push/fetch/branch 等直接拒绝。
 * - update-ref 必须带旧值（三个位置参数：引用 新值 旧值），且引用在 allowRefs 内；不允许 -d / --stdin。
 * - tag 只允许 `tag -a <名> -m <说明> <提交>` 与 `tag -d <名>`，名字对应的 refs/tags/<名> 在 allowRefs 内；不允许 -f。
 * - worktree 只允许 `add --detach <缓存目录下的路径> <提交>` 与 `remove [--force] <缓存目录下的路径>`。
 * - merge / merge-file / add / commit / checkout / reset / read-tree：cwd 必须在 heliu 缓存目录（临时 worktree）内。
 * - clone：目标在缓存目录内，源必须是本地路径，必须 --shared 或 --reference；不允许 --upload-pack / --template / -c。
 */
export function assertWriteAllowed(cwd: string, args: readonly string[], opts: Pick<RunGitWriteOptions, "allowRefs" | "cacheRoot">): void {
  const sub = args[0];
  if (!sub || sub.startsWith("-")) throw new GitForbiddenError(args, "第一个参数必须是子命令");
  if (NEVER_SUBCOMMANDS.has(sub)) throw new GitForbiddenError(args, `写模式也绝不执行 ${sub}`);
  if (!WRITE_SUBCOMMANDS.has(sub)) throw new GitForbiddenError(args, `子命令 ${sub} 不在写模式白名单内`);
  const rest = args.slice(1);
  if (rest.some((a) => a === "--output" || a.startsWith("--output="))) throw new GitForbiddenError(args, "禁止 --output");
  const inCache = under(cwd, opts.cacheRoot);
  const allowRefs = opts.allowRefs ?? [];
  const needCache = (what: string) => {
    if (!inCache) throw new GitForbiddenError(args, `${what} 只允许在 heliu 临时目录（${opts.cacheRoot}）内执行，当前目录 ${cwd}`);
  };
  switch (sub) {
    case "merge-tree":
      if (!rest.includes("--write-tree")) throw new GitForbiddenError(args, "merge-tree 只允许 --write-tree");
      return;
    case "commit-tree":
    case "write-tree":
      return;
    case "update-ref": {
      if (hasFlag(rest, ["-d", "--delete", "--stdin", "-z"])) throw new GitForbiddenError(args, "update-ref 不允许删除或批量（-d / --stdin）");
      const pos = positionals(rest, ["-m"]);
      if (pos.length !== 3) throw new GitForbiddenError(args, "update-ref 必须带旧值：update-ref <引用> <新值> <旧值>");
      const [ref, nv, ov] = pos as [string, string, string];
      if (!allowRefs.includes(ref)) throw new GitForbiddenError(args, `引用 ${ref} 不在本次允许写入的范围（${allowRefs.join("、") || "无"}）`);
      if (!SHA_RE.test(nv) || ZERO_SHA.test(nv)) throw new GitForbiddenError(args, "update-ref 新值必须是完整提交 sha");
      if (!SHA_RE.test(ov)) throw new GitForbiddenError(args, "update-ref 旧值必须是完整 sha（新建用全 0）");
      return;
    }
    case "tag": {
      if (hasFlag(rest, ["-f", "--force", "-s", "--sign", "-u", "--local-user"])) throw new GitForbiddenError(args, "tag 不允许 -f / 签名");
      const del = rest.includes("-d") || rest.includes("--delete");
      const pos = positionals(rest, ["-m", "-F"]);
      if (del) {
        if (pos.length !== 1) throw new GitForbiddenError(args, "tag -d 一次只删一个");
      } else {
        if (!rest.includes("-a") && !rest.includes("--annotate")) throw new GitForbiddenError(args, "只允许打附注 tag（-a）");
        if (pos.length !== 2) throw new GitForbiddenError(args, "tag 形式：tag -a <名> -m <说明> <提交>");
      }
      const name = pos[0] as string;
      if (!allowRefs.includes(`refs/tags/${name}`)) throw new GitForbiddenError(args, `tag ${name} 不在本次允许写入的范围`);
      return;
    }
    case "worktree": {
      const action = rest[0];
      const pos = positionals(rest.slice(1));
      if (action === "add") {
        if (!rest.includes("--detach")) throw new GitForbiddenError(args, "worktree add 只允许 --detach（不建分支）");
        if (hasFlag(rest, ["-b", "-B", "--orphan", "-f", "--force", "--lock"])) throw new GitForbiddenError(args, "worktree add 不允许建分支/强制");
        const path = pos[0];
        if (!path || !under(path, opts.cacheRoot)) throw new GitForbiddenError(args, `临时 worktree 必须建在 ${opts.cacheRoot} 下`);
        return;
      }
      if (action === "remove") {
        const path = pos[0];
        if (pos.length !== 1 || !path || !under(path, opts.cacheRoot)) throw new GitForbiddenError(args, `只允许移除 ${opts.cacheRoot} 下的临时 worktree`);
        return;
      }
      throw new GitForbiddenError(args, "worktree 写模式只允许 add --detach / remove（list 走只读运行器）");
    }
    case "merge":
      needCache("merge");
      if (hasFlag(rest, ["-s", "--strategy", "-X", "--strategy-option", "--ff-only"])) throw new GitForbiddenError(args, "merge 不允许改合并策略");
      return;
    case "merge-file":
      needCache("merge-file");
      for (const p of positionals(rest, ["-L", "--marker-size"])) {
        if (p.startsWith("/") && !under(p, opts.cacheRoot)) throw new GitForbiddenError(args, `merge-file 只处理临时目录里的文件（${p}）`);
      }
      return;
    case "add":
      needCache("add");
      if (hasFlag(rest, ["-A", "--all", "-f", "--force"])) throw new GitForbiddenError(args, "add 只允许列出具体文件");
      return;
    case "commit":
      needCache("commit");
      if (hasFlag(rest, ["--amend", "-a", "--all"])) throw new GitForbiddenError(args, "commit 不允许 --amend / -a");
      return;
    case "checkout":
      needCache("checkout");
      return;
    case "reset":
      needCache("reset（含 --hard）");
      return;
    case "read-tree":
      needCache("read-tree");
      return;
    case "clone": {
      if (hasFlag(rest, ["-u", "--upload-pack", "--template", "-c", "--config", "--recurse-submodules", "--separate-git-dir", "--server-option"])) {
        throw new GitForbiddenError(args, "clone 不允许 --upload-pack / --template / -c / 子模块");
      }
      if (!rest.includes("--shared") && !rest.includes("-s") && !rest.some((a) => a === "--reference" || a.startsWith("--reference="))) {
        throw new GitForbiddenError(args, "演练克隆必须 --shared 或 --reference（只读引用真实对象库）");
      }
      const pos = positionals(rest, ["--reference", "--depth", "--origin", "-o", "--branch", "-b"]);
      const [src, dst] = pos;
      if (!src || !dst) throw new GitForbiddenError(args, "clone 需要源与目标");
      if (src.includes("://") || /^[^/]+:/.test(src)) throw new GitForbiddenError(args, "clone 源必须是本地路径");
      if (!under(dst, opts.cacheRoot)) throw new GitForbiddenError(args, `clone 目标必须在 ${opts.cacheRoot} 下`);
      if (!inCache) throw new GitForbiddenError(args, "clone 必须在 heliu 临时目录内执行");
      return;
    }
    default:
      throw new GitForbiddenError(args, `子命令 ${sub} 不在写模式白名单内`);
  }
}

/** 写模式额外的全局选项：不跑仓库里的 hooks、不签名、不开编辑器、不记 rerere */
const WRITE_GLOBAL_ARGS = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "commit.gpgSign=false",
  "-c", "tag.gpgSign=false",
  "-c", "rerere.enabled=false",
  "-c", "core.editor=true",
];

/** 先 deny 再 allow 的写模式沙箱配置 */
export function sandboxWriteProfile(policy: WritePolicy): string {
  const deny = policy.deny.length ? `(deny file-write* ${subpathRules(policy.deny)})` : "";
  const allow = policy.allow.length && policy.deny.length ? `(allow file-write* ${subpathRules(policy.allow)})` : "";
  return `(version 1)(allow default)${deny}${allow}`;
}

/** 把任意命令包进写模式沙箱（解冲突子代理、checks 也用它）；沙箱不可用或无 deny 时原样返回 */
export function wrapInSandbox(cmd: readonly string[], policy: WritePolicy | undefined): { cmd: string[]; sandboxed: boolean } {
  if (!policy || !policy.deny.length || !sandboxAvailable()) return { cmd: [...cmd], sandboxed: false };
  return { cmd: [SANDBOX_EXEC, "-p", sandboxWriteProfile(policy), ...cmd], sandboxed: true };
}

function auditArg(a: string): string {
  const one = a.replace(/\r?\n/g, "⏎").replace(/\t/g, " ");
  return one.length > 160 ? `${one.slice(0, 157)}…` : one;
}

/** 追加一行审计日志（失败静默：审计目录不可写不应中断合并，但调用方已校验目录存在） */
export function appendAudit(file: string, line: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${line}\n`, "utf8");
  } catch {
    /* 审计写失败不影响执行结果；调用方在执行前已建好目录 */
  }
}

/**
 * 运行一条写模式 git 命令（M4 唯一写入口）。
 * - 参数先过 assertWriteAllowed；不通过直接抛 GitForbiddenError，不执行、但记一行「拒绝」审计。
 * - 执行前先写审计行（时间 · 原因 · 目录 · 完整参数），失败时再补一行结果。
 * - macOS 上包进 sandbox-exec：deny 被管理仓库根、allow 目标 common dir 与 heliu 缓存目录。
 */
export async function runGitWrite(repo: string, args: readonly string[], opts: RunGitWriteOptions): Promise<GitResult> {
  const stamp = () => new Date().toISOString();
  try {
    assertWriteAllowed(repo, args, opts);
  } catch (e) {
    appendAudit(opts.auditLog, `${stamp()}\t拒绝\t${opts.reason}\t${repo}\tgit ${args.map(auditArg).join(" ")}\t${(e as Error).message}`);
    throw e;
  }
  const sandboxed = !!opts.policy?.deny.length && sandboxAvailable();
  if (opts.requireSandbox && !sandboxed) {
    appendAudit(opts.auditLog, `${stamp()}\t未执行\t${opts.reason}\t${repo}\tgit ${args.map(auditArg).join(" ")}\t沙箱不可用`);
    return { ok: false, code: null, stdout: "", stderr: "无法建立写保护沙箱（sandbox-exec 不可用），按规则不执行", timedOut: false, durationMs: 0 };
  }
  appendAudit(opts.auditLog, `${stamp()}\t执行\t${opts.reason}\t${repo}\tgit ${args.map(auditArg).join(" ")}${sandboxed ? "" : "\t（无沙箱）"}`);
  const sub = args[0];
  const finalArgs = sub === "commit" && !args.includes("--no-verify") ? ["commit", "--no-verify", ...args.slice(1)] : [...args];
  const gitCmd = ["git", ...GLOBAL_ARGS, ...WRITE_GLOBAL_ARGS, "-C", repo, ...finalArgs];
  const { cmd } = wrapInSandbox(gitCmd, sandboxed ? opts.policy : undefined);
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const started = performance.now();
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd,
      env: buildEnv({ GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", ...(opts.env ?? {}) }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (e) {
    appendAudit(opts.auditLog, `${stamp()}\t  ↳ 启动失败：${String(e)}`);
    return { ok: false, code: null, stdout: "", stderr: String(e), timedOut: false, durationMs: 0 };
  }
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { stdout, stderr, code: await proc.exited };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const r = await Promise.race([done, timeout]);
  if (timer) clearTimeout(timer);
  const durationMs = Math.round(performance.now() - started);
  if (r === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    done.catch(() => undefined);
    appendAudit(opts.auditLog, `${stamp()}\t  ↳ 超时（${timeoutMs}ms）`);
    return { ok: false, code: null, stdout: "", stderr: `超时（${timeoutMs}ms）`, timedOut: true, durationMs };
  }
  const ok = r.code === 0 || (opts.okExitCodes ?? []).includes(r.code);
  if (!ok) appendAudit(opts.auditLog, `${stamp()}\t  ↳ 退出码 ${r.code}：${auditArg(r.stderr.trim().split("\n")[0] ?? "")}`);
  return { ok, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: false, durationMs };
}
