/**
 * 本机数据位置（ADR-3）。全部可用环境变量覆盖，测试用它指向 fixture。
 * - HELIU_HOME：heliu 注册表与缓存根目录
 * - HELIU_CLAUDE_APP_DIR：Claude 桌面应用数据目录（会话 JSON、git-worktrees.json）
 * - HELIU_CLAUDE_HOME：~/.claude（运行中会话 sessions/<pid>.json）
 */
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface HeliuPaths {
  heliuHome: string;
  projectsDir: string;
  claudeAppDir: string;
  desktopSessionsDir: string;
  gitWorktreesJson: string;
  claudeHome: string;
  runningSessionsDir: string;
}

export function heliuPaths(env: NodeJS.ProcessEnv = process.env): HeliuPaths {
  const home = homedir();
  const heliuHome = env.HELIU_HOME || join(home, "Library", "Application Support", "heliu");
  const claudeAppDir = env.HELIU_CLAUDE_APP_DIR || join(home, "Library", "Application Support", "Claude");
  const claudeHome = env.HELIU_CLAUDE_HOME || join(home, ".claude");
  return {
    heliuHome,
    projectsDir: join(heliuHome, "projects"),
    claudeAppDir,
    desktopSessionsDir: join(claudeAppDir, "claude-code-sessions"),
    gitWorktreesJson: join(claudeAppDir, "git-worktrees.json"),
    claudeHome,
    runningSessionsDir: join(claudeHome, "sessions"),
  };
}

/** 是否位于 iCloud Drive（按路径判断） */
export function looksLikeICloud(p: string): boolean {
  return p.includes("/Library/Mobile Documents/");
}

const realCache = new Map<string, string>();
/**
 * 规范化路径用于比较：realpath（不存在则 resolve）+ Unicode NFC。
 * realpath 只 stat 不读内容，不会触发 iCloud 下载。
 */
export function canonicalPath(p: string): string {
  const cached = realCache.get(p);
  if (cached !== undefined) return cached;
  let out: string;
  try {
    out = existsSync(p) ? realpathSync(p) : resolve(p);
  } catch {
    out = resolve(p);
  }
  out = out.normalize("NFC").replace(/\/+$/, "");
  realCache.set(p, out);
  return out;
}

/** child 是否等于 parent 或位于其下 */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + "/");
}
