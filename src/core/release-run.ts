/**
 * M4 执行：release run / rollback。全项目唯一会写被管理仓库的地方，所有写操作经 runGitWrite（审计 + 沙箱 + 白名单）。
 *
 * run：
 *  0. 安全闸：每个要写的仓库，集成分支当前 sha == 合并单 base_sha（否则整体中止，提示重新预演）；
 *     集成分支（--to-main 时含主线）若在某个 worktree 里检出则中止（移动引用会让那个目录看起来「有改动」）；tag 已存在则中止。
 *  1. 逐项（按合并单顺序）：
 *     无冲突 → merge-tree --write-tree → commit-tree -p <集成> -p <分支> → update-ref <集成> <新> <旧>（不需要工作树）；
 *     有冲突 → ~/.cache/heliu/worktrees/<项目>/<里程碑>/<仓库> 里 worktree add --detach → merge --no-commit →
 *              union 文件 merge-file（新日期在前）→ 其余交解冲突子代理 → 校验无残留标记、未动无冲突文件 → commit → update-ref。
 *     有 checks 时在临时 worktree 里跑，失败该项记「失败·待处理」（不移动引用）。
 *     每次 update-ref 先把 {ref, old, new} 记进合并单再执行（中断后 rollback 也能判断）。
 *  2. 收尾（没有「等它」/未执行项时）：每个仓库 tag -a <里程碑>；--to-main 时能快进才 update-ref 主线；
 *     顺延 / 失败的功能卡 → 下一版并记 rolled_from；里程碑 → 已发布；合并单末尾写发布说明。绝不 push。
 * rollback：按 refs_moved 逆序把引用指回旧值（校验当前值 == 新值），tag -d 只删自己打的；台账改动逆序恢复。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { lines, runGit, runGitWrite, sandboxAvailable, wrapInSandbox, type GitResult, type WritePolicy } from "./git.ts";
import { Ledger } from "./ledger.ts";
import { heliuCacheDir } from "./paths.ts";
import type { ProjectConfig, RepoConfig } from "./project.ts";
import {
  appendExecLog,
  auditFile,
  loadPlan,
  resultText,
  savePlan,
  setReleaseNotes,
  type CheckRecord,
  type PlanItem,
  type PlanRepo,
  type ReleasePlan,
  type ResolverRecord,
} from "./release-plan.ts";
import { isUnionFile, ReleaseError, resolveReleaseMilestone, stamp } from "./release.ts";
import { runResolver } from "./resolver.ts";
import { hasConflictMarkers, LABEL_BASE, LABEL_OURS, LABEL_THEIRS, UNION_MARKER_SIZE, unionFromMarkers } from "./union.ts";

export type AskFn = (question: string, choices: Array<{ key: string; label: string }>, def: string) => Promise<string>;

export interface RehearsalOptions {
  /** 真实仓库（根目录与 common dir）：演练期间沙箱里一律禁止写入 */
  protect: string[];
  /** 演练用的临时 worktree 根（放在演练目录里，不与真实执行混用） */
  worktreeRoot: string;
}

export interface RunOptions {
  dryRun?: boolean;
  yes?: boolean;
  toMain?: boolean;
  /** 集成分支/主线在某个 worktree 里检出时仍继续（那个目录会显示为有改动，需你自己同步） */
  allowCheckedOut?: boolean;
  ask?: AskFn;
  log?: (line: string) => void;
  now?: () => Date;
  /** 解冲突器本次运行的总预算（美元），默认 HELIU_RESOLVER_TOTAL_BUDGET 或 10 */
  resolverBudgetUsd?: number;
  rehearsal?: RehearsalOptions;
}

export interface RunReport {
  plan: ReleasePlan;
  milestone: string;
  dryRun: boolean;
  /** 中止原因（安全闸未过；此时没有写任何东西） */
  aborted: string[];
  finalized: boolean;
  stopped: boolean;
  merged: PlanItem[];
  alreadyIn: PlanItem[];
  failed: PlanItem[];
  waiting: PlanItem[];
  unrehearsed: PlanItem[];
  rolled: Array<{ feature: string; title: string; to: string; reason: string }>;
  dropped: Array<{ feature: string; title: string }>;
  tags: Array<{ repo: string; label: string; tag: string; sha: string; target: string }>;
  tagErrors: string[];
  mainMoved: Array<{ repo: string; label: string; from: string; to: string }>;
  mainSkipped: Array<{ repo: string; label: string; reason: string }>;
  unpushed: string[];
  costUsd: number;
  elapsedMs: number;
  /** --dry-run 时的逐项说明 */
  dryRunLines: string[];
  warnings: string[];
}

interface RepoRun {
  cfg: RepoConfig;
  pr: PlanRepo;
  root: string;
  commonDir: string;
  integRef: string;
  cur: string;
  wtPath: string;
  wt: string | null;
  policy: WritePolicy;
  allowRefs: string[];
  env: Record<string, string>;
}

const short = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");
const READ_TIMEOUT = 60_000;

function nextMilestoneName(ledger: Ledger, current: string): string {
  const m = ledger.listMilestones().find((x) => x.status === "规划中" && x.id !== current);
  return m ? m.id : "新建的 vNext";
}

/** 读 worktree list --porcelain：分支 → 检出目录 */
async function checkedOut(root: string, protect: string[]): Promise<Map<string, string>> {
  const r = await runGit(root, ["worktree", "list", "--porcelain"], { timeoutMs: READ_TIMEOUT, protect });
  const out = new Map<string, string>();
  if (!r.ok) return out;
  let path = "";
  for (const l of lines(r.stdout)) {
    if (l.startsWith("worktree ")) path = l.slice(9);
    else if (l.startsWith("branch ")) out.set(l.slice(7), path);
  }
  return out;
}

async function revParse(cwd: string, rev: string, protect: string[]): Promise<string | null> {
  const r = await runGit(cwd, ["rev-parse", "--verify", "-q", rev], { timeoutMs: READ_TIMEOUT, protect });
  return r.ok ? (lines(r.stdout)[0] ?? null) : null;
}

