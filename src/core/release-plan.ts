/**
 * 合并单（M4）：<台账>/releases/<里程碑>.md
 *
 * - frontmatter 是机器段（以它为准）：里程碑、各仓库集成分支与 base_sha、每一项的 decision / 执行结果、refs_moved（回滚依据）。
 * - 正文是人读的勾选表（每次 preview 重新生成）+「## 执行记录」「## 发布说明」（执行时追加，preview 刷新时原样保留）。
 * - 用户只需要改 frontmatter 里某项的 decision（并入 / 顺延 / 等它 / 不并 / 待定）；preview 刷新时保留与默认值不同的 decision。
 * - 「未能试合」（沙箱建不起来 / 超时 / 出错，没有得到试合结果）单列一档，绝不算作有冲突；默认「待定」，run 跳过、不并入也不顺延。
 * - 看板（M3）也会在同一路径写「草稿」（schema 1，逐条 tier/bindings）。本模块写 schema 2；读到看板草稿时标 format=board，
 *   run / set 拒绝执行，preview 先备份到 releases/.history/ 再生成可执行合并单。
 * - 多仓库：任务卡只写了单个 integration_branch / base_sha；这里按仓库存一份（repos[]），顶层两个字段镜像主仓库，便于一眼看。
 * 本模块只做格式与纯函数，不碰 git。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { splitFrontmatter } from "./ledger.ts";

export const DECISIONS = ["并入", "顺延", "等它", "不并", "待定"] as const;
export type Decision = (typeof DECISIONS)[number];

/** 预演时的状态（决定排序与默认 decision）：已进集成 → 无冲突 → 有冲突 → 未能试合 → 未完成 → 无法合并 */
export const ITEM_STATES = ["已进集成", "无冲突", "有冲突", "未能试合", "未完成", "无法合并"] as const;
export type ItemState = (typeof ITEM_STATES)[number];

/**
 * 档位（前五个与看板 src/board/api-types.ts 的 ReleaseTier 同名同义）+ 建议动作。
 * unmergeable = 分支不存在 / 仓库没配集成分支等，M4 无法执行。
 */
export type PlanTier = "in_integration" | "clean" | "conflict" | "precheck_failed" | "unfinished" | "unmergeable";
export const TIER_OF: Record<ItemState, PlanTier> = {
  已进集成: "in_integration",
  无冲突: "clean",
  有冲突: "conflict",
  未能试合: "precheck_failed",
  未完成: "unfinished",
  无法合并: "unmergeable",
};
export const ACTION_TEXT: Record<ItemState, string> = {
  已进集成: "跳过（已在集成分支）",
  无冲突: "合入",
  有冲突: "合入（需解冲突）",
  未能试合: "重新试合或人工确认",
  未完成: "顺延",
  无法合并: "先补分支/配置（默认顺延）",
};

/** 执行结果 */
export type ItemResult = "已合入" | "已在集成" | "失败·待处理" | "未执行" | "未演练" | "跳过·待定";

export type PlanStatus = "草稿" | "执行中" | "待续" | "已发布" | "已回滚";

export interface PlanRepo {
  repo: string;
  label: string;
  /** null = 仓库没配集成分支（该仓库的项无法合并） */
  integration_branch: string | null;
  base_sha: string | null;
  main: string;
  main_sha: string | null;
}

export interface ResolverRecord {
  files: string[];
  rounds: number;
  turns: number | null;
  cost_usd: number;
  ok: boolean;
  summary: string;
}

export interface CheckRecord {
  cmd: string;
  ok: boolean;
  code: number | null;
  ms: number;
  tail: string;
}

export interface PlanItem {
  feature: string;
  title: string;
  decision: Decision;
  /** preview 算出的默认决定；decision ≠ default_decision 视为用户改过，刷新时保留 */
  default_decision: Decision;
  state: ItemState;
  /** 状态补充：会话等你回答 / 分支不存在 / 仓库未配置集成分支 … */
  detail: string | null;
  repo: string | null;
  branch: string | null;
  /** 预演时分支顶端；执行时合入的就是这个提交（之后的新提交不会被带进来） */
  branch_sha: string | null;
  /** 落后集成分支提交数 */
  behind: number | null;
  precheck: { conflicts: string[]; union: string[]; other: string[] } | null;
  /** 试合三态（复用 src/core/todo.ts precheckStateOf）：checked / failed / skipped；不需要试合为 null */
  precheck_state?: "checked" | "failed" | "skipped" | null;
  /* 执行后填写 */
  result?: ItemResult | null;
  result_detail?: string | null;
  old_sha?: string | null;
  new_sha?: string | null;
  union_resolved?: string[];
  resolver?: ResolverRecord | null;
  checks?: CheckRecord[];
}

