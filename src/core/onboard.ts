/**
 * heliu project add 向导（M5）：只读探测一个仓库，猜出主线 / 远端 / 集成分支候选 / 是否 iCloud，
 * 交给 CLI 打中文摘要、让用户确认后再写注册表并建台账。本模块只读 git、不写任何文件。
 *
 * 猜测规则：
 * - 远端：--remote > origin > 第一个远端。
 * - 主线：--main > `symbolic-ref refs/remotes/<远端>/HEAD` > 本地有 main / master > 当前检出分支。
 * - 集成分支候选（都要求未进主线、领先主线 >0）：
 *     ① 名字含 merge / integration / release，按领先主线提交数从多到少；
 *     ② 名字不像、但包含 ≥2 条「未进主线的其他分支」（像集成分支在用），按包含数、领先数排序；
 *        只是叠在另一个候选之上的分支（包含它、但只多包含它本身，典型是从集成分支切出的功能分支）排到后面，
 *        包含数相同时主目录正检出的优先。
 *   默认取 ① 的第一个，没有 ① 时取 ② 的第一个，都没有就不设（以后 --integration 指定）。
 * - iCloud：路径含 Mobile Documents（脏检查默认跳过，避免触发下载）。
 */
import { basename } from "node:path";
import { aheadBehindAll, listLocalBranches, mergedInto, refExists } from "./branches.ts";
import { gitVersion, lines, runGit, versionAtLeast, type RunGitOptions } from "./git.ts";
import { canonicalPath, looksLikeICloud } from "./paths.ts";
import { ProjectError } from "./project.ts";

export interface IntegrationCandidate {
  branch: string;
  ahead: number;
  behind: number;
  /** 被它包含、但还没进主线的其他本地分支数 */
  contains: number;
  /** 名字含 merge / integration / release */
  byName: boolean;
  lastCommitAt: string | null;
  /** 主目录当前检出的就是它 */
  checkedOut: boolean;
  /** 它只是叠在另一个候选之上的分支（包含那个候选、却只多包含它自己）→ 排到后面 */
  onTopOf: string | null;
}

export interface RepoDetection {
  root: string;
  icloud: boolean;
  remotes: string[];
  remote: string | null;
  remoteWhy: string;
  main: string;
  mainWhy: string;
  mainExists: boolean;
  /** 主目录当前检出的分支 */
  head: string | null;
  branches: number;
  worktrees: number | null;
  candidates: IntegrationCandidate[];
  integration: string | null;
  integrationWhy: string;
  warnings: string[];
}

export const INTEGRATION_NAME_RE = /merge|integrat|release/i;
const MAX_CANDIDATES = 6;

