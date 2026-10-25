/**
 * milestone.todo：预约到某版、尚未合入的功能卡，按对账结果分组。
 *
 * 每张卡只进一组，按优先级（高 → 低）取第一个命中的：
 *   等你回答（绑定会话 status=blocked）
 *   > 有冲突（仅 --precheck：任一绑定分支试合冲突文件 >0）
 *   > 可合并（全部绑定分支已进集成分支/主线，或 --precheck 试合无冲突）
 *   > 落后需同步（独立未合并且落后集成分支；仓库无集成分支时看主线）
 *   > 停滞（最后活动/最后提交 ≥7 天）
 *   > 开发中（有绑定分支）
 *   > 无绑定（没有绑定，或绑定的分支已不存在）
 * 绑定分支已全部进主线、但台账状态还没更新的卡不计入待办，单独列出（doneByGit）。
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
import { canonicalPath, isUnder } from "./paths.ts";

export const STALE_DAYS = 7;

export const TODO_GROUP_DEFS: Array<{ key: TodoGroupKey; title: string; hint: string }> = [
  { key: "blocked", title: "等你回答", hint: "绑定的会话停下来等你拍板（会话最后记录的请求，可能已过期）" },
  { key: "conflict", title: "有冲突", hint: "试合到集成分支（无集成分支则主线）有冲突文件" },
  { key: "mergeable", title: "可合并", hint: "已进集成分支，或试合无冲突" },
  { key: "behind", title: "落后需同步", hint: "独立未合并，且落后集成分支（无集成分支看主线），合并前请评估是否同步基线" },
  { key: "stale", title: "停滞", hint: `最后活动/最后提交已 ≥${STALE_DAYS} 天` },
  { key: "active", title: "开发中", hint: "有绑定分支，正在推进" },
  { key: "unbound", title: "无绑定", hint: "还没绑定分支（想法），或绑定的分支已不存在" },
];

export interface TodoInput {
  milestone: LedgerMilestone;
  requested: string;
  /** 预约到该版的全部功能卡（含已合入的，函数内部过滤） */
  features: LedgerFeature[];
  report: ReconcileReport;
  sessions: SessionView[];
  /** Stop hook 记录的会话最后活动（可选） */
  stops?: StopRecord[];
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
  const doneByGit: TodoItem[] = [];

  for (const f of input.features) {
    if (DONE_STATUSES.has(f.status)) continue;
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
      };
      return { binding, repo, fv, sessions: sess };
    });

    // 最后活动：会话最后活动 / 最后提交 / Stop hook（按 worktree 路径或会话 id 匹配）
    let last: string | null = null;
    for (const r of resolved) {
      last = maxIso(last, r.binding.lastCommitAt);
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
    const blocked = resolved.flatMap((r) => r.sessions).find((s) => s.status === "blocked");
    const ok = (r: Resolved) => {
      const p = r.fv?.precheck;
      return !!p && !p.timedOut && !p.error && p.conflictFiles === 0;
    };

    let group: TodoGroupKey;
    let needsAction: string | null = null;
    if (existing.length && existing.length === resolved.length && existing.every((r) => r.fv!.mergedState === "in_main") && !blocked) {
      doneByGit.push(toItem(f, "mergeable", resolved, null, last, idleDays));
      continue;
    }
    if (blocked) {
      group = "blocked";
      needsAction = blocked.needs ?? "（会话未写明需要什么，见 heliu sessions）";
    } else if (precheck && existing.some((r) => (r.fv!.precheck?.conflictFiles ?? 0) > 0)) group = "conflict";
    else if (existing.length && existing.every((r) => r.fv!.mergedState !== "unmerged" || (precheck && ok(r)))) group = "mergeable";
    else if (existing.some((r) => r.fv!.mergedState === "unmerged" && (behindOf(r.repo!, r.fv!) ?? 0) > 0)) group = "behind";
    else if (existing.length && idleDays !== null && idleDays >= STALE_DAYS) group = "stale";
    else if (existing.length) group = "active";
    else group = "unbound";
    items.push(toItem(f, group, resolved, needsAction, last, idleDays));
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

  return { milestone: input.milestone, requested: input.requested, precheck, total: items.length, groups, doneByGit };
}

function toItem(f: LedgerFeature, group: TodoGroupKey, resolved: Resolved[], needsAction: string | null, last: string | null, idleDays: number | null): TodoItem {
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
  };
}