export async function runRelease(project: ProjectConfig, ref: string, opts: RunOptions = {}): Promise<RunReport> {
  const t0 = performance.now();
  const now = () => (opts.now ? opts.now() : new Date());
  const log = opts.log ?? (() => undefined);
  const ledger = Ledger.of(project);
  const m = resolveReleaseMilestone(ledger, ref);
  const loaded = loadPlan(ledger.dir, m.id);
  if (!loaded) throw new ReleaseError(`还没有 ${m.id} 的合并单：先 heliu 合并 ${m.id} --预演`);
  const plan: ReleasePlan = loaded;
  if (plan.status === "已发布") throw new ReleaseError(`${m.id} 已发布（${plan.finalized_at ?? ""}）。要重来先 heliu 回滚 ${m.id}`);
  const cacheRoot = heliuCacheDir();
  const auditLog = auditFile(ledger.dir, m.id);
  const rehearsal = opts.rehearsal ?? null;
  if (rehearsal && !sandboxAvailable()) throw new ReleaseError("演练必须在写保护沙箱里进行（sandbox-exec 不可用）：否则 git 会刷新真实对象库里已有对象的 mtime，无法保证真仓库零写入");
  const budget = opts.resolverBudgetUsd ?? Number(process.env.HELIU_RESOLVER_TOTAL_BUDGET || 10);
  const report: RunReport = {
    plan, milestone: m.id, dryRun: !!opts.dryRun, aborted: [], finalized: false, stopped: false,
    merged: [], alreadyIn: [], failed: [], waiting: [], unrehearsed: [], rolled: [], dropped: [], tags: [], tagErrors: [],
    mainMoved: [], mainSkipped: [], unpushed: [], costUsd: 0, elapsedMs: 0, dryRunLines: [], warnings: [],
  };
  const cfgById = new Map(project.repos.map((r) => [r.id, r]));
  const releaseStates = new Set(["已进集成", "无冲突", "有冲突", "未完成"]);
  const tagRepoIds = [...new Set(plan.items.filter((i) => i.decision === "并入" && i.repo && cfgById.has(i.repo) && releaseStates.has(i.state)).map((i) => i.repo as string))];

  // 所有被管理仓库的根与 common dir（沙箱 deny）
  const repoRoots: Array<{ id: string; root: string; common: string }> = [];
  for (const r of project.repos) {
    const rp = await runGit(r.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: READ_TIMEOUT, protect: [r.path] });
    repoRoots.push({ id: r.id, root: r.path, common: rp.ok ? (lines(rp.stdout)[0] ?? join(r.path, ".git")) : join(r.path, ".git") });
  }
  const denyAll = [...(rehearsal?.protect ?? []), ...repoRoots.map((x) => x.root), ...repoRoots.map((x) => x.common)];
  const readProtect = denyAll;

  // 安全闸
  const runs = new Map<string, RepoRun>();
  if (plan.status === "执行中") report.warnings.push(`上次执行似乎意外中断（合并单状态仍是「执行中」）；已移动的引用都记在 refs_moved，可 heliu 回滚 ${m.id}`);
  for (const id of tagRepoIds) {
    const cfg = cfgById.get(id) as RepoConfig;
    const pr = plan.repos.find((r) => r.repo === id);
    const label = cfg.label;
    if (!pr?.integration_branch || !pr.base_sha) {
      report.aborted.push(`${label}：合并单里没有集成分支/base_sha，请重新预演`);
      continue;
    }
    const rr = repoRoots.find((x) => x.id === id) as { root: string; common: string };
    const integRef = `refs/heads/${pr.integration_branch}`;
    const cur = await revParse(cfg.path, `${integRef}^{commit}`, readProtect);
    if (!cur) {
      report.aborted.push(`${label}：集成分支 ${pr.integration_branch} 不存在`);
      continue;
    }
    if (cur !== pr.base_sha) {
      report.aborted.push(`${label}：集成分支 ${pr.integration_branch} 在预演后动过（预演时 ${short(pr.base_sha)}，现在 ${short(cur)}），请重新 heliu 合并 ${m.id} --预演`);
      continue;
    }
    const co = await checkedOut(cfg.path, readProtect);
    const watch = [integRef, ...(opts.toMain ? [`refs/heads/${cfg.main}`] : [])];
    for (const w of watch) {
      const where = co.get(w);
      if (!where) continue;
      const msg = `${label}：${w.replace("refs/heads/", "")} 正在 ${where} 里检出；heliu 移动这个引用后，那个目录会显示为「有改动」（其实是落后），heliu 不替你改工作目录`;
      if (opts.allowCheckedOut) report.warnings.push(`${msg}。已按 --allow-checked-out 继续，之后请在该目录自行同步（如 git merge --ff-only 或 git reset --keep）`);
      else report.aborted.push(`${msg}。请先在该目录切到别的分支，或加 --allow-checked-out 继续`);
    }
    if (await revParse(cfg.path, `refs/tags/${m.id}`, readProtect)) report.aborted.push(`${label}：tag ${m.id} 已存在（heliu 不覆盖已有 tag）`);
    const policy: WritePolicy = { deny: denyAll, allow: [rr.common, cacheRoot] };
    const env: Record<string, string> = { GIT_LFS_SKIP_SMUDGE: "1" };
    const name = await runGit(cfg.path, ["config", "--get", "user.name"], { timeoutMs: READ_TIMEOUT, protect: readProtect });
    const mail = await runGit(cfg.path, ["config", "--get", "user.email"], { timeoutMs: READ_TIMEOUT, protect: readProtect });
    if (!name.ok || !mail.ok || !name.stdout.trim() || !mail.stdout.trim()) {
      Object.assign(env, { GIT_AUTHOR_NAME: "heliu", GIT_AUTHOR_EMAIL: "heliu@localhost", GIT_COMMITTER_NAME: "heliu", GIT_COMMITTER_EMAIL: "heliu@localhost" });
    }
    const wtBase = rehearsal?.worktreeRoot ?? join(cacheRoot, "worktrees", project.name, m.id);
    runs.set(id, {
      cfg, pr, root: cfg.path, commonDir: rr.common, integRef, cur,
      wtPath: join(wtBase, id), wt: null, policy,
      allowRefs: [integRef, `refs/tags/${m.id}`, ...(opts.toMain ? [`refs/heads/${cfg.main}`] : [])],
      env,
    });
  }
  if (!rehearsal && !sandboxAvailable()) report.warnings.push("sandbox-exec 不可用：写操作只靠白名单约束（无操作系统级写保护）");

  if (report.aborted.length) {
    report.elapsedMs = Math.round(performance.now() - t0);
    return report;
  }

  const labelOf = (id: string | null) => (id ? (cfgById.get(id)?.label ?? id) : "—");
  if (opts.dryRun) {
    report.dryRunLines = dryRunLines(plan, project, ledger, m.id, runs, cfgById, opts);
    report.elapsedMs = Math.round(performance.now() - t0);
    return report;
  }
  if (!opts.yes && !opts.ask) throw new ReleaseError("执行需要逐条确认：请在终端里运行，或确认合并单后加 --yes");

  // 开始执行：里程碑 → 合并中（「下一版」随之指向后一个规划中的版本）
  mkdirSync(dirname(auditLog), { recursive: true });
  plan.status = "执行中";
  plan.executed_at = plan.executed_at ?? stamp(now());
  plan.milestone_status_before = plan.milestone_status_before ?? m.status;
  if (m.status !== "合并中") ledger.setMilestoneStatus(m.id, "合并中");
  appendExecLog(plan, [`### ${stamp(now())} ${rehearsal ? "演练执行（克隆上）" : "执行"}${opts.yes ? "（--yes）" : ""}`]);
  savePlan(plan);

  const gw = (rr: RepoRun, cwd: string, args: string[], reason: string, extra: { okExitCodes?: number[] } = {}): Promise<GitResult> =>
    runGitWrite(cwd, args, { reason, auditLog, cacheRoot, allowRefs: rr.allowRefs, policy: rr.policy, requireSandbox: !!rehearsal, env: rr.env, okExitCodes: extra.okExitCodes });
  const rd = (cwd: string, args: string[], okExitCodes?: number[]) => runGit(cwd, args, { timeoutMs: READ_TIMEOUT, protect: [...readProtect, cwd], okExitCodes });

  const removeWorktree = async (rr: RepoRun): Promise<void> => {
    if (!existsSync(rr.wtPath) && !rr.wt) return;
    const r = await gw(rr, rr.root, ["worktree", "remove", "--force", rr.wtPath], "移除临时 worktree");
    if (!r.ok && existsSync(rr.wtPath)) {
      rmSync(rr.wtPath, { recursive: true, force: true });
      report.warnings.push(`${rr.cfg.label}：临时 worktree 不在 git 登记里，已直接删除目录 ${rr.wtPath}（仓库里可能留下一条可 prune 的登记，heliu hygiene 会报）`);
    }
    rr.wt = null;
  };

  const removeStrays = async (rr: RepoRun): Promise<string[]> => {
    if (!rr.wt) return [];
    const st = await rd(rr.wt, ["status", "--porcelain", "--untracked-files=all"]);
    const strays = lines(st.stdout).filter((l) => l.startsWith("?? ")).map((l) => l.slice(3));
    for (const f of strays) rmSync(join(rr.wt, f), { recursive: true, force: true });
    return strays;
  };

  const ensureWorktree = async (rr: RepoRun, at: string): Promise<void> => {
    if (!rr.wt) {
      if (existsSync(rr.wtPath)) {
        log(`  发现上次中断留下的临时 worktree，先清理：${rr.wtPath}`);
        await removeWorktree(rr);
      }
      mkdirSync(dirname(rr.wtPath), { recursive: true });
      log(`  建临时 worktree：${rr.wtPath}`);
      const r = await gw(rr, rr.root, ["worktree", "add", "--detach", "-q", rr.wtPath, at], "建临时 worktree（解冲突 / checks）");
      if (!r.ok) throw new ReleaseError(`${rr.cfg.label}：建临时 worktree 失败：${r.stderr.trim().split("\n").slice(-1)[0]}`);
      rr.wt = rr.wtPath;
      return;
    }
    const r = await gw(rr, rr.wt, ["reset", "--hard", "-q", at], "临时 worktree 对齐");
    if (!r.ok) throw new ReleaseError(`${rr.cfg.label}：临时 worktree 对齐失败：${r.stderr.trim()}`);
    await removeStrays(rr);
  };

  const moveRef = async (rr: RepoRun, refName: string, nv: string, ov: string, note: string): Promise<boolean> => {
    plan.refs_moved.push({ repo: rr.cfg.id, ref: refName, old: ov, new: nv, time: new Date().toISOString(), note });
    savePlan(plan); // 先记再动
    const r = await gw(rr, rr.root, ["update-ref", "-m", `heliu release ${m.id}: ${note}`, refName, nv, ov], note);
    if (!r.ok) {
      plan.refs_moved.pop();
      savePlan(plan);
      return false;
    }
    return true;
  };

  const runChecks = async (rr: RepoRun, it: PlanItem): Promise<boolean> => {
    const checks = project.checks ?? [];
    if (!checks.length || !rr.wt) return true;
    it.checks = [];
    for (const cmd of checks) {
      const started = performance.now();
      const { cmd: full } = wrapInSandbox(["/bin/sh", "-c", cmd], rr.policy);
      let rec: CheckRecord;
      try {
        const p = Bun.spawn({ cmd: full, cwd: rr.wt, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, ...rr.env } as Record<string, string> });
        const timeoutMs = Number(process.env.HELIU_CHECK_TIMEOUT_MS || 10 * 60_000);
        let timer: ReturnType<typeof setTimeout> | undefined;
        const res = await Promise.race([
          (async () => {
            const [o, e] = await Promise.all([new Response(p.stdout as ReadableStream).text(), new Response(p.stderr as ReadableStream).text()]);
            return { code: await p.exited, out: `${o}${e}` };
          })(),
          new Promise<"timeout">((r) => (timer = setTimeout(() => r("timeout"), timeoutMs))),
        ]);
        if (timer) clearTimeout(timer);
        if (res === "timeout") {
          p.kill("SIGKILL");
          rec = { cmd, ok: false, code: null, ms: Math.round(performance.now() - started), tail: `超时（${timeoutMs}ms）` };
        } else {
          rec = { cmd, ok: res.code === 0, code: res.code, ms: Math.round(performance.now() - started), tail: res.out.trim().split("\n").slice(-8).join("\n") };
        }
      } catch (e) {
        rec = { cmd, ok: false, code: null, ms: 0, tail: String(e) };
      }
      it.checks.push(rec);
      log(`    检查 ${cmd} → ${rec.ok ? "通过" : `失败（退出码 ${rec.code ?? "—"}）`}`);
      if (!rec.ok) return false;
    }
    return true;
  };

  const fail = async (rr: RepoRun | null, it: PlanItem, reason: string): Promise<void> => {
    it.result = "失败·待处理";
    it.result_detail = reason;
    log(`  ✗ ${it.feature} 失败·待处理：${reason}`);
    if (rr?.wt) {
      await gw(rr, rr.wt, ["reset", "--hard", "-q", rr.cur], "失败后清理临时 worktree");
      await removeStrays(rr);
    }
  };

  const listUnmerged = async (wt: string): Promise<string[]> => lines((await rd(wt, ["diff", "--name-only", "--diff-filter=U"])).stdout).filter(Boolean);
  const stagedRaw = async (wt: string): Promise<Map<string, string>> => {
    const r = await rd(wt, ["diff", "--cached", "--raw", "--no-renames", "--no-abbrev"]);
    const out = new Map<string, string>();
    for (const l of lines(r.stdout)) {
      const tab = l.indexOf("\t");
      if (tab < 0) continue;
      const meta = l.slice(0, tab).split(" ");
      out.set(l.slice(tab + 1), `${meta[4] ?? ""}:${meta[3] ?? ""}`);
    }
    return out;
  };

  const unionResolve = async (rr: RepoRun, file: string): Promise<{ ok: boolean; sorted: number; reason?: string }> => {
    const wt = rr.wt as string;
    const [base, ours, theirs] = await Promise.all([1, 2, 3].map((n) => rd(wt, ["cat-file", "-p", `:${n}:${file}`])));
    if (!ours?.ok || !theirs?.ok) return { ok: false, sorted: 0, reason: "不是双方修改的冲突（如一方删除）" };
    const texts = [ours.stdout, base?.ok ? base.stdout : "", theirs.stdout];
    if (texts.some((t) => t.includes("\u0000"))) return { ok: false, sorted: 0, reason: "二进制文件" };
    mkdirSync(join(cacheRoot, "tmp"), { recursive: true });
    const tmp = mkdtempSync(join(cacheRoot, "tmp", "union-"));
    try {
      const [o, b, t] = ["ours", "base", "theirs"].map((n) => join(tmp, n));
      writeFileSync(o as string, texts[0] as string);
      writeFileSync(b as string, texts[1] as string);
      writeFileSync(t as string, texts[2] as string);
      const sort = project.unionSortByDate !== false;
      const labels = ["-L", LABEL_OURS, "-L", LABEL_BASE, "-L", LABEL_THEIRS];
      const args = sort
        ? ["merge-file", "-p", `--marker-size=${UNION_MARKER_SIZE}`, ...labels, o as string, b as string, t as string]
        : ["merge-file", "-p", "--union", ...labels, o as string, b as string, t as string];
      const okCodes = Array.from({ length: 127 }, (_, k) => k + 1);
      const r = await gw(rr, wt, args, `union 合并 ${file}`, { okExitCodes: okCodes });
      if (!r.ok) return { ok: false, sorted: 0, reason: `merge-file 失败：${r.stderr.trim()}` };
      let text = r.stdout;
      let sorted = 0;
      if (sort) {
        const u = unionFromMarkers(r.stdout, { sortByDate: true });
        text = u.text;
        sorted = u.sorted;
      }
      if (hasConflictMarkers(text) && !hasConflictMarkers(texts[0] as string) && !hasConflictMarkers(texts[2] as string)) {
        return { ok: false, sorted: 0, reason: "union 结果仍有冲突标记" };
      }
      writeFileSync(join(wt, file), text);
      const a = await gw(rr, wt, ["add", "--", file], `union 文件 git add ${file}`);
      if (!a.ok) return { ok: false, sorted: 0, reason: `git add 失败：${a.stderr.trim()}` };
      return { ok: true, sorted };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  };

  const mergeOne = async (rr: RepoRun, it: PlanItem): Promise<void> => {
    const target = it.branch_sha;
    if (!target) return fail(rr, it, "合并单里没有分支提交，请重新预演");
    if (!(await revParse(rr.root, `${target}^{commit}`, readProtect))) return fail(rr, it, `预演时的提交 ${short(target)} 已不存在（分支被改写？），请重新预演`);
    const tip = it.branch ? await revParse(rr.root, `refs/heads/${it.branch}`, readProtect) : null;
    const drift = tip && tip !== target ? `分支在预演后又有新提交（现在 ${short(tip)}），本次只合入预演时的 ${short(target)}` : null;
    const anc = await rd(rr.root, ["merge-base", "--is-ancestor", target, rr.cur], [1]);
    if (anc.ok && anc.code === 0) {
      it.result = "已在集成";
      it.result_detail = "执行时发现已被集成分支包含";
      return;
    }
    const subject = `合并 ${it.feature}「${it.title}」（${it.branch}）`;
    const firstCommit = lines((await rd(rr.root, ["log", "--reverse", "--no-merges", "--format=%s", `${rr.cur}..${target}`, "--"])).stdout)[0] ?? null;
    const msg = (extra: string[]) => ["-m", subject, "-m", [`heliu release ${m.id}：按合并单合入集成分支 ${rr.pr.integration_branch}。`, ...extra].join("\n")];
    const mt = await gw(rr, rr.root, ["merge-tree", "--write-tree", "--name-only", "--no-messages", rr.cur, target], `试合 ${it.feature}`, { okExitCodes: [1] });
    if (!mt.ok) return fail(rr, it, `merge-tree 失败：${mt.stderr.trim().split("\n")[0] ?? ""}`);
    const out = lines(mt.stdout);
    const old = rr.cur;
    if (mt.code === 0) {
      log(`  无冲突：纯对象库合并`);
      const ct = await gw(rr, rr.root, ["commit-tree", out[0] as string, "-p", rr.cur, "-p", target, ...msg([])], `合并提交 ${it.feature}`);
      const nv = lines(ct.stdout)[0];
      if (!ct.ok || !nv) return fail(rr, it, `commit-tree 失败：${ct.stderr.trim()}`);
      if ((project.checks ?? []).length) {
        await ensureWorktree(rr, nv);
        if (!(await runChecks(rr, it))) return fail(rr, it, `检查失败：${it.checks?.find((c) => !c.ok)?.cmd ?? ""}`);
      }
      if (!(await moveRef(rr, rr.integRef, nv, old, `合入 ${it.feature}`))) return fail(rr, it, "update-ref 失败（集成分支被并发改动？）");
      rr.cur = nv;
      Object.assign(it, { result: "已合入", old_sha: old, new_sha: nv, result_detail: drift });
      log(`  ✓ 已合入 → ${short(nv)}`);
      return;
    }
    // 有冲突：临时 worktree
    const conflicts = out.slice(1).filter(Boolean);
    log(`  有冲突（${conflicts.join("、")}）：在临时 worktree 里合并`);
    await ensureWorktree(rr, rr.cur);
    const wt = rr.wt as string;
    const mg = await gw(rr, wt, ["merge", "--no-commit", "--no-ff", "-q", target], `merge ${it.feature}（有冲突）`, { okExitCodes: [1] });
    if (!mg.ok) return fail(rr, it, `git merge 失败：${mg.stderr.trim().split("\n").slice(-1)[0] ?? ""}`);
    let unmerged = await listUnmerged(wt);
    const before = await stagedRaw(wt);
    const unionDone: string[] = [];
    const notes: string[] = [];
    let sortedHunks = 0;
    for (const f of unmerged.filter((x) => isUnionFile(project, x))) {
      const r = await unionResolve(rr, f);
      if (r.ok) {
        unionDone.push(f);
        sortedHunks += r.sorted;
      } else notes.push(`union ${f} 未处理（${r.reason}），交给解冲突器`);
    }
    if (unionDone.length) log(`  union：${unionDone.join("、")}${sortedHunks ? `（${sortedHunks} 处按新日期在前排序）` : ""}`);
    unmerged = await listUnmerged(wt);
    let resolver: ResolverRecord | null = null;
    if (unmerged.length) {
      resolver = { files: [...unmerged], rounds: 0, turns: 0, cost_usd: 0, ok: false, summary: "" };
      const mb = lines((await rd(rr.root, ["merge-base", rr.cur, target])).stdout)[0];
      const recent = mb ? lines((await rd(rr.root, ["log", "-3", "--no-merges", "--format=%s", `${mb}..${rr.cur}`, "--", ...unmerged])).stdout) : [];
      for (let round = 1; round <= 2 && unmerged.length; round++) {
        if (report.costUsd >= budget) {
          notes.push(`解冲突器预算用完（本次已花 $${report.costUsd.toFixed(2)} ≥ $${budget}）`);
          break;
        }
        log(`  解冲突器第 ${round} 轮：${unmerged.join("、")}`);
        const r = await runResolver({
          cwd: wt,
          files: unmerged,
          milestone: m.id,
          integration: { branch: rr.pr.integration_branch as string, recent },
          incoming: { feature: it.feature, title: it.title, branch: it.branch ?? "", firstCommit },
          round,
          policy: rr.policy,
        });
        resolver.rounds = round;
        resolver.turns = (resolver.turns ?? 0) + (r.turns ?? 0);
        resolver.cost_usd += r.costUsd;
        report.costUsd += r.costUsd;
        plan.resolver_cost_usd += r.costUsd;
        resolver.summary = (r.summary || r.error || "").slice(0, 1200);
        log(`    ${r.ok ? "完成" : "失败"} · $${r.costUsd.toFixed(2)}${r.turns !== null ? ` · ${r.turns} 步` : ""}${r.error ? ` · ${r.error}` : ""}`);
        if (r.authFailed) {
          notes.push(r.error ?? "解冲突器无法登录");
          break;
        }
        unmerged = await listUnmerged(wt);
        // 已 add 但仍带标记的也算没解完
        for (const f of resolver.files) if (!unmerged.includes(f) && existsSync(join(wt, f)) && hasConflictMarkers(readFileSync(join(wt, f), "utf8"))) unmerged.push(f);
      }
      resolver.ok = unmerged.length === 0;
      it.resolver = resolver;
      if (unmerged.length) return fail(rr, it, `仍有冲突未解决：${unmerged.join("、")}${notes.length ? `；${notes.join("；")}` : ""}`);
    }
    const marked = conflicts.filter((f) => existsSync(join(wt, f)) && hasConflictMarkers(readFileSync(join(wt, f), "utf8")));
    if (marked.length) return fail(rr, it, `解完仍有冲突标记：${marked.join("、")}`);
    // 解冲突器不得改动无冲突的文件
    const after = await stagedRaw(wt);
    const touched: string[] = [];
    for (const [p, v] of after) if (!conflicts.includes(p) && before.get(p) !== v) touched.push(p);
    for (const p of before.keys()) if (!conflicts.includes(p) && !after.has(p)) touched.push(p);
    if (touched.length) return fail(rr, it, `解冲突器改动了无冲突的文件：${touched.slice(0, 5).join("、")}${touched.length > 5 ? ` 等 ${touched.length} 个` : ""}`);
    const unstaged = lines((await rd(wt, ["diff", "--name-only"])).stdout).filter(Boolean);
    if (unstaged.length) {
      await gw(rr, wt, ["checkout", "--", ...unstaged], "丢弃未暂存的改动");
      notes.push(`丢弃未暂存改动 ${unstaged.length} 个`);
    }
    const strays = await removeStrays(rr);
    if (strays.length) notes.push(`清掉未跟踪文件 ${strays.length} 个`);
    if (!(await runChecks(rr, it))) return fail(rr, it, `检查失败：${it.checks?.find((c) => !c.ok)?.cmd ?? ""}`);
    const how = [
      unionDone.length ? `union：${unionDone.join("、")}${sortedHunks ? `（${sortedHunks} 处新日期在前）` : ""}` : null,
      resolver ? `解冲突器（${resolver.rounds} 轮，$${resolver.cost_usd.toFixed(2)}）：${resolver.files.join("、")}` : null,
    ].filter((x): x is string => !!x);
    const cm = await gw(rr, wt, ["commit", "-q", ...msg(how.map((h) => `冲突处理：${h}`))], `提交合并 ${it.feature}`);
    if (!cm.ok) return fail(rr, it, `commit 失败：${cm.stderr.trim()}`);
    const nv = await revParse(wt, "HEAD", readProtect);
    if (!nv) return fail(rr, it, "读不到合并提交");
    if (!(await moveRef(rr, rr.integRef, nv, old, `合入 ${it.feature}（解冲突）`))) return fail(rr, it, "update-ref 失败（集成分支被并发改动？）");
    rr.cur = nv;
    Object.assign(it, { result: "已合入", old_sha: old, new_sha: nv, union_resolved: unionDone, result_detail: [drift, ...notes].filter(Boolean).join("；") || null });
    log(`  ✓ 已合入 → ${short(nv)}`);
  };

  // 逐项执行
  try {
    for (let k = 0; k < plan.items.length; k++) {
      const it = plan.items[k] as PlanItem;
      if (it.decision !== "并入") continue;
      if (it.repo && !cfgById.has(it.repo)) {
        it.result = "未演练";
        continue;
      }
      if (report.stopped) {
        it.result = "未执行";
        continue;
      }
      if (it.state === "已进集成") {
        it.result = "已在集成";
        continue;
      }
      if (it.state === "无法合并" || !it.repo) {
        it.result = "失败·待处理";
        it.result_detail = it.detail ?? "无法合并";
        continue;
      }
      const rr = runs.get(it.repo);
      if (!rr) {
        it.result = "失败·待处理";
        it.result_detail = "仓库未就绪";
        continue;
      }
      const head = `#${k + 1} ${it.feature}「${it.title}」· ${labelOf(it.repo)} ${it.branch}（${it.state}${it.precheck?.conflicts.length ? `：${it.precheck.conflicts.join("、")}` : ""}）`;
      if (!opts.yes && opts.ask) {
        const a = await opts.ask(`${head} → 并入？`, [
          { key: "y", label: "并入" },
          { key: "s", label: "本次不并（顺延）" },
          { key: "w", label: "等它" },
          { key: "q", label: "停止" },
        ], "y");
        if (a === "s") {
          it.decision = "顺延";
          continue;
        }
        if (a === "w") {
          it.decision = "等它";
          continue;
        }
        if (a === "q") {
          report.stopped = true;
          it.result = "未执行";
          continue;
        }
      }
      log(head);
      await mergeOne(rr, it);
      savePlan(plan);
      if (it.result === "失败·待处理" && it.checks?.some((c) => !c.ok) && !opts.yes && opts.ask) {
        const a = await opts.ask("检查失败。跳过这一项继续（它会被顺延），还是停下来？", [
          { key: "s", label: "跳过继续" },
          { key: "q", label: "停止" },
        ], "s");
        if (a === "q") report.stopped = true;
      }
    }

    for (const it of plan.items) {
      if (it.result === "已合入") report.merged.push(it);
      else if (it.result === "已在集成") report.alreadyIn.push(it);
      else if (it.result === "失败·待处理") report.failed.push(it);
      else if (it.result === "未演练") report.unrehearsed.push(it);
      if (it.decision === "等它" || it.result === "未执行") report.waiting.push(it);
    }

    let finalize = report.waiting.length === 0;
    if (finalize && !opts.yes && opts.ask) {
      const a = await opts.ask(`全部处理完：合入 ${report.merged.length}、失败 ${report.failed.length}。打 tag ${m.id} 并把里程碑标为已发布？`, [
        { key: "y", label: "发布" },
        { key: "n", label: "先不收尾" },
      ], "y");
      finalize = a === "y";
      if (!finalize) report.stopped = true;
    }

    if (finalize) await finalizeRelease();
    else {
      plan.status = "待续";
      appendExecLog(plan, [
        `本次合入 ${report.merged.length} 项、失败 ${report.failed.length} 项；${report.waiting.length ? `还有 ${report.waiting.length} 项等它/未执行` : "你选择先不收尾"}，本版未打 tag、未改「已发布」。`,
        `等它们好了：heliu 合并 ${m.id} --预演 → heliu 合并 ${m.id}（已合入的会显示为已进集成）`,
      ]);
    }
  } finally {
    for (const rr of runs.values()) {
      try {
        await removeWorktree(rr);
      } catch (e) {
        report.warnings.push(`${rr.cfg.label}：移除临时 worktree 失败：${(e as Error).message}`);
      }
    }
    if (plan.status === "执行中") plan.status = "待续";
    plan.updated = stamp(now());
    savePlan(plan);
  }

  for (const rr of runs.values()) {
    const moved = plan.refs_moved.some((x) => x.repo === rr.cfg.id && !x.rolled_back);
    if (!moved) continue;
    const refs = [`refs/heads/${rr.pr.integration_branch}`];
    if (report.tags.some((t) => t.repo === rr.cfg.id)) refs.push(`refs/tags/${m.id}`);
    if (report.mainMoved.some((t) => t.repo === rr.cfg.id)) refs.push(`refs/heads/${rr.cfg.main}`);
    report.unpushed.push(`${rr.cfg.label}：${refs.join(" 与 ")}`);
  }
  report.elapsedMs = Math.round(performance.now() - t0);
  return report;

  async function finalizeRelease(): Promise<void> {
    const ts = stamp(now());
    const mergedIds = [...new Set(report.merged.map((i) => i.feature))];
    const deferCount = plan.items.filter((i) => i.decision === "顺延" || i.result === "失败·待处理").length;
    for (const rr of runs.values()) {
      const summary = `${m.id}：合入 ${mergedIds.length} 项${mergedIds.length ? `（${mergedIds.slice(0, 12).join("、")}${mergedIds.length > 12 ? " 等" : ""}）` : ""}；顺延 ${deferCount} 项。heliu release 于 ${ts}`;
      const t = await gw(rr, rr.root, ["tag", "-a", m.id, "-m", summary, rr.cur], `打 tag ${m.id}`);
      if (!t.ok) {
        report.tagErrors.push(`${rr.cfg.label}：tag 失败：${t.stderr.trim()}`);
        continue;
      }
      const sha = (await revParse(rr.root, `refs/tags/${m.id}`, readProtect)) ?? "";
      plan.refs_moved.push({ repo: rr.cfg.id, ref: `refs/tags/${m.id}`, old: null, new: sha, time: new Date().toISOString(), note: `打 tag（指向 ${short(rr.cur)}）` });
      report.tags.push({ repo: rr.cfg.id, label: rr.cfg.label, tag: m.id, sha, target: rr.cur });
      savePlan(plan);
      if (opts.toMain) {
        const mainRef = `refs/heads/${rr.cfg.main}`;
        const mainSha = await revParse(rr.root, mainRef, readProtect);
        const ff = mainSha ? await rd(rr.root, ["merge-base", "--is-ancestor", mainSha, rr.cur], [1]) : null;
        if (!mainSha) report.mainSkipped.push({ repo: rr.cfg.id, label: rr.cfg.label, reason: `主线 ${rr.cfg.main} 不存在` });
        else if (mainSha === rr.cur) report.mainSkipped.push({ repo: rr.cfg.id, label: rr.cfg.label, reason: "主线已与集成分支相同" });
        else if (!ff?.ok || ff.code !== 0) {
          const ab = await rd(rr.root, ["rev-list", "--count", `${rr.cur}..${mainSha}`]);
          report.mainSkipped.push({ repo: rr.cfg.id, label: rr.cfg.label, reason: `主线有 ${lines(ab.stdout)[0] ?? "?"} 个集成分支没有的提交，不能快进；请你决定怎么并（heliu 不替你做非快进合并）` });
        } else if (await moveRef(rr, mainRef, rr.cur, mainSha, "主线快进到集成分支")) {
          report.mainMoved.push({ repo: rr.cfg.id, label: rr.cfg.label, from: mainSha, to: rr.cur });
        } else report.mainSkipped.push({ repo: rr.cfg.id, label: rr.cfg.label, reason: "update-ref 失败" });
      }
    }
    applyLedger();
    ledger.setMilestoneStatus(m.id, "已发布");
    plan.status = "已发布";
    plan.finalized_at = ts;
    report.finalized = true;
    setReleaseNotes(plan, releaseNotes(ts));
    appendExecLog(plan, [`已发布：合入 ${report.merged.length}、已在集成 ${report.alreadyIn.length}、失败 ${report.failed.length}、顺延 ${report.rolled.length}；解冲突器花费 $${report.costUsd.toFixed(2)}`]);
  }

  function applyLedger(): void {
    const byFeature = new Map<string, PlanItem[]>();
    for (const it of plan.items) {
      if (it.repo && !cfgById.has(it.repo)) continue; // 未演练的仓库：不改台账
      const list = byFeature.get(it.feature) ?? [];
      list.push(it);
      byFeature.set(it.feature, list);
    }
    let nextId: string | null = null;
    const next = () => (nextId ??= ledger.resolveMilestone("next", { create: true })?.milestone.id ?? "vNext");
    const mainRepos = new Set(report.mainMoved.map((x) => x.repo));
    for (const [fid, its] of byFeature) {
      let f;
      try {
        f = ledger.getFeature(fid);
      } catch {
        continue;
      }
      const before = { milestone: f.milestone, rolled_from: [...f.rolled_from], status: f.status as string };
      const failed = its.filter((i) => i.result === "失败·待处理");
      const deferred = its.filter((i) => i.decision === "顺延");
      const merged = its.filter((i) => i.result === "已合入" || i.result === "已在集成");
      const dropped = its.filter((i) => i.decision === "不并");
      let patch: Parameters<Ledger["releaseUpdate"]>[1];
      let note: string;
      if (failed.length || deferred.length) {
        const to = next();
        const reason = failed.length ? `执行失败：${failed[0]?.result_detail ?? ""}` : (deferred[0]?.detail ?? "决定顺延");
        patch = { milestone: to, rolled_from: before.rolled_from.includes(m.id) ? before.rolled_from : [...before.rolled_from, m.id] };
        note = `release ${m.id}：顺延到 ${to}（${reason}）${merged.length ? `；其中 ${merged.length} 条绑定已合入` : ""}`;
        report.rolled.push({ feature: fid, title: f.title, to, reason });
      } else if (merged.length) {
        const status = merged.every((i) => i.repo && mainRepos.has(i.repo)) ? "已进主线" : "已合入";
        if (f.status === status || f.status === "已发布" || (f.status === "已进主线" && status === "已合入")) continue;
        patch = { status };
        note = `release ${m.id}：${status}（集成分支 ${merged.map((i) => short(i.new_sha ?? null)).filter((x) => x !== "—").join("、") || "已包含"}）`;
      } else if (dropped.length === its.length) {
        patch = { milestone: null };
        note = `release ${m.id}：本版不并，改为未预约`;
        report.dropped.push({ feature: fid, title: f.title });
      } else continue;
      const after = ledger.releaseUpdate(fid, patch, note, now());
      plan.ledger_changes.push({ feature: fid, from: before, to: { milestone: after.milestone, rolled_from: after.rolled_from, status: after.status }, note });
    }
  }

  function releaseNotes(ts: string): string {
    const L: string[] = [];
    const tagText = report.tags.map((t) => `${t.label} ${t.tag} → ${short(t.target)}`).join("；") || "无";
    L.push(`- 版本 ${m.id} · ${ts}${rehearsal ? " · **演练（克隆上执行）**" : ""} · tag：${tagText}（未推送）`);
    const line = (i: PlanItem) => `${i.feature} ${i.title}（${labelOf(i.repo)} \`${i.branch ?? "—"}\`${i.new_sha ? ` → ${short(i.new_sha)}` : ""}）`;
    L.push(`- 已合入（${report.merged.length}）：`);
    for (const i of report.merged) L.push(`  - ${line(i)}`);
    if (report.alreadyIn.length) {
      L.push(`- 已在集成分支（${report.alreadyIn.length}）：`);
      for (const i of report.alreadyIn) L.push(`  - ${line(i)}`);
    }
    L.push(`- 顺延（${report.rolled.length}）：`);
    for (const r of report.rolled) L.push(`  - ${r.feature} ${r.title} → ${r.to}（${r.reason}）`);
    if (report.dropped.length) {
      L.push(`- 不并、改为未预约（${report.dropped.length}）：`);
      for (const d of report.dropped) L.push(`  - ${d.feature} ${d.title}`);
    }
    if (report.unrehearsed.length) L.push(`- 未演练（非主仓库，${report.unrehearsed.length} 项）：${report.unrehearsed.map((i) => i.feature).join("、")}`);
    const conflictItems = plan.items.filter((i) => i.union_resolved?.length || i.resolver);
    L.push(`- 冲突处理（${conflictItems.length}）：`);
    for (const i of conflictItems) {
      const bits: string[] = [];
      if (i.union_resolved?.length) bits.push(`union ${i.union_resolved.join("、")}`);
      if (i.resolver) bits.push(`解冲突器 ${i.resolver.files.join("、")}（${i.resolver.rounds} 轮，$${i.resolver.cost_usd.toFixed(2)}${i.resolver.ok ? "" : "，未解完"}）${i.resolver.summary ? `：${i.resolver.summary.replace(/\s*\n\s*/g, " / ").slice(0, 300)}` : ""}`);
      L.push(`  - ${i.feature}：${bits.join("；")}${i.result !== "已合入" ? `（${resultText(i)}）` : ""}`);
    }
    L.push(`- 旧引用（可回滚：heliu 回滚 ${m.id}）：`);
    for (const mv of plan.refs_moved.filter((x) => !x.rolled_back)) L.push(`  - ${labelOf(mv.repo)} ${mv.ref}：${mv.old ? short(mv.old) : "（新建）"} → ${short(mv.new)}（${mv.note}）`);
    for (const s of report.mainSkipped) L.push(`- 主线未动（${s.label}）：${s.reason}`);
    L.push(`- 未推送：${[...runs.values()].map((rr) => `${rr.cfg.label} refs/heads/${rr.pr.integration_branch} 与 refs/tags/${m.id}`).join("；")}（按仓库规矩，推送由你决定）`);
    return L.join("\n");
  }
}