export interface RefMove {
  repo: string;
  ref: string;
  /** null = 本次新建（tag） */
  old: string | null;
  new: string;
  time: string;
  note: string;
  /** 回滚后标记 */
  rolled_back?: string | null;
}

export interface LedgerChange {
  feature: string;
  from: { milestone: string | null; rolled_from: string[]; status: string };
  to: { milestone: string | null; rolled_from: string[]; status: string };
  note: string;
  rolled_back?: string | null;
}

export interface ReleasePlan {
  /** m4 = 本模块写的可执行合并单（schema 2）；board = 看板生成的草稿（schema 1，不能直接执行） */
  format: "m4" | "board";
  /** format=board 时：看板草稿里各卡的决定（只用于提示，不导入） */
  boardDecisions?: Array<{ feature: string; decision: string }>;
  milestone: string;
  project: string;
  status: PlanStatus;
  created: string;
  updated: string;
  executed_at: string | null;
  finalized_at: string | null;
  rolled_back_at: string | null;
  /** 主仓库的集成分支与 base_sha（镜像 repos[] 中主仓库那一条；多仓库以 repos 为准） */
  integration_branch: string | null;
  base_sha: string | null;
  /** 执行开始前里程碑的状态（回滚时恢复） */
  milestone_status_before: string | null;
  repos: PlanRepo[];
  items: PlanItem[];
  refs_moved: RefMove[];
  ledger_changes: LedgerChange[];
  resolver_cost_usd: number;
  /** 正文中 preview 不重写的部分（## 执行记录 / ## 发布说明 起到文末） */
  tail: string;
  /** 文件路径 */
  file: string;
}

export const EXEC_HEADING = "## 执行记录";
export const NOTES_HEADING = "## 发布说明";

export function releasesDir(ledgerDir: string): string {
  return join(ledgerDir, "releases");
}
export function planFile(ledgerDir: string, milestone: string): string {
  return join(releasesDir(ledgerDir), `${milestone}.md`);
}
export function auditFile(ledgerDir: string, milestone: string): string {
  return join(releasesDir(ledgerDir), `${milestone}.log`);
}

/** 同一项的身份：功能卡 + 仓库 + 分支 */
export function itemKey(i: Pick<PlanItem, "feature" | "repo" | "branch">): string {
  return `${i.feature}\u0000${i.repo ?? ""}\u0000${i.branch ?? ""}`;
}

export function isDecision(v: unknown): v is Decision {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}

/** 用户输入的决定：容忍 y/n、英文与近义词 */
export function parseDecision(raw: string): Decision {
  const t = raw.trim().toLowerCase();
  const map: Record<string, Decision> = {
    并入: "并入", 合入: "并入", 合: "并入", merge: "并入", y: "并入", yes: "并入",
    顺延: "顺延", 下一版: "顺延", defer: "顺延", next: "顺延", n: "顺延",
    等它: "等它", 等: "等它", wait: "等它", w: "等它",
    不并: "不并", 不要: "不并", skip: "不并", drop: "不并",
    待定: "待定", pending: "待定", 未定: "待定", "?": "待定",
  };
  const d = map[t] ?? map[raw.trim()];
  if (!d) throw new Error(`决定只能是：${DECISIONS.join(" / ")}`);
  return d;
}

/* ───────────── 解析 / 序列化 ───────────── */

const s = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

