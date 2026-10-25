/**
 * 分支事实采集（只读对象库命令）：
 * - for-each-ref 一次取全部本地分支（sha、提交时间、主题、上游）
 * - --merged=<主线/集成> 两次批量调用得到合并三档
 * - ahead/behind：git ≥2.41 用 %(ahead-behind:) 一次算完，否则逐分支 rev-list --left-right --count
 * - 可选 merge-tree 预检（对象隔离区内）
 */
import type { AheadBehind, MergedState, PrecheckResult } from "../types.ts";
import { lines, runGit, type ObjectQuarantine, type RunGitOptions } from "./git.ts";

export interface RawBranch {
  name: string;
  ref: string;
  sha: string;
  /** unix 秒 */
  committedAt: number | null;
  subject: string;
  upstream: string | null;
}

const SEP = "\x1f";

export async function listLocalBranches(repo: string, opts: RunGitOptions): Promise<{ branches: RawBranch[]; ok: boolean; timedOut: boolean }> {
  const fmt = ["%(refname)", "%(objectname)", "%(committerdate:unix)", "%(upstream)", "%(contents:subject)"].join("%1f");
  const r = await runGit(repo, ["for-each-ref", `--format=${fmt}`, "refs/heads"], opts);
  if (!r.ok) return { branches: [], ok: false, timedOut: r.timedOut };
  const branches: RawBranch[] = [];
  for (const line of lines(r.stdout)) {
    const [ref = "", sha = "", ct = "", upstream = "", ...subj] = line.split(SEP);
    if (!ref.startsWith("refs/heads/")) continue;
    const t = Number(ct);
    branches.push({
      name: ref.slice("refs/heads/".length),
      ref,
      sha,
      committedAt: Number.isFinite(t) && ct !== "" ? t : null,
      subject: subj.join(SEP),
      upstream: upstream || null,
    });
  }
  return { branches, ok: true, timedOut: false };
}

/** 被 base 包含的本地分支集合（refs/heads/...） */
export async function mergedInto(repo: string, baseRef: string, opts: RunGitOptions): Promise<Set<string> | null> {
  const r = await runGit(repo, ["for-each-ref", `--merged=${baseRef}`, "--format=%(refname)", "refs/heads"], opts);
  return r.ok ? new Set(lines(r.stdout)) : null;
}

export async function refExists(repo: string, ref: string, opts: RunGitOptions): Promise<boolean> {
  const r = await runGit(repo, ["show-ref", "--verify", "-q", ref], opts);
  return r.ok;
}

export async function listRemoteRefs(repo: string, opts: RunGitOptions): Promise<Set<string>> {
  const r = await runGit(repo, ["for-each-ref", "--format=%(refname)", "refs/remotes"], opts);
  return r.ok ? new Set(lines(r.stdout)) : new Set();
}

/** rev-list --left-right --count base...ref → 领先/落后 */
export async function aheadBehind(repo: string, baseRef: string, ref: string, opts: RunGitOptions): Promise<AheadBehind | null> {
  const r = await runGit(repo, ["rev-list", "--left-right", "--count", `${baseRef}...${ref}`, "--"], opts);
  if (!r.ok) return null;
  const [behind, ahead] = (lines(r.stdout)[0] ?? "").trim().split(/\s+/).map(Number);
  if (behind === undefined || ahead === undefined || Number.isNaN(behind) || Number.isNaN(ahead)) return null;
  return { ahead, behind };
}

/**
 * 批量 ahead/behind：git ≥2.41 用 for-each-ref %(ahead-behind:base)；
 * 失败或旧版本回退到逐分支 rev-list。返回 ref → AheadBehind。
 */
export async function aheadBehindAll(
  repo: string,
  baseRef: string,
  refs: string[],
  useAtom: boolean,
  opts: RunGitOptions,
): Promise<Map<string, AheadBehind | null>> {
  const out = new Map<string, AheadBehind | null>();
  if (useAtom) {
    const r = await runGit(repo, ["for-each-ref", `--format=%(refname)%1f%(ahead-behind:${baseRef})`, "refs/heads"], opts);
    if (r.ok) {
      for (const line of lines(r.stdout)) {
        const [ref = "", ab = ""] = line.split(SEP);
        const [ahead, behind] = ab.trim().split(/\s+/).map(Number);
        if (ahead !== undefined && behind !== undefined && !Number.isNaN(ahead) && !Number.isNaN(behind)) {
          out.set(ref, { ahead, behind });
        }
      }
      if (refs.every((x) => out.has(x))) return out;
    }
  }
  await Promise.all(
    refs
      .filter((x) => !out.has(x))
      .map(async (ref) => {
        out.set(ref, await aheadBehind(repo, baseRef, ref, opts));
      }),
  );
  return out;
}

