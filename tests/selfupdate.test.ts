/**
 * F-0004 检查更新 / 一键更新：临时目录里建一个裸仓库当「GitHub」，克隆一份当「合流代码目录」。
 * 覆盖：已是最新 / 落后（新提交本机有、没有两种）/ 本机领先 / 分叉 / 有改动 / 不在 main / 问不到远端；
 * 一键更新只快进、前提不满足时代码目录一个字节都不动；依赖清单与 App 外壳变化的识别；看板接口与「重启后生效」。
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpdateData, UpdateRunData } from "../src/board/api-types.ts";
import { createBoardApp } from "../src/board/server.ts";
import { heliuPaths } from "../src/core/paths.ts";
import { checkUpdate, runUpdate, UpdateError } from "../src/core/selfupdate.ts";

const tmp = mkdtempSync(join(tmpdir(), "heliu-selfupdate-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync({ cmd: ["git", ...args], cwd, env: ENV, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}：${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}
function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}
function commit(root: string, rel: string, text: string, msg: string): string {
  write(root, rel, text);
  git(root, "add", rel);
  git(root, "commit", "-q", "-m", msg);
  return git(root, "rev-parse", "HEAD");
}

let n = 0;
/** 一套新的：GitHub（裸仓库）+ 合流代码目录（克隆）+ 另一个开发者的克隆（往 GitHub 推新提交用） */
function setup(): { hub: string; root: string; dev: string } {
  const base = join(tmp, `s${++n}`);
  const hub = join(base, "hub.git");
  const seed = join(base, "seed");
  mkdirSync(seed, { recursive: true });
  git(base, "init", "-q", "--bare", "-b", "main", hub);
  git(seed, "init", "-q", "-b", "main");
  commit(seed, "README.md", "合流\n", "初始");
  git(seed, "remote", "add", "origin", hub);
  git(seed, "push", "-q", "origin", "main");
  const root = join(base, "root");
  const dev = join(base, "dev");
  git(base, "clone", "-q", hub, root);
  git(base, "clone", "-q", hub, dev);
  return { hub, root, dev };
}
/** 另一个开发者往 GitHub 推一个提交 */
function upstream(dev: string, rel: string, text: string, msg: string): string {
  const sha = commit(dev, rel, text, msg);
  git(dev, "push", "-q", "origin", "main");
  return sha;
}
const head = (root: string) => git(root, "rev-parse", "HEAD");

describe("checkUpdate（只读）", () => {
  test("已是最新", async () => {
    const { root } = setup();
    const c = await checkUpdate(root);
    expect(c.error).toBeNull();
    expect(c.state).toBe("latest");
    expect(c.canRun).toBe(false);
    expect(c.local).toBe(head(root));
  });

  test("GitHub 有新提交、本机还没下载：落后，个数未知，可以一键更新；检查本身不写引用", async () => {
    const { root, dev } = setup();
    const sha = upstream(dev, "a.txt", "1\n", "新功能");
    const refsBefore = git(root, "for-each-ref");
    const c = await checkUpdate(root);
    expect(c.state).toBe("behind");
    expect(c.remoteSha).toBe(sha);
    expect(c.behind).toBeNull();
    expect(c.dirty).toBe(false);
    expect(c.blockers).toEqual([]);
    expect(c.canRun).toBe(true);
    expect(git(root, "for-each-ref")).toBe(refsBefore);
  });

  test("新提交本机已经有了（之前 fetch 过）：数得出落后几个", async () => {
    const { root, dev } = setup();
    upstream(dev, "a.txt", "1\n", "一");
    upstream(dev, "b.txt", "2\n", "二");
    git(root, "fetch", "-q", "origin");
    const c = await checkUpdate(root);
    expect(c.state).toBe("behind");
    expect(c.behind).toBe(2);
    expect(c.ahead).toBe(0);
  });

  test("本机比 GitHub 新：不用更新", async () => {
    const { root } = setup();
    commit(root, "mine.txt", "x\n", "本机的");
    const c = await checkUpdate(root);
    expect(c.state).toBe("ahead");
    expect(c.ahead).toBe(1);
    expect(c.canRun).toBe(false);
  });

  test("两边分叉：不能一键更新", async () => {
    const { root, dev } = setup();
    upstream(dev, "a.txt", "1\n", "远端");
    git(root, "fetch", "-q", "origin");
    commit(root, "mine.txt", "x\n", "本机");
    const c = await checkUpdate(root);
    expect(c.state).toBe("diverged");
    expect(c.canRun).toBe(false);
    expect(c.blockers.join()).toContain("不在 GitHub 上");
  });

  test("跟踪文件有改动 / 不在 main：列出原因，不能一键更新", async () => {
    const { root, dev } = setup();
    upstream(dev, "a.txt", "1\n", "远端");
    write(root, "README.md", "改了\n");
    let c = await checkUpdate(root);
    expect(c.dirty).toBe(true);
    expect(c.canRun).toBe(false);
    expect(c.blockers.join()).toContain("没提交的改动");
    git(root, "checkout", "-q", "README.md");
    git(root, "checkout", "-q", "-b", "feature");
    c = await checkUpdate(root);
    expect(c.canRun).toBe(false);
    expect(c.blockers.join()).toContain("不在 main");
  });

  test("问不到远端：unknown 并写明原因", async () => {
    const { root } = setup();
    git(root, "remote", "set-url", "origin", join(tmp, "不存在.git"));
    const c = await checkUpdate(root);
    expect(c.state).toBe("unknown");
    expect(c.error).toContain("问不到 GitHub 主线");
  });

  test("不是 git 仓库", async () => {
    const d = join(tmp, "plain");
    mkdirSync(d, { recursive: true });
    const c = await checkUpdate(d);
    expect(c.state).toBe("unknown");
    expect(c.error).toContain("不是 git 仓库");
  });
});

