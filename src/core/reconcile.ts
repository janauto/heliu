/**
 * 对账：分支 × worktree × 桌面会话 → ReconcileReport。
 * 全程只读：git 走 git.ts 白名单；文件系统只 readdir/stat/读会话 JSON。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  type DirtyState,
  type FeatureView,
  type HygieneIssue,
  type ReconcileReport,
  type RepoCounts,
  type RepoHealth,
  type RepoReport,
  type ScanOptions,
  type SessionLink,
  type SessionRef,
  type SessionView,
  type WorktreeInfo,
} from "../types.ts";
import {
  aheadBehind,
  aheadBehindAll,
  branchesNotContaining,
  classifyMerged,
  firstUniqueSubject,
  integrationSince,
  listLocalBranches,
  listRemoteRefs,
  mergedInto,
  precheckMerge,
  refExists,
  topChangedDir,
  treeOf,
  type RawBranch,
} from "./branches.ts";
import { createObjectQuarantine, gitStats, gitVersion, lines, runGit, versionAtLeast, type RunGitOptions } from "./git.ts";
import { isRandomName, pickLabel } from "./labels.ts";
import { canonicalPath, isUnder, type HeliuPaths } from "./paths.ts";
import type { ProjectConfig, RepoConfig } from "./project.ts";
import {
  loadDesktopSessions,
  loadDesktopWorktrees,
  loadRunningSessions,
  runningFor,
  runningIndex,
  sessionStatus,
  type DesktopSession,
  type DesktopWorktree,
} from "./sessions.ts";
import { branchSlug, checkDirty, parseWorktreePorcelain, scanAdminDirs, toWorktreeInfo, type AdminDirScan } from "./worktrees.ts";

const iso = (ms: number | null | undefined): string | null => (ms ? new Date(ms).toISOString() : null);

export interface SessionContext {
  sessions: DesktopSession[];
  running: Map<string, "busy" | "idle">;
  desktopWorktrees: DesktopWorktree[];
  parseErrors: number;
  files: number;
}

export function loadSessionContext(paths: HeliuPaths): SessionContext {
  const d = loadDesktopSessions(paths);
  return {
    sessions: d.sessions,
    running: runningIndex(loadRunningSessions(paths)),
    desktopWorktrees: loadDesktopWorktrees(paths),
    parseErrors: d.parseErrors,
    files: d.files,
  };
}

/** 第一阶段：仓库级 git 事实 */
interface RepoScan {
  cfg: RepoConfig;
  report: RepoReport;
  root: string;
  commonDir: string;
  raw: RawBranch[];
  worktrees: WorktreeInfo[];
  /** 规范化后的 worktree 路径（会话归属用） */
  worktreeReal: Array<{ path: string; wt: WorktreeInfo }>;
  mainRef: string | null;
  mainSha: string | null;
  integRef: string | null;
  inMain: Set<string> | null;
  inInteg: Set<string> | null;
  abMain: Map<string, { ahead: number; behind: number } | null>;
  abInteg: Map<string, { ahead: number; behind: number } | null>;
  remoteRefs: Set<string>;
  admin: AdminDirScan | null;
  gitOpts: RunGitOptions;
  callsBefore: number;
  timeoutsBefore: number;
  started: number;
}

function emptyReport(cfg: RepoConfig): RepoReport {
  return {
    id: cfg.id,
    label: cfg.label,
    path: cfg.path,
    icloud: cfg.icloud,
    main: cfg.main,
    integration: cfg.integration,
    remote: cfg.remote,
    reachable: false,
    error: null,
    warnings: [],
    counts: null,
    health: null,
    branches: [],
    worktrees: [],
    hygiene: [],
    elapsedMs: 0,
    gitCalls: 0,
    gitTimeouts: 0,
  };
}

