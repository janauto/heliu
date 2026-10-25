/**
 * sync：自动草稿——把「在 worktree 里开发、还没有功能卡、也没进主线」的分支登记成草稿卡。
 *
 * - 标题：关联会话标题（关联来源优先级 记录 > 写入 > 目录），没有会话则用 M1 标签。
 * - 状态：主会话 status_category=completed → 待合并；其余（含 blocked）→ 开发中。
 * - 预约：下一版（next）；来源 source: sync。
 * - 绑定：repo / branch / worktree / session / pr。
 * - 去重：按 仓库 + 分支，已有卡片（任何状态，含已放弃）的分支不再建。
 * - 「未进主线」按承诺层口径：尚无独有提交的分支（与主线同点 / reflog 显示自创建后未提交）虽然 git 祖先判断为
 *   「已进主线」，但没有任何工作被合入，照样建草稿（标「尚无提交」，状态 开发中）。
 * - dry-run：只列出将要建的草稿，不写任何文件（包括不自动建 vNext）。
 */
import type { FeatureBinding, FeatureStatus, FeatureView, LedgerFeature, SessionLink } from "../types.ts";
import { humanizeBranch } from "./labels.ts";
import { Ledger } from "./ledger.ts";
import { bindingKey, sourceBranchIndex, zeroCommitBranches } from "./owncommits.ts";
import type { HeliuPaths } from "./paths.ts";
import type { ProjectConfig } from "./project.ts";
import { reconcile, type ReconcileResult } from "./reconcile.ts";

export interface SyncDraft {
  repo: string;
  repoLabel: string;
  branch: string;
  worktree: string;
  session: string | null;
  sessionTitle: string | null;
  /** 会话与分支的关联来源 */
  sessionLink: SessionLink | null;
  sessionStatus: string | null;
  title: string;
  titleSource: "session" | "label";
  status: FeatureStatus;
  pr: number | null;
  lastCommitAt: string | null;
  mergedState: FeatureView["mergedState"];
  /** 尚无独有提交（与主线同点或自创建后未提交） */
  noCommits: boolean;
  /** 写入后的卡号（dry-run 为 null） */
  id: string | null;
}

export interface SyncResult {
  dryRun: boolean;
  ledgerDir: string;
  /** 草稿预约到的里程碑 id（dry-run 且尚无「规划中」时为 null，表示将自动建 vNext） */
  milestone: string | null;
  milestoneWillBeCreated: boolean;
  drafts: SyncDraft[];
  skipped: { hasCard: number; inMain: number; noWorktree: number; notFeature: number };
  created: LedgerFeature[];
}

export interface SyncOptions {
  dryRun: boolean;
  now?: Date;
  /** 已有对账结果（测试/复用），缺省现跑一次（不预检、不做脏检查） */
  reconciled?: ReconcileResult;
}

