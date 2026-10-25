/**
 * whereami：当前目录 → 项目 / 仓库 / 分支 / 功能卡 / 预约里程碑 / 落后数 / 会话。
 *
 * 为 SessionStart hook 设计的快路径（<300ms）：
 * - 不跑全量对账；git 只调 2 次：rev-parse（顶层 + common dir + HEAD）与 for-each-ref %(ahead-behind:HEAD)
 *   （一次算出落后主线与集成分支；git<2.41 回退为 rev-list --count）。
 * - 台账用文件系统直接读 frontmatter（只解析正文含当前分支名的卡片）。
 * - 会话只从 ~/.claude/sessions/<pid>.json 匹配（hook 的 session_id 或 cwd），标题缺失时按 id 直接定位桌面会话文件。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BranchRole, LedgerFeature, WhereAmI } from "../types.ts";
import { lines, runGit } from "./git.ts";
import { Ledger, ledgerDir, parseFeature } from "./ledger.ts";
import { canonicalPath, isUnder, type HeliuPaths } from "./paths.ts";
import { detectProject, type ProjectConfig, type RepoConfig } from "./project.ts";

export interface WhereamiOptions {
  /** 已知项目（CLI --project）；缺省按 cwd 自动识别 */
  project?: ProjectConfig | null;
  /** hook 输入里的 session_id（CLI 会话 id） */
  sessionId?: string | null;
  /** 单条 git 超时 */
  timeoutMs?: number;
}

function emptyResult(cwd: string): WhereAmI {
  return {
    cwd,
    project: null,
    repo: null,
    worktree: null,
    isMainCheckout: false,
    branch: null,
    detached: false,
    role: null,
    feature: null,
    milestone: null,
    behindMain: null,
    behindIntegration: null,
    session: null,
    ledgerDir: null,
    notes: [],
    elapsedMs: 0,
  };
}

/** 当前 cwd 属于项目里的哪个仓库：common dir 相同优先，其次路径落在仓库根下（取最深） */
function matchRepo(project: ProjectConfig, top: string | null, commonDir: string | null, cwd: string): RepoConfig | null {
  if (commonDir) {
    const hit = project.repos.find((r) => canonicalPath(join(r.path, ".git")) === commonDir);
    if (hit) return hit;
  }
  const p = top ?? cwd;
  let best: RepoConfig | null = null;
  for (const r of project.repos) {
    const root = canonicalPath(r.path);
    if (isUnder(p, root) && (!best || root.length > canonicalPath(best.path).length)) best = r;
  }
  return best;
}

/** 只读查找绑定当前分支的功能卡：先用字符串包含过滤，再解析 frontmatter */
export function findFeatureForBranch(dir: string, repoId: string, branch: string): { feature: LedgerFeature | null; others: string[] } {
  const fdir = join(dir, "features");
  const hits: LedgerFeature[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(fdir);
  } catch {
    return { feature: null, others: [] };
  }
  for (const name of names) {
    if (!name.endsWith(".md") || name.startsWith(".")) continue;
    const file = join(fdir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (!text.includes(branch)) continue;
    const f = parseFeature(text, file);
    if (f && f.bindings.some((b) => b.repo === repoId && b.branch === branch)) hits.push(f);
  }
  hits.sort((a, b) => a.id.localeCompare(b.id));
  return { feature: hits[0] ?? null, others: hits.slice(1).map((f) => f.id) };
}

interface RunningEntry {
  sessionId: string | null;
  hostSessionId: string | null;
  name: string | null;
  cwd: string | null;
  pid: number | null;
}

function readRunning(paths: HeliuPaths): RunningEntry[] {
  const out: RunningEntry[] = [];
  let names: string[] = [];
  try {
    names = readdirSync(paths.runningSessionsDir);
  } catch {
    return out;
  }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    try {
      const o = JSON.parse(readFileSync(join(paths.runningSessionsDir, n), "utf8")) as Record<string, unknown>;
      const s = (v: unknown) => (typeof v === "string" && v ? v : null);
      out.push({ sessionId: s(o.sessionId), hostSessionId: s(o.hostSessionId), name: s(o.name), cwd: s(o.cwd), pid: typeof o.pid === "number" ? o.pid : Number(n.replace(/\.json$/, "")) });
    } catch {
      /* 坏文件跳过 */
    }
  }
  return out;
}

function pidAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 按 id 直接定位桌面会话文件（文件名 = <sessionId>.json），只读 title */
function desktopTitle(paths: HeliuPaths, hostSessionId: string): string | null {
  try {
    for (const account of readdirSync(paths.desktopSessionsDir)) {
      for (const org of readdirSync(join(paths.desktopSessionsDir, account))) {
        const f = join(paths.desktopSessionsDir, account, org, `${hostSessionId}.json`);
        if (!existsSync(f)) continue;
        const o = JSON.parse(readFileSync(f, "utf8")) as { title?: unknown };
        return typeof o.title === "string" && o.title.trim() ? o.title.trim() : null;
      }
    }
  } catch {
    /* 目录不存在或文件坏 */
  }
  return null;
}

/** 当前会话：先按 hook 给的 session_id，再按 cwd（只认存活进程） */
export function matchSession(paths: HeliuPaths, cwd: string, top: string | null, sessionId?: string | null): WhereAmI["session"] {
  const running = readRunning(paths);
  let hit: RunningEntry | undefined;
  if (sessionId) hit = running.find((r) => r.sessionId === sessionId || r.hostSessionId === sessionId);
  if (!hit) {
    const cands = running.filter((r) => r.cwd && pidAlive(r.pid) && [cwd, top].includes(canonicalPath(r.cwd)));
    hit = cands[0];
  }
  if (!hit) return sessionId ? { sessionId: null, cliSessionId: sessionId, title: null } : null;
  const title = hit.name ?? (hit.hostSessionId ? desktopTitle(paths, hit.hostSessionId) : null);
  return { sessionId: hit.hostSessionId, cliSessionId: hit.sessionId, title };
}

/** 落后数：一次 for-each-ref %(ahead-behind:HEAD)；失败回退 rev-list --count */
async function behindCounts(
  top: string,
  refs: string[],
  timeoutMs: number,
  protect: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (!refs.length) return out;
  const r = await runGit(top, ["for-each-ref", "--format=%(refname)%1f%(ahead-behind:HEAD)", ...refs], { timeoutMs, protect });
  if (r.ok) {
    for (const line of lines(r.stdout)) {
      const [ref = "", ab = ""] = line.split("\x1f");
      // ref 相对 HEAD 的「领先」= HEAD 落后 ref 的提交数
      const ahead = Number(ab.trim().split(/\s+/)[0]);
      if (ref && Number.isFinite(ahead)) out.set(ref, ahead);
    }
    if (refs.every((x) => out.has(x))) return out;
  }
  await Promise.all(
    refs
      .filter((x) => !out.has(x))
      .map(async (ref) => {
        const c = await runGit(top, ["rev-list", "--count", `HEAD..${ref}`, "--"], { timeoutMs, protect });
        const n = Number(lines(c.stdout)[0]);
        out.set(ref, c.ok && Number.isFinite(n) ? n : null);
      }),
  );
  return out;
}