export function classifyMerged(ref: string, inMain: Set<string> | null, inIntegration: Set<string> | null): MergedState {
  if (inMain?.has(ref)) return "in_main";
  if (inIntegration?.has(ref)) return "in_integration";
  return "unmerged";
}

/** 不包含 ref 的本地分支（标签去重用：共同祖先上的提交不算本分支的「首条提交」） */
export async function branchesNotContaining(repo: string, ref: string, opts: RunGitOptions): Promise<string[] | null> {
  const r = await runGit(repo, ["for-each-ref", `--no-contains=${ref}`, "--format=%(refname)", "refs/heads"], opts);
  return r.ok ? lines(r.stdout) : null;
}

/**
 * 首条独有提交主题（标签用）：沿 first-parent 从旧到新，取 base..ref 中
 * 不被「不包含本分支的其他分支」共享的第一条非合并提交。
 * 例：固件仓 feat/aios-* 都从同一段 aios 基础提交分出，只看 base..ref 会得到同一个标签。
 */
export async function firstUniqueSubject(
  repo: string,
  baseRef: string,
  ref: string,
  opts: RunGitOptions,
  exclude: readonly string[] = [],
): Promise<string | null> {
  const negatives = [baseRef, ...exclude.filter((x) => x !== ref)];
  const r = await runGit(repo, ["log", "--reverse", "--first-parent", "--no-merges", "--format=%s", ref, "--not", ...negatives, "--"], opts);
  if (!r.ok) return null;
  const first = lines(r.stdout).find((l) => l.trim().length > 0);
  return first?.trim() || null;
}

/** base...ref 改动最多的一级目录（标签用） */
export async function topChangedDir(repo: string, baseRef: string, ref: string, opts: RunGitOptions): Promise<string | null> {
  const r = await runGit(repo, ["diff", "--name-only", `${baseRef}...${ref}`, "--"], opts);
  if (!r.ok) return null;
  const counts = new Map<string, number>();
  for (const f of lines(r.stdout)) {
    if (!f) continue;
    const seg = f.includes("/") ? f.split("/")[0] + "/" : f;
    counts.set(seg, (counts.get(seg) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best ? `${best}（${n} 个文件）` : null;
}

/** 集成分支第一条自有提交（first-parent）的 unix 秒 */
export async function integrationSince(repo: string, mainRef: string, integRef: string, opts: RunGitOptions): Promise<number | null> {
  const r = await runGit(repo, ["log", "--first-parent", "--reverse", "--format=%ct", `${mainRef}..${integRef}`, "--"], opts);
  if (!r.ok) return null;
  const t = Number(lines(r.stdout)[0]);
  return Number.isFinite(t) && t > 0 ? t : null;
}

export async function treeOf(repo: string, ref: string, opts: RunGitOptions): Promise<string | null> {
  const r = await runGit(repo, ["rev-parse", "--verify", "-q", `${ref}^{tree}`], opts);
  return r.ok ? (lines(r.stdout)[0] ?? null) : null;
}

/**
 * merge-tree 试合预检：不碰工作区、不碰 index、新对象写入隔离区。
 * 退出码 0=无冲突，1=有冲突；其余视为错误。
 */
export async function precheckMerge(
  repo: string,
  targetName: string,
  targetRef: string,
  targetTree: string | null,
  ref: string,
  quarantine: ObjectQuarantine,
  opts: RunGitOptions,
): Promise<PrecheckResult> {
  const r = await runGit(repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", targetRef, ref], {
    ...opts,
    env: { ...(opts.env ?? {}), ...quarantine.env },
    okExitCodes: [1],
  });
  if (r.timedOut) {
    return { target: targetName, conflictFiles: null, conflicts: [], contentEquivalent: false, timedOut: true, error: "超时" };
  }
  if (!r.ok) {
    return {
      target: targetName,
      conflictFiles: null,
      conflicts: [],
      contentEquivalent: false,
      timedOut: false,
      error: r.stderr.trim().split("\n")[0] || `退出码 ${r.code}`,
    };
  }
  const out = lines(r.stdout);
  const tree = out[0] ?? "";
  const conflicts = r.code === 1 ? [...new Set(out.slice(1).filter((l) => l.length > 0))] : [];
  return {
    target: targetName,
    conflictFiles: conflicts.length,
    conflicts,
    contentEquivalent: r.code === 0 && targetTree !== null && tree === targetTree,
    timedOut: false,
    error: null,
  };
}
