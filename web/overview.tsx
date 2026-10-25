/** @jsxImportSource preact */
/** 总览：现在最该做的（M1 摘要逻辑）+ 各版本还欠什么 + 每仓库健康条（每个数字旁有中文解释）。 */
import type { OverviewData } from "../src/board/api-types.ts";
import type { ReconcileReport, RepoReport } from "../src/types.ts";
import type { Tab } from "./main.tsx";

export function OverviewPage({ status, overview, go }: { tick: number; status: ReconcileReport | null; overview: OverviewData | null; go: (t: Tab) => void }) {
  if (!status || !overview) return <p class="muted">正在对账（只读扫描，通常不到 2 秒）…</p>;
  return (
    <div>
      <h2>现在最该做的</h2>
      <div class="panel">
        {overview.actions.length ? (
          <ol class="actions">
            {overview.actions.map((a) => (
              <li>{a}</li>
            ))}
          </ol>
        ) : (
          <p class="ok">暂时没有需要马上处理的事。</p>
        )}
        <p class="muted small">箭头前是事实，箭头后是建议；heliu 不会替你执行任何 git 写操作。</p>
      </div>

      <h2>各版本还欠什么</h2>
      <div class="panel">
        {overview.columns.map((c) => (
          <div class="metric">
            <span class="k">
              {c.title}
              {c.isNext ? (
                <>
                  {" "}
                  <span class="badge next">下一版</span>
                </>
              ) : null}
            </span>
            <span class="v">
              还欠 <b>{c.owed}</b> 项 · 可合 <b>{c.mergeable}</b> · 冲突 <b>{c.conflict ?? "未检查"}</b> · 等你 <b>{c.waiting}</b>{" "}
              <a href="#/board" onClick={(e) => (e.preventDefault(), go("board"))}>
                看版本列
              </a>
            </span>
          </div>
        ))}
        <p class="muted small">还欠 = 预约到这一版、台账状态还是 想法/开发中/待合并 的功能；可合 / 冲突来自试合（merge-tree，在临时区进行，不碰仓库）；等你 = 绑定的会话停下来等你回答。</p>
      </div>

      <h2>仓库健康</h2>
      <p class="muted small">↑ = 比基线多的提交（自己的工作），↓ = 落后基线的提交。远端对比只基于本地已有引用，heliu 从不 fetch。</p>
      <div class="health">
        {status.repos.map((r) => (
          <RepoHealth r={r} go={go} />
        ))}
      </div>
    </div>
  );
}

function RepoHealth({ r, go }: { r: RepoReport; go: (t: Tab) => void }) {
  if (!r.reachable || !r.counts || !r.health) {
    return (
      <div class="panel">
        <h3>{r.label}</h3>
        <p class="err">无法读取：{r.error ?? "不可达"}（heliu doctor 查看详情）</p>
      </div>
    );
  }
  const c = r.counts;
  const h = r.health;
  const m = h.mainVsRemote;
  const i = h.integration;
  const d = h.worktreeDirty;
  const remote = m?.remoteRef.replace(/^refs\/remotes\//, "") ?? "";
  return (
    <div class="panel">
      <h3>
        {r.label} <span class="muted small">主线 {r.main}{r.icloud ? " · iCloud" : ""}</span>
      </h3>
      {r.error ? <p class="err small">{r.error}</p> : null}
      <div class="metric">
        <span class="k">主线 vs 远端</span>
        <span class="v">
          {m && m.ahead !== null && m.behind !== null ? (
            <>
              <b>
                ↑{m.ahead} ↓{m.behind}
              </b>
              <span class="why">
                {m.ahead === 0 && m.behind === 0
                  ? `与 ${remote} 一致`
                  : `本地主线比 ${remote} 多 ${m.ahead} 个提交、少 ${m.behind} 个${m.ahead > 0 && m.behind > 0 ? "（已分叉）" : ""}`}
              </span>
            </>
          ) : (
            <span class="why">{m?.note ?? "未配置远端"}</span>
          )}
        </span>
      </div>
      {i ? (
        <div class={`metric${i.exists && !i.mergedIntoMain && (i.unmergedDays ?? 0) >= 3 ? " red" : ""}`}>
          <span class="k">集成分支</span>
          <span class="v">
            {!i.exists ? (
              <span class="why">集成分支 {i.branch} 在本地不存在</span>
            ) : i.mergedIntoMain ? (
              <span class="why">已并回主线</span>
            ) : (
              <>
                领先 <b>{i.aheadOfMain ?? "?"}</b> · <b>{i.unmergedDays ?? "?"}</b> 天未并回
                <span class="why">
                  {i.branch} 比主线多 {i.aheadOfMain ?? "?"} 个提交，从 {i.since ? i.since.slice(0, 10) : "?"} 起一直没合回主线
                  {(i.unmergedDays ?? 0) >= 3 ? "（≥3 天，标红）" : ""}
                </span>
              </>
            )}
          </span>
        </div>
      ) : null}
      <div class="metric">
        <span class="k">无远端引用</span>
        <span class="v">
          <b>{c.neverPushed}</b> 个分支
          <span class="why">本地找不到同名远端引用（可能从没推送过，也可能只是没 fetch）</span>
        </span>
      </div>
      <div class="metric">
        <span class="k">worktree</span>
        <span class="v">
          <b>{c.worktrees}</b> 个
          <span class="why">
            {[
              d.dirty ? `有未提交改动 ${d.dirty}` : "",
              d.unknown ? `检查超时/未知 ${d.unknown}` : "",
              d.clean ? `已跟踪文件干净 ${d.clean}` : "",
              d.skipped ? `未检查 ${d.skipped}（iCloud 仓默认跳过，避免触发下载）` : "",
            ]
              .filter(Boolean)
              .join(" · ") || "—"}
          </span>
        </span>
      </div>
      <div class="metric">
        <span class="k">已进主线</span>
        <span class="v">
          <b>{c.mergedIntoMain}</b> / {c.branches} 个分支
          <span class="why">
            提交已被主线包含（不代表功能已验收）；未进主线 {c.unmergedIntoMain}
            {r.integration ? `（其中已进集成分支 ${c.inIntegration}、独立 ${c.independent}）` : ""}
          </span>
        </span>
      </div>
      <div class="metric">
        <span class="k">卫生</span>
        <span class="v">
          警告 <b>{h.hygieneWarnings}</b> · 提示 {h.hygieneInfos}{" "}
          <a href="#/hygiene" onClick={(e) => (e.preventDefault(), go("hygiene"))}>
            看卫生页
          </a>
        </span>
      </div>
    </div>
  );
}