export async function detectRepo(path: string, input: { main?: string; integration?: string; remote?: string; timeoutMs?: number } = {}): Promise<RepoDetection> {
  const target = canonicalPath(path);
  const t = input.timeoutMs ?? 8000;
  const top = await runGit(target, ["rev-parse", "--path-format=absolute", "--show-toplevel"], { timeoutMs: t });
  if (!top.ok) throw new ProjectError(top.timedOut ? `git 超时：${target}` : `不是 git 仓库：${target}`);
  const root = canonicalPath(lines(top.stdout)[0] ?? target);
  const opts: RunGitOptions = { timeoutMs: t, limitKey: root, protect: [root] };
  const warnings: string[] = [];

  // 远端
  const rr = await runGit(root, ["remote"], opts);
  const remotes = rr.ok ? lines(rr.stdout) : [];
  let remote = input.remote ?? null;
  let remoteWhy = "参数指定";
  if (!remote) {
    remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
    remoteWhy = !remote ? "没有远端" : remote === "origin" ? "有 origin 就用 origin" : "没有 origin，用第一个远端";
  } else if (!remotes.includes(remote)) warnings.push(`远端 ${remote} 在本地不存在（已有：${remotes.join("、") || "无"}）`);

  // 主线
  const hr = await runGit(root, ["symbolic-ref", "-q", "--short", "HEAD"], opts);
  const head = (hr.ok && lines(hr.stdout)[0]) || null;
  let main = input.main ?? null;
  let mainWhy = "参数指定";
  if (!main && remote) {
    const sr = await runGit(root, ["symbolic-ref", "-q", "--short", `refs/remotes/${remote}/HEAD`], opts);
    const v = lines(sr.stdout)[0];
    if (sr.ok && v && v.startsWith(`${remote}/`)) {
      main = v.slice(remote.length + 1);
      mainWhy = `${remote}/HEAD 指向它`;
    }
  }
  if (!main) {
    for (const cand of ["main", "master"]) {
      if (await refExists(root, `refs/heads/${cand}`, opts)) {
        main = cand;
        mainWhy = `本地有 ${cand}`;
        break;
      }
    }
  }
  if (!main) {
    main = head ?? "main";
    mainWhy = head ? "没有 main/master，用当前检出分支" : "什么都没探测到，先填 main";
  }
  const mainRef = `refs/heads/${main}`;
  const mainExists = await refExists(root, mainRef, opts);
  if (!mainExists) warnings.push(`主线 ${main} 在本地不存在：对账会把它标成错误，可用 --main 指定`);

  // 分支与 worktree 规模
  const lb = await listLocalBranches(root, opts);
  const wt = await runGit(root, ["worktree", "list", "--porcelain"], opts);
  const worktrees = wt.ok ? Math.max(0, lines(wt.stdout).filter((l) => l.startsWith("worktree ")).length - 1) : null;

  // 集成分支候选
  const candidates: IntegrationCandidate[] = [];
  if (lb.ok && mainExists) {
    const refs = lb.branches.map((b) => b.ref);
    const useAtom = versionAtLeast(await gitVersion(), [2, 41]);
    const [ab, inMain] = await Promise.all([aheadBehindAll(root, mainRef, refs, useAtom, opts), mergedInto(root, mainRef, opts)]);
    const notInMain = lb.branches.filter((b) => b.ref !== mainRef && !(inMain?.has(b.ref) ?? false) && (ab.get(b.ref)?.ahead ?? 0) > 0);
    const notInMainRefs = new Set(notInMain.map((b) => b.ref));
    const base = notInMain.map((b) => ({
      b,
      ahead: ab.get(b.ref)?.ahead ?? 0,
      behind: ab.get(b.ref)?.behind ?? 0,
      byName: INTEGRATION_NAME_RE.test(b.name),
    }));
    // 只对「名字像」的与领先最多的几条算包含数（每条一次 for-each-ref --merged）
    const probe = [...base.filter((x) => x.byName), ...base.filter((x) => !x.byName).sort((a, c) => c.ahead - a.ahead).slice(0, MAX_CANDIDATES)];
    const sets = new Map<string, Set<string>>();
    for (const x of probe) {
      const m = await mergedInto(root, x.b.ref, opts);
      const set = new Set(m ? [...m].filter((r) => r !== x.b.ref && notInMainRefs.has(r)) : []);
      const contains = set.size;
      if (!x.byName && contains < 2) continue;
      sets.set(x.b.name, set);
      candidates.push({
        branch: x.b.name,
        ahead: x.ahead,
        behind: x.behind,
        contains,
        byName: x.byName,
        lastCommitAt: x.b.committedAt ? new Date(x.b.committedAt * 1000).toISOString() : null,
        checkedOut: x.b.name === head,
        onTopOf: null,
      });
    }
    const shaOf = new Map(lb.branches.map((b) => [b.name, b.sha]));
    for (const a of candidates) {
      if (a.byName) continue;
      const below = candidates.find(
        (c) => c !== a && shaOf.get(c.branch) !== shaOf.get(a.branch) && sets.get(a.branch)?.has(`refs/heads/${c.branch}`) && a.contains - c.contains <= 1,
      );
      if (below) a.onTopOf = below.branch;
    }
    candidates.sort(
      (a, c) =>
        Number(c.byName) - Number(a.byName) ||
        (a.byName
          ? c.ahead - a.ahead
          : Number(!!a.onTopOf) - Number(!!c.onTopOf) || c.contains - a.contains || Number(c.checkedOut) - Number(a.checkedOut) || c.ahead - a.ahead) ||
        a.branch.localeCompare(c.branch),
    );
    candidates.splice(MAX_CANDIDATES);
  }

  let integration: string | null = input.integration ?? null;
  let integrationWhy = "参数指定";
  if (integration) {
    if (lb.ok && !lb.branches.some((b) => b.name === integration)) warnings.push(`集成分支 ${integration} 在本地不存在`);
  } else if (candidates[0]) {
    const c = candidates[0];
    integration = c.branch;
    integrationWhy = c.byName ? `名字像集成分支，领先主线 ${c.ahead} 个提交（候选里最多）` : `名字不像，但包含 ${c.contains} 条未进主线的分支，像集成分支在用`;
  } else integrationWhy = "没找到候选（名字含 merge/integration/release、或包含 ≥2 条未进主线分支的）";

  return {
    root,
    icloud: looksLikeICloud(root),
    remotes,
    remote,
    remoteWhy,
    main,
    mainWhy,
    mainExists,
    head,
    branches: lb.branches.length,
    worktrees,
    candidates,
    integration,
    integrationWhy,
    warnings,
  };
}

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "—");

