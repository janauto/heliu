/**
 * 解冲突子代理：在临时 worktree 里调用 `claude -p`（Opus）解决非 union 文件的冲突。
 *
 * 二进制：HELIU_CLAUDE_BIN → 桌面版内置 CLI（~/Library/Application Support/Claude/claude-code/2.1.308/…/claude）→ PATH 里的 claude。
 * 测试：HELIU_RESOLVER_STUB=<脚本> 时改为 `/bin/sh <脚本>`（同样的参数、同样从 stdin 收提示词），桩脚本按约定打印 JSON。
 *
 * 安全参数（固定）：
 *   -p --model opus --permission-mode acceptEdits
 *   --allowedTools Read Edit Write "Bash(git diff *)" "Bash(git add *)" "Bash(git status *)" "Bash(git checkout --theirs *)" "Bash(git checkout --ours *)"
 *   --max-budget-usd 2 --output-format json
 * - 从 Claude Code 内部调用时必须去掉 CLAUDECODE（否则拒绝嵌套启动）：命令前缀 `env -u CLAUDECODE`，环境对象里也删掉。
 * - 进程包在写模式沙箱里（deny 被管理仓库根、allow 目标 common dir 与 heliu 缓存），子代理即使想也写不到用户工作目录。
 * - 只在 -p 非交互模式运行：允许列表外的工具（含 git commit / push）一律被拒，不会弹确认。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { wrapInSandbox, type WritePolicy } from "./git.ts";

export const DESKTOP_CLAUDE = join(homedir(), "Library", "Application Support", "Claude", "claude-code", "2.1.308", "a93ded4b1b47", "claude.app", "Contents", "MacOS", "claude");

export const RESOLVER_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "Bash(git diff *)",
  "Bash(git add *)",
  "Bash(git status *)",
  "Bash(git checkout --theirs *)",
  "Bash(git checkout --ours *)",
] as const;

export const RESOLVER_BUDGET_USD = 2;

export interface ResolverBinary {
  cmd: string[];
  label: string;
  stub: boolean;
}

/** 解冲突器可执行文件（不检查是否能跑，只按优先级挑） */
export function resolverBinary(env: NodeJS.ProcessEnv = process.env): ResolverBinary {
  if (env.HELIU_RESOLVER_STUB) return { cmd: ["/bin/sh", env.HELIU_RESOLVER_STUB], label: `桩 ${env.HELIU_RESOLVER_STUB}`, stub: true };
  if (env.HELIU_CLAUDE_BIN) return { cmd: [env.HELIU_CLAUDE_BIN], label: env.HELIU_CLAUDE_BIN, stub: false };
  if (existsSync(DESKTOP_CLAUDE)) return { cmd: [DESKTOP_CLAUDE], label: "桌面版内置 claude 2.1.308", stub: false };
  const which = Bun.which("claude");
  return { cmd: [which ?? "claude"], label: which ?? "claude（PATH）", stub: false };
}

/** 固定的 claude -p 参数（提示词从 stdin 传入，避免被 --allowedTools 的可变参数吞掉） */
export function resolverArgs(budgetUsd = RESOLVER_BUDGET_USD): string[] {
  return [
    "-p",
    "--model", "opus",
    "--permission-mode", "acceptEdits",
    "--allowedTools", ...RESOLVER_ALLOWED_TOOLS,
    "--max-budget-usd", String(budgetUsd),
    "--output-format", "json",
  ];
}

export interface ResolverInput {
  cwd: string;
  /** 冲突文件（相对 worktree 根） */
  files: string[];
  milestone: string;
  /** 集成侧（ours / HEAD） */
  integration: { branch: string; recent: string[] };
  /** 合入侧（theirs / MERGE_HEAD） */
  incoming: { feature: string; title: string; branch: string; firstCommit: string | null };
  /** 第几轮（≥2 时提示词强调「上一轮没解完的文件」） */
  round: number;
  policy?: WritePolicy;
  timeoutMs?: number;
  budgetUsd?: number;
}

export interface ResolverRun {
  ok: boolean;
  exitCode: number | null;
  costUsd: number;
  turns: number | null;
  summary: string;
  error: string | null;
  binary: string;
  stub: boolean;
  sandboxed: boolean;
  durationMs: number;
  /** 认证失败（未登录 / OAuth 过期）：重试无意义 */
  authFailed?: boolean;
}

/** 未登录 / OAuth 过期 的输出特征 */
const AUTH_FAILURE = /Not logged in|Please run \/login|Failed to authenticate|OAuth session expired|Invalid API key/i;

export function buildResolverPrompt(i: ResolverInput): string {
  const lines = [
    `你在一个临时 git worktree 里（${i.cwd}），正在把功能分支合并进集成分支（里程碑 ${i.milestone}）。git merge 已停在冲突处。`,
    "",
    `- 集成分支一侧（ours / HEAD）：${i.integration.branch}${i.integration.recent.length ? `；最近改过这些文件的提交：${i.integration.recent.map((x) => `「${x}」`).join("、")}` : ""}`,
    `- 合入分支一侧（theirs / MERGE_HEAD）：${i.incoming.branch}，功能卡 ${i.incoming.feature}「${i.incoming.title}」${i.incoming.firstCommit ? `，首条提交说明「${i.incoming.firstCommit}」` : ""}`,
    "",
    i.round > 1 ? "上一轮之后这些文件仍有冲突，请继续解决：" : "冲突文件：",
    ...i.files.map((f) => `- ${f}`),
    "",
    "规则：",
    "1. 只解冲突：不重构、不顺手改别的文件、不改没有冲突的部分。",
    "2. 两边的功能都保留；确实无法兼容时以集成分支为准，并在报告里说明。",
    "3. 每个文件解完后去掉全部冲突标记（<<<<<<< ======= >>>>>>>），然后执行 git add <文件>。",
    "4. 不要 commit、不要 push、不要切换分支、不要改 .git 目录。",
    "5. 最后用一句话报告每个文件怎么解的，每个文件一行，格式「文件：做法」。",
  ];
  return lines.join("\n");
}

