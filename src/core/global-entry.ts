/**
 * 装进 Claude（全局接入）：
 * - 全局 CLAUDE.md 里的「合流」一段：带 begin / end 标记，scripts/install.sh 写入、重跑只更新这一段、scripts/uninstall.sh 删掉；
 *   原文在 examples/全局入口.md（受版本管理）。标记以外的内容一个字都不动。
 * - 自检（doctor「装进 Claude」三项）：插件是否从本目录加载、全局入口是否最新、终端里能不能直接敲 heliu。全部只读。
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck } from "../types.ts";

/** 合流仓库根（本文件在 src/core/） */
export const HELIU_REPO_ROOT = join(import.meta.dir, "..", "..");
export const ENTRY_BEGIN = "<!-- heliu:begin";
export const ENTRY_END = "<!-- heliu:end -->";
const BEGIN_LINE = `${ENTRY_BEGIN} · 合流全局入口：由合流仓库的 scripts/install.sh 写入，原文在 examples/全局入口.md；重跑安装只更新这一段，scripts/uninstall.sh 会删掉 -->`;
export const MARKETPLACE = "heliu-local";
export const PLUGIN_ID = "heliu@heliu-local";

export function entryTemplatePath(root: string = HELIU_REPO_ROOT): string {
  return join(root, "examples", "全局入口.md");
}

/** 原文 → 带标记的整段 */
export function renderEntry(body: string): string {
  return `${BEGIN_LINE}\n${body.trim()}\n${ENTRY_END}`;
}

export function loadEntry(root: string = HELIU_REPO_ROOT): string {
  return renderEntry(readFileSync(entryTemplatePath(root), "utf8"));
}

/**
 * 全局 CLAUDE.md 的位置：HELIU_GLOBAL_CLAUDE_MD 优先；其次 ~/CLAUDE.md（已存在时——它是家目录下所有项目的上级规则文件）；
 * 都没有就用 Claude Code 的用户级记忆 ~/.claude/CLAUDE.md。
 */
export function globalClaudeMdPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  if (env.HELIU_GLOBAL_CLAUDE_MD) return env.HELIU_GLOBAL_CLAUDE_MD;
  const top = join(home, "CLAUDE.md");
  return existsSync(top) ? top : join(home, ".claude", "CLAUDE.md");
}