function dryRunLines(plan: ReleasePlan, project: ProjectConfig, ledger: Ledger, ms: string, runs: Map<string, RepoRun>, cfgById: Map<string, RepoConfig>, opts: RunOptions): string[] {
  const out: string[] = [];
  const next = nextMilestoneName(ledger, ms);
  for (const rr of runs.values()) out.push(`${rr.cfg.label}：集成分支 ${rr.pr.integration_branch} @${short(rr.cur)} = 合并单 base_sha ✓`);
  plan.items.forEach((i, k) => {
    const head = `#${k + 1} ${i.feature}「${i.title}」${i.repo ? ` · ${cfgById.get(i.repo)?.label ?? i.repo} ${i.branch ?? ""}` : ""}`;
    let what: string;
    if (i.decision === "并入") {
      if (i.repo && !cfgById.has(i.repo)) what = "未演练（演练只克隆主仓库）";
      else if (i.state === "已进集成") what = "跳过（已在集成分支）";
      else if (i.state === "无法合并") what = `无法合并（${i.detail ?? ""}）→ 将记失败并顺延到 ${next}`;
      else if (i.state === "无冲突") what = `纯对象库合并：merge-tree → commit-tree → update-ref${(project.checks ?? []).length ? "（先在临时 worktree 跑 checks）" : ""}`;
      else {
        const u = i.precheck?.union ?? [];
        const o = i.precheck?.other ?? [];
        what = `临时 worktree 合并：${u.length ? `union ${u.join("、")}` : ""}${u.length && o.length ? "；" : ""}${o.length ? `解冲突器 ${o.join("、")}` : ""}${!u.length && !o.length ? "执行时重新计算冲突" : ""}`;
      }
    } else if (i.decision === "顺延") what = `不合，顺延到 ${next}${i.detail ? `（${i.detail}）` : ""}`;
    else if (i.decision === "等它") what = "不合；本版先不收尾（不打 tag）";
    else what = "不合，改为未预约";
    out.push(`${head}：${what}`);
  });
  const waiting = plan.items.some((i) => i.decision === "等它");
  if (waiting) out.push(`收尾：有「等它」的项，本次不打 tag、不改「已发布」`);
  else {
    for (const rr of runs.values()) out.push(`收尾：${rr.cfg.label} tag -a ${ms}${opts.toMain ? `；主线 ${rr.cfg.main} 能快进则快进` : ""}`);
    out.push(`里程碑 ${ms} → 已发布；顺延的功能卡 → ${next}（rolled_from 记 ${ms}）`);
  }
  out.push("（--dry-run：以上都没有执行，没有移动任何引用）");
  return out;
}

