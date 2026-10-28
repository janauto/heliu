/**
 * M9 跨仓配对的证据：Claude Code 对话记录（~/.claude/projects/<目录>/<cliSessionId>.jsonl，不在 iCloud）。
 *
 * 用户总在一个仓库（如文档仓）开会话，真实改动却落在另一个仓库的 worktree（如 ~/.cache/backclip-web/esp_claw-aios）。
 * 桌面会话 JSON 的 writtenBranches / gitAnchors 只记会话自己的仓库，所以只能从对话记录里找：
 * 会话在哪些「别的仓库的 worktree」里出现过、改过文件、提交过。
 *
 * - 只读、只读本项目会话的那几个文件；先用正则在整份文本里找路径，命中的行才 JSON.parse。
 * - 结果只有路径、计数、工具类别、时间戳，不存一个字的对话内容。
 * - 路径既认绝对路径，也认 `~/…`、`$HOME/…` 写法（Bash 命令里常见）：按「家目录之后的那一段」匹配。
 * - 根目录可注入（HELIU_TRANSCRIPTS_DIR），测试用伪造样本。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function transcriptsRoot(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return env.HELIU_TRANSCRIPTS_DIR || join(home, ".claude", "projects");
}

/** cliSessionId → 对话记录文件（扫一层子目录；同名多处取最大的那份） */
export function indexTranscripts(root: string): Map<string, string> {
  const out = new Map<string, { file: string; size: number }>();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root);
  } catch {
    return new Map();
  }
  for (const d of dirs) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, d));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const file = join(root, d, n);
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      const id = n.slice(0, -".jsonl".length);
      const cur = out.get(id);
      if (!cur || size > cur.size) out.set(id, { file, size });
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.file]));
}

export interface EvidenceCount {
  /** 目标 worktree 的绝对路径（与对账结果里的 worktree.path 相同） */
  worktree: string;
  /** 除写入 / 提交以外的出现次数（查看、列目录、工具输出里提到） */
  reads: number;
  /** Edit / Write / NotebookEdit / MultiEdit 的 file_path 落在这个 worktree 下 */
  writes: number;
  /** Bash 命令提到这个 worktree 且含 git commit */
  commits: number;
  lastSeenAt: string | null;
}

const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);
const GIT_COMMIT = /\bgit\b[^\n|;&]*\bcommit\b/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 路径的匹配片段：家目录下的取「/家目录之后」那一段（~/x、$HOME/x、/Users/me/x 都含它），否则整条路径 */
export function matchSuffix(path: string, home: string = homedir()): string {
  const h = home.replace(/\/+$/, "");
  return path.startsWith(`${h}/`) ? path.slice(h.length) : path;
}

export interface Matcher {
  re: RegExp;
  /** 片段 → worktree 路径 */
  bySuffix: Map<string, string>;
  /** 目标集合签名：目标变了（新建了 worktree）就要重新提取 */
  sig: string;
}

/** 把一组 worktree 路径编成一个正则：长的在前，后面不能紧跟路径字符（esp_claw 不会误中 esp_claw-aios） */
export function buildMatcher(worktrees: string[], home: string = homedir()): Matcher | null {
  const bySuffix = new Map<string, string>();
  for (const w of worktrees) {
    const s = matchSuffix(w, home);
    if (s.length >= 4 && !bySuffix.has(s)) bySuffix.set(s, w);
  }
  if (!bySuffix.size) return null;
  const parts = [...bySuffix.keys()].sort((a, b) => b.length - a.length);
  return { re: new RegExp(`(${parts.map(esc).join("|")})(?![\\w.-])`, "g"), bySuffix, sig: parts.slice().sort().join("\n") };
}

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function toolUses(o: unknown): ToolUse[] {
  const content = (o as { message?: { content?: unknown } })?.message?.content;
  if (!Array.isArray(content)) return [];
  const out: ToolUse[] = [];
  for (const c of content) {
    if (c && typeof c === "object" && (c as { type?: unknown }).type === "tool_use") {
      const name = (c as { name?: unknown }).name;
      const input = (c as { input?: unknown }).input;
      if (typeof name === "string" && input && typeof input === "object") out.push({ name, input: input as Record<string, unknown> });
    }
  }
  return out;
}

/** 一份对话记录里，各目标 worktree 的出现 / 写入 / 提交次数（只读；没有命中返回空数组） */
export function extractEvidence(text: string, m: Matcher): EvidenceCount[] {
  const acc = new Map<string, EvidenceCount>();
  const get = (wt: string) => {
    let e = acc.get(wt);
    if (!e) acc.set(wt, (e = { worktree: wt, reads: 0, writes: 0, commits: 0, lastSeenAt: null }));
    return e;
  };
  const suffixesIn = (s: string): string[] => {
    const hits: string[] = [];
    for (const x of s.matchAll(m.re)) hits.push(x[1]!);
    return hits;
  };
  m.re.lastIndex = 0;
  let lineEnd = -1;
  for (const hit of text.matchAll(m.re)) {
    const pos = hit.index ?? 0;
    if (pos < lineEnd) continue; // 同一行已经整行处理过
    const start = text.lastIndexOf("\n", pos) + 1;
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    lineEnd = end;
    const line = text.slice(start, end);
    const mentions = suffixesIn(line);
    const total = new Map<string, number>();
    for (const s of mentions) {
      const wt = m.bySuffix.get(s)!;
      total.set(wt, (total.get(wt) ?? 0) + 1);
    }
    let obj: unknown = null;
    try {
      obj = JSON.parse(line);
    } catch {
      obj = null;
    }
    const ts = obj && typeof (obj as { timestamp?: unknown }).timestamp === "string" ? ((obj as { timestamp: string }).timestamp as string) : null;
    const strong = new Map<string, number>();
    for (const t of toolUses(obj)) {
      if (WRITE_TOOLS.has(t.name) && typeof t.input.file_path === "string") {
        for (const s of suffixesIn(t.input.file_path)) {
          const wt = m.bySuffix.get(s)!;
          get(wt).writes += 1;
          strong.set(wt, (strong.get(wt) ?? 0) + 1);
        }
      } else if (t.name === "Bash" && typeof t.input.command === "string" && GIT_COMMIT.test(t.input.command)) {
        for (const wt of new Set(suffixesIn(t.input.command).map((s) => m.bySuffix.get(s)!))) {
          get(wt).commits += 1;
          strong.set(wt, (strong.get(wt) ?? 0) + 1);
        }
      }
    }
    for (const [wt, n] of total) {
      const e = get(wt);
      e.reads += Math.max(0, n - (strong.get(wt) ?? 0));
      if (ts && (!e.lastSeenAt || ts > e.lastSeenAt)) e.lastSeenAt = ts;
    }
  }
  return [...acc.values()];
}

/** 读文件并提取；文件读不到返回 null */
export function extractFile(file: string, m: Matcher): EvidenceCount[] | null {
  if (!existsSync(file)) return null;
  try {
    return extractEvidence(readFileSync(file, "utf8"), m);
  } catch {
    return null;
  }
}