async function scanRepo(cfg: RepoConfig, ctx: SessionContext, options: ScanOptions): Promise<RepoScan> {
  const started = performance.now();
  const report = emptyReport(cfg);
  const root = canonicalPath(cfg.path);
  // protect：沙箱内禁止写入的路径，rev-parse 拿到 common dir 后补上
  const gitOpts: RunGitOptions = { timeoutMs: options.timeoutMs, limitKey: root, protect: [root] };
  const stats = gitStats(root);
  const scan: RepoScan = {
    cfg,
    report,
    root,
    commonDir: join(root, ".git"),
    raw: [],
    worktrees: [],
    worktreeReal: [],
    mainRef: null,
    mainSha: null,
    integRef: null,
    inMain: null,
    inInteg: null,
    abMain: new Map(),
    abInteg: new Map(),
    remoteRefs: new Set(),
    admin: null,
    gitOpts,
    callsBefore: stats.calls,
    timeoutsBefore: stats.timeouts,
    started,
  };
  if (!existsSync(root)) {
    report.error = "路径不存在";
    return scan;
  }
  const rp = await runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], gitOpts);
  if (!rp.ok) {
    report.error = rp.timedOut ? "git 超时（rev-parse）" : "不是 git 仓库";
    return scan;
  }
  const [common, top] = lines(rp.stdout);
  scan.commonDir = canonicalPath(common ?? join(root, ".git"));
  gitOpts.protect = [root, common ?? join(root, ".git")];
  if (top && canonicalPath(top) !== root) {
    report.warnings.push(`配置路径不是仓库根目录，实际根目录为 ${top}`);
  }
  report.reachable = true;

  const mainRef = `refs/heads/${cfg.main}`;
  const integRefCand = cfg.integration ? `refs/heads/${cfg.integration}` : null;
  const version = await gitVersion();
  const useAtom = versionAtLeast(version, [2, 41]);

  const [branchesRes, mainExists, integExists, remoteRefs, wtRes] = await Promise.all([
    listLocalBranches(root, gitOpts),
    refExists(root, mainRef, gitOpts),
    integRefCand ? refExists(root, integRefCand, gitOpts) : Promise.resolve(false),
    listRemoteRefs(root, gitOpts),
    runGit(root, ["worktree", "list", "--porcelain"], gitOpts),
  ]);
  if (!branchesRes.ok) {
    report.error = branchesRes.timedOut ? "git 超时（for-each-ref）" : "读取分支失败";
    report.reachable = false;
    return scan;
  }
  scan.raw = branchesRes.branches;
  scan.remoteRefs = remoteRefs;
  if (mainExists) scan.mainRef = mainRef;
  else report.error = `主线分支 ${cfg.main} 不存在`;
  if (integRefCand) {
    if (integExists) scan.integRef = integRefCand;
    else report.warnings.push(`集成分支 ${cfg.integration} 不存在，按未配置处理`);
  }
  scan.mainSha = scan.raw.find((b) => b.ref === mainRef)?.sha ?? null;

  const refs = scan.raw.map((b) => b.ref);
  const [inMain, inInteg, abMain, abInteg] = await Promise.all([
    scan.mainRef ? mergedInto(root, scan.mainRef, gitOpts) : Promise.resolve(null),
    scan.integRef ? mergedInto(root, scan.integRef, gitOpts) : Promise.resolve(null),
    scan.mainRef ? aheadBehindAll(root, scan.mainRef, refs, useAtom, gitOpts) : Promise.resolve(new Map()),
    scan.integRef ? aheadBehindAll(root, scan.integRef, refs, useAtom, gitOpts) : Promise.resolve(new Map()),
  ]);
  scan.inMain = inMain;
  scan.inInteg = inInteg;
  scan.abMain = abMain;
  scan.abInteg = abInteg;
  if (scan.mainRef && !inMain) report.warnings.push("计算「已进主线」失败（超时或出错），合并状态可能不准");

  // worktree
  if (wtRes.ok) {
    const desktopByPath = new Map(ctx.desktopWorktrees.map((d) => [canonicalPath(d.path), d]));
    const claudeWtDir = join(root, ".claude", "worktrees");
    parseWorktreePorcelain(wtRes.stdout).forEach((w, i) => {
      if (w.bare) return;
      const real = canonicalPath(w.path);
      const desk = desktopByPath.get(real);
      const managed = !!desk || isUnder(real, claudeWtDir);
      const info = toWorktreeInfo(w, i === 0, managed && i !== 0, desk?.leasedBy ?? null);
      scan.worktrees.push(info);
      scan.worktreeReal.push({ path: real, wt: info });
    });
  } else {
    report.warnings.push(wtRes.timedOut ? "worktree list 超时" : "worktree list 失败");
  }
  scan.admin = scanAdminDirs(scan.commonDir, cfg.icloud);
  return scan;
}

