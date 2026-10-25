import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { heliuPaths } from "../src/core/paths.ts";
import type { ProjectConfig } from "../src/core/project.ts";
import { reconcile, type ReconcileResult } from "../src/core/reconcile.ts";
import type { FeatureView, RepoReport } from "../src/types.ts";
import { B, buildFixture, gitSnapshot, type Fixture } from "./helpers/fixture.ts";

let fx: Fixture;
let res: ReconcileResult;
let repo: RepoReport;
let snapBefore: string;
let snapAfter: string;
const NOW = new Date("2026-10-30T12:00:00+08:00");

const br = (name: string): FeatureView => {
  const b = repo.branches.find((x) => x.branch === name);
  if (!b) throw new Error(`缺分支 ${name}`);
  return b;
};

beforeAll(async () => {
  fx = buildFixture();
  const notGit = join(fx.root, "not-a-repo");
  mkdirSync(notGit);
  const project: ProjectConfig = {
    name: "测试项目",
    source: "(内存)",
    repos: [
      { id: "main", label: "主仓", path: fx.repo, main: "main", integration: "integ", remote: "origin", icloud: false },
      { id: "missing", label: "缺失仓", path: join(fx.root, "nope"), main: "main", integration: null, remote: null, icloud: false },
      { id: "plain", label: "非仓库", path: notGit, main: "main", integration: null, remote: null, icloud: false },
    ],
  };
  snapBefore = gitSnapshot(fx.repo);
  // 预检 + 脏检查全开：最重的路径也必须零写入
  res = await reconcile(project, heliuPaths(fx.env), { precheck: true, dirty: true, timeoutMs: 8000 }, { now: NOW });
  snapAfter = gitSnapshot(fx.repo);
  repo = res.report.repos[0]!;
}, 60_000);

afterAll(() => fx.cleanup());

