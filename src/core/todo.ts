/**
 * milestone.todo：预约到某版、尚未合入的功能卡，按对账结果分组。
 *
 * 计入待办只看台账状态（承诺层事实）：想法/开发中/待合并 永远计入；已合入/已进主线/已发布/已放弃 不计入。
 * git 只负责分组与灯色，不把卡移出待办、不自动改状态（分支已被包含时只给建议）。
 *
 * 每张卡只进一组，按优先级（高 → 低）取第一个命中的：
 *   等你回答（绑定会话 status=blocked）
 *   > 有冲突（仅 --precheck：任一绑定分支试合冲突文件 >0）
 *   > 可合并（全部绑定分支有独有提交且已进主线/集成分支，或 --precheck 试合无冲突）
 *   > 落后需同步（独立未合并且落后集成分支；仓库无集成分支时看主线）
 *   > 停滞（最后活动/最后提交 ≥7 天）
 *   > 开发中（有绑定分支；绑定分支「尚无独有提交」的也在这里，标「尚无提交」）
 *   > 尚未关联开发分支（没有绑定，或绑定的分支已不存在）
 */
import type {
  FeatureView,
  LedgerFeature,
  LedgerMilestone,
  ReconcileReport,
  RepoReport,
  SessionRef,
  SessionView,
  TodoBinding,
  TodoGroup,
  TodoGroupKey,
  TodoItem,
  TodoReport,
} from "../types.ts";
import type { StopRecord } from "./cache.ts";
import { DONE_STATUSES } from "./ledger.ts";
import { bindingKey, zeroCommitByFacts } from "./owncommits.ts";
import { canonicalPath, isUnder } from "./paths.ts";

export const STALE_DAYS = 7;

export const TODO_GROUP_DEFS: Array<{ key: TodoGroupKey; title: string; hint: string }> = [
  { key: "blocked", title: "等你回答", hint: "绑定的会话停下来等你拍板（会话最后记录的请求，可能已过期）" },
  { key: "conflict", title: "有冲突", hint: "试合到集成分支（无集成分支则主线）有冲突文件" },
  { key: "mergeable", title: "可合并", hint: "已进集成分支，或试合无冲突" },
  { key: "behind", title: "落后需同步", hint: "独立未合并，且落后集成分支（无集成分支看主线），合并前请评估是否同步基线" },
  { key: "stale", title: "停滞", hint: `最后活动/最后提交已 ≥${STALE_DAYS} 天` },
  { key: "active", title: "开发中", hint: "有绑定分支，正在推进" },
  { key: "unbound", title: "尚未关联开发分支", hint: "还没绑定分支（想法），或绑定的分支已不存在" },
];

/** 计入待办的唯一判据（待办列表与 milestone list 的计数共用）：只看台账状态 */
export function countsTowardTodo(f: LedgerFeature): boolean {
  return !DONE_STATUSES.has(f.status);
}

/** 预约到某版且计入待办的卡（effective = 卡片里写的里程碑 → 实际 id，next 别名已解析） */
export function todoFeatures(features: LedgerFeature[], milestoneId: string, effective: (f: LedgerFeature) => string | null): LedgerFeature[] {
  return features.filter((f) => effective(f) === milestoneId && countsTowardTodo(f));
}

export interface TodoInput {
  milestone: LedgerMilestone;
  requested: string;
  /** 预约到该版的全部功能卡（含已合入的，函数内部过滤） */
  features: LedgerFeature[];
  report: ReconcileReport;
  sessions: SessionView[];
  /** Stop hook 记录的会话最后活动（可选） */
  stops?: StopRecord[];
  /** 「尚无独有提交」的绑定（bindingKey）；缺省按纯事实判定（同点或领先 0），ops 层会用 reflog 精化 */
  zeroCommit?: Set<string>;
  /** 当前下一版 */
  nextMilestone?: { id: string; status: LedgerMilestone["status"] } | null;
  now?: Date;
}

const maxIso = (a: string | null, b: string | null): string | null => (!a ? b : !b ? a : a > b ? a : b);

interface Resolved {
  binding: TodoBinding;
  repo: RepoReport | null;
  fv: FeatureView | null;
  sessions: Array<{ id: string; status: SessionView["status"] | SessionRef["status"]; needs: string | null; at: string | null }>;
}

function behindOf(repo: RepoReport, fv: FeatureView): number | null {
  return (repo.integration ? fv.vsIntegration?.behind : fv.vsMain?.behind) ?? null;
}