/** 会话归属：取 cwd/originCwd/worktreePath 落点最深的仓库 */
function ownerOf(s: DesktopSession, scans: RepoScan[]): RepoScan | null {
  const cands = [s.originCwd, s.cwd, s.worktreePath].filter((x): x is string => !!x).map(canonicalPath);
  return deepestMatch(cands, scans);
}

function deepestMatch(paths: string[], scans: RepoScan[]): RepoScan | null {
  let best: RepoScan | null = null;
  let bestLen = -1;
  for (const sc of scans) {
    if (!sc.report.reachable) continue;
    for (const p of paths) {
      if (isUnder(p, sc.root) && sc.root.length > bestLen) {
        best = sc;
        bestLen = sc.root.length;
      }
      for (const w of sc.worktreeReal) {
        if (isUnder(p, w.path) && w.path.length > bestLen) {
          best = sc;
          bestLen = w.path.length;
        }
      }
    }
  }
  return best;
}

interface BranchLink {
  session: DesktopSession;
  link: SessionLink;
}

const LINK_RANK: Record<SessionLink, number> = { branch: 0, written: 1, worktree: 2 };

/** 会话 → (仓库, 分支) 关联；按分支名关联，worktree 目录只作弱关联（目录会被复用） */
function linkSessions(ctx: SessionContext, scans: RepoScan[]): { owned: Map<RepoScan, DesktopSession[]>; links: Map<RepoScan, Map<string, BranchLink[]>> } {
  const owned = new Map<RepoScan, DesktopSession[]>();
  const links = new Map<RepoScan, Map<string, BranchLink[]>>();
  const add = (sc: RepoScan, branch: string, l: BranchLink) => {
    if (!sc.raw.some((b) => b.name === branch)) return;
    let m = links.get(sc);
    if (!m) links.set(sc, (m = new Map()));
    const arr = m.get(branch) ?? [];
    const existing = arr.find((x) => x.session === l.session);
    if (existing) {
      if (LINK_RANK[l.link] < LINK_RANK[existing.link]) existing.link = l.link;
    } else arr.push(l);
    m.set(branch, arr);
  };
  for (const s of ctx.sessions) {
    const owner = ownerOf(s, scans);
    if (owner) {
      const arr = owned.get(owner) ?? [];
      arr.push(s);
      owned.set(owner, arr);
      if (s.branch) add(owner, s.branch, { session: s, link: "branch" });
      else {
        const cwd = s.cwd ? canonicalPath(s.cwd) : null;
        const wt = cwd ? owner.worktreeReal.filter((w) => !w.wt.isMain && isUnder(cwd, w.path)).sort((a, b) => b.path.length - a.path.length)[0] : undefined;
        if (wt?.wt.branch) add(owner, wt.wt.branch, { session: s, link: "worktree" });
      }
    }
    for (const wb of s.writtenBranches) {
      const target = wb.path ? deepestMatch([canonicalPath(wb.path)], scans) : owner;
      if (target) add(target, wb.branch, { session: s, link: "written" });
    }
  }
  for (const m of links.values()) {
    for (const arr of m.values()) {
      // 关联强度 > 未归档优先 > 最后活动倒序
      arr.sort(
        (a, b) =>
          LINK_RANK[a.link] - LINK_RANK[b.link] ||
          Number(a.session.isArchived) - Number(b.session.isArchived) ||
          (b.session.lastActivityAt ?? 0) - (a.session.lastActivityAt ?? 0),
      );
    }
  }
  return { owned, links };
}