function parseItem(v: unknown): PlanItem | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const feature = s(o.feature);
  if (!feature) return null;
  const decision = isDecision(o.decision) ? o.decision : "顺延";
  const def = isDecision(o.default_decision) ? o.default_decision : decision;
  const state = (ITEM_STATES as readonly string[]).includes(String(o.state)) ? (o.state as ItemState) : "无法合并";
  const pc = o.precheck && typeof o.precheck === "object" ? (o.precheck as Record<string, unknown>) : null;
  const item: PlanItem = {
    feature,
    title: s(o.title) ?? feature,
    decision,
    default_decision: def,
    state,
    detail: s(o.detail),
    repo: s(o.repo),
    branch: s(o.branch),
    branch_sha: s(o.branch_sha),
    behind: n(o.behind),
    precheck: pc ? { conflicts: arr(pc.conflicts), union: arr(pc.union), other: arr(pc.other) } : null,
  };
  if ("precheck_state" in o) {
    const ps = s(o.precheck_state);
    item.precheck_state = ps === "checked" || ps === "failed" || ps === "skipped" ? ps : null;
  }
  if (o.result !== undefined) item.result = (s(o.result) as ItemResult | null) ?? null;
  if (o.result_detail !== undefined) item.result_detail = s(o.result_detail);
  if (o.old_sha !== undefined) item.old_sha = s(o.old_sha);
  if (o.new_sha !== undefined) item.new_sha = s(o.new_sha);
  if (o.union_resolved !== undefined) item.union_resolved = arr(o.union_resolved);
  if (o.resolver && typeof o.resolver === "object") {
    const r = o.resolver as Record<string, unknown>;
    item.resolver = { files: arr(r.files), rounds: n(r.rounds) ?? 0, turns: n(r.turns), cost_usd: n(r.cost_usd) ?? 0, ok: r.ok === true, summary: s(r.summary) ?? "" };
  }
  if (Array.isArray(o.checks)) {
    item.checks = o.checks
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({ cmd: s(c.cmd) ?? "", ok: c.ok === true, code: n(c.code), ms: n(c.ms) ?? 0, tail: s(c.tail) ?? "" }));
  }
  return item;
}

function parseRepo(v: unknown): PlanRepo | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const repo = s(o.repo);
  if (!repo) return null;
  return { repo, label: s(o.label) ?? repo, integration_branch: s(o.integration_branch), base_sha: s(o.base_sha), main: s(o.main) ?? "main", main_sha: s(o.main_sha) };
}

function parseMove(v: unknown): RefMove | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const repo = s(o.repo);
  const ref = s(o.ref);
  const nv = s(o.new);
  if (!repo || !ref || !nv) return null;
  return { repo, ref, old: s(o.old), new: nv, time: s(o.time) ?? "", note: s(o.note) ?? "", rolled_back: s(o.rolled_back) };
}

function parseChange(v: unknown): LedgerChange | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const feature = s(o.feature);
  const side = (x: unknown) => {
    const y = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    return { milestone: s(y.milestone), rolled_from: arr(y.rolled_from), status: s(y.status) ?? "" };
  };
  if (!feature) return null;
  return { feature, from: side(o.from), to: side(o.to), note: s(o.note) ?? "", rolled_back: s(o.rolled_back) };
}

/** 看板草稿：schema ≠ 2，且条目用 bindings[] 而不是 repo/branch/state */
function isBoardDraft(d: Record<string, unknown>): boolean {
  if (Number(d.schema) === 2) return false;
  const items = Array.isArray(d.items) ? d.items : [];
  return items.some((x) => !!x && typeof x === "object" && "bindings" in (x as object) && !("state" in (x as object)));
}

export function parsePlan(text: string, file: string): ReleasePlan {
  const doc = splitFrontmatter(text);
  if (!doc) throw new Error(`${file} 不是合并单（缺 frontmatter）`);
  const d = doc.data;
  const milestone = s(d.milestone);
  if (!milestone) throw new Error(`${file} 缺 milestone`);
  if (isBoardDraft(d)) {
    const raw = (Array.isArray(d.items) ? d.items : []) as Array<Record<string, unknown>>;
    return {
      format: "board",
      boardDecisions: raw.map((x) => ({ feature: String(x.feature ?? ""), decision: String(x.decision ?? "") })).filter((x) => x.feature),
      milestone,
      project: s(d.project) ?? "",
      status: "草稿",
      created: s(d.generated_at) ?? "",
      updated: s(d.generated_at) ?? "",
      executed_at: null,
      finalized_at: null,
      rolled_back_at: null,
      integration_branch: null,
      base_sha: null,
      milestone_status_before: null,
      repos: [],
      items: [],
      refs_moved: [],
      ledger_changes: [],
      resolver_cost_usd: 0,
      tail: "",
      file,
    };
  }
  const idx = Math.min(...[EXEC_HEADING, NOTES_HEADING].map((h) => doc.body.indexOf(`\n${h}`)).filter((i) => i >= 0), Number.MAX_SAFE_INTEGER);
  const tail = idx === Number.MAX_SAFE_INTEGER ? "" : doc.body.slice(idx + 1);
  const status = s(d.status) as PlanStatus | null;
  return {
    format: "m4",
    milestone,
    project: s(d.project) ?? "",
    status: status && ["草稿", "执行中", "待续", "已发布", "已回滚"].includes(status) ? status : "草稿",
    created: s(d.created) ?? "",
    updated: s(d.updated) ?? "",
    executed_at: s(d.executed_at),
    finalized_at: s(d.finalized_at),
    rolled_back_at: s(d.rolled_back_at),
    integration_branch: s(d.integration_branch),
    base_sha: s(d.base_sha),
    milestone_status_before: s(d.milestone_status_before),
    repos: Array.isArray(d.repos) ? d.repos.map(parseRepo).filter((x): x is PlanRepo => !!x) : [],
    items: Array.isArray(d.items) ? d.items.map(parseItem).filter((x): x is PlanItem => !!x) : [],
    refs_moved: Array.isArray(d.refs_moved) ? d.refs_moved.map(parseMove).filter((x): x is RefMove => !!x) : [],
    ledger_changes: Array.isArray(d.ledger_changes) ? d.ledger_changes.map(parseChange).filter((x): x is LedgerChange => !!x) : [],
    resolver_cost_usd: n(d.resolver_cost_usd) ?? 0,
    tail,
    file,
  };
}

