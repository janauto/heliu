/**
 * union 文件（索引类 Markdown：README、进度表）的冲突处理：「两边都保留、新日期在前」（用户 10-22 集成方案的做法）。
 *
 * - 关闭排序（project.yaml union_sort_by_date: false）：直接用 `git merge-file -p --union`。
 * - 开启排序（默认）：用 `git merge-file -p` 拿到带标记的结果（标记长度 32、自定义标签，避免与正文里的 <<<<<<< 混淆），
 *   每个冲突块按 union 语义（集成侧在前、合入侧在后）合并，再在块内按「新日期在前」稳定排序：
 *   - 块内条目 = 空行分隔的段落；若每侧都是一整段列表/表格行，则每行一个条目；
 *   - 只有块内**每个**条目都带日期（2026-10-22 / 2026.10.22 / 2026年10月22日 / 20261022）且条目类型一致时才排序，否则保持 union 原序；
 *   - 完全相同的条目只保留一份。
 * 纯函数部分（unionFromMarkers / entryDate）可单测；merge-file 调用由调用方注入写模式运行器。
 */

export const UNION_MARKER_SIZE = 32;
export const LABEL_OURS = "HELIU-集成";
export const LABEL_BASE = "HELIU-基";
export const LABEL_THEIRS = "HELIU-合入";

const DATE_RES = [/(20\d{2})\s*[-./年]\s*(\d{1,2})\s*[-./月]\s*(\d{1,2})/g, /(?<!\d)(20\d{2})(\d{2})(\d{2})(?!\d)/g];

/** 条目里最新的日期（yyyymmdd 数值）；没有日期返回 null */
export function entryDate(text: string): number | null {
  let best: number | null = null;
  for (const re of DATE_RES) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const y = Number(m[1]);
      const mo = Number(m[2]);
      const d = Number(m[3]);
      if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
      const v = y * 10000 + mo * 100 + d;
      if (best === null || v > best) best = v;
    }
  }
  return best;
}

const ROW_RE = /^\s*([-*+]\s|\d+[.)]\s|\|)/;

interface Entry {
  lines: string[];
  kind: "line" | "para";
}

/** 一侧的行 → 条目；返回 null 表示结构不适合排序（例如列表中间夹空行） */
function splitEntries(lines: string[]): Entry[] | null {
  const paras: string[][] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) paras.push(cur);
      cur = [];
    } else cur.push(l);
  }
  if (cur.length) paras.push(cur);
  if (!paras.length) return [];
  const allRows = paras.every((p) => p.every((l) => ROW_RE.test(l)));
  if (allRows) {
    if (paras.length > 1) return null; // 多段列表：排了会丢掉段间空行，不排
    return (paras[0] as string[]).map((l) => ({ lines: [l], kind: "line" as const }));
  }
  return paras.map((p) => ({ lines: p, kind: "para" as const }));
}

/** 一个冲突块（集成侧 ours、合入侧 theirs）→ union 结果行 */
export function combineHunk(ours: string[], theirs: string[], sortByDate: boolean): { lines: string[]; sorted: boolean } {
  const plain = [...ours, ...theirs];
  if (!sortByDate) return { lines: plain, sorted: false };
  const a = splitEntries(ours);
  const b = splitEntries(theirs);
  if (!a || !b) return { lines: plain, sorted: false };
  const seen = new Set<string>();
  const entries: Entry[] = [];
  for (const e of [...a, ...b]) {
    const k = e.lines.join("\n");
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push(e);
  }
  if (entries.length < 2) return { lines: entries.flatMap((e) => e.lines), sorted: false };
  const kind = entries[0]!.kind;
  if (!entries.every((e) => e.kind === kind)) return { lines: plain, sorted: false };
  const dated = entries.map((e, i) => ({ e, i, d: entryDate(e.lines.join("\n")) }));
  if (dated.some((x) => x.d === null)) return { lines: plain, sorted: false };
  dated.sort((x, y) => (y.d as number) - (x.d as number) || x.i - y.i);
  const lead: string[] = [];
  for (const l of ours) {
    if (l.trim() === "") lead.push(l);
    else break;
  }
  const trailBlank = (ours.length && ours[ours.length - 1]!.trim() === "") || (theirs.length && theirs[theirs.length - 1]!.trim() === "");
  const body: string[] = [];
  dated.forEach((x, k) => {
    if (kind === "para" && k > 0) body.push("");
    body.push(...x.e.lines);
  });
  return { lines: [...lead, ...body, ...(trailBlank ? [""] : [])], sorted: true };
}

/**
 * 把 merge-file 的带标记输出改写成 union 结果。
 * 返回 hunks = 冲突块数、sorted = 按日期重排过的块数；leftover = 仍残留的标记（理论上为 0）。
 */
export function unionFromMarkers(text: string, opts: { sortByDate: boolean; markerSize?: number }): { text: string; hunks: number; sorted: number } {
  const size = opts.markerSize ?? UNION_MARKER_SIZE;
  const isMarker = (l: string, ch: string) => l.startsWith(ch.repeat(size)) && (l.length === size || l[size] === " ");
  const L = text.split("\n");
  const out: string[] = [];
  let hunks = 0;
  let sorted = 0;
  for (let i = 0; i < L.length; i++) {
    const line = L[i] as string;
    if (!isMarker(line, "<")) {
      out.push(line);
      continue;
    }
    const ours: string[] = [];
    const theirs: string[] = [];
    let mode: "ours" | "base" | "theirs" = "ours";
    let closed = false;
    for (i++; i < L.length; i++) {
      const l = L[i] as string;
      if (isMarker(l, "|")) mode = "base";
      else if (l === "=".repeat(size)) mode = "theirs";
      else if (isMarker(l, ">")) {
        closed = true;
        break;
      } else if (mode === "ours") ours.push(l);
      else if (mode === "theirs") theirs.push(l);
    }
    if (!closed) {
      // 不完整的块：原样保留（调用方会检测到残留标记并转交解冲突器）
      out.push(line, ...ours, ...theirs);
      continue;
    }
    hunks++;
    const c = combineHunk(ours, theirs, opts.sortByDate);
    if (c.sorted) sorted++;
    out.push(...c.lines);
  }
  return { text: out.join("\n"), hunks, sorted };
}

/** 文本里是否还有冲突标记（只认 <<<<<<< / >>>>>>> 开头的行；单独的 ======= 可能是 Markdown 标题下划线，不算） */
export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|>{7})( |$)/m.test(text);
}
