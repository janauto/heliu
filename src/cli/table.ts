/**
 * 中文表格：按显示宽度（全角=2）对齐，超宽按显示宽度截断加「…」。
 */
import stringWidth from "string-width";

export const width = (s: string): number => stringWidth(s);

/** 按显示宽度截断 */
export function truncate(s: string, max: number): string {
  if (max <= 0) return "";
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = width(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}

/** 中间截断，保留尾部（分支名的 hash 后缀更有辨识度） */
export function truncateMiddle(s: string, max: number): string {
  if (width(s) <= max) return s;
  const chars = [...s];
  let tail = "";
  let tw = 0;
  const tailBudget = Math.floor((max - 1) / 2);
  for (let i = chars.length - 1; i >= 0; i--) {
    const cw = width(chars[i] ?? "");
    if (tw + cw > tailBudget) break;
    tail = chars[i] + tail;
    tw += cw;
  }
  return truncate(s, max - tw) .replace(/…$/, "") + "…" + tail;
}

export function pad(s: string, w: number, align: "left" | "right" = "left"): string {
  const gap = Math.max(0, w - width(s));
  return align === "right" ? " ".repeat(gap) + s : s + " ".repeat(gap);
}

export interface Column {
  header: string;
  /** 最大显示宽度；undefined 表示不截断 */
  max?: number;
  align?: "left" | "right";
  /** 截断方式 */
  cut?: "end" | "middle";
}

export function renderTable(columns: Column[], rows: string[][], opts: { wide?: boolean; indent?: string } = {}): string {
  const indent = opts.indent ?? "";
  const cells = rows.map((r) =>
    columns.map((c, i) => {
      const v = (r[i] ?? "").replace(/[\r\n\t]+/g, " ");
      if (opts.wide || c.max === undefined) return v;
      return c.cut === "middle" ? truncateMiddle(v, c.max) : truncate(v, c.max);
    }),
  );
  const widths = columns.map((c, i) => Math.max(width(c.header), ...cells.map((r) => width(r[i] ?? ""))));
  const line = (vals: string[]) =>
    indent +
    vals
      .map((v, i) => pad(v, widths[i] ?? 0, columns[i]?.align))
      .join("  ")
      .replace(/\s+$/, "");
  const out = [line(columns.map((c) => c.header)), indent + widths.map((w) => "-".repeat(w)).join("  ")];
  for (const r of cells) out.push(line(r));
  return out.join("\n");
}

/**
 * 按显示宽度折行：中文逐字可断，英文优先在空格处断；保留原文换行，丢弃空行。
 * 不截断任何内容。
 */
export function wrapText(text: string, maxWidth: number): string[] {
  const limit = Math.max(10, maxWidth);
  const out: string[] = [];
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const para = raw.replace(/\t/g, " ").replace(/\s+$/, "");
    if (!para.trim()) continue;
    let line = "";
    for (const ch of para) {
      if (width(line) + width(ch) > limit) {
        const sp = line.lastIndexOf(" ");
        // 英文单词中间：退回到最近的空格（只在空格不太靠前时，避免整行过短）
        if (/[\x21-\x7e]/.test(ch) && sp > 0 && width(line.slice(0, sp)) > limit / 2) {
          out.push(line.slice(0, sp));
          line = line.slice(sp + 1);
        } else {
          out.push(line);
          line = "";
        }
        if (ch === " " && line === "") continue;
      }
      line += ch;
    }
    if (line) out.push(line);
  }
  return out.length ? out : [""];
}

/** 带前缀的悬挂缩进：首行「前缀+正文」，后续行与正文对齐 */
export function hangingWrap(prefix: string, text: string, totalWidth: number): string[] {
  const indent = " ".repeat(width(prefix));
  return wrapText(text, totalWidth - width(prefix)).map((l, i) => (i === 0 ? prefix : indent) + l);
}

/** 输出宽度：COLUMNS 环境变量 > 终端列数 > 100，夹在 60~160 */
export function outputWidth(): number {
  const c = Number(process.env.COLUMNS) || process.stdout.columns || 100;
  return Math.max(60, Math.min(160, c));
}