export function loadPlan(ledgerDir: string, milestone: string): ReleasePlan | null {
  const f = planFile(ledgerDir, milestone);
  if (!existsSync(f)) return null;
  return parsePlan(readFileSync(f, "utf8"), f);
}

function itemYaml(i: PlanItem): Record<string, unknown> {
  const o: Record<string, unknown> = {
    feature: i.feature,
    title: i.title,
    decision: i.decision,
    default_decision: i.default_decision,
    state: i.state,
    tier: TIER_OF[i.state],
    action: ACTION_TEXT[i.state],
    detail: i.detail,
    repo: i.repo,
    branch: i.branch,
    branch_sha: i.branch_sha,
    behind: i.behind,
    precheck: i.precheck,
  };
  if (i.precheck_state !== undefined) o.precheck_state = i.precheck_state;
  if (i.result !== undefined) o.result = i.result;
  if (i.result_detail) o.result_detail = i.result_detail;
  if (i.old_sha) o.old_sha = i.old_sha;
  if (i.new_sha) o.new_sha = i.new_sha;
  if (i.union_resolved?.length) o.union_resolved = i.union_resolved;
  if (i.resolver) o.resolver = i.resolver;
  if (i.checks?.length) o.checks = i.checks;
  return o;
}

export function serializePlan(p: ReleasePlan, opts: { projectLabel?: string } = {}): string {
  const fm = {
    heliu: "release-plan",
    schema: 2,
    milestone: p.milestone,
    project: p.project,
    status: p.status,
    created: p.created,
    updated: p.updated,
    executed_at: p.executed_at,
    finalized_at: p.finalized_at,
    rolled_back_at: p.rolled_back_at,
    integration_branch: p.integration_branch,
    base_sha: p.base_sha,
    milestone_status_before: p.milestone_status_before,
    resolver_cost_usd: Math.round(p.resolver_cost_usd * 10000) / 10000,
    repos: p.repos,
    items: p.items.map(itemYaml),
    refs_moved: p.refs_moved,
    ledger_changes: p.ledger_changes,
  };
  const yaml = YAML.stringify(fm, { lineWidth: 0 });
  const tail = p.tail.trim() ? `\n${p.tail.replace(/^\n+/, "").replace(/\s*$/, "\n")}` : "";
  return `---\n${yaml}---\n\n${renderPlanBody(p, opts)}${tail}`;
}