export async function whereami(paths: HeliuPaths, cwdRaw: string, opts: WhereamiOptions = {}): Promise<WhereAmI> {
  const started = performance.now();
  const cwd = canonicalPath(cwdRaw);
  const res = emptyResult(cwd);
  const timeoutMs = opts.timeoutMs ?? 3000;
  const done = () => {
    res.elapsedMs = Math.round(performance.now() - started);
    return res;
  };
  if (!existsSync(cwd)) {
    res.notes.push(`目录不存在：${cwd}`);
    return done();
  }

  const project = opts.project ?? (await detectProject(paths, cwd));
  if (!project) {
    res.notes.push("当前目录不在任何已注册项目内（heliu project add <仓库路径> --name <项目名> 注册）");
    res.session = matchSession(paths, cwd, null, opts.sessionId);
    return done();
  }
  res.project = { name: project.name, source: project.source };
  res.ledgerDir = ledgerDir(project);

  const rp = await runGit(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir", "--symbolic-full-name", "HEAD"], { timeoutMs });
  let top: string | null = null;
  let commonDir: string | null = null;
  if (rp.ok) {
    const [t, c, head] = lines(rp.stdout);
    top = t ? canonicalPath(t) : null;
    commonDir = c ? canonicalPath(c) : null;
    if (head && head.startsWith("refs/heads/")) res.branch = head.slice("refs/heads/".length);
    else if (head === "HEAD") res.detached = true;
  } else {
    res.notes.push(rp.timedOut ? "git 超时，无法确定当前分支" : "当前目录不是 git 仓库");
  }
  res.worktree = top;

  const repo = matchRepo(project, top, commonDir, cwd);
  if (!repo) {
    res.notes.push(`当前目录不属于项目「${project.name}」的任何仓库`);
    res.session = matchSession(paths, cwd, top, opts.sessionId);
    return done();
  }
  res.repo = { id: repo.id, label: repo.label, path: repo.path };
  res.isMainCheckout = !!top && top === canonicalPath(repo.path);

  let role: BranchRole | null = null;
  if (res.branch) role = res.branch === repo.main ? "main" : res.branch === repo.integration ? "integration" : "feature";
  res.role = role;

  // 落后数 + 台账 + 会话并行
  const protect = [top ?? cwd, commonDir ?? join(repo.path, ".git")];
  const refs: string[] = [];
  if (top && (res.branch || res.detached)) {
    if (role !== "main") refs.push(`refs/heads/${repo.main}`);
    if (repo.integration && role !== "integration") refs.push(`refs/heads/${repo.integration}`);
  }
  const behindJob = top ? behindCounts(top, refs, timeoutMs, protect) : Promise.resolve(new Map<string, number | null>());

  if (res.branch && role === "feature") {
    const { feature, others } = findFeatureForBranch(res.ledgerDir, repo.id, res.branch);
    if (feature) {
      res.feature = { id: feature.id, title: feature.title, status: feature.status, milestone: feature.milestone, acceptance: feature.acceptance, file: feature.file };
      if (others.length) res.notes.push(`本分支还绑定在 ${others.join("、")} 上`);
      if (feature.milestone) {
        try {
          const m = new Ledger(res.ledgerDir).findMilestone(feature.milestone);
          if (m) res.milestone = { id: m.id, title: m.title, status: m.status };
          else res.notes.push(`预约的里程碑 ${feature.milestone} 不在 milestones.yaml 里`);
        } catch (e) {
          res.notes.push((e as Error).message);
        }
      }
    }
  }
  res.session = matchSession(paths, cwd, top, opts.sessionId);

  const behind = await behindJob;
  res.behindMain = role === "main" ? null : (behind.get(`refs/heads/${repo.main}`) ?? null);
  res.behindIntegration = repo.integration && role !== "integration" ? (behind.get(`refs/heads/${repo.integration}`) ?? null) : null;
  return done();
}

/** SessionStart 注入的中文上下文；不在项目内返回 null */
export function whereamiContext(w: WhereAmI): string | null {
  if (!w.project || !w.repo) return null;
  const where = `${w.repo.label}/${w.branch ?? (w.detached ? "分离 HEAD" : "未知分支")}`;
  const behindParts: string[] = [];
  if (w.behindMain !== null) behindParts.push(`落后主线 ${w.behindMain} 提交`);
  if (w.behindIntegration !== null) behindParts.push(`落后集成分支 ${w.behindIntegration}`);
  const behind = behindParts.length ? `；${behindParts.join("、")}` : "";
  const cwdHint = `调用 heliu 工具时请传 cwd="${w.cwd}"。`;
  if (w.role === "main" || w.role === "integration") {
    const what = w.role === "main" ? "主线" : "集成分支";
    return `【合流】你在 ${where}（${what}）${behind}。主线/集成分支不建功能卡；若要做新功能，建议开新会话（独立 worktree）后用 heliu_feature_add 登记。${cwdHint}`;
  }
  if (w.feature) {
    const ms = w.feature.milestone ? `预约 ${w.milestone?.id ?? w.feature.milestone}` : "未预约版本";
    return `【合流】你在 ${where}，功能卡 ${w.feature.id}『${w.feature.title}』（${w.feature.status}）${ms}${behind}。${cwdHint}`;
  }
  return `【合流】你在 ${where}${behind}。本分支暂无功能卡；若本会话在做新功能，请在明确需求后调用 heliu_feature_add 登记（标题用用户的一句话），否则忽略。${cwdHint}`;
}
