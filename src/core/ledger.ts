/**
 * 台账（承诺层，M2）：<ledger>/milestones.yaml + <ledger>/features/F-0001-<slug>.md
 *
 * 规则：
 * - 台账只存 git 里没有的东西（承诺、绑定、验收档位、顺延）；领先/落后/冲突/最后活动全由对账实时派生。
 * - 台账目录：project.yaml 的 ledger: 覆盖，否则 <主仓库>/.heliu/（主仓库 = primary 或第一个仓库）。
 * - frontmatter 用 yaml 包解析/序列化，正文原样保留；未知字段原样带回，不丢用户手改的内容。
 * - 写入一律「临时文件 + rename」原子替换；分配 F 编号时持有目录锁，防两个会话同时登记撞号。
 * - 本模块只写台账目录，不碰任何 git 对象/工作区文件。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import YAML from "yaml";
import {
  ACCEPTANCE_LEVELS,
  FEATURE_STATUSES,
  MILESTONE_STATUSES,
  type AcceptanceLevel,
  type FeatureBinding,
  type FeatureSource,
  type FeatureStatus,
  type LedgerFeature,
  type LedgerMilestone,
  type MilestoneStatus,
} from "../types.ts";
import { parseFeatureType } from "./classify.ts";
import { primaryRepo, ProjectError, type ProjectConfig } from "./project.ts";

export class LedgerError extends ProjectError {
  constructor(message: string) {
    super(message);
    this.name = "LedgerError";
  }
}

/** 「下一版」的各种说法 */
export const NEXT_ALIASES = new Set(["next", "下一版", "下个版本", "下一个版本", "下版"]);
/** 自动创建的「下一版」占位名 */
export const VNEXT = "vNext";
/** 不再计入待办的状态 */
export const DONE_STATUSES: ReadonlySet<FeatureStatus> = new Set<FeatureStatus>(["已合入", "已进主线", "已发布", "已放弃"]);

/** 台账目录 */
export function ledgerDir(project: ProjectConfig): string {
  if (project.ledger) return project.ledger;
  return join(primaryRepo(project).path, ".heliu");
}

/** 本地日期 YYYY-MM-DD */
export function today(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/** F-3 / f3 / 3 / F-0003 → F-0003；不像编号则原样返回 */
export function normalizeFeatureId(raw: string): string {
  const m = /^\s*(?:F-?)?(\d{1,6})\s*$/i.exec(raw);
  if (!m) return raw.trim();
  return `F-${String(Number(m[1])).padStart(4, "0")}`;
}

/** 文件名 slug：标题前 24 个字符（允许中文），空白与 / 换成 -（另把 \ : 也换掉，macOS Finder 不认 :） */
export function featureSlug(title: string): string {
  const head = Array.from(title.trim()).slice(0, 24).join("");
  const s = head
    .replace(/[\s/\\:]+/g, "-")
    // 去掉控制字符
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "未命名";
}

/* ───────────── frontmatter ───────────── */

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface ParsedDoc {
  data: Record<string, unknown>;
  body: string;
}

/** 拆 frontmatter；没有 frontmatter 返回 null */
export function splitFrontmatter(text: string): ParsedDoc | null {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  const m = FM_RE.exec(src);
  if (!m) return null;
  const raw = YAML.parse(m[1] ?? "") as unknown;
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return { data, body: src.slice(m[0].length) };
}

// type / module（M8）必须在这里：否则手写的 type: 会进 extras，写回时盖掉程序设的值
const KNOWN_KEYS = ["id", "title", "status", "milestone", "acceptance", "bindings", "rolled_from", "source", "type", "module", "created", "updated"];

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v).trim() || null);
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/^#/, ""));
  return Number.isFinite(n) ? n : null;
};

function parseBinding(v: unknown): FeatureBinding | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const repo = str(o.repo);
  const branch = str(o.branch);
  if (!repo || !branch) return null;
  return { repo, branch, worktree: str(o.worktree), session: str(o.session), pr: num(o.pr) };
}