describe("对账结果", () => {
  test("零写入：.git 下所有文件 mtime/大小不变（含 --precheck 与 worktree 脏检查）", () => {
    expect(snapAfter).toBe(snapBefore);
  });

  test("计数", () => {
    expect(repo.reachable).toBe(true);
    expect(repo.error).toBeNull();
    expect(repo.counts).toEqual({
      branches: 8,
      worktrees: 4,
      mergedIntoMain: 3, // main、merged-main、at-tip
      unmergedIntoMain: 5,
      inIntegration: 1,
      independent: 3, // bold-shaw、conflict、behind
      neverPushed: 6, // 只有 main 与 in-integ 有远端引用
    });
  });

  test("合并三档与角色", () => {
    expect(br(B.main).role).toBe("main");
    expect(br(B.integ).role).toBe("integration");
    expect(br(B.integ).mergedState).toBe("unmerged");
    expect(br(B.mergedMain).mergedState).toBe("in_main");
    expect(br(B.atTip).mergedState).toBe("in_main");
    expect(br(B.inInteg).mergedState).toBe("in_integration");
    expect(br(B.standalone).mergedState).toBe("unmerged");
    expect(br(B.conflict).mergedState).toBe("unmerged");
    expect(br(B.behind).mergedState).toBe("unmerged");
  });

  test("领先/落后", () => {
    expect(br(B.behind).vsMain).toEqual({ ahead: 1, behind: 4 });
    expect(br(B.standalone).vsMain).toEqual({ ahead: 2, behind: 0 });
    expect(br(B.inInteg).vsIntegration).toEqual({ ahead: 0, behind: 2 });
    expect(br(B.integ).vsMain).toEqual({ ahead: 3, behind: 0 });
    expect(br(B.integ).vsIntegration).toBeNull();
    expect(br(B.main).vsMain).toBeNull();
  });

  test("worktree 关联与脏检查", () => {
    expect(br(B.standalone).worktree?.dirName).toBe("bold-shaw-cccccc");
    expect(br(B.behind).worktree?.dirName).toBe("reused-dir-eeeeee");
    expect(br(B.main).worktree?.isMain).toBe(true);
    expect(br(B.inInteg).worktree).toBeNull();
    expect(repo.worktrees.length).toBe(5);
    expect(repo.worktrees.every((w) => w.dirty === "clean")).toBe(true);
    expect(repo.worktrees.find((w) => w.dirName === "bold-shaw-cccccc")?.leasedBy).toBe("local_full");
  });

  test("卫生检查", () => {
    const kinds = repo.hygiene.map((h) => h.kind).sort();
    expect(kinds).toEqual(["dir_branch_mismatch", "index_lock", "merged_worktree_remains", "orphan_admin_dir", "worktree_no_commits"]);
    expect(repo.hygiene.find((h) => h.kind === "dir_branch_mismatch")?.branch).toBe(B.behind);
    expect(repo.hygiene.find((h) => h.kind === "orphan_admin_dir")?.path?.endsWith("/worktrees/x")).toBe(true);
    expect(repo.hygiene.find((h) => h.kind === "index_lock")?.path?.endsWith("bold-shaw-cccccc/index.lock")).toBe(true);
    expect(repo.hygiene.find((h) => h.kind === "merged_worktree_remains")?.branch).toBe(B.mergedMain);
    expect(repo.hygiene.find((h) => h.kind === "worktree_no_commits")?.branch).toBe(B.atTip);
  });

  test("标签：会话标题 > 首条独有提交 > 末次提交", () => {
    expect(br(B.standalone).randomName).toBe(true);
    expect(br(B.standalone).label).toBe("实现 EPP 网关 v0（代调 MCP / CLI）");
    expect(br(B.standalone).labelSource).toBe("session");
    expect(br(B.behind).label).toBe("已归档的旧会话：老分支调研");
    expect(br(B.inInteg).label).toBe("已进集成的功能");
    expect(br(B.inInteg).labelSource).toBe("first_commit");
    expect(br(B.integ).label).toBe("integ: 改 README");
    expect(br(B.mergedMain).labelSource).toBe("tip_commit");
    expect(br(B.main).label).toBe("主线");
    expect(repo.branches.every((b) => b.label.length > 0)).toBe(true);
  });

  test("会话关联：按分支名强关联、writtenBranches、运行中状态", () => {
    const s = br(B.standalone).sessions;
    expect(s[0]?.sessionId).toBe("local_full");
    expect(s[0]?.status).toBe("running");
    expect(s[0]?.prs[0]?.number).toBe(3);
    const behind = br(B.behind).sessions.map((x) => [x.sessionId, x.link]);
    expect(behind).toEqual([
      ["local_archived", "branch"],
      ["local_weird", "written"],
    ]);
    expect(res.report.sessions.total).toBe(4); // local_other 属于别的目录
    expect(res.report.sessions.parseErrors).toBe(2);
    expect(res.sessions.map((x) => x.sessionId).sort()).toEqual(["local_archived", "local_full", "local_minimal", "local_weird"]);
  });

  test("会话 → 分支的关联来源（记录 > 写入 > 目录）与目录当前分支（M1 遗留修复）", () => {
    const by = new Map(res.sessions.map((x) => [x.sessionId, x]));
    expect(by.get("local_full")).toMatchObject({ linkedBranch: B.standalone, branchLink: "branch", dirBranch: B.standalone });
    // 无 branch 字段：取 writtenBranches；会话目录 reused-dir-eeeeee 现在检出的是 behind 分支
    expect(by.get("local_weird")).toMatchObject({ linkedBranch: B.behind, branchLink: "written", dirBranch: B.behind });
    // 只有 cwd（主目录），没有记录/写入：不按主目录推断分支
    expect(by.get("local_minimal")).toMatchObject({ linkedBranch: null, branchLink: null, dirBranch: "main" });
  });

  test("merge-tree 预检：冲突文件数与目标", () => {
    expect(br(B.conflict).precheck).toMatchObject({ target: "integ", conflictFiles: 1, conflicts: ["README.md"], timedOut: false });
    expect(br(B.standalone).precheck).toMatchObject({ target: "integ", conflictFiles: 0, contentEquivalent: false });
    expect(br(B.integ).precheck).toMatchObject({ target: "main", conflictFiles: 0 });
    expect(br(B.inInteg).precheck).toBeNull();
    expect(br(B.mergedMain).precheck).toBeNull();
  });

  test("健康条", () => {
    const h = repo.health!;
    expect(h.mainVsRemote).toMatchObject({ remoteRef: "refs/remotes/origin/main", ahead: 4, behind: 0 });
    expect(h.integration).toMatchObject({ branch: "integ", exists: true, mergedIntoMain: false, aheadOfMain: 3 });
    expect(typeof h.integration?.unmergedDays).toBe("number");
    expect(h.worktreeDirty).toEqual({ clean: 5, dirty: 0, unknown: 0, skipped: 0 });
    expect(h.hygieneWarnings).toBe(3);
  });

  test("分支按最后提交倒序", () => {
    const ts = repo.branches.map((b) => b.lastCommitAt ?? "");
    expect([...ts].sort().reverse()).toEqual(ts);
  });

  test("不可达仓库被跳过且给出原因", () => {
    const [, missing, plain] = res.report.repos;
    expect(missing).toMatchObject({ reachable: false, error: "路径不存在", branches: [] });
    expect(plain).toMatchObject({ reachable: false, error: "不是 git 仓库" });
  });

  test("JSON 结构稳定", () => {
    const j = JSON.parse(JSON.stringify(res.report));
    expect(j.schemaVersion).toBe(1);
    expect(Object.keys(j).sort()).toEqual(["elapsedMs", "generatedAt", "options", "project", "repos", "schemaVersion", "sessions"]);
    expect(Object.keys(j.repos[0].branches[0]).sort()).toEqual(
      [
        "branch", "label", "labelSource", "lastCommitAt", "lastCommitSubject", "mergedState", "precheck", "pushed",
        "randomName", "ref", "role", "sessions", "sha", "upstream", "vsIntegration", "vsMain", "worktree",
      ].sort(),
    );
  });
});

describe("iCloud 仓默认跳过脏检查", () => {
  test("icloud: true 且未加 --dirty → 全部 skipped，主目录给提示", async () => {
    const project: ProjectConfig = {
      name: "icloud",
      source: "(内存)",
      repos: [{ id: "r", label: "r", path: fx.repo, main: "main", integration: null, remote: null, icloud: true }],
    };
    const before = gitSnapshot(fx.repo);
    const r = await reconcile(project, heliuPaths(fx.env), { precheck: false, dirty: false, timeoutMs: 8000 }, { now: NOW });
    expect(gitSnapshot(fx.repo)).toBe(before);
    const rep = r.report.repos[0]!;
    expect(rep.worktrees.every((w) => w.dirty === "skipped")).toBe(true);
    expect(rep.hygiene.find((h) => h.kind === "main_dirty")?.severity).toBe("info");
    // 未配置集成分支：in-integ 只算独立未合并
    expect(rep.branches.find((b) => b.branch === B.inInteg)?.mergedState).toBe("unmerged");
    expect(rep.branches.find((b) => b.branch === B.inInteg)?.vsIntegration).toBeNull();
  });
});