export function candidateLine(c: IntegrationCandidate): string {
  const parts = [`领先主线 ${c.ahead}`];
  if (c.contains) parts.push(`包含 ${c.contains} 条未进主线的分支`);
  parts.push(`最后提交 ${day(c.lastCommitAt)}`);
  if (c.byName) parts.push("名字像集成分支");
  if (c.checkedOut) parts.push("主目录正检出");
  if (c.onTopOf) parts.push(`叠在 ${c.onTopOf} 之上（像从它切出的功能分支）`);
  return `${c.branch} · ${parts.join(" · ")}`;
}

export interface OnboardPlan {
  name: string;
  exists: boolean;
  id: string;
  label: string;
  /** 台账目录（展开后的绝对路径）与写进 project.yaml 的原文（null = 不写，沿用 <主仓库>/.heliu/） */
  ledgerDir: string;
  ledgerSetting: string | null;
  ledgerNote: string;
  registry: string;
}

/** 中文摘要（确认前打印） */
export function renderOnboard(d: RepoDetection, plan: OnboardPlan): string {
  const out = [`合流 · 接入仓库：${d.root}`];
  out.push(`  项目：${plan.name}（${plan.exists ? "已存在，追加/替换这个仓库" : "新建"}）· 仓库 id ${plan.id} · 显示名 ${plan.label}`);
  out.push(`  主线：${d.main}（${d.mainWhy}）`);
  out.push(`  远端：${d.remote ?? "无"}（${d.remoteWhy}${d.remotes.length > 1 ? `；共 ${d.remotes.join("、")}` : ""}）· heliu 从不 fetch/push`);
  out.push(`  集成分支：${d.integration ?? "不设"}（${d.integrationWhy}）`);
  if (d.candidates.length) {
    out.push("  候选：");
    d.candidates.forEach((c, i) => out.push(`    ${i + 1}) ${candidateLine(c)}`));
  }
  out.push(`  iCloud：${d.icloud ? "是（路径含 Mobile Documents；工作区脏检查默认跳过，避免触发下载）" : "否"}`);
  out.push(`  规模：${d.branches} 个本地分支 · ${d.worktrees ?? "?"} 个 worktree（不含主目录）${d.head ? ` · 主目录在 ${d.head}` : ""}`);
  out.push(`  台账：${plan.ledgerDir}（${plan.ledgerNote}）`);
  out.push(`  注册表：${plan.registry}`);
  for (const w of d.warnings) out.push(`  ! ${w}`);
  out.push("  以上全部来自 git 只读命令，没有改动仓库。");
  return out.join("\n");
}

/** 仓库 id：目录名转小写、非字母数字换成 -（与 project add 一致） */
export function repoIdOf(root: string): string {
  return (
    basename(root)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "") || "repo"
  );
}