function toSessionRef(l: BranchLink, ctx: SessionContext): SessionRef {
  const s = l.session;
  const running = runningFor(s, ctx.running);
  return {
    sessionId: s.sessionId,
    title: s.title,
    status: sessionStatus(s, running),
    statusCategory: s.statusCategory,
    needsAction: s.needsAction,
    isArchived: s.isArchived,
    lastActivityAt: iso(s.lastActivityAt),
    link: l.link,
    prs: s.prs,
  };
}

async function finishRepo(scan: RepoScan, ctx: SessionContext, links: Map<string, BranchLink[]>, options: ScanOptions, now: Date): Promise<RepoReport> {
  const { report, cfg, root, gitOpts } = scan;
  if (!report.reachable) {
    report.elapsedMs = Math.round(performance.now() - scan.started);
    return report;
  }

  // 脏检查：非 iCloud 默认做；iCloud 只有 --dirty 才做
  const doDirty = !cfg.icloud || options.dirty;
  const dirtyJob = doDirty
    ? Promise.all(
        scan.worktrees.map(async (w) => {
          if (w.prunable) {
            w.dirty = "unknown";
            w.dirtyReason = "worktree 目录已不存在";
            return;
          }
          const d = await checkDirty(w.path, { ...gitOpts, protect: [...(gitOpts.protect ?? []), w.path] });
          w.dirty = d.state;
          w.dirtyCount = d.count;
          w.dirtyReason = d.reason;
        }),
      )
    : Promise.resolve();
  if (!doDirty) for (const w of scan.worktrees) w.dirtyReason = "iCloud 仓默认跳过（--dirty 才检查）";

  const wtByBranch = new Map<string, WorktreeInfo>();
  for (const w of scan.worktrees) if (w.branch) wtByBranch.set(w.branch, w);

  const remoteNames = new Set<string>();
  for (const r of scan.remoteRefs) {
    const m = /^refs\/remotes\/[^/]+\/(.+)$/.exec(r);
    if (m && m[1] !== "HEAD") remoteNames.add(m[1] ?? "");
  }

  // 预检隔离区
  const quarantine = options.precheck ? createObjectQuarantine(scan.commonDir) : null;
  const precheckTargetRef = scan.integRef ?? scan.mainRef;
  const precheckTargetName = scan.integRef ? (cfg.integration as string) : cfg.main;
  const [targetTree, mainTree] = quarantine
    ? await Promise.all([
        precheckTargetRef ? treeOf(root, precheckTargetRef, gitOpts) : Promise.resolve(null),
        scan.mainRef ? treeOf(root, scan.mainRef, gitOpts) : Promise.resolve(null),
      ])
    : [null, null];

  try {
    report.branches = await Promise.all(
      scan.raw.map(async (b): Promise<FeatureView> => {
        const role = b.ref === scan.mainRef ? "main" : b.ref === scan.integRef ? "integration" : "feature";
        let mergedState = classifyMerged(b.ref, scan.inMain, scan.inInteg);
        if (role === "integration" && mergedState === "in_integration") mergedState = "unmerged";
        const vsMain = role === "main" ? null : (scan.abMain.get(b.ref) ?? null);
        const vsIntegration = role === "integration" || !scan.integRef ? null : (scan.abInteg.get(b.ref) ?? null);
        const bl = links.get(b.name) ?? [];
        const sessions = bl.map((l) => toSessionRef(l, ctx));
        const wt = wtByBranch.get(b.name) ?? null;

        // 标签
        let label: { label: string; source: FeatureView["labelSource"] };
        if (role === "main") label = { label: "主线", source: "branch_name" };
        else {
          const title = bl[0]?.session.title ?? null;
          let first: string | null = null;
          let top: string | null = null;
          if (!title && scan.mainRef && (vsMain?.ahead ?? 0) > 0) {
            const exclude = (await branchesNotContaining(root, b.ref, gitOpts)) ?? [];
            first = await firstUniqueSubject(root, scan.mainRef, b.ref, gitOpts, exclude);
            if (!first) top = await topChangedDir(root, scan.mainRef, b.ref, gitOpts);
          }
          label = pickLabel({ branch: b.name, sessionTitle: title, firstCommitSubject: first, topDir: top, tipSubject: b.subject });
        }

        // 预检
        let precheck: FeatureView["precheck"] = null;
        if (quarantine) {
          if (role === "feature" && mergedState === "unmerged" && precheckTargetRef) {
            precheck = await precheckMerge(root, precheckTargetName, precheckTargetRef, targetTree, b.ref, quarantine, gitOpts);
          } else if (role === "integration" && mergedState === "unmerged" && scan.mainRef) {
            precheck = await precheckMerge(root, cfg.main, scan.mainRef, mainTree, b.ref, quarantine, gitOpts);
          }
        }

        const pushed = remoteNames.has(b.name) || (!!b.upstream && scan.remoteRefs.has(b.upstream));
        return {
          branch: b.name,
          ref: b.ref,
          sha: b.sha,
          role,
          mergedState,
          label: label.label,
          labelSource: label.source,
          randomName: isRandomName(b.name),
          lastCommitAt: b.committedAt ? new Date(b.committedAt * 1000).toISOString() : null,
          lastCommitSubject: b.subject,
          vsMain,
          vsIntegration,
          upstream: b.upstream,
          pushed,
          worktree: wt ? { path: wt.path, dirName: wt.dirName, isMain: wt.isMain, dirty: wt.dirty } : null,
          sessions,
          precheck,
        };
      }),
    );
  } finally {
    quarantine?.dispose();
  }

  await dirtyJob;
  // 脏检查完成后回填分支里的 worktree 快照
  for (const fv of report.branches) {
    if (fv.worktree) {
      const w = wtByBranch.get(fv.branch);
      if (w) fv.worktree.dirty = w.dirty;
    }
  }
  report.branches.sort((a, b) => (b.lastCommitAt ?? "").localeCompare(a.lastCommitAt ?? "") || a.branch.localeCompare(b.branch));
  report.worktrees = scan.worktrees;
  report.hygiene = buildHygiene(scan, report.branches);
  report.counts = buildCounts(report.branches, scan.worktrees);
  report.health = await buildHealth(scan, report, now);

  const stats = gitStats(root);
  report.gitCalls = stats.calls - scan.callsBefore;
  report.gitTimeouts = stats.timeouts - scan.timeoutsBefore;
  report.elapsedMs = Math.round(performance.now() - scan.started);
  return report;
}