export function savePlan(p: ReleasePlan): void {
  mkdirSync(dirname(p.file), { recursive: true });
  const tmp = `${p.file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, serializePlan(p), "utf8");
  renameSync(tmp, p.file);
}

/* ───────────── 汇总 ───────────── */

export interface PlanCounts {
  /** 决定并入、且不是已进集成/有冲突/无法合并（主要是试合无冲突的） */
  newMerge: number;
  inIntegration: number;
  conflict: number;
  precheckFailed: number;
  unchecked: number;
  deferred: number;
  waiting: number;
  dropped: number;
  /** 待定且不属于「未能试合」档 */
  otherPending: number;
}

export function planCounts(p: Pick<ReleasePlan, "items">): PlanCounts {
  const it = p.items;
  return {
    newMerge: it.filter((i) => i.decision === "并入" && !["已进集成", "有冲突", "无法合并"].includes(i.state)).length,
    inIntegration: it.filter((i) => i.state === "已进集成").length,
    conflict: it.filter((i) => i.state === "有冲突").length,
    precheckFailed: it.filter((i) => i.state === "未能试合").length,
    unchecked: it.filter((i) => i.precheck_state === "skipped").length,
    deferred: it.filter((i) => i.decision === "顺延").length,
    waiting: it.filter((i) => i.decision === "等它").length,
    dropped: it.filter((i) => i.decision === "不并").length,
    otherPending: it.filter((i) => i.decision === "待定" && i.state !== "未能试合").length,
  };
}

/** 新增待合 N · 已在集成 M · 有冲突 C · 未能试合 F · 未检查 U · 顺延 D（另有等它/不并/待定时追加） */
export function planCountsLine(p: Pick<ReleasePlan, "items">): string {
  const c = planCounts(p);
  const parts = [`新增待合 ${c.newMerge}`, `已在集成 ${c.inIntegration}`, `有冲突 ${c.conflict}`, `未能试合 ${c.precheckFailed}`, `未检查 ${c.unchecked}`, `顺延 ${c.deferred}`];
  if (c.waiting) parts.push(`等它 ${c.waiting}`);
  if (c.dropped) parts.push(`不并 ${c.dropped}`);
  if (c.otherPending) parts.push(`待定 ${c.otherPending}`);
  return parts.join(" · ");
}

/* ───────────── 人读勾选表 ───────────── */

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "—");
const cell = (x: string) => x.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

export function conflictText(i: PlanItem): string {
  if (i.state === "未能试合") return "未能试合";
  if (!i.precheck) return "—";
  if (!i.precheck.conflicts.length) return "无";
  const parts: string[] = [];
  if (i.precheck.union.length) parts.push(`union（两边内容都保留、新日期在前）：${i.precheck.union.join("、")}`);
  if (i.precheck.other.length) parts.push(`需解冲突：${i.precheck.other.join("、")}`);
  return parts.join("；");
}

export function resultText(i: PlanItem): string {
  if (!i.result) return "";
  const bits: string[] = [i.result];
  if (i.new_sha) bits.push(`→ ${short(i.new_sha)}`);
  if (i.union_resolved?.length) bits.push(`union ${i.union_resolved.length} 个`);
  if (i.resolver) bits.push(`解冲突器 ${i.resolver.rounds} 轮 $${i.resolver.cost_usd.toFixed(2)}`);
  if (i.result_detail) bits.push(i.result_detail);
  return bits.join(" · ");
}

export function renderPlanBody(p: ReleasePlan, opts: { projectLabel?: string } = {}): string {
  const lines: string[] = [];
  lines.push(`# 合并单 ${p.milestone}${p.project ? ` · ${opts.projectLabel ?? p.project}` : ""}`);
  lines.push("");
  lines.push(`> 以文件顶部 frontmatter 为准。改某项的 \`decision\`（并入 / 顺延 / 等它 / 不并）后：`);
  lines.push(`> \`heliu 合并 ${p.milestone} --预演\` 刷新（保留你改过的决定）→ \`heliu 合并 ${p.milestone}\` 执行；也可 \`heliu release set ${p.milestone} <卡号> <决定>\`。`);
  lines.push(`> 下表每次预演重新生成，直接改表格不生效。`);
  lines.push("");
  const repoLine = p.repos
    .map((r) => `${r.label} ${r.integration_branch ?? "（未配置集成分支）"}${r.base_sha ? `@${short(r.base_sha)}` : ""}`)
    .join(" · ");
  lines.push(`- 集成分支（预演时）：${repoLine || "—"}`);
  lines.push(`- 状态：${p.status} · 生成 ${p.created}${p.updated && p.updated !== p.created ? ` · 更新 ${p.updated}` : ""}${p.executed_at ? ` · 执行 ${p.executed_at}` : ""}`);
  lines.push(`- 共 ${p.items.length} 项：${planCountsLine(p)}`);
  lines.push("");
  lines.push("## 勾选表");
  lines.push("");
  lines.push("| # | 决定 | 功能 | 仓库 · 分支 | 状态 | 试合冲突 | 说明 / 结果 |");
  lines.push("|---|---|---|---|---|---|---|");
  const labelOf = new Map(p.repos.map((r) => [r.repo, r.label]));
  p.items.forEach((i, k) => {
    const box = i.decision === "并入" ? "[x] 并入" : `[ ] ${i.decision}`;
    const mark = i.decision !== i.default_decision ? "（你改的）" : "";
    const where = i.repo && i.branch ? `${labelOf.get(i.repo) ?? i.repo} · \`${i.branch}\`` : "—";
    const state = i.state === "已进集成" ? "已进集成（跳过）" : `${i.state} → ${ACTION_TEXT[i.state]}`;
    const info = [i.detail, i.behind ? `落后集成 ${i.behind}` : null, resultText(i) || null].filter(Boolean).join(" · ");
    lines.push(`| ${k + 1} | ${box}${mark} | ${cell(`${i.feature} ${i.title}`)} | ${cell(where)} | ${cell(state)} | ${cell(conflictText(i))} | ${cell(info || "—")} |`);
  });
  lines.push("");
  lines.push("图例：顺序 = 已进集成（跳过）→ 无冲突 → 有冲突（union 文件优先）→ 未能试合 → 未完成 → 无法合并。「未能试合」= 没有得到试合结果（沙箱建不起来 / 超时 / 出错），不等于有冲突，也不等于无冲突。");
  lines.push("决定：并入 = 本次合入；顺延 = 不合，功能卡改到下一版并记 rolled_from；等它 = 本次不合也不顺延，本版先不收尾（不打 tag），等它好了重新预演再执行；不并 = 不合、改为未预约；待定 = 还没决定（「未能试合」的默认），执行时跳过、不并入也不顺延、留在本版，本版先不收尾。");
  lines.push("");
  return lines.join("\n");
}