/** 未知状态值原样保留（只在写入命令里校验），避免把用户手改的值抹掉 */
function asStatus(v: unknown): FeatureStatus {
  return (str(v) ?? "想法") as FeatureStatus;
}
function asAcceptance(v: unknown): AcceptanceLevel {
  return (str(v) ?? "未") as AcceptanceLevel;
}

/** frontmatter 中我们不认识的字段：写回时原样带上 */
const extrasOf = new WeakMap<LedgerFeature, Record<string, unknown>>();

export function parseFeature(text: string, file: string): LedgerFeature | null {
  let doc: ParsedDoc | null;
  try {
    doc = splitFrontmatter(text);
  } catch {
    return null;
  }
  if (!doc) return null;
  const d = doc.data;
  const id = str(d.id) ?? (/^(F-\d+)/.exec(basename(file))?.[1] ?? null);
  if (!id) return null;
  const f: LedgerFeature = {
    id,
    title: str(d.title) ?? id,
    status: asStatus(d.status),
    milestone: str(d.milestone),
    acceptance: asAcceptance(d.acceptance),
    bindings: Array.isArray(d.bindings) ? d.bindings.map(parseBinding).filter((b): b is FeatureBinding => b !== null) : [],
    rolled_from: Array.isArray(d.rolled_from) ? d.rolled_from.map((x) => String(x)) : [],
    source: (str(d.source) ?? "cli") as FeatureSource,
    type: str(d.type),
    module: str(d.module),
    created: str(d.created) ?? "",
    updated: str(d.updated) ?? "",
    body: doc.body,
    file,
  };
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) if (!KNOWN_KEYS.includes(k)) extras[k] = v;
  extrasOf.set(f, extras);
  return f;
}

export function serializeFeature(f: LedgerFeature): string {
  const fm: Record<string, unknown> = {
    id: f.id,
    title: f.title,
    status: f.status,
    milestone: f.milestone,
    acceptance: f.acceptance,
    bindings: f.bindings.map((b) => {
      const o: Record<string, unknown> = { repo: b.repo, branch: b.branch };
      if (b.worktree) o.worktree = b.worktree;
      if (b.session) o.session = b.session;
      if (b.pr !== null && b.pr !== undefined) o.pr = b.pr;
      return o;
    }),
    rolled_from: f.rolled_from,
    source: f.source,
    // 只在用户设过时才写，老卡片文件不因此改动
    ...(f.type ? { type: f.type } : {}),
    ...(f.module ? { module: f.module } : {}),
    created: f.created,
    updated: f.updated,
    ...(extrasOf.get(f) ?? {}),
  };
  const yaml = YAML.stringify(fm, { lineWidth: 0 });
  const body = f.body.startsWith("\n") || f.body === "" ? f.body : `\n${f.body}`;
  return `---\n${yaml}---\n${body}`;
}

/** 在正文末尾的「## 变更记录」下追加一行（没有该节则新建） */
export function appendChangeLog(body: string, line: string): string {
  const heading = "## 变更记录";
  const trimmed = body.replace(/\s+$/, "");
  if (trimmed.includes(heading)) return `${trimmed}\n- ${line}\n`;
  return `${trimmed}${trimmed ? "\n\n" : ""}${heading}\n- ${line}\n`;
}

/* ───────────── 文件工具 ───────────── */

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, file);
}

/** 目录锁（mkdir 原子）：最多等 3 秒；超过 30 秒的锁视为残留 */
function withLock<T>(dir: string, fn: () => T): T {
  const lock = join(dir, ".lock");
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30_000) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() - started > 3000) throw new LedgerError(`台账被占用（${lock}），请稍后重试`);
      Bun.sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/* ───────────── 里程碑 ───────────── */

const MILESTONES_HEADER =
  "# heliu 里程碑（状态：规划中 | 冻结 | 合并中 | 已发布）。顺序即排期顺序；「下一版」= 第一个「规划中」。可手工编辑。\n";

function parseMilestone(v: unknown): LedgerMilestone | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  if (!id) return null;
  return {
    id,
    title: str(o.title) ?? "",
    status: (str(o.status) ?? "规划中") as MilestoneStatus,
    target_date: str(o.target_date),
    integration_branch: str(o.integration_branch),
    notes: str(o.notes) ?? "",
  };
}