function buildCounts(branches: FeatureView[], worktrees: WorktreeInfo[]): RepoCounts {
  const mergedIntoMain = branches.filter((b) => b.mergedState === "in_main").length;
  return {
    branches: branches.length,
    worktrees: worktrees.filter((w) => !w.isMain).length,
    mergedIntoMain,
    unmergedIntoMain: branches.length - mergedIntoMain,
    inIntegration: branches.filter((b) => b.role === "feature" && b.mergedState === "in_integration").length,
    independent: branches.filter((b) => b.role === "feature" && b.mergedState === "unmerged").length,
    neverPushed: branches.filter((b) => !b.pushed).length,
  };
}

function buildHygiene(scan: RepoScan, branches: FeatureView[]): HygieneIssue[] {
  const out: HygieneIssue[] = [];
  const byName = new Map(branches.map((b) => [b.branch, b]));
  const issue = (i: Omit<HygieneIssue, "count"> & { count?: number | null }) => out.push({ count: null, ...i });
  for (const w of scan.worktrees) {
    if (w.isMain) {
      if (w.dirty === "dirty") {
        issue({ kind: "main_dirty", severity: "warn", message: `主目录有 ${w.dirtyCount} 处已跟踪文件改动未提交`, path: w.path, branch: w.branch, count: w.dirtyCount });
      } else if (w.dirty === "skipped") {
        issue({ kind: "main_dirty", severity: "info", message: "主目录脏检查已跳过（iCloud 仓，--dirty 才检查）", path: w.path, branch: w.branch });
      } else if (w.dirty === "unknown") {
        issue({ kind: "main_dirty", severity: "info", message: `主目录脏检查未完成：${w.dirtyReason ?? "未知"}`, path: w.path, branch: w.branch });
      }
      continue;
    }
    if (w.prunable) {
      issue({ kind: "prunable_worktree", severity: "warn", message: `worktree 目录已不存在，登记仍在：${w.dirName}`, path: w.path, branch: w.branch });
      continue;
    }
    if (w.managedByDesktop && w.branch && branchSlug(w.branch) !== w.dirName) {
      issue({ kind: "dir_branch_mismatch", severity: "warn", message: `目录 ${w.dirName} 实际在分支 ${w.branch} 上（目录被复用）`, path: w.path, branch: w.branch });
    }
    if (w.detached) {
      issue({ kind: "detached_worktree", severity: "info", message: `worktree ${w.dirName} 处于分离 HEAD（${(w.head ?? "").slice(0, 8)}）`, path: w.path, branch: null });
    }
    const atMainTip = !!scan.mainSha && w.head === scan.mainSha;
    const fv = w.branch ? byName.get(w.branch) : undefined;
    if (fv && fv.role === "feature" && fv.mergedState === "in_main") {
      if (atMainTip || fv.sha === scan.mainSha) {
        issue({ kind: "worktree_no_commits", severity: "info", message: `worktree ${w.dirName} 停在主线顶端，相对主线 0 提交`, path: w.path, branch: w.branch });
      } else {
        issue({ kind: "merged_worktree_remains", severity: "info", message: `分支 ${w.branch} 已进主线，worktree 目录仍在`, path: w.path, branch: w.branch });
      }
    } else if (w.detached && atMainTip) {
      issue({ kind: "worktree_no_commits", severity: "info", message: `worktree ${w.dirName} 停在主线顶端，相对主线 0 提交`, path: w.path, branch: null });
    }
  }
  const admin = scan.admin;
  if (admin) {
    for (const o of admin.orphans) {
      issue({ kind: "orphan_admin_dir", severity: "warn", message: `孤儿条目 .git/worktrees/${o.split("/").pop()}（缺 gitdir）`, path: o, branch: null });
    }
    for (const l of admin.locks) {
      issue({ kind: "index_lock", severity: "warn", message: `检测到锁文件 ${l.replace(scan.commonDir, ".git")}（是否残留待确认：可能有 git 进程正在运行）`, path: l, branch: null });
    }
    if (admin.conflictCopies.length) {
      const sample = admin.conflictCopies.slice(0, 3).map((p) => p.replace(scan.commonDir, ".git")).join("、");
      issue({
        kind: "icloud_conflict_copy",
        severity: "warn",
        message: `.git 内有 ${admin.conflictCopies.length} 个 iCloud 冲突副本（如 ${sample}）`,
        path: scan.commonDir,
        branch: null,
        count: admin.conflictCopies.length,
      });
    }
  }
  return out;
}