/** 终端命令软链可能在的目录（install.sh 建在其中第一个在 PATH 上且可写的目录）；HELIU_BIN_DIRS（冒号分隔）可覆盖 */
export function binLinkDirs(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  if (env.HELIU_BIN_DIRS) return env.HELIU_BIN_DIRS.split(":").filter(Boolean);
  return [join(home, ".bun", "bin"), join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
}

type Span = { start: number; end: number } | "broken" | null;

/** 已有段落的位置（begin 标记 → end 标记末尾）；没有 → null；只有一半 → "broken" */
function findEntry(text: string): Span {
  const b = text.indexOf(ENTRY_BEGIN);
  const e = text.indexOf(ENTRY_END);
  if (b < 0 && e < 0) return null;
  if (b < 0 || e < b) return "broken";
  if (text.indexOf(ENTRY_BEGIN, b + 1) >= 0 && text.indexOf(ENTRY_BEGIN, b + 1) < e) return "broken";
  return { start: b, end: e + ENTRY_END.length };
}

export type EntryState = "current" | "stale" | "missing" | "broken";

export function entryState(text: string, block: string): EntryState {
  const s = findEntry(text);
  if (s === null) return "missing";
  if (s === "broken") return "broken";
  return text.slice(s.start, s.end) === block ? "current" : "stale";
}

export interface EntryEdit {
  text: string;
  action: "added" | "updated" | "unchanged" | "broken";
}

/** 写入或更新：有段落就原地替换，没有就追加到文末（与前文空一行） */
export function applyEntry(text: string, block: string): EntryEdit {
  const s = findEntry(text);
  if (s === "broken") return { text, action: "broken" };
  if (s === null) {
    const head = text.replace(/\s+$/, "");
    return { text: `${head}${head ? "\n\n" : ""}${block}\n`, action: "added" };
  }
  const next = text.slice(0, s.start) + block + text.slice(s.end);
  return { text: next, action: next === text ? "unchanged" : "updated" };
}

/** 删除段落，并收拢它前后多出来的空行 */
export function removeEntry(text: string): { text: string; removed: boolean; broken: boolean } {
  const s = findEntry(text);
  if (s === "broken") return { text, removed: false, broken: true };
  if (s === null) return { text, removed: false, broken: false };
  const before = text.slice(0, s.start).replace(/\s+$/, "");
  const after = text.slice(s.end).replace(/^\s+/, "");
  const joined = before && after ? `${before}\n\n${after}` : before || after;
  return { text: joined ? `${joined.replace(/\s+$/, "")}\n` : "", removed: true, broken: false };
}

const check = (id: string, level: DoctorCheck["level"], message: string): DoctorCheck => ({ id, ok: level !== "fail", level, message });

function readJson(file: string): { ok: true; v: unknown } | { ok: false; missing: boolean } {
  if (!existsSync(file)) return { ok: false, missing: true };
  try {
    return { ok: true, v: JSON.parse(readFileSync(file, "utf8")) as unknown };
  } catch {
    return { ok: false, missing: false };
  }
}

function real(p: string): string | null {
  try {
    return realpathSync(p).normalize("NFC");
  } catch {
    return null;
  }
}

export interface InstallCheckOptions {
  /** ~/.claude（插件注册表 plugins/known_marketplaces.json 与 settings.json 所在） */
  claudeHome: string;
  /** 全局 CLAUDE.md 路径 */
  claudeMd: string;
  /** 终端命令软链候选目录 */
  binDirs: string[];
  /** 合流仓库根 */
  root?: string;
}

/** doctor「装进 Claude」：插件 / 全局入口 / 终端命令。只读，提醒不算失败 */
export function installChecks(o: InstallCheckOptions): DoctorCheck[] {
  const root = o.root ?? HELIU_REPO_ROOT;
  const rootReal = real(root) ?? root;
  const out: DoctorCheck[] = [];
  const fix = "在合流目录运行 scripts/install.sh";

  // 插件：本地 marketplace 指向哪里、是否启用
  const km = readJson(join(o.claudeHome, "plugins", "known_marketplaces.json"));
  const entry = km.ok ? (km.v as Record<string, { source?: { path?: string } } | undefined>)?.[MARKETPLACE] : undefined;
  const mpPath = entry?.source?.path ?? null;
  const settings = readJson(join(o.claudeHome, "settings.json"));
  const enabled = settings.ok ? (settings.v as { enabledPlugins?: Record<string, boolean> })?.enabledPlugins?.[PLUGIN_ID] : undefined;
  if (!km.ok && !km.missing) out.push(check("plugin", "warn", `读不了 Claude 的插件注册表（${join(o.claudeHome, "plugins", "known_marketplaces.json")}）`));
  else if (!mpPath) out.push(check("plugin", "warn", `Claude 里还没装合流插件（会话里没有 heliu_* 工具和 /heliu）：${fix}`));
  else if ((real(mpPath) ?? mpPath.normalize("NFC")) !== rootReal) out.push(check("plugin", "warn", `合流插件指向另一个目录：${mpPath}；${fix} 会改指到这里`));
  else if (enabled !== true) out.push(check("plugin", "warn", `合流插件已装但没启用：claude plugin enable ${PLUGIN_ID}`));
  else out.push(check("plugin", "ok", `插件 ${PLUGIN_ID} 已启用，从本目录原地加载（改了合流代码后，新开的会话才用上新工具）`));

  // 全局入口：全局 CLAUDE.md 里的「合流」一段
  let block: string | null = null;
  try {
    block = loadEntry(root);
  } catch {
    out.push(check("global-entry", "warn", `读不了全局入口原文：${entryTemplatePath(root)}`));
  }
  if (block !== null) {
    let text: string | null = null;
    let unreadable = false;
    try {
      text = existsSync(o.claudeMd) ? readFileSync(o.claudeMd, "utf8") : null;
    } catch {
      unreadable = true;
    }
    const msg: Record<EntryState, [DoctorCheck["level"], string]> = {
      current: ["ok", `全局 CLAUDE.md 已有合流入口：${o.claudeMd}（所有会话都知道什么时候用合流）`],
      stale: ["warn", `全局 CLAUDE.md 里的合流入口是旧版：${fix} 更新（只改带 heliu 标记的那一段）`],
      missing: ["warn", `全局 CLAUDE.md（${o.claudeMd}）还没有合流入口：${fix} 会追加一段，不动其他内容`],
      broken: ["warn", `全局 CLAUDE.md 里合流段落的开始 / 结束标记不成对（${o.claudeMd}），请手动检查；安装脚本这时不会改它`],
    };
    if (unreadable) out.push(check("global-entry", "warn", `读不了全局 CLAUDE.md：${o.claudeMd}`));
    else {
      const [level, m] = msg[text === null ? "missing" : entryState(text, block)];
      out.push(check("global-entry", level, m));
    }
  }

  // 终端命令：PATH 目录里的 heliu 软链是否指向本仓库
  const want = real(join(root, "bin", "heliu"));
  let linked: string | null = null;
  const elsewhere: string[] = [];
  for (const d of o.binDirs) {
    const p = join(d, "heliu");
    const r = real(p);
    if (!r) continue;
    if (want && r === want) {
      linked = p;
      break;
    }
    elsewhere.push(`${p} → ${r}`);
  }
  if (linked) out.push(check("terminal-cli", "ok", `终端里可以直接敲 heliu（${linked} 指向本目录）`));
  else if (elsewhere.length) out.push(check("terminal-cli", "warn", `终端里的 heliu 指向别处：${elsewhere.join("；")}；${fix} 会改指到这里`));
  else out.push(check("terminal-cli", "warn", `终端里还不能直接敲 heliu：${fix} 会在 ~/.bun/bin 建软链；不建也能用完整路径 ${join(root, "bin", "heliu")}`));
  return out;
}