describe("runUpdate（用户确认后）", () => {
  test("快进到 GitHub 主线；识别依赖清单与 App 外壳的变化；写一行记录", async () => {
    const { root, dev } = setup();
    const from = head(root);
    upstream(dev, "src/a.ts", "export {}\n", "改看板");
    upstream(dev, "package.json", "{}\n", "加依赖");
    const to = upstream(dev, "app/macos/Sources/x.swift", "//\n", "改外壳");
    const audit = join(tmp, "audit", "self-update.log");
    const r = await runUpdate(root, { skipInstall: true, auditFile: audit });
    expect(r.from).toBe(from);
    expect(r.to).toBe(to);
    expect(head(root)).toBe(to);
    expect(r.count).toBe(3);
    expect(r.commits.map((c) => c.subject)).toEqual(["改外壳", "加依赖", "改看板"]);
    expect(r.files).toBe(3);
    expect(r.depsChanged).toBe(true);
    expect(r.depsInstalled).toBeNull();
    expect(r.shellChanged).toBe(true);
    expect(readFileSync(join(root, "src/a.ts"), "utf8")).toBe("export {}\n");
    expect(readFileSync(audit, "utf8")).toContain("3 个提交");
    // 再检查：已是最新；再更新：拒绝
    expect((await checkUpdate(root)).state).toBe("latest");
    await expect(runUpdate(root, { skipInstall: true })).rejects.toThrow("已经是最新");
  });

  test("只改看板代码：不报依赖、不报外壳", async () => {
    const { root, dev } = setup();
    upstream(dev, "web/x.tsx", "1\n", "改页面");
    const r = await runUpdate(root, { skipInstall: true });
    expect(r.depsChanged).toBe(false);
    expect(r.shellChanged).toBe(false);
  });

  test("前提不满足时什么都不改：有改动 / 分叉 / 不在 main", async () => {
    // 有改动
    let s = setup();
    upstream(s.dev, "a.txt", "1\n", "远端");
    write(s.root, "README.md", "改了\n");
    let before = head(s.root);
    await expect(runUpdate(s.root, { skipInstall: true })).rejects.toBeInstanceOf(UpdateError);
    expect(head(s.root)).toBe(before);
    expect(readFileSync(join(s.root, "README.md"), "utf8")).toBe("改了\n");
    // 分叉（远端的新提交本机还没下载：检查时按已有远端引用估不出，下载后核对祖先关系拒绝）
    s = setup();
    upstream(s.dev, "a.txt", "1\n", "远端");
    commit(s.root, "mine.txt", "x\n", "本机");
    git(s.root, "update-ref", "-d", "refs/remotes/origin/main");
    before = head(s.root);
    await expect(runUpdate(s.root, { skipInstall: true })).rejects.toThrow("没法快进");
    expect(head(s.root)).toBe(before);
    // 不在 main
    s = setup();
    upstream(s.dev, "a.txt", "1\n", "远端");
    git(s.root, "checkout", "-q", "-b", "feature");
    before = git(s.root, "rev-parse", "main");
    await expect(runUpdate(s.root, { skipInstall: true })).rejects.toThrow("不在 main");
    expect(git(s.root, "rev-parse", "main")).toBe(before);
  });
});

describe("看板接口 /api/update", () => {
  test("检查 → 更新 → 提示重启后生效；写接口要 JSON", async () => {
    const { root, dev } = setup();
    const to = upstream(dev, "web/x.tsx", "1\n", "改页面");
    const home = join(tmp, "heliu-home");
    const paths = heliuPaths({ ...process.env, HELIU_HOME: home });
    const { app } = createBoardApp({ paths, project: null, distDir: join(tmp, "dist"), updateRoot: root });
    const get = async () => (await (await app.request("/api/update")).json()) as { data: UpdateData };
    let d = (await get()).data;
    expect(d.check.state).toBe("behind");
    expect(d.check.canRun).toBe(true);
    expect(d.needsRestart).toBe(false);

    const bad = await app.request("/api/update/run", { method: "POST", body: "{}" });
    expect(bad.status).toBe(415);
    expect(head(root)).not.toBe(to);

    const res = await app.request("/api/update/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(200);
    const run = (await res.json()) as { data: UpdateRunData };
    expect(run.data.result.to).toBe(to);
    expect(head(root)).toBe(to);

    d = (await get()).data;
    expect(d.check.state).toBe("latest");
    expect(d.needsRestart).toBe(true);
    expect(d.running).not.toBe(d.onDisk);
    expect(d.last?.to).toBe(to);
    expect(readFileSync(join(home, "self-update.log"), "utf8")).toContain("1 个提交");

    const again = await app.request("/api/update/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: string }).error).toContain("已经是最新");
  });
});