async function buildHealth(scan: RepoScan, report: RepoReport, now: Date): Promise<RepoHealth> {
  const { cfg, root, gitOpts } = scan;
  let mainVsRemote: RepoHealth["mainVsRemote"] = null;
  if (scan.mainRef) {
    const mainRaw = scan.raw.find((b) => b.ref === scan.mainRef);
    const remoteRef = cfg.remote ? `refs/remotes/${cfg.remote}/${cfg.main}` : (mainRaw?.upstream ?? null);
    if (remoteRef) {
      if (scan.remoteRefs.has(remoteRef)) {
        const ab = await aheadBehind(root, remoteRef, scan.mainRef, gitOpts);
        mainVsRemote = { remoteRef, ahead: ab?.ahead ?? null, behind: ab?.behind ?? null, note: ab ? null : "计算失败或超时" };
      } else {
        mainVsRemote = { remoteRef, ahead: null, behind: null, note: "本地没有该远端引用（未 fetch 或远端无此分支）" };
      }
    } else {
      mainVsRemote = { remoteRef: "", ahead: null, behind: null, note: "未配置远端，主线也没有上游" };
    }
  }

  let integration: RepoHealth["integration"] = null;
  if (cfg.integration) {
    const fv = report.branches.find((b) => b.role === "integration");
    let since: number | null = null;
    if (fv && scan.mainRef && fv.mergedState !== "in_main") since = await integrationSince(root, scan.mainRef, fv.ref, gitOpts);
    integration = {
      branch: cfg.integration,
      exists: !!fv,
      mergedIntoMain: fv?.mergedState === "in_main",
      aheadOfMain: fv?.vsMain?.ahead ?? null,
      behindMain: fv?.vsMain?.behind ?? null,
      since: since ? new Date(since * 1000).toISOString() : null,
      unmergedDays: since ? Math.floor((now.getTime() / 1000 - since) / 86400) : null,
    };
  }

  const worktreeDirty: Record<DirtyState, number> = { clean: 0, dirty: 0, unknown: 0, skipped: 0 };
  for (const w of scan.worktrees) worktreeDirty[w.dirty]++;
  return {
    mainVsRemote,
    integration,
    worktreeDirty,
    hygieneWarnings: report.hygiene.filter((h) => h.severity === "warn").length,
    hygieneInfos: report.hygiene.filter((h) => h.severity === "info").length,
  };
}

