import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { assertReadOnly, createObjectQuarantine, GitForbiddenError, parseGitVersion, runGit, sandboxAvailable, sandboxProfile, versionAtLeast } from "../src/core/git.ts";
import { buildFixture, type Fixture } from "./helpers/fixture.ts";

function listFiles(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[]).sort();
}

describe("只读白名单", () => {
  const allowed: string[][] = [
    ["for-each-ref", "--format=%(refname)", "refs/heads"],
    ["rev-list", "--left-right", "--count", "main...x"],
    ["merge-base", "--is-ancestor", "a", "b"],
    ["worktree", "list", "--porcelain"],
    ["log", "-1", "--format=%s"],
    ["symbolic-ref", "-q", "HEAD"],
    ["rev-parse", "--git-common-dir"],
    ["diff", "--name-only", "a...b"],
    ["status", "--porcelain", "-uno"],
    ["show-ref", "--verify", "-q", "refs/heads/main"],
    ["branch", "--list", "--format=%(refname)"],
    ["config", "--get", "remote.origin.url"],
    ["remote"],
    ["remote", "-v"],
    ["cat-file", "-t", "HEAD"],
  ];
  for (const a of allowed) test(`允许 git ${a.join(" ")}`, () => expect(() => assertReadOnly(a)).not.toThrow());

  const denied: string[][] = [
    ["checkout", "main"],
    ["merge", "x"],
    ["fetch"],
    ["pull"],
    ["push"],
    ["commit", "-m", "x"],
    ["stash"],
    ["gc"],
    ["reset", "--hard"],
    ["worktree", "add", "/tmp/x"],
    ["worktree", "remove", "x"],
    ["worktree", "prune"],
    ["branch", "-d", "x"],
    ["branch", "--list", "-D", "x"],
    ["branch", "new-branch"],
    ["config", "user.name", "x"],
    ["config", "--get", "x", "--unset"],
    ["config", "set", "user.name", "x"],
    ["remote", "add", "o", "url"],
    ["remote", "remove", "o"],
    ["symbolic-ref", "HEAD", "refs/heads/x"],
    ["symbolic-ref", "-d", "HEAD"],
    ["merge-tree", "a", "b"],
    ["log", "--output=/tmp/x"],
    ["diff", "--ext-diff"],
    ["-c", "core.x=y", "status"],
    [],
  ];
  for (const a of denied) {
    test(`拒绝 git ${a.join(" ") || "(空)"}`, () => expect(() => assertReadOnly(a)).toThrow(GitForbiddenError));
  }

  test("merge-tree 只有在对象隔离区里才放行", () => {
    expect(() => assertReadOnly(["merge-tree", "--write-tree", "a", "b"])).toThrow(GitForbiddenError);
    expect(() => assertReadOnly(["merge-tree", "--write-tree", "a", "b"], { GIT_OBJECT_DIRECTORY: "/tmp/q" })).not.toThrow();
  });

  test("runGit 对越界命令直接抛错，不起进程", async () => {
    await expect(runGit("/tmp", ["push"])).rejects.toThrow(GitForbiddenError);
  });
});

describe("沙箱配置", () => {
  test("同时写入 NFC/NFD 两种形式并转义引号", () => {
    const nfd = "/tmp/磁吸背夹".normalize("NFD");
    const p = sandboxProfile([nfd, '/tmp/a"b']);
    expect(p).toContain(`(subpath "${"/tmp/磁吸背夹".normalize("NFC")}")`);
    expect(p).toContain(`(subpath "${nfd}")`);
    expect(p).toContain('(subpath "/tmp/a\\"b")');
    expect(p.startsWith("(version 1)(allow default)(deny file-write*")).toBe(true);
  });
});

describe("版本解析", () => {
  test("Apple git 版本串", () => {
    expect(parseGitVersion("git version 2.50.1 (Apple Git-155)")).toEqual([2, 50, 1]);
    expect(versionAtLeast([2, 50, 1], [2, 38])).toBe(true);
    expect(versionAtLeast([2, 37, 9], [2, 38])).toBe(false);
  });
});

describe("runGit 行为", () => {
  let fx: Fixture;
  beforeAll(() => {
    fx = buildFixture();
  });
  afterAll(() => fx.cleanup());

  test("超时返回 {timedOut: true} 而不是抛异常", async () => {
    const r = await runGit(fx.repo, ["log", "--all", "--format=%H"], { timeoutMs: 1 });
    expect(r.timedOut).toBe(true);
    expect(r.ok).toBe(false);
  });

  test("status 在 GIT_OPTIONAL_LOCKS=0 下不回写 index", async () => {
    // 让 README 的 stat 信息过期：正常的 git status 会借机刷新并重写 index
    const f = join(fx.repo, "README.md");
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);
    const before = statSync(join(fx.repo, ".git", "index"));
    const r = await runGit(fx.repo, ["status", "--porcelain=v1", "-uno"]);
    expect(r.ok).toBe(true);
    const after = statSync(join(fx.repo, ".git", "index"));
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });

  test("对象隔离区：merge-tree 新对象不落进真实对象库", async () => {
    const objects = join(fx.repo, ".git", "objects");
    const before = listFiles(objects);
    const q = createObjectQuarantine(join(fx.repo, ".git"));
    try {
      const r = await runGit(fx.repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "integ", "claude/conflict-ffffff"], {
        env: q.env,
        okExitCodes: [1],
      });
      expect(r.code).toBe(1); // 有冲突
      expect(r.stdout.split("\n")[1]).toBe("README.md");
      expect(listFiles(q.dir).length).toBeGreaterThan(2); // 除 info/、pack/ 外，试合对象写进了隔离区
    } finally {
      q.dispose();
    }
    expect(listFiles(objects)).toEqual(before);
  });

  test("沙箱挡住 git 对已有对象/pack 的 mtime「刷新」", async () => {
    if (!sandboxAvailable()) return; // 非 macOS 环境下 merge-tree 会被直接拒绝，见 runGit
    // 打包后，试合 main 与它的祖先：结果树已存在于 pack 中，git 会尝试 utime 刷新 pack
    Bun.spawnSync({ cmd: ["git", "-C", fx.repo, "gc", "-q"] });
    const objects = join(fx.repo, ".git", "objects");
    const snap = () =>
      listFiles(objects)
        .map((f) => {
          const st = statSync(join(objects, f));
          return `${f}|${st.mtimeMs}|${st.size}`;
        })
        .join("\n");
    const before = snap();
    await Bun.sleep(20);
    const q = createObjectQuarantine(join(fx.repo, ".git"));
    try {
      const r = await runGit(fx.repo, ["merge-tree", "--write-tree", "--name-only", "--no-messages", "main", "main~1"], {
        env: q.env,
        okExitCodes: [1],
        protect: [fx.repo],
      });
      expect(r.code).toBe(0);
    } finally {
      q.dispose();
    }
    expect(snap()).toBe(before);
  });
});