/** 版本号形式：1.2 → v1.2 */
function milestoneIdFrom(ref: string): string {
  const t = ref.trim();
  return /^\d/.test(t) ? `v${t}` : t;
}

export interface MilestoneResolution {
  milestone: LedgerMilestone;
  /** 本次新建的（vNext 或预约到不存在的版本） */
  created: boolean;
}

export interface AddFeatureInput {
  title: string;
  /** 里程碑引用：next/下一版（默认）/ v1.2 / 1.2 / null = 不预约 */
  milestone?: string | null;
  bindings?: FeatureBinding[];
  body?: string;
  source?: FeatureSource;
  status?: FeatureStatus;
  /** M8：建卡时就知道类型 / 模块（比如从星图拖进某个模块）；不给 = 推测 */
  type?: string | null;
  module?: string | null;
  now?: Date;
}

export interface LedgerLoad {
  features: LedgerFeature[];
  /** 无法解析的卡片文件 */
  broken: string[];
}

export class Ledger {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  static of(project: ProjectConfig): Ledger {
    return new Ledger(ledgerDir(project));
  }

  get featuresDir(): string {
    return join(this.dir, "features");
  }
  get milestonesFile(): string {
    return join(this.dir, "milestones.yaml");
  }

  exists(): boolean {
    return existsSync(this.milestonesFile) || existsSync(this.featuresDir);
  }

  /** 建台账目录（幂等） */
  init(): { dir: string; created: boolean } {
    const created = !this.exists();
    mkdirSync(this.featuresDir, { recursive: true });
    if (!existsSync(this.milestonesFile)) atomicWrite(this.milestonesFile, `${MILESTONES_HEADER}${YAML.stringify({ milestones: [] })}`);
    return { dir: this.dir, created };
  }

  /* 里程碑 */

  listMilestones(): LedgerMilestone[] {
    if (!existsSync(this.milestonesFile)) return [];
    let raw: unknown;
    try {
      raw = YAML.parse(readFileSync(this.milestonesFile, "utf8"));
    } catch (e) {
      throw new LedgerError(`${this.milestonesFile} 不是合法 YAML：${(e as Error).message}`);
    }
    const list = raw && typeof raw === "object" ? (raw as { milestones?: unknown }).milestones : null;
    return Array.isArray(list) ? list.map(parseMilestone).filter((m): m is LedgerMilestone => m !== null) : [];
  }