/** 收集草稿候选（纯函数，便于测试） */
export function collectDrafts(
  _project: ProjectConfig,
  rec: ReconcileResult,
  existing: LedgerFeature[],
  zeroCommit: Set<string> = new Set(),
): { drafts: SyncDraft[]; skipped: SyncResult["skipped"] } {
  const skipped = { hasCard: 0, inMain: 0, noWorktree: 0, notFeature: 0 };
  const bound = new Set<string>();
  for (const f of existing) for (const b of f.bindings) bound.add(`${b.repo}\u0000${b.branch}`);
  const drafts: SyncDraft[] = [];
  const statusById = new Map(rec.sessions.map((s) => [s.sessionId, s]));
  for (const repo of rec.report.repos) {
    if (!repo.reachable) continue;
    const ordered = [...repo.branches].sort((a, b) => (a.lastCommitAt ?? "").localeCompare(b.lastCommitAt ?? "") || a.branch.localeCompare(b.branch));
    for (const fv of ordered) {
      if (fv.role !== "feature") {
        skipped.notFeature++;
        continue;
      }
      const noCommits = zeroCommit.has(bindingKey(repo.id, fv.branch));
      if (fv.mergedState === "in_main" && !noCommits) {
        skipped.inMain++;
        continue;
      }
      if (!fv.worktree || fv.worktree.isMain) {
        skipped.noWorktree++;
        continue;
      }
      const key = `${repo.id}\u0000${fv.branch}`;
      if (bound.has(key)) {
        skipped.hasCard++;
        continue;
      }
      bound.add(key);
      // FeatureView.sessions 已按 记录 > 写入 > 目录、未归档优先、最后活动倒序排好
      const s = fv.sessions[0] ?? null;
      const sv = s ? statusById.get(s.sessionId) : undefined;
      // 尚无提交的分支没有自己的提交主题，M1 标签会落到主线最后一条提交上，改用分支名
      const title = s?.title?.trim() || (noCommits ? humanizeBranch(fv.branch) : fv.label);
      const pr = s?.prs.find((p) => !p.branch || p.branch === fv.branch)?.number ?? null;
      drafts.push({
        repo: repo.id,
        repoLabel: repo.label,
        branch: fv.branch,
        worktree: fv.worktree.path,
        session: s?.sessionId ?? null,
        sessionTitle: s?.title ?? null,
        sessionLink: s?.link ?? null,
        sessionStatus: s?.statusCategory ?? sv?.statusCategory ?? null,
        title,
        titleSource: s?.title?.trim() ? "session" : "label",
        status: !noCommits && (s?.statusCategory ?? null) === "completed" ? "待合并" : "开发中",
        pr,
        lastCommitAt: fv.lastCommitAt,
        mergedState: fv.mergedState,
        noCommits,
        id: null,
      });
    }
  }
  return { drafts, skipped };
}

export async function syncLedger(project: ProjectConfig, paths: HeliuPaths, opts: SyncOptions): Promise<SyncResult> {
  const ledger = Ledger.of(project);
  const rec = opts.reconciled ?? (await reconcile(project, paths, { precheck: false, dirty: false, timeoutMs: 8000 }));
  const existing = ledger.load().features;
  // 已被主线/集成分支包含、有独立 worktree 的功能分支：判定是否「尚无独有提交」
  const candidates = rec.report.repos.flatMap((r) =>
    r.reachable ? r.branches.filter((b) => b.role === "feature" && b.mergedState !== "unmerged" && b.worktree && !b.worktree.isMain).map((b) => ({ repo: r.id, branch: b.branch })) : [],
  );
  const zero = await zeroCommitBranches(rec.report, candidates, { sourceOf: sourceBranchIndex(paths, rec.report) });
  const { drafts, skipped } = collectDrafts(project, rec, existing, zero);
  const next = ledger.resolveMilestone("next", { create: false });
  const result: SyncResult = {
    dryRun: opts.dryRun,
    ledgerDir: ledger.dir,
    milestone: next?.milestone.id ?? null,
    milestoneWillBeCreated: !next,
    drafts,
    skipped,
    created: [],
  };
  if (opts.dryRun || !drafts.length) return result;

  for (const d of drafts) {
    const binding: FeatureBinding = { repo: d.repo, branch: d.branch, worktree: d.worktree, session: d.session, pr: d.pr };
    const why = d.titleSource === "session" ? `会话「${d.sessionTitle}」` : "分支标签（无关联会话）";
    const body = `${d.title}\n\n> 由 heliu sync 自动生成的草稿：标题取自${why}${d.noCommits ? "；分支尚无独有提交" : ""}。请确认标题与预约版本（heliu 预约 <卡号> <版本>）。`;
    const { feature, milestoneCreated } = ledger.addFeature({ title: d.title, milestone: "next", bindings: [binding], body, source: "sync", status: d.status, now: opts.now });
    if (milestoneCreated) {
      result.milestone = milestoneCreated.id;
    }
    d.id = feature.id;
    result.created.push(feature);
  }
  result.milestoneWillBeCreated = false;
  return result;
}
