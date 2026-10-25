/**
 * Claude Code hooks 处理（bin/heliu-hook 调用）。
 *
 * 约束（ADR-6）：<300ms 返回；任何错误静默（stderr 至多一行），退出码永远 0；不阻塞会话。
 * - SessionStart：whereami → {"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"…"}}；
 *   顺带把「首次见到的 worktree」记进缓存（替代 WorktreeCreate，见下）。
 * - Stop：会话 id → 最后活动写入缓存 sqlite（不写台账）。
 * - WorktreeCreate：**plugin 不注册**。官方文档：配置 WorktreeCreate hook 会「替换」默认的 git worktree 创建，
 *   hook 必须在 stdout 打印新 worktree 路径，否则创建失败。heliu 只读、不代建 worktree，所以不能挂这个事件。
 *   这里保留分支只为兜底：万一被手工注册，只记录、不输出（此时创建会失败，hooks.json 里不要加它）。
 */
import { Cache } from "../core/cache.ts";
import { canonicalPath, heliuPaths, type HeliuPaths } from "../core/paths.ts";
import { detectProject } from "../core/project.ts";
import { whereami, whereamiContext } from "../core/whereami.ts";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  name?: string;
  [k: string]: unknown;
}

export interface HookResult {
  /** 要写到 stdout 的内容（null = 不输出） */
  stdout: string | null;
  /** 调试信息（只在 HELIU_HOOK_DEBUG=1 时写 stderr） */
  debug: string[];
}

/** hook 里 git 单条超时：给整体 300ms 预算留余量 */
export const HOOK_GIT_TIMEOUT_MS = 180;

export function parseHookInput(text: string): HookInput | null {
  if (!text.trim()) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as HookInput) : null;
  } catch {
    return null;
  }
}

function safeCache(paths: HeliuPaths, project: string, fn: (c: Cache) => void, debug: string[]): void {
  let c: Cache | null = null;
  try {
    c = Cache.open(paths, project);
    if (c) fn(c);
  } catch (e) {
    debug.push(`缓存写入失败：${(e as Error).message}`);
  } finally {
    c?.close();
  }
}

export async function handleHook(input: HookInput, paths: HeliuPaths = heliuPaths(), now: number = Date.now()): Promise<HookResult> {
  const debug: string[] = [];
  const event = input.hook_event_name ?? "";
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const sessionId = typeof input.session_id === "string" ? input.session_id : null;

  if (event === "SessionStart") {
    const w = await whereami(paths, cwd, { sessionId, timeoutMs: HOOK_GIT_TIMEOUT_MS });
    debug.push(`whereami ${w.elapsedMs}ms`);
    const ctx = whereamiContext(w);
    if (w.project && w.repo && w.worktree && !w.isMainCheckout) {
      const wt = w.worktree;
      safeCache(paths, w.project.name, (c) => c.recordWorktree(wt, wt.split("/").pop() ?? null, sessionId, "SessionStart", now), debug);
    }
    if (!ctx) return { stdout: null, debug };
    return { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx } }), debug };
  }

  if (event === "Stop") {
    if (!sessionId) return { stdout: null, debug };
    const project = await detectProject(paths, cwd);
    if (!project) return { stdout: null, debug };
    safeCache(paths, project.name, (c) => c.recordStop(sessionId, canonicalPath(cwd), now), debug);
    return { stdout: null, debug };
  }

  if (event === "WorktreeCreate") {
    // 不应被注册（见文件头）。只记录，不输出路径。
    const project = await detectProject(paths, cwd);
    if (project) {
      const name = typeof input.name === "string" ? input.name : null;
      safeCache(paths, project.name, (c) => c.recordWorktree(`${canonicalPath(cwd)}#${name ?? ""}`, name, sessionId, "WorktreeCreate", now), debug);
    }
    return { stdout: null, debug };
  }

  return { stdout: null, debug };
}