  private saveMilestones(list: LedgerMilestone[]): void {
    this.init();
    const doc = {
      milestones: list.map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        target_date: m.target_date,
        integration_branch: m.integration_branch,
        notes: m.notes,
      })),
    };
    atomicWrite(this.milestonesFile, `${MILESTONES_HEADER}${YAML.stringify(doc, { lineWidth: 0 })}`);
  }

  /** 新里程碑插在 vNext 占位之前（v1.2 应排在「下一版占位」前面），否则追加到末尾 */
  private insertMilestone(list: LedgerMilestone[], m: LedgerMilestone): LedgerMilestone[] {
    const idx = m.id.startsWith(VNEXT) ? -1 : list.findIndex((x) => x.id.startsWith(VNEXT));
    if (idx < 0) return [...list, m];
    return [...list.slice(0, idx), m, ...list.slice(idx)];
  }

  findMilestone(ref: string, list = this.listMilestones()): LedgerMilestone | null {
    const t = ref.trim();
    if (NEXT_ALIASES.has(t.toLowerCase()) || NEXT_ALIASES.has(t)) return list.find((m) => m.status === "规划中") ?? null;
    const lower = t.toLowerCase();
    return list.find((m) => m.id.toLowerCase() === lower) ?? list.find((m) => m.id.toLowerCase() === milestoneIdFrom(t).toLowerCase()) ?? null;
  }

  /**
   * 解析里程碑引用。
   * - next/下一版：第一个「规划中」；没有则（create 时）自动建 vNext。
   * - v1.2 / 1.2：已有则用；没有则（create 时）新建为「规划中」。
   * create=false 时找不到返回 null，不写盘（dry-run、查询用）。
   */
  resolveMilestone(ref: string, opts: { create: boolean; title?: string }): MilestoneResolution | null {
    const list = this.listMilestones();
    const found = this.findMilestone(ref, list);
    if (found) return { milestone: found, created: false };
    if (!opts.create) return null;
    const isNext = NEXT_ALIASES.has(ref.trim().toLowerCase()) || NEXT_ALIASES.has(ref.trim());
    let id = isNext ? VNEXT : milestoneIdFrom(ref);
    if (!id) throw new LedgerError("里程碑名不能为空");
    if (isNext) {
      let n = 2;
      while (list.some((m) => m.id === id)) id = `${VNEXT}${n++}`;
    }
    const m: LedgerMilestone = {
      id,
      title: opts.title ?? "",
      // vNext 是「下一版」的占位名，可改名：heliu milestone rename vNext v1.3
      status: "规划中",
      target_date: null,
      integration_branch: null,
      notes: "",
    };
    this.saveMilestones(this.insertMilestone(list, m));
    return { milestone: m, created: true };
  }

  addMilestone(input: { id: string; title?: string; target_date?: string | null; integration_branch?: string | null; notes?: string }): LedgerMilestone {
    const list = this.listMilestones();
    const id = milestoneIdFrom(input.id);
    if (!id) throw new LedgerError("里程碑名不能为空");
    if (NEXT_ALIASES.has(id.toLowerCase()) || NEXT_ALIASES.has(id)) throw new LedgerError(`「${input.id}」是「下一版」的别名，不能作为里程碑名`);
    if (list.some((m) => m.id.toLowerCase() === id.toLowerCase())) throw new LedgerError(`里程碑 ${id} 已存在`);
    const m: LedgerMilestone = {
      id,
      title: input.title ?? "",
      status: "规划中",
      target_date: input.target_date ?? null,
      integration_branch: input.integration_branch ?? null,
      notes: input.notes ?? "",
    };
    this.saveMilestones(this.insertMilestone(list, m));
    return m;
  }

  setMilestoneStatus(ref: string, status: MilestoneStatus): LedgerMilestone {
    if (!MILESTONE_STATUSES.includes(status)) throw new LedgerError(`里程碑状态只能是：${MILESTONE_STATUSES.join(" / ")}`);
    const list = this.listMilestones();
    const m = this.findMilestone(ref, list);
    if (!m) throw new LedgerError(`没有里程碑 ${ref}（已有：${list.map((x) => x.id).join("、") || "无"}）`);
    m.status = status;
    this.saveMilestones(list);
    return m;
  }

  freezeMilestone(ref: string): LedgerMilestone {
    return this.setMilestoneStatus(ref, "冻结");
  }

  /** 改名：同时改所有预约到它的功能卡与顺延记录 */
  renameMilestone(from: string, to: string, now = new Date()): { milestone: LedgerMilestone; features: number } {
    return withLock(this.ensureFeaturesDir(), () => {
      const list = this.listMilestones();
      const m = this.findMilestone(from, list);
      if (!m) throw new LedgerError(`没有里程碑 ${from}`);
      const newId = milestoneIdFrom(to);
      if (list.some((x) => x !== m && x.id.toLowerCase() === newId.toLowerCase())) throw new LedgerError(`里程碑 ${newId} 已存在`);
      const oldId = m.id;
      m.id = newId;
      this.saveMilestones(list);
      let n = 0;
      for (const f of this.load().features) {
        const hit = f.milestone === oldId || f.rolled_from.includes(oldId);
        if (!hit) continue;
        if (f.milestone === oldId) f.milestone = newId;
        f.rolled_from = f.rolled_from.map((x) => (x === oldId ? newId : x));
        f.updated = today(now);
        f.body = appendChangeLog(f.body, `${today(now)} 里程碑改名：${oldId} → ${newId}`);
        this.writeFeature(f);
        n++;
      }
      return { milestone: m, features: n };
    });
  }

  /* 功能卡 */

  private ensureFeaturesDir(): string {
    this.init();
    return this.featuresDir;
  }

  load(): LedgerLoad {
    const features: LedgerFeature[] = [];
    const broken: string[] = [];
    if (!existsSync(this.featuresDir)) return { features, broken };
    for (const name of readdirSync(this.featuresDir)) {
      if (!name.endsWith(".md") || name.startsWith(".")) continue;
      const file = join(this.featuresDir, name);
      try {
        const f = parseFeature(readFileSync(file, "utf8"), file);
        if (f) features.push(f);
        else broken.push(file);
      } catch {
        broken.push(file);
      }
    }
    features.sort((a, b) => a.id.localeCompare(b.id));
    return { features, broken };
  }

  listFeatures(filter: { milestone?: string | null; status?: FeatureStatus[] } = {}): LedgerFeature[] {
    let list = this.load().features;
    if (filter.milestone !== undefined) {
      if (filter.milestone === null) list = list.filter((f) => !f.milestone);
      else {
        const target = this.findMilestone(filter.milestone);
        if (!target) return [];
        list = list.filter((f) => this.effectiveMilestone(f) === target.id);
      }
    }
    if (filter.status?.length) list = list.filter((f) => filter.status!.includes(f.status));
    return list;
  }

  /** 卡片里写的是 next 时按当前「下一版」解析 */
  effectiveMilestone(f: LedgerFeature, milestones?: LedgerMilestone[]): string | null {
    if (!f.milestone) return null;
    const m = this.findMilestone(f.milestone, milestones ?? this.listMilestones());
    return m ? m.id : f.milestone;
  }

  getFeature(idRaw: string): LedgerFeature {
    const id = normalizeFeatureId(idRaw);
    const f = this.load().features.find((x) => x.id === id);
    if (!f) throw new LedgerError(`没有功能卡 ${id}（heliu feature list 查看全部）`);
    return f;
  }

  /** 按仓库 + 分支找已绑定的卡 */
  findByBinding(repo: string, branch: string, features = this.load().features): LedgerFeature | null {
    return features.find((f) => f.bindings.some((b) => b.repo === repo && b.branch === branch)) ?? null;
  }

  private writeFeature(f: LedgerFeature): void {
    atomicWrite(f.file, serializeFeature(f));
  }

  private nextId(features: LedgerFeature[]): string {
    let max = 0;
    for (const f of features) {
      const m = /^F-(\d+)$/.exec(f.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    // 同时看文件名，防止有坏卡片占着编号
    for (const name of existsSync(this.featuresDir) ? readdirSync(this.featuresDir) : []) {
      const m = /^F-(\d+)/.exec(name);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `F-${String(max + 1).padStart(4, "0")}`;
  }

  /** 预约检查：只能预约到「规划中」的里程碑 */
  private assertReservable(m: LedgerMilestone): void {
    if (m.status !== "规划中") {
      throw new LedgerError(`里程碑 ${m.id} 状态为「${m.status}」，不再接新预约；可预约到下一版（heliu 预约 <卡号> 下一版）`);
    }
  }

  addFeature(input: AddFeatureInput): { feature: LedgerFeature; milestoneCreated: LedgerMilestone | null } {
    const title = input.title.replace(/\s+/g, " ").trim();
    if (!title) throw new LedgerError("功能标题不能为空");
    const now = input.now ?? new Date();
    const dir = this.ensureFeaturesDir();
    let milestoneCreated: LedgerMilestone | null = null;
    let milestone: string | null = null;
    const ref = input.milestone === undefined ? "next" : input.milestone;
    if (ref) {
      const r = this.resolveMilestone(ref, { create: true });
      if (!r) throw new LedgerError(`无法解析里程碑 ${ref}`);
      this.assertReservable(r.milestone);
      milestone = r.milestone.id;
      if (r.created) milestoneCreated = r.milestone;
    }
    const bindings = dedupeBindings(input.bindings ?? []);
    return withLock(dir, () => {
      const existing = this.load().features;
      const id = this.nextId(existing);
      const file = join(dir, `${id}-${featureSlug(title)}.md`);
      const body = `\n${(input.body ?? title).trim()}\n\n<!-- 备注、验收证据链接写在这里；领先/落后/冲突等由 heliu 实时对账，不必手填 -->\n`;
      const f: LedgerFeature = {
        id,
        title,
        status: input.status ?? (bindings.length ? "开发中" : "想法"),
        milestone,
        acceptance: "未",
        bindings,
        rolled_from: [],
        source: input.source ?? "cli",
        type: input.type ? parseFeatureTypeOr(input.type) : null,
        module: input.module?.trim() || null,
        created: today(now),
        updated: today(now),
        body,
        file,
      };
      this.writeFeature(f);
      return { feature: f, milestoneCreated };
    });
  }

  private update(idRaw: string, now: Date, mutate: (f: LedgerFeature) => string | null): LedgerFeature {
    return withLock(this.ensureFeaturesDir(), () => {
      const f = this.getFeature(idRaw);
      const log = mutate(f);
      f.updated = today(now);
      if (log) f.body = appendChangeLog(f.body, `${today(now)} ${log}`);
      this.writeFeature(f);
      return f;
    });
  }

  /** 改预约：记录变更；目标里程碑不存在则新建（规划中） */
  reserve(idRaw: string, ref: string | null, now = new Date()): { feature: LedgerFeature; milestoneCreated: LedgerMilestone | null; from: string | null } {
    let target: string | null = null;
    let milestoneCreated: LedgerMilestone | null = null;
    if (ref && !["none", "无", "取消", "未预约"].includes(ref.trim())) {
      // 先确认卡片存在，再决定是否建里程碑
      this.getFeature(idRaw);
      const r = this.resolveMilestone(ref, { create: true });
      if (!r) throw new LedgerError(`无法解析里程碑 ${ref}`);
      this.assertReservable(r.milestone);
      target = r.milestone.id;
      if (r.created) milestoneCreated = r.milestone;
    }
    let from: string | null = null;
    const feature = this.update(idRaw, now, (f) => {
      from = f.milestone;
      if (from === target) return null;
      f.milestone = target;
      return `预约：${from ?? "未预约"} → ${target ?? "未预约"}`;
    });
    return { feature, milestoneCreated, from };
  }

  bind(idRaw: string, binding: FeatureBinding, now = new Date()): { feature: LedgerFeature; added: boolean } {
    if (!binding.repo || !binding.branch) throw new LedgerError("绑定需要仓库与分支");
    let added = false;
    const feature = this.update(idRaw, now, (f) => {
      const ex = f.bindings.find((b) => b.repo === binding.repo && b.branch === binding.branch);
      if (ex) {
        ex.worktree = binding.worktree ?? ex.worktree;
        ex.session = binding.session ?? ex.session;
        ex.pr = binding.pr ?? ex.pr;
        return null;
      }
      f.bindings.push({ ...binding });
      added = true;
      if (f.status === "想法") f.status = "开发中";
      return `绑定：${binding.repo}/${binding.branch}${binding.session ? `（会话 ${binding.session}）` : ""}`;
    });
    return { feature, added };
  }

  setStatus(idRaw: string, status: FeatureStatus, now = new Date()): LedgerFeature {
    if (!FEATURE_STATUSES.includes(status)) throw new LedgerError(`功能状态只能是：${FEATURE_STATUSES.join(" / ")}`);
    return this.update(idRaw, now, (f) => {
      if (f.status === status) return null;
      const old = f.status;
      f.status = status;
      return `状态：${old} → ${status}`;
    });
  }

  setAcceptance(idRaw: string, level: AcceptanceLevel, now = new Date()): LedgerFeature {
    if (!ACCEPTANCE_LEVELS.includes(level)) throw new LedgerError(`验收档位只能是：${ACCEPTANCE_LEVELS.join(" / ")}`);
    return this.update(idRaw, now, (f) => {
      if (f.acceptance === level) return null;
      const old = f.acceptance;
      f.acceptance = level;
      return `验收：${old} → ${level}`;
    });
  }

  /**
   * M4 合并执行专用：顺延（milestone + rolled_from）、合入后改状态、回滚时恢复原值。
   * 不做「只能预约到规划中」校验——回滚要把卡放回已冻结/合并中的版本；状态值仍校验。
   * 每次都在卡片「## 变更记录」里记一行。
   */
  releaseUpdate(
    idRaw: string,
    patch: { milestone?: string | null; rolled_from?: string[]; status?: FeatureStatus },
    log: string,
    now = new Date(),
  ): LedgerFeature {
    if (patch.status !== undefined && !FEATURE_STATUSES.includes(patch.status)) throw new LedgerError(`功能状态只能是：${FEATURE_STATUSES.join(" / ")}`);
    return this.update(idRaw, now, (f) => {
      if (patch.milestone !== undefined) f.milestone = patch.milestone;
      if (patch.rolled_from !== undefined) f.rolled_from = [...patch.rolled_from];
      if (patch.status !== undefined) f.status = patch.status;
      return log;
    });
  }

  /** M8：设类型 / 模块（null 或空串 = 清掉，回到推测） */
  classify(idRaw: string, input: { type?: string | null; module?: string | null }, now = new Date()): LedgerFeature {
    let type: string | null | undefined;
    if (input.type !== undefined) {
      if (input.type === null || !input.type.trim()) type = null;
      else {
        try {
          type = parseFeatureType(input.type);
        } catch (e) {
          throw new LedgerError((e as Error).message);
        }
      }
    }
    const module = input.module === undefined ? undefined : input.module === null || !input.module.trim() ? null : input.module.replace(/\s+/g, " ").trim();
    return this.update(idRaw, now, (f) => {
      const logs: string[] = [];
      if (type !== undefined && f.type !== type) {
        logs.push(`类型：${f.type ?? "（推测）"} → ${type ?? "（推测）"}`);
        f.type = type;
      }
      if (module !== undefined && f.module !== module) {
        logs.push(`模块：${f.module ?? "（推测）"} → ${module ?? "（推测）"}`);
        f.module = module;
      }
      return logs.length ? logs.join("；") : null;
    });
  }

  rename(idRaw: string, title: string, now = new Date()): LedgerFeature {
    const t = title.replace(/\s+/g, " ").trim();
    if (!t) throw new LedgerError("功能标题不能为空");
    return this.update(idRaw, now, (f) => {
      if (f.title === t) return null;
      const old = f.title;
      f.title = t;
      return `改名：${old} → ${t}`;
    });
  }
}

function parseFeatureTypeOr(raw: string): string {
  try {
    return parseFeatureType(raw);
  } catch (e) {
    throw new LedgerError((e as Error).message);
  }
}

/** 同仓库同分支只保留一条（后者补全前者的空字段） */
export function dedupeBindings(list: FeatureBinding[]): FeatureBinding[] {
  const out: FeatureBinding[] = [];
  for (const b of list) {
    const ex = out.find((x) => x.repo === b.repo && x.branch === b.branch);
    if (ex) {
      ex.worktree = ex.worktree ?? b.worktree;
      ex.session = ex.session ?? b.session;
      ex.pr = ex.pr ?? b.pr;
    } else out.push({ repo: b.repo, branch: b.branch, worktree: b.worktree ?? null, session: b.session ?? null, pr: b.pr ?? null });
  }
  return out;
}

/** 校验并规范化用户输入的状态/档位 */
export function parseFeatureStatus(raw: string): FeatureStatus {
  const t = raw.trim();
  if ((FEATURE_STATUSES as readonly string[]).includes(t)) return t as FeatureStatus;
  throw new LedgerError(`功能状态只能是：${FEATURE_STATUSES.join(" / ")}`);
}
export function parseAcceptance(raw: string): AcceptanceLevel {
  const t = raw.trim();
  if ((ACCEPTANCE_LEVELS as readonly string[]).includes(t)) return t as AcceptanceLevel;
  throw new LedgerError(`验收档位只能是：${ACCEPTANCE_LEVELS.join(" / ")}`);
}