/* ───────────────────────── rollback ───────────────────────── */

export interface RollbackOptions {
  yes?: boolean;
  ask?: AskFn;
  log?: (line: string) => void;
  now?: () => Date;
  allowCheckedOut?: boolean;
  rehearsal?: RehearsalOptions;
}

export interface RollbackReport {
  milestone: string;
  reverted: Array<{ repo: string; ref: string; to: string | null; action: string }>;
  skipped: Array<{ repo: string; ref: string; reason: string }>;
  conflicts: string[];
  ledgerRestored: string[];
  ledgerSkipped: string[];
  milestoneStatus: string | null;
  complete: boolean;
  nothing: boolean;
}

export async function rollbackRelease(project: ProjectConfig, ref: string, opts: RollbackOptions = {}): Promise<RollbackReport> {
  const now = () => (opts.now ? opts.now() : new Date());
  const log = opts.log ?? (() => undefined);
  const ledger = Ledger.of(project);
  const m = resolveReleaseMilestone(ledger, ref);
  const plan = loadPlan(ledger.dir, m.id);
  if (!plan) throw new ReleaseError(`没有 ${m.id} 的合并单`);
  const moves = plan.refs_moved.filter((x) => !x.rolled_back).reverse();
  const changes = plan.ledger_changes.filter((x) => !x.rolled_back).reverse();
  const rep: RollbackReport = { milestone: m.id, reverted: [], skipped: [], conflicts: [], ledgerRestored: [], ledgerSkipped: [], milestoneStatus: null, complete: false, nothing: false };
  if (!moves.length && !changes.length && plan.status !== "执行中" && plan.status !== "待续" && plan.status !== "已发布") {
    rep.nothing = true;
    rep.complete = true;
    return rep;
  }
  if (!opts.yes) {
    if (!opts.ask) throw new ReleaseError("回滚需要确认：请在终端里运行，或加 --yes");
    const a = await opts.ask(`将按合并单逆序撤回 ${moves.length} 个引用改动、恢复 ${changes.length} 张功能卡。继续？`, [
      { key: "y", label: "回滚" },
      { key: "n", label: "取消" },
    ], "n");
    if (a !== "y") throw new ReleaseError("已取消回滚");
  }
  const cacheRoot = heliuCacheDir();
  const auditLog = auditFile(ledger.dir, m.id);
  const cfgById = new Map(project.repos.map((r) => [r.id, r]));
  const roots: string[] = [...(opts.rehearsal?.protect ?? [])];
  const commons = new Map<string, string>();
  for (const r of project.repos) {
    const rp = await runGit(r.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs: READ_TIMEOUT, protect: [r.path] });
    const c = rp.ok ? (lines(rp.stdout)[0] ?? join(r.path, ".git")) : join(r.path, ".git");
    commons.set(r.id, c);
    roots.push(r.path, c);
  }
  for (const mv of moves) {
    const cfg = cfgById.get(mv.repo);
    if (!cfg) {
      rep.skipped.push({ repo: mv.repo, ref: mv.ref, reason: "项目里已没有这个仓库" });
      continue;
    }
    if (mv.ref.startsWith("refs/heads/")) {
      const co = await checkedOut(cfg.path, roots);
      const where = co.get(mv.ref);
      if (where && !opts.allowCheckedOut) {
        rep.conflicts.push(`${cfg.label}：${mv.ref} 正在 ${where} 里检出，回滚会让那个目录显示为有改动；请先切走或加 --allow-checked-out`);
        break;
      }
    }
    const policy: WritePolicy = { deny: roots, allow: [commons.get(mv.repo) as string, cacheRoot] };
    const base = { auditLog, cacheRoot, policy, requireSandbox: !!opts.rehearsal, allowRefs: [mv.ref] };
    const cur = await revParse(cfg.path, mv.ref, roots);
    const stampNow = new Date(now()).toISOString();
    if (mv.ref.startsWith("refs/tags/")) {
      if (!cur) {
        mv.rolled_back = `${stampNow} 已不存在`;
        rep.skipped.push({ repo: mv.repo, ref: mv.ref, reason: "tag 已不存在" });
        continue;
      }
      if (cur !== mv.new) {
        rep.conflicts.push(`${cfg.label}：${mv.ref} 现在指向 ${short(cur)}，不是 heliu 打的 ${short(mv.new)}，不删`);
        break;
      }
      const r = await runGitWrite(cfg.path, ["tag", "-d", mv.ref.slice("refs/tags/".length)], { ...base, reason: `回滚：删除 heliu 打的 tag` });
      if (!r.ok) {
        rep.conflicts.push(`${cfg.label}：删除 tag 失败：${r.stderr.trim()}`);
        break;
      }
      mv.rolled_back = stampNow;
      rep.reverted.push({ repo: mv.repo, ref: mv.ref, to: null, action: "删除 tag" });
      log(`  ✓ ${cfg.label} 删除 ${mv.ref}`);
      continue;
    }
    if (cur === mv.old) {
      mv.rolled_back = `${stampNow} 本来就在旧值`;
      rep.skipped.push({ repo: mv.repo, ref: mv.ref, reason: `已在旧值 ${short(mv.old)}` });
      continue;
    }
    if (cur !== mv.new || !mv.old) {
      rep.conflicts.push(`${cfg.label}：${mv.ref} 现在是 ${short(cur)}，既不是 heliu 移动后的 ${short(mv.new)} 也不是旧值 ${short(mv.old)}——之后有人动过，停止回滚`);
      break;
    }
    const r = await runGitWrite(cfg.path, ["update-ref", "-m", `heliu rollback ${m.id}`, mv.ref, mv.old, mv.new], { ...base, reason: `回滚：${mv.note}` });
    if (!r.ok) {
      rep.conflicts.push(`${cfg.label}：update-ref 失败：${r.stderr.trim()}`);
      break;
    }
    mv.rolled_back = stampNow;
    rep.reverted.push({ repo: mv.repo, ref: mv.ref, to: mv.old, action: "指回旧值" });
    log(`  ✓ ${cfg.label} ${mv.ref} ${short(mv.new)} → ${short(mv.old)}`);
    savePlan(plan);
  }
  const refsDone = !rep.conflicts.length;
  if (refsDone) {
    for (const c of changes) {
      let f;
      try {
        f = ledger.getFeature(c.feature);
      } catch {
        rep.ledgerSkipped.push(`${c.feature}：卡片已不存在`);
        continue;
      }
      const same = f.milestone === c.to.milestone && f.status === c.to.status && JSON.stringify(f.rolled_from) === JSON.stringify(c.to.rolled_from);
      if (!same) {
        rep.ledgerSkipped.push(`${c.feature}：发布后又改过，未自动恢复（原值：预约 ${c.from.milestone ?? "未预约"} · 状态 ${c.from.status}）`);
        continue;
      }
      ledger.releaseUpdate(c.feature, { milestone: c.from.milestone, rolled_from: c.from.rolled_from, status: c.from.status as never }, `rollback ${m.id}：恢复为 预约 ${c.from.milestone ?? "未预约"} · 状态 ${c.from.status}`, now());
      c.rolled_back = new Date(now()).toISOString();
      rep.ledgerRestored.push(c.feature);
    }
    const ms = ledger.findMilestone(m.id);
    if (plan.milestone_status_before && ms && ms.status !== plan.milestone_status_before) {
      ledger.setMilestoneStatus(m.id, plan.milestone_status_before as never);
      rep.milestoneStatus = plan.milestone_status_before;
    }
    plan.status = "已回滚";
    plan.rolled_back_at = stamp(now());
    plan.milestone_status_before = null;
    plan.executed_at = null;
    plan.finalized_at = null;
  }
  appendExecLog(plan, [
    `### ${stamp(now())} 回滚`,
    `撤回引用 ${rep.reverted.length} 个、跳过 ${rep.skipped.length} 个、恢复功能卡 ${rep.ledgerRestored.length} 张${rep.conflicts.length ? `；停止：${rep.conflicts.join("；")}` : ""}`,
  ]);
  plan.updated = stamp(now());
  savePlan(plan);
  rep.complete = refsDone;
  return rep;
}