/* ───────────── 刷新：保留用户改过的决定 ───────────── */

/**
 * 用新预演结果刷新旧合并单：同一项（卡号+仓库+分支）若旧 decision ≠ 旧 default_decision（用户改过），保留旧 decision。
 * 执行记录、refs_moved、ledger_changes、发布说明原样保留（「等它」后的第二次执行要接着记）。
 */
export function mergeWithPrevious(fresh: ReleasePlan, old: ReleasePlan | null): { plan: ReleasePlan; kept: number } {
  if (!old) return { plan: fresh, kept: 0 };
  const prev = new Map(old.items.map((i) => [itemKey(i), i]));
  let kept = 0;
  for (const it of fresh.items) {
    const o = prev.get(itemKey(it));
    if (!o) continue;
    if (o.decision !== o.default_decision && it.state !== "已进集成") {
      it.decision = o.decision;
      kept++;
    }
  }
  return {
    plan: {
      ...fresh,
      created: old.created || fresh.created,
      executed_at: old.executed_at,
      milestone_status_before: old.milestone_status_before,
      refs_moved: old.refs_moved,
      ledger_changes: old.ledger_changes,
      resolver_cost_usd: old.resolver_cost_usd,
      tail: old.tail,
    },
    kept,
  };
}

/** 在正文「## 执行记录」下追加若干行（没有该节则新建在发布说明之前） */
export function appendExecLog(p: ReleasePlan, lines: string[]): void {
  if (!lines.length) return;
  const block = lines.map((l) => (l.startsWith("- ") || l.startsWith("  ") || l.startsWith("### ") ? l : `- ${l}`)).join("\n");
  const t = p.tail;
  const execIdx = t.indexOf(EXEC_HEADING);
  const notesIdx = t.indexOf(NOTES_HEADING);
  if (execIdx < 0) {
    const section = `${EXEC_HEADING}\n${block}\n`;
    p.tail = notesIdx >= 0 ? `${t.slice(0, notesIdx)}${section}\n${t.slice(notesIdx)}` : `${t}${t && !t.endsWith("\n") ? "\n" : ""}${t ? "\n" : ""}${section}`;
    return;
  }
  const end = notesIdx > execIdx ? notesIdx : t.length;
  const head = t.slice(0, end).replace(/\s+$/, "");
  p.tail = `${head}\n${block}\n${end < t.length ? `\n${t.slice(end)}` : ""}`;
}

/** 写入/替换「## 发布说明」节 */
export function setReleaseNotes(p: ReleasePlan, notes: string): void {
  const t = p.tail;
  const idx = t.indexOf(NOTES_HEADING);
  const base = (idx >= 0 ? t.slice(0, idx) : t).replace(/\s+$/, "");
  p.tail = `${base}${base ? "\n\n" : ""}${NOTES_HEADING}\n${notes.trim()}\n`;
}