export interface ReconcileResult {
  report: ReconcileReport;
  sessions: SessionView[];
}

/** 主入口：扫描项目全部仓库并对账 */
export async function reconcile(
  project: ProjectConfig,
  paths: HeliuPaths,
  options: ScanOptions,
  opts: { now?: Date; sessionContext?: SessionContext } = {},
): Promise<ReconcileResult> {
  const started = performance.now();
  const now = opts.now ?? new Date();
  const ctx = opts.sessionContext ?? loadSessionContext(paths);
  const scans = await Promise.all(project.repos.map((r) => scanRepo(r, ctx, options)));
  const { owned, links } = linkSessions(ctx, scans);
  const repos = await Promise.all(scans.map((sc) => finishRepo(sc, ctx, links.get(sc) ?? new Map(), options, now)));

  const sessions: SessionView[] = [];
  for (const sc of scans) {
    for (const s of owned.get(sc) ?? []) {
      const running = runningFor(s, ctx.running);
      sessions.push({
        sessionId: s.sessionId,
        cliSessionId: s.cliSessionId,
        title: s.title,
        repo: sc.cfg.id,
        branch: s.branch,
        worktreeName: s.worktreeName,
        worktreePath: s.worktreePath,
        cwd: s.cwd,
        status: sessionStatus(s, running),
        statusCategory: s.statusCategory,
        statusDetail: s.statusDetail,
        needsAction: s.needsAction,
        isArchived: s.isArchived,
        running,
        createdAt: iso(s.createdAt),
        lastActivityAt: iso(s.lastActivityAt),
        completedTurns: s.completedTurns,
        model: s.model,
        spawnedFrom: s.spawnedFrom,
        prs: s.prs,
      });
    }
  }
  sessions.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? ""));

  const report: ReconcileReport = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    elapsedMs: Math.round(performance.now() - started),
    project: { name: project.name, source: project.source },
    options,
    repos,
    sessions: { total: sessions.length, parseErrors: ctx.parseErrors },
  };
  return { report, sessions };
}