/** 从 --output-format json 的输出里取结果；容忍桩只打印最少字段 */
export function parseResolverOutput(stdout: string): { cost: number; turns: number | null; summary: string; isError: boolean } | null {
  const text = stdout.trim();
  const candidates = [text, ...text.split("\n").reverse()];
  for (const c of candidates) {
    const t = c.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t) as Record<string, unknown>;
      const cost = Number(o.total_cost_usd ?? o.cost_usd ?? 0);
      const turns = o.num_turns === undefined ? null : Number(o.num_turns);
      return {
        cost: Number.isFinite(cost) ? cost : 0,
        turns: turns !== null && Number.isFinite(turns) ? turns : null,
        summary: typeof o.result === "string" ? o.result.trim() : "",
        isError: o.is_error === true || (typeof o.subtype === "string" && o.subtype !== "success"),
      };
    } catch {
      /* 继续找下一行 */
    }
  }
  return null;
}

/**
 * 只去掉 CLAUDECODE（嵌套启动检查）。
 * 实测（2026-10-26，桌面版内）：若再去掉 CLAUDE_CODE_MESSAGING_* 等桌面会话变量，子进程的 OAuth 续期走不通
 * （「OAuth session expired and could not be refreshed」），所以其余变量原样保留。
 */
const STRIP_ENV = ["CLAUDECODE"];

/** 实验/兜底：HELIU_RESOLVER_ENV=host-refresh 再去掉宿主续期标记；=clean 去掉全部 CLAUDE_* 变量（等同在普通终端里运行） */
function stripped(k: string): boolean {
  const mode = process.env.HELIU_RESOLVER_ENV ?? "";
  if (STRIP_ENV.includes(k)) return true;
  if (mode === "host-refresh" && k === "CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH") return true;
  if (mode === "clean" && (k.startsWith("CLAUDE_") || k === "CLAUDECODE")) return true;
  return false;
}

/** 跑一轮解冲突器；不抛异常 */
export async function runResolver(i: ResolverInput): Promise<ResolverRun> {
  const bin = resolverBinary();
  const prompt = buildResolverPrompt(i);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !stripped(k)) env[k] = v;
  env.HELIU_CONFLICT_FILES = i.files.join("\n");
  env.GIT_EDITOR = "true";
  const base = ["/usr/bin/env", "-u", "CLAUDECODE", ...bin.cmd, ...resolverArgs(i.budgetUsd)];
  const { cmd, sandboxed } = wrapInSandbox(base, i.policy);
  const timeoutMs = i.timeoutMs ?? Number(process.env.HELIU_RESOLVER_TIMEOUT_MS || 15 * 60_000);
  const started = performance.now();
  const fail = (error: string, exitCode: number | null = null): ResolverRun => ({
    ok: false, exitCode, costUsd: 0, turns: null, summary: "", error, binary: bin.label, stub: bin.stub, sandboxed, durationMs: Math.round(performance.now() - started),
  });
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({ cmd, cwd: i.cwd, env, stdin: new Blob([prompt]), stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    return fail(`无法启动解冲突器（${bin.label}）：${String(e)}`);
  }
  const done = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), new Response(proc.stderr as ReadableStream).text()]);
    return { stdout, stderr, code: await proc.exited };
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([done, new Promise<"timeout">((res) => (timer = setTimeout(() => res("timeout"), timeoutMs)))]);
  if (timer) clearTimeout(timer);
  if (r === "timeout") {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
    done.catch(() => undefined);
    return fail(`解冲突器超时（${Math.round(timeoutMs / 1000)}s）`);
  }
  const parsed = parseResolverOutput(r.stdout);
  const durationMs = Math.round(performance.now() - started);
  const authText = `${parsed?.summary ?? ""} ${r.stderr}`;
  if (AUTH_FAILURE.test(authText)) {
    return {
      ...fail(`解冲突器无法登录（${bin.label}：${authText.trim().split("\n")[0]?.slice(0, 120)}）。请在终端里用该 claude 登录后重试，或设 HELIU_CLAUDE_BIN 指向已登录的 claude`, r.code),
      durationMs,
      authFailed: true,
    };
  }
  if (!parsed) return { ...fail(`解冲突器没有输出可解析的 JSON（退出码 ${r.code}）：${(r.stderr || r.stdout).trim().split("\n").slice(-2).join(" ").slice(0, 300)}`, r.code), durationMs };
  return {
    ok: r.code === 0 && !parsed.isError,
    exitCode: r.code,
    costUsd: parsed.cost,
    turns: parsed.turns,
    summary: parsed.summary,
    error: r.code === 0 && !parsed.isError ? null : `解冲突器报告失败（退出码 ${r.code}）${parsed.summary ? `：${parsed.summary.slice(0, 300)}` : ""}`,
    binary: bin.label,
    stub: bin.stub,
    sandboxed,
    durationMs,
  };
}