export function groupTodo(input: TodoInput): TodoReport {
  const now = input.now ?? new Date();
  const precheck = input.report.options.precheck;
  const sessionsById = new Map(input.sessions.map((s) => [s.sessionId, s]));
  const repos = new Map(input.report.repos.map((r) => [r.id, r]));
  const stops = input.stops ?? [];

  const items: TodoItem[] = [];

  for (const f of input.features) {
    if (!countsTowardTodo(f)) continue;
    const resolved: Resolved[] = f.bindings.map((b) => {
      const repo = repos.get(b.repo) ?? null;
      const fv = repo?.reachable ? (repo.branches.find((x) => x.branch === b.branch) ?? null) : null;
      // 绑定会话：卡片上写明的会话 + 对账里以「记录」关联到该分支的会话
      const sess: Resolved["sessions"] = [];
      const seen = new Set<string>();
      if (b.session) {
        const sv = sessionsById.get(b.session);
        if (sv) {
          sess.push({ id: sv.sessionId, status: sv.status, needs: sv.needsAction?.trim() || sv.statusDetail?.trim() || null, at: sv.lastActivityAt });
          seen.add(sv.sessionId);
        }
      }
      for (const s of fv?.sessions ?? []) {
        if (s.link !== "branch" || seen.has(s.sessionId)) continue;
        const sv = sessionsById.get(s.sessionId);
        sess.push({ id: s.sessionId, status: s.status, needs: s.needsAction?.trim() || sv?.statusDetail?.trim() || null, at: s.lastActivityAt });
        seen.add(s.sessionId);
      }
      const main = sess[0];
      const noCommits = !!fv && !!repo && (input.zeroCommit ? input.zeroCommit.has(bindingKey(b.repo, b.branch)) : zeroCommitByFacts(repo, fv));
      const binding: TodoBinding = {
        repo: b.repo,
        repoLabel: repo?.label ?? b.repo,
        branch: b.branch,
        exists: !!fv,
        mergedState: fv?.mergedState ?? null,
        behindMain: fv?.vsMain?.behind ?? null,
        behindIntegration: fv?.vsIntegration?.behind ?? null,
        conflictFiles: fv?.precheck?.conflictFiles ?? null,
        sessionId: main?.id ?? b.session ?? null,
        sessionStatus: main?.status ?? null,
        lastCommitAt: fv?.lastCommitAt ?? null,
        noCommits,
      };
      return { binding, repo, fv, sessions: sess };
    });

    // 最后活动：会话最后活动 / 最后提交 / Stop hook（按 worktree 路径或会话 id 匹配）
    let last: string | null = null;
    for (const r of resolved) {
      // 尚无提交的分支，最后提交其实是主线上的提交，不算本功能的活动
      if (!r.binding.noCommits) last = maxIso(last, r.binding.lastCommitAt);
      for (const s of r.sessions) last = maxIso(last, s.at);
      const wt = f.bindings.find((b) => b.repo === r.binding.repo && b.branch === r.binding.branch)?.worktree ?? r.fv?.worktree?.path ?? null;
      const wtReal = wt ? canonicalPath(wt) : null;
      for (const st of stops) {
        const hit =
          r.sessions.some((s) => s.id === st.sessionId || sessionsById.get(s.id)?.cliSessionId === st.sessionId) ||
          (!!wtReal && !!st.cwd && isUnder(canonicalPath(st.cwd), wtReal));
        if (hit) last = maxIso(last, new Date(st.at).toISOString());
      }
    }
    const idleDays = last ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000) : null;

    const existing = resolved.filter((r) => r.fv);
    // 有独有提交的绑定才参与「已合入 / 落后 / 冲突」判断；尚无提交的分支没有任何工作可合
    const working = existing.filter((r) => !r.binding.noCommits);
    const blocked = resolved.flatMap((r) => r.sessions).find((s) => s.status === "blocked");
    const ok = (r: Resolved) => {
      const p = r.fv?.precheck;
      return !!p && !p.timedOut && !p.error && p.conflictFiles === 0;
    };

    let group: TodoGroupKey;
    let needsAction: string | null = null;
    let note: string | null = null;
    let suggestion: string | null = null;
    if (blocked) {
      group = "blocked";
      needsAction = blocked.needs ?? "（会话未写明需要什么，见 heliu sessions）";
      if (existing.length && !working.length) note = "尚无提交";
    } else if (existing.length && !working.length) {
      group = "active";
      note = "尚无提交";
    } else if (precheck && working.some((r) => r.fv!.mergedState === "unmerged" && (r.fv!.precheck?.conflictFiles ?? 0) > 0)) {
      group = "conflict";
    } else if (working.length && working.length === existing.length && working.every((r) => r.fv!.mergedState !== "unmerged" || (precheck && ok(r)))) {
      group = "mergeable";
      if (working.every((r) => r.fv!.mergedState === "in_main")) {
        note = "已进主线";
        suggestion = `该分支已进主线，是否把 ${f.id} 标为已进主线？（heliu feature status ${f.id} 已进主线）`;
      } else if (working.every((r) => r.fv!.mergedState !== "unmerged")) {
        note = "已进集成分支";
        if (f.status !== "已合入") suggestion = `该分支已被集成分支包含，是否把 ${f.id} 标为已合入？（heliu feature status ${f.id} 已合入）`;
      } else note = "试合无冲突";
    } else if (working.some((r) => r.fv!.mergedState === "unmerged" && (behindOf(r.repo!, r.fv!) ?? 0) > 0)) group = "behind";
    else if (existing.length && idleDays !== null && idleDays >= STALE_DAYS) group = "stale";
    else if (existing.length) group = "active";
    else group = "unbound";
    items.push(toItem(f, group, resolved, needsAction, last, idleDays, note, suggestion));
  }

  const groups: TodoGroup[] = TODO_GROUP_DEFS.map((d) => {
    const list = items.filter((i) => i.group === d.key);
    list.sort(
      (a, b) =>
        Number(b.rolledFrom.length > 0) - Number(a.rolledFrom.length > 0) ||
        (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") ||
        a.id.localeCompare(b.id),
    );
    return { key: d.key, title: d.title, hint: d.hint, count: d.key === "conflict" && !precheck ? null : list.length, items: list };
  });

  return { milestone: input.milestone, requested: input.requested, precheck, total: items.length, groups, doneByGit: [], nextMilestone: input.nextMilestone ?? null };
}

function toItem(
  f: LedgerFeature,
  group: TodoGroupKey,
  resolved: Resolved[],
  needsAction: string | null,
  last: string | null,
  idleDays: number | null,
  note: string | null,
  suggestion: string | null,
): TodoItem {
  return {
    id: f.id,
    title: f.title,
    status: f.status,
    acceptance: f.acceptance,
    rolledFrom: f.rolled_from,
    group,
    bindings: resolved.map((r) => r.binding),
    needsAction,
    lastActivityAt: last,
    idleDays,
    file: f.file,
    note,
    suggestion,
  };
}
