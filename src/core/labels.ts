/**
 * 随机分支名 → 人能读懂的标签。
 * 优先级：会话标题 > 首条独有提交主题 > 改动最多的一级目录 > 末次提交主题 > 分支名本身。
 * 「形容词-科学家-hash」类随机名（bold-shaw-093e51）必须拿到非分支名的标签。
 */
import type { LabelSource } from "../types.ts";

/** Docker / Claude 桌面端随机名使用的形容词表 */
const RANDOM_ADJECTIVES = new Set(
  (
    "admiring adoring affectionate agitated amazing angry awesome beautiful blissful bold boring brave busy " +
    "charming clever compassionate competent condescending confident cool cranky crazy dazzling determined " +
    "distracted dreamy eager ecstatic elastic elated elegant eloquent epic exciting fervent festive flamboyant " +
    "focused friendly frosty funny gallant gifted goofy gracious great happy hardcore heuristic hopeful hungry " +
    "infallible inspiring intelligent interesting jolly jovial keen kind laughing loving lucid magical modest " +
    "musing mystifying naughty nervous nice nifty nostalgic objective optimistic peaceful pedantic pensive " +
    "practical priceless quirky quizzical recursing relaxed reverent romantic sad serene sharp silly sleepy " +
    "stoic strange stupefied suspicious sweet tender thirsty trusting unruffled upbeat vibrant vigilant " +
    "vigorous wizardly wonderful xenodochial youthful zealous zen"
  ).split(" "),
);

/** claude/bold-shaw-093e51、bold-shaw 之类 */
export function isRandomName(branch: string): boolean {
  const slug = branch.split("/").pop() ?? branch;
  const m = /^([a-z]+)-([a-z]+)(?:-[0-9a-f]{4,})?$/.exec(slug);
  return !!m && RANDOM_ADJECTIVES.has(m[1] ?? "");
}

export interface LabelInputs {
  branch: string;
  sessionTitle: string | null;
  firstCommitSubject: string | null;
  topDir: string | null;
  tipSubject: string | null;
}

/** 去掉 claude/ 前缀与 6 位 hash 后缀，作为最后兜底 */
export function humanizeBranch(branch: string): string {
  const slug = branch.replace(/^(claude|codex|feat|fix|feature)\//, "");
  return slug.replace(/-[0-9a-f]{6}$/, "");
}

/** 提交主题做标签时去掉 conventional 前缀里的类型，保留 scope：「feat(timeline): 时间线 v2」→「timeline: 时间线 v2」 */
export function tidySubject(subject: string): string {
  const m = /^(feat|fix|docs|chore|refactor|test|tests|perf|style|build|ci|merge|revert|wip)(?:\(([^)]+)\))?!?:\s*(.+)$/i.exec(subject.trim());
  if (!m) return subject.trim();
  return m[2] ? `${m[2]}: ${m[3]}` : (m[3] ?? subject).trim();
}

export function pickLabel(i: LabelInputs): { label: string; source: LabelSource } {
  const clean = (s: string | null) => (s ?? "").replace(/\s+/g, " ").trim();
  const title = clean(i.sessionTitle);
  if (title) return { label: title, source: "session" };
  const first = clean(i.firstCommitSubject);
  if (first) return { label: tidySubject(first), source: "first_commit" };
  const dir = clean(i.topDir);
  if (dir) return { label: `改动集中在 ${dir}`, source: "top_dir" };
  const tip = clean(i.tipSubject);
  if (tip) return { label: tidySubject(tip), source: "tip_commit" };
  return { label: humanizeBranch(i.branch), source: "branch_name" };
}
