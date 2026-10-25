/**
 * 测试 fixture：在临时目录里造一个「主线 + 集成分支 + 三类分支 + worktree + 卫生问题」的仓库。
 * 注意：fixture 搭建需要写操作（commit/merge/worktree add），这里直接 spawn git，
 * 绝不经过 src/core/git.ts 的只读白名单（白名单会、也应该拒绝这些命令）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tick = 0;
/** 写入型 git（仅限 fixture） */
export function gitW(cwd: string, ...args: string[]): string {
  tick++;
  const date = `2026-10-${String(1 + Math.min(tick, 27)).padStart(2, "0")}T10:00:00+08:00`;
  const r = Bun.spawnSync({
    cmd: ["git", "-C", cwd, ...args],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: tmpdir(),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`fixture git ${args.join(" ")} 失败：${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function commit(repo: string, file: string, content: string, msg: string): string {
  writeFileSync(join(repo, file), content);
  gitW(repo, "add", file);
  gitW(repo, "commit", "-q", "-m", msg);
  return gitW(repo, "rev-parse", "HEAD");
}

export interface Fixture {
  root: string;
  repo: string;
  claudeApp: string;
  claudeHome: string;
  heliuHome: string;
  env: Record<string, string>;
  wt: Record<string, string>;
  cleanup(): void;
}

export const B = {
  main: "main",
  integ: "integ",
  mergedMain: "claude/merged-main-aaaaaa",
  inInteg: "claude/in-integ-bbbbbb",
  standalone: "claude/bold-shaw-cccccc",
  behind: "claude/behind-dddddd",
  conflict: "claude/conflict-ffffff",
  atTip: "claude/at-tip-999999",
} as const;

export function buildFixture(): Fixture {
  tick = 0;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heliu-fixture-")));
  // 路径含中文与空格：覆盖 iCloud「Mobile Documents/磁吸背夹」这类真实路径的转义与沙箱匹配
  const repo = join(root, "磁吸 仓库");
  mkdirSync(repo);
  gitW(repo, "init", "-q", "-b", "main");
  gitW(repo, "config", "commit.gpgsign", "false");

  // 主线 c1..c3
  const c1 = commit(repo, "README.md", "# 项目\n\n第一版\n", "c1: 初始化");
  commit(repo, "docs.md", "文档\n", "c2: 文档");
  commit(repo, "plan.md", "计划\n", "c3: 计划");

  // 已进主线：从 main 分出 → 一条提交 → --no-ff 合回 main
  gitW(repo, "checkout", "-q", "-b", B.mergedMain);
  commit(repo, "a.txt", "a\n", "feat: 已进主线的功能");
  gitW(repo, "checkout", "-q", "main");
  gitW(repo, "merge", "-q", "--no-ff", "-m", "merge: 合入 merged-main", B.mergedMain);

  // 集成分支：从 main 分出，自己改 README
  gitW(repo, "checkout", "-q", "-b", B.integ);
  commit(repo, "README.md", "# 项目\n\n集成分支版本\n", "integ: 改 README");

  // 已进集成分支：从 main 分出 → 一条提交 → --no-ff 合入 integ
  gitW(repo, "checkout", "-q", "main");
  gitW(repo, "checkout", "-q", "-b", B.inInteg);
  commit(repo, "b.txt", "b\n", "feat: 已进集成的功能");
  gitW(repo, "checkout", "-q", B.integ);
  gitW(repo, "merge", "-q", "--no-ff", "-m", "merge: 合入 in-integ", B.inInteg);

  // 独立未合并（随机名）：从 main 分出
  gitW(repo, "checkout", "-q", "main");
  gitW(repo, "checkout", "-q", "-b", B.standalone);
  commit(repo, "c.txt", "c\n", "feat: EPP 网关首个提交");
  commit(repo, "c2.txt", "c2\n", "feat: EPP 网关第二个提交");

  // 冲突分支：与集成分支改同一行 README
  gitW(repo, "checkout", "-q", "main");
  gitW(repo, "checkout", "-q", "-b", B.conflict);
  commit(repo, "README.md", "# 项目\n\n冲突分支版本\n", "feat: 冲突地改 README");

  // 落后主线：从 c1 分出
  gitW(repo, "checkout", "-q", "-b", B.behind, c1);
  mkdirSync(join(repo, "legacy"), { recursive: true });
  commit(repo, "legacy/old.md", "old\n", "docs: 老分支");

  // 停在主线顶端、无提交
  gitW(repo, "checkout", "-q", "main");
  gitW(repo, "branch", B.atTip, "main");

  // 远端跟踪引用：模拟 origin/main 落后、in-integ 已推送（远端地址不存在，heliu 也绝不会 fetch）
  gitW(repo, "remote", "add", "origin", "/nonexistent/origin.git");
  gitW(repo, "update-ref", "refs/remotes/origin/main", c1);
  gitW(repo, "update-ref", `refs/remotes/origin/${B.inInteg}`, gitW(repo, "rev-parse", B.inInteg));

  // worktree：三个桌面端风格目录 + 一个目录名≠分支名
  const wtDir = join(repo, ".claude", "worktrees");
  mkdirSync(wtDir, { recursive: true });
  const wt = {
    standalone: join(wtDir, "bold-shaw-cccccc"),
    reused: join(wtDir, "reused-dir-eeeeee"),
    merged: join(wtDir, "merged-main-aaaaaa"),
    atTip: join(wtDir, "at-tip-999999"),
  };
  gitW(repo, "worktree", "add", "-q", wt.standalone, B.standalone);
  gitW(repo, "worktree", "add", "-q", wt.reused, B.behind);
  gitW(repo, "worktree", "add", "-q", wt.merged, B.mergedMain);
  gitW(repo, "worktree", "add", "-q", wt.atTip, B.atTip);

  // 卫生问题：孤儿管理目录（缺 gitdir）+ 残留 index.lock
  const orphan = join(repo, ".git", "worktrees", "x");
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, "HEAD"), "ref: refs/heads/gone\n");
  writeFileSync(join(repo, ".git", "worktrees", "bold-shaw-cccccc", "index.lock"), "");

  // Claude 桌面数据
  const claudeApp = join(root, "claude-app");
  const claudeHome = join(root, "claude-home");
  const heliuHome = join(root, "heliu-home");
  const sessDir = join(claudeApp, "claude-code-sessions", "acct", "org");
  mkdirSync(sessDir, { recursive: true });
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  mkdirSync(heliuHome, { recursive: true });
  const fixtures = join(import.meta.dir, "..", "fixtures", "sessions");
  for (const f of readdirSync(fixtures)) {
    const text = readFileSync(join(fixtures, f), "utf8").replaceAll("__REPO__", repo);
    writeFileSync(join(sessDir, f), text);
  }
  writeFileSync(
    join(claudeApp, "git-worktrees.json"),
    JSON.stringify({
      schemaVersion: 1,
      worktrees: {
        "bold-shaw-cccccc": { name: "bold-shaw-cccccc", path: wt.standalone, branch: B.standalone, baseRepo: repo, leasedBy: "local_full", createdAt: 1, uncleanSince: null },
        "reused-dir-eeeeee": { name: "reused-dir-eeeeee", path: wt.reused, branch: "claude/reused-dir-eeeeee", baseRepo: repo, leasedBy: null },
      },
    }),
  );
  // 运行中会话：用当前测试进程的 pid，保证「存活」
  writeFileSync(
    join(claudeHome, "sessions", `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, hostSessionId: "local_full", sessionId: "cli-full", name: "实现 EPP 网关 v0", status: "busy", cwd: wt.standalone }),
  );
  writeFileSync(join(claudeHome, "sessions", `${process.pid}.abc.key`), "ignored");

  return {
    root,
    repo,
    claudeApp,
    claudeHome,
    heliuHome,
    env: { HELIU_HOME: heliuHome, HELIU_CLAUDE_APP_DIR: claudeApp, HELIU_CLAUDE_HOME: claudeHome },
    wt,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** 零写入快照：关键 git 文件的 mtime/大小 + 对象/引用文件清单 */
export function gitSnapshot(repo: string): string {
  const out: string[] = [];
  const g = join(repo, ".git");
  for (const f of ["HEAD", "index", "logs/HEAD", "packed-refs", "config"]) {
    try {
      const s = statSync(join(g, f));
      out.push(`${f}|${s.mtimeMs}|${s.size}`);
    } catch {
      out.push(`${f}|missing`);
    }
  }
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else {
        const s = statSync(p);
        out.push(`${r}|${s.mtimeMs}|${s.size}`);
      }
    }
  };
  walk(g, "");
  return out.sort().join("\n");
}
