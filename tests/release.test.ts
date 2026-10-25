/**
 * M4 合并执行：写模式运行器白名单、union 纯函数、解冲突器参数、合并单预演/刷新、run --dry-run / base_sha 闸 / run --yes / rollback、
 * checks 失败、CLI 别名。
 *
 * fixture：主线 main + 集成分支 integ；
 *   f1/f2/f3 无冲突（各加一个文件）· fu 与集成分支同处改 README.md（union 文件）· fc 与集成分支同行改 src.txt（普通冲突，桩解冲突器用 --ours）·
 *   fb 未完成（绑定会话 blocked）· fi 已进集成分支。
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { assertWriteAllowed, GitForbiddenError, runGitWrite } from "../src/core/git.ts";
import { Ledger } from "../src/core/ledger.ts";
import { heliuPaths } from "../src/core/paths.ts";
import { loadProject } from "../src/core/project.ts";
import { previewRelease, setPlanDecision } from "../src/core/release.ts";
import { loadPlan, parsePlan, serializePlan } from "../src/core/release-plan.ts";
import { rollbackRelease, runRelease } from "../src/core/release-run.ts";
import { buildResolverPrompt, parseResolverOutput, resolverArgs, resolverBinary } from "../src/core/resolver.ts";
import { combineHunk, entryDate, unionFromMarkers } from "../src/core/union.ts";
import { gitW } from "./helpers/fixture.ts";
import { buildReleaseFixture, type RFx } from "./helpers/release-fixture.ts";

const BIN = join(import.meta.dir, "..", "bin", "heliu");

function refsOf(repo: string): string {
  return gitW(repo, "for-each-ref", "--format=%(refname) %(objectname)");
}
const isAncestor = (repo: string, a: string, b: string): boolean =>
  Bun.spawnSync({ cmd: ["git", "-C", repo, "merge-base", "--is-ancestor", a, b] }).exitCode === 0;

let fx: RFx;
const savedEnv: Record<string, string | undefined> = {};
function useEnv(env: Record<string, string>): void {
  for (const [k, v] of Object.entries(env)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}

beforeAll(() => {
  fx = buildReleaseFixture();
  useEnv(fx.env);
});
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(fx.root, { recursive: true, force: true });
});

const project = () => loadProject(heliuPaths({ ...process.env, ...fx.env }), "演示");
const paths = () => heliuPaths({ ...process.env, ...fx.env });

describe("写模式运行器（runGitWrite 白名单）", () => {
  const opts = () => ({ cacheRoot: fx.cache, allowRefs: ["refs/heads/integ", "refs/tags/v1.2"] });
  const deny = (cwd: string, args: string[]) => expect(() => assertWriteAllowed(cwd, args, opts())).toThrow(GitForbiddenError);
  const allow = (cwd: string, args: string[]) => expect(() => assertWriteAllowed(cwd, args, opts())).not.toThrow();
  const Z = "0".repeat(40);
  const A = "a".repeat(40);
  const Bs = "b".repeat(40);

  test("拒绝 push / fetch / pull / branch -d / gc / config", () => {
    for (const a of [["push", "origin", "integ"], ["fetch", "origin"], ["pull"], ["branch", "-d", "x"], ["gc"], ["config", "user.name", "x"], ["stash"], ["clean", "-fd"]]) deny(fx.repo, a);
  });
  test("reset --hard / checkout / merge / commit / add 只允许在 heliu 临时目录内", () => {
    deny(fx.repo, ["reset", "--hard", "HEAD"]);
    deny(fx.repo, ["checkout", "main"]);
    deny(fx.repo, ["merge", "--no-commit", "feat/f1"]);
    deny(fx.repo, ["commit", "-m", "x"]);
    deny(fx.repo, ["add", "README.md"]);
    const wt = join(fx.cache, "worktrees", "演示", "v1.2", "docs");
    allow(wt, ["reset", "--hard", "-q", A]);
    allow(wt, ["merge", "--no-commit", "--no-ff", A]);
    allow(wt, ["add", "--", "README.md"]);
    deny(wt, ["add", "-A"]);
    deny(wt, ["commit", "--amend", "-m", "x"]);
    deny(wt, ["merge", "-s", "ours", A]);
  });
  test("update-ref 必须带旧值、只许写允许的引用；不允许 -d / --stdin", () => {
    allow(fx.repo, ["update-ref", "-m", "x", "refs/heads/integ", A, Bs]);
    deny(fx.repo, ["update-ref", "refs/heads/integ", A]);
    deny(fx.repo, ["update-ref", "refs/heads/main", A, Bs]);
    deny(fx.repo, ["update-ref", "refs/heads/feat/f1", A, Bs]);
    deny(fx.repo, ["update-ref", "-d", "refs/heads/integ", A]);
    deny(fx.repo, ["update-ref", "--stdin"]);
    deny(fx.repo, ["update-ref", "refs/heads/integ", Z, A]);
  });
  test("tag 只许附注 tag 与删除允许的名字；worktree 只许在缓存目录 add --detach / remove；clone 必须 --shared 且目标在缓存", () => {
    allow(fx.repo, ["tag", "-a", "v1.2", "-m", "说明", A]);
    allow(fx.repo, ["tag", "-d", "v1.2"]);
    deny(fx.repo, ["tag", "-f", "-a", "v1.2", "-m", "x", A]);
    deny(fx.repo, ["tag", "-a", "v9", "-m", "x", A]);
    deny(fx.repo, ["tag", "v1.2", A]);
    allow(fx.repo, ["worktree", "add", "--detach", "-q", join(fx.cache, "worktrees", "x"), A]);
    deny(fx.repo, ["worktree", "add", "--detach", join(fx.root, "elsewhere"), A]);
    deny(fx.repo, ["worktree", "add", "-b", "x", join(fx.cache, "w2"), A]);
    deny(fx.repo, ["worktree", "remove", join(fx.repo, ".claude", "worktrees", "user")]);
    deny(fx.repo, ["worktree", "prune"]);
    allow(fx.cache, ["clone", "--mirror", "--shared", "-q", fx.repo, join(fx.cache, "rehearsal", "c.git")]);
    deny(fx.cache, ["clone", "--mirror", fx.repo, join(fx.cache, "rehearsal", "c2.git")]);
    deny(fx.cache, ["clone", "--shared", "https://example.com/x.git", join(fx.cache, "c3")]);
    deny(fx.cache, ["clone", "--shared", fx.repo, join(fx.root, "outside")]);
  });
  test("拒绝也写审计日志；执行前先写一行", async () => {
    const log = join(fx.root, "audit-test.log");
    await expect(runGitWrite(fx.repo, ["push", "origin", "integ"], { reason: "测试", auditLog: log, cacheRoot: fx.cache })).rejects.toThrow(GitForbiddenError);
    await expect(runGitWrite(fx.repo, ["fetch"], { reason: "测试", auditLog: log, cacheRoot: fx.cache })).rejects.toThrow(GitForbiddenError);
    const text = readFileSync(log, "utf8");
    expect(text.split("\n").filter((l) => l.includes("\t拒绝\t")).length).toBe(2);
    expect(text).toContain("git push origin integ");
  });
});

describe("union：两边都保留、新日期在前", () => {
  test("日期识别", () => {
    expect(entryDate("- 2026-10-22 新功能")).toBe(20261022);
    expect(entryDate("| 2026.9.3 | x |")).toBe(20260903);
    expect(entryDate("2026年10月5日 记录；20261101 补")).toBe(20261101);
    expect(entryDate("没有日期")).toBeNull();
  });
  test("块内按日期排序；缺日期时保持 union 原序；可关闭", () => {
    expect(combineHunk(["- 2026-10-20 A"], ["- 2026-10-22 U"], true).lines).toEqual(["- 2026-10-22 U", "- 2026-10-20 A"]);
    expect(combineHunk(["- 2026-10-20 A"], ["- 2026-10-22 U"], false).lines).toEqual(["- 2026-10-20 A", "- 2026-10-22 U"]);
    expect(combineHunk(["- A 无日期"], ["- 2026-10-22 U"], true).lines).toEqual(["- A 无日期", "- 2026-10-22 U"]);
    expect(combineHunk(["段落 2026-10-01", "第二行"], ["段落 2026-10-05"], true).lines).toEqual(["段落 2026-10-05", "", "段落 2026-10-01", "第二行"]);
    expect(combineHunk(["- 2026-10-20 A"], ["- 2026-10-20 A", "- 2026-10-21 B"], true).lines).toEqual(["- 2026-10-21 B", "- 2026-10-20 A"]);
  });
  test("解析 merge-file 标记输出（含 diff3 基线段）", () => {
    const M = (c: string) => c.repeat(32);
    const text = `头\n${M("<")} HELIU-集成\n- 2026-10-20 A\n${M("|")} HELIU-基\n${M("=")}\n- 2026-10-22 U\n${M(">")} HELIU-合入\n尾\n`;
    const r = unionFromMarkers(text, { sortByDate: true });
    expect(r.text).toBe("头\n- 2026-10-22 U\n- 2026-10-20 A\n尾\n");
    expect(r.hunks).toBe(1);
    expect(r.sorted).toBe(1);
  });
});

describe("解冲突器调用约定", () => {
  test("参数固定：opus、acceptEdits、工具白名单、预算 2、json；桩优先", () => {
    const a = resolverArgs();
    expect(a.slice(0, 5)).toEqual(["-p", "--model", "opus", "--permission-mode", "acceptEdits"]);
    for (const t of ["Read", "Edit", "Write", "Bash(git diff *)", "Bash(git add *)", "Bash(git status *)", "Bash(git checkout --theirs *)", "Bash(git checkout --ours *)"]) expect(a).toContain(t);
    expect(a.join(" ")).toContain("--max-budget-usd 2 --output-format json");
    expect(resolverBinary({ HELIU_RESOLVER_STUB: "/x/stub.sh", HELIU_CLAUDE_BIN: "/y/claude" }).stub).toBe(true);
    expect(resolverBinary({ HELIU_CLAUDE_BIN: "/y/claude" }).cmd).toEqual(["/y/claude"]);
  });
  test("提示词含两侧功能与规则；解析 JSON 输出", () => {
    const p = buildResolverPrompt({
      cwd: "/w",
      files: ["src.txt"],
      milestone: "v1.2",
      integration: { branch: "integ", recent: ["integ: 改 src"] },
      incoming: { feature: "F-0005", title: "冲突功能 C", branch: "feat/fc", firstCommit: "feat: 冲突地改 src" },
      round: 1,
    });
    for (const s of ["F-0005「冲突功能 C」", "feat: 冲突地改 src", "integ: 改 src", "只解冲突", "不重构", "两边的功能都保留", "git add", "一句话报告"]) expect(p).toContain(s);
    expect(parseResolverOutput('噪声\n{"type":"result","subtype":"success","is_error":false,"num_turns":4,"result":"ok","total_cost_usd":0.5}\n')).toEqual({ cost: 0.5, turns: 4, summary: "ok", isError: false });
    expect(parseResolverOutput("不是 json")).toBeNull();
  });
});

describe("合并单：预演 → 改决定 → 刷新", () => {
  test("顺序与默认决定：已进集成 → 无冲突 → 有冲突（union 优先）→ 未完成", async () => {
    const r = await previewRelease(project(), paths(), "v1.2");
    const order = r.plan.items.map((i) => `${i.branch}:${i.state}:${i.decision}`);
    expect(order).toEqual([
      "feat/fi:已进集成:并入",
      "feat/f1:无冲突:并入",
      "feat/f2:无冲突:并入",
      "feat/f3:无冲突:并入",
      "feat/fu:有冲突:并入",
      "feat/fc:有冲突:并入",
      "feat/fb:未完成:顺延",
    ]);
    const fu = r.plan.items.find((i) => i.branch === "feat/fu")!;
    expect(fu.precheck).toEqual({ conflicts: ["README.md"], union: ["README.md"], other: [] });
    expect(r.plan.items.find((i) => i.branch === "feat/fc")!.precheck?.other).toEqual(["src.txt"]);
    expect(r.plan.items.find((i) => i.branch === "feat/fb")!.detail).toContain("会话等你回答");
    expect(r.plan.base_sha).toBe(fx.sha.integ!);
    expect(r.plan.integration_branch).toBe("integ");
    const text = readFileSync(r.file, "utf8");
    expect(text).toContain("| # | 决定 | 功能 |");
    expect(text).toContain("[x] 并入");
    expect(text).toContain("已进集成（跳过）");
    // 往返
    const again = parsePlan(serializePlan(r.plan), r.file);
    expect(again.items).toEqual(r.plan.items);
    // 预演只读：仓库引用不变
    expect(gitW(fx.repo, "rev-parse", "integ")).toBe(fx.sha.integ!);
  }, 60_000);

  test("改决定后刷新：保留用户改过的决定", async () => {
    const s = setPlanDecision(project(), "v1.2", fx.ids.f2!, "顺延");
    expect(s.changed.length).toBe(1);
    const r = await previewRelease(project(), paths(), "v1.2");
    expect(r.kept).toBe(1);
    expect(r.plan.items.find((i) => i.branch === "feat/f2")!.decision).toBe("顺延");
    expect(readFileSync(r.file, "utf8")).toContain("（你改的）");
    // 改回并入（与默认一致）
    setPlanDecision(project(), "v1.2", "#3", "并入");
    expect(loadPlan(fx.ledger, "v1.2")!.items[2]!.decision).toBe("并入");
  }, 60_000);
});

describe("执行与回滚", () => {
  test("非交互且没有 --yes 时拒绝执行", async () => {
    await expect(runRelease(project(), "v1.2", {})).rejects.toThrow("--yes");
  });

  test("--dry-run 不动任何引用、不写审计", async () => {
    const before = refsOf(fx.repo);
    const r = await runRelease(project(), "v1.2", { dryRun: true });
    expect(r.aborted).toEqual([]);
    expect(r.dryRunLines.join("\n")).toContain("纯对象库合并");
    expect(r.dryRunLines.join("\n")).toContain("union README.md");
    expect(r.dryRunLines.join("\n")).toContain("解冲突器 src.txt");
    expect(refsOf(fx.repo)).toBe(before);
    expect(existsSync(join(fx.ledger, "releases", "v1.2.log"))).toBe(false);
    expect(loadPlan(fx.ledger, "v1.2")!.status).toBe("草稿");
  }, 60_000);

  test("集成分支在预演后动过（base_sha 不匹配）→ 整体中止，什么都不写", async () => {
    gitW(fx.repo, "update-ref", "refs/heads/integ", fx.sha["feat/fi"]!, fx.sha.integ!);
    try {
      const before = refsOf(fx.repo);
      const r = await runRelease(project(), "v1.2", { yes: true });
      expect(r.aborted.join("")).toContain("在预演后动过");
      expect(refsOf(fx.repo)).toBe(before);
      expect(loadPlan(fx.ledger, "v1.2")!.refs_moved).toEqual([]);
    } finally {
      gitW(fx.repo, "update-ref", "refs/heads/integ", fx.sha.integ!, fx.sha["feat/fi"]!);
    }
  }, 60_000);

  test("run --yes：集成分支包含 5 条、tag、union、解冲突器、顺延、refs_moved、用户工作目录不动", async () => {
    const mainReadme = readFileSync(join(fx.repo, "README.md"), "utf8");
    const logs: string[] = [];
    const r = await runRelease(project(), "v1.2", { yes: true, log: (l) => logs.push(l) });
    expect(r.aborted).toEqual([]);
    expect(r.failed.map((i) => `${i.branch}:${i.result_detail}`)).toEqual([]);
    expect(r.finalized).toBe(true);
    const integ = gitW(fx.repo, "rev-parse", "integ");
    for (const b of ["feat/f1", "feat/f2", "feat/f3", "feat/fu", "feat/fc", "feat/fi"]) expect(isAncestor(fx.repo, fx.sha[b]!, integ)).toBe(true);
    expect(isAncestor(fx.repo, fx.sha["feat/fb"]!, integ)).toBe(false);
    expect(r.merged.length).toBe(5);
    // tag：附注 tag 指向集成分支顶端
    expect(gitW(fx.repo, "cat-file", "-t", "refs/tags/v1.2")).toBe("tag");
    expect(gitW(fx.repo, "rev-parse", "v1.2^{commit}")).toBe(integ);
    // union：两边都保留、新日期在前
    const readme = gitW(fx.repo, "show", `${integ}:README.md`);
    expect(readme).toContain("- 2026-10-22 新功能 U\n- 2026-10-20 集成：合入 A");
    // 普通冲突：桩用 --ours
    expect(gitW(fx.repo, "show", `${integ}:src.txt`)).toBe("line1\nline2 集成版\nline3");
    const plan = loadPlan(fx.ledger, "v1.2")!;
    const fc = plan.items.find((i) => i.branch === "feat/fc")!;
    expect(fc.resolver).toMatchObject({ files: ["src.txt"], rounds: 1, turns: 3, ok: true });
    expect(fc.resolver!.cost_usd).toBeCloseTo(0.12);
    expect(plan.items.find((i) => i.branch === "feat/fu")!.union_resolved).toEqual(["README.md"]);
    // refs_moved：5 次集成分支 + 1 个 tag，首尾相接
    const heads = plan.refs_moved.filter((m) => m.ref === "refs/heads/integ");
    expect(heads.length).toBe(5);
    expect(heads[0]!.old).toBe(fx.sha.integ!);
    for (let k = 1; k < heads.length; k++) expect(heads[k]!.old).toBe(heads[k - 1]!.new);
    expect(heads[4]!.new).toBe(integ);
    expect(plan.refs_moved.filter((m) => m.ref === "refs/tags/v1.2").length).toBe(1);
    expect(plan.status).toBe("已发布");
    // 顺延：fb → v1.3，rolled_from = [v1.2]
    const l = new Ledger(fx.ledger);
    const fb = l.getFeature(fx.ids.fb!);
    expect(fb.milestone).toBe("v1.3");
    expect(fb.rolled_from).toEqual(["v1.2"]);
    expect(l.getFeature(fx.ids.f1!).status).toBe("已合入");
    expect(l.getFeature(fx.ids.fi!).status).toBe("已合入");
    expect(l.findMilestone("v1.2")!.status).toBe("已发布");
    // 发布说明 + 未推送提醒
    const text = readFileSync(plan.file, "utf8");
    expect(text).toContain("## 发布说明");
    expect(text).toContain("未推送");
    expect(r.unpushed.join("")).toContain("refs/heads/integ 与 refs/tags/v1.2");
    // 审计日志：每条写模式 git 一行
    const audit = readFileSync(join(fx.ledger, "releases", "v1.2.log"), "utf8");
    expect(audit).toContain("git update-ref");
    expect(audit).toContain("git tag -a v1.2");
    expect(audit).not.toContain("git push");
    // 临时 worktree 已删，用户主目录与其它分支不动
    expect(existsSync(join(fx.cache, "worktrees", "演示", "v1.2", "docs"))).toBe(false);
    expect(gitW(fx.repo, "worktree", "list", "--porcelain").split("\n").filter((x) => x.startsWith("worktree ")).length).toBe(1);
    expect(readFileSync(join(fx.repo, "README.md"), "utf8")).toBe(mainReadme);
    expect(gitW(fx.repo, "status", "--porcelain")).toBe("");
    for (const b of ["main", "feat/f1", "feat/fc", "feat/fb"]) expect(gitW(fx.repo, "rev-parse", b)).toBe(fx.sha[b]!);
    // 再预演被拒（已发布）
    await expect(previewRelease(project(), paths(), "v1.2")).rejects.toThrow("已");
  }, 120_000);

  test("rollback：引用回到旧值、tag 删除、台账恢复", async () => {
    const r = await rollbackRelease(project(), "v1.2", { yes: true });
    expect(r.complete).toBe(true);
    expect(r.conflicts).toEqual([]);
    expect(gitW(fx.repo, "rev-parse", "integ")).toBe(fx.sha.integ!);
    expect(Bun.spawnSync({ cmd: ["git", "-C", fx.repo, "rev-parse", "--verify", "-q", "refs/tags/v1.2"] }).exitCode).not.toBe(0);
    const l = new Ledger(fx.ledger);
    const fb = l.getFeature(fx.ids.fb!);
    expect(fb.milestone).toBe("v1.2");
    expect(fb.rolled_from).toEqual([]);
    expect(l.getFeature(fx.ids.f1!).status).toBe("待合并");
    expect(l.findMilestone("v1.2")!.status).toBe("冻结");
    const plan = loadPlan(fx.ledger, "v1.2")!;
    expect(plan.status).toBe("已回滚");
    expect(plan.refs_moved.every((m) => !!m.rolled_back)).toBe(true);
    // 回滚后可以重新预演；已回滚的引用记录保留
    const p2 = await previewRelease(project(), paths(), "v1.2");
    expect(p2.plan.status).toBe("草稿");
    expect(p2.plan.base_sha).toBe(fx.sha.integ!);
  }, 60_000);
});

describe("checks 失败与「等它」", () => {
  let fx2: RFx;
  beforeAll(() => {
    fx2 = buildReleaseFixture({ checks: ["test ! -f a1.txt"] });
  });
  afterAll(() => rmSync(fx2.root, { recursive: true, force: true }));
  const p2 = () => loadProject(heliuPaths({ ...process.env, ...fx2.env }), "演示");

  test("「等它」：合入其余项但不收尾（不打 tag、不顺延、里程碑合并中）", async () => {
    useEnv({ HELIU_CACHE_DIR: fx2.cache, HELIU_RESOLVER_STUB: fx2.env.HELIU_RESOLVER_STUB! });
    try {
      await previewRelease(p2(), heliuPaths({ ...process.env, ...fx2.env }), "v1.2");
      setPlanDecision(p2(), "v1.2", fx2.ids.fb!, "等它");
      setPlanDecision(p2(), "v1.2", fx2.ids.fu!, "顺延");
      setPlanDecision(p2(), "v1.2", fx2.ids.fc!, "顺延");
      const r = await runRelease(p2(), "v1.2", { yes: true });
      expect(r.finalized).toBe(false);
      // checks「a1.txt 不存在」让 f1 失败，其余无冲突项通过 checks 后合入
      expect(r.failed.map((i) => i.branch)).toEqual(["feat/f1"]);
      expect(r.failed[0]!.result_detail).toContain("检查失败");
      expect(r.merged.map((i) => i.branch)).toEqual(["feat/f2", "feat/f3"]);
      expect(gitW(fx2.repo, "rev-parse", "integ")).not.toBe(fx2.sha.integ!);
      expect(isAncestor(fx2.repo, fx2.sha["feat/f1"]!, gitW(fx2.repo, "rev-parse", "integ"))).toBe(false);
      expect(Bun.spawnSync({ cmd: ["git", "-C", fx2.repo, "rev-parse", "--verify", "-q", "refs/tags/v1.2"] }).exitCode).not.toBe(0);
      const plan = loadPlan(fx2.ledger, "v1.2")!;
      expect(plan.status).toBe("待续");
      expect(plan.items.find((i) => i.branch === "feat/f2")!.checks?.[0]).toMatchObject({ ok: true });
      const l = new Ledger(fx2.ledger);
      expect(l.findMilestone("v1.2")!.status).toBe("合并中");
      expect(l.getFeature(fx2.ids.fb!).milestone).toBe("v1.2");
      // 待续后回滚：只撤回本次移动的两次
      const rb = await rollbackRelease(p2(), "v1.2", { yes: true });
      expect(rb.reverted.length).toBe(2);
      expect(gitW(fx2.repo, "rev-parse", "integ")).toBe(fx2.sha.integ!);
      expect(l.findMilestone("v1.2")!.status).toBe("冻结");
    } finally {
      useEnv({ HELIU_CACHE_DIR: fx.cache, HELIU_RESOLVER_STUB: fx.env.HELIU_RESOLVER_STUB! });
    }
  }, 120_000);
});

describe("CLI 别名", () => {
  test("heliu 合并 v1.2 --预演 / release set / 合并 --dry-run", () => {
    const env = { ...process.env, ...fx.env };
    const run = (...args: string[]) => Bun.spawnSync({ cmd: [process.execPath, "run", BIN, ...args, "--project", "演示"], env, stdout: "pipe", stderr: "pipe" });
    const a = run("合并", "v1.2", "--预演");
    expect(a.exitCode).toBe(0);
    const out = a.stdout.toString();
    expect(out).toContain("合并单 v1.2");
    expect(out).toContain("已进集成（");
    expect(out).toContain("未完成（1）");
    const s = run("release", "set", "v1.2", fx.ids.f3!, "顺延");
    expect(s.exitCode).toBe(0);
    expect(s.stdout.toString()).toContain("已改 1 项");
    const d = run("合并", "v1.2", "--dry-run");
    expect(d.exitCode).toBe(0);
    expect(d.stdout.toString()).toContain("--dry-run");
    expect(d.stdout.toString()).toContain("不合，顺延到 v1.3");
    const n = run("合并", "v1.2");
    expect(n.exitCode).not.toBe(0);
    expect(n.stderr.toString()).toContain("--yes");
    expect(readdirSync(join(fx.ledger, "releases"))).toContain("v1.2.md");
  }, 60_000);
});
