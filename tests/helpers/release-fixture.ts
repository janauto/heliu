/**
 * M4 合并执行 fixture：主线 main + 集成分支 integ；
 *   feat/f1、f2、f3 无冲突 · feat/fu 与集成分支同处改 README.md（union 文件）· feat/fc 与集成分支同行改 src.txt（普通冲突）·
 *   feat/fb 未完成（绑定会话 blocked）· feat/fi 已进集成分支。台账：v1.2（冻结，7 张卡）、v1.3（规划中）。
 * 另附桩解冲突器（对冲突文件 checkout --ours + add，打印 claude 风格 JSON）。
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../../src/core/ledger.ts";
import { gitW } from "./fixture.ts";

export interface RFx {
  root: string;
  repo: string;
  ledger: string;
  cache: string;
  heliuHome: string;
  claudeApp: string;
  env: Record<string, string>;
  sha: Record<string, string>;
  ids: Record<string, string>;
}

function commit(repo: string, file: string, content: string, msg: string): void {
  mkdirSync(join(repo, file, ".."), { recursive: true });
  writeFileSync(join(repo, file), content);
  gitW(repo, "add", file);
  gitW(repo, "commit", "-q", "-m", msg);
}

export function buildReleaseFixture(opts: { checks?: string[] } = {}): RFx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heliu-release-")));
  const repo = join(root, "仓 库");
  mkdirSync(repo);
  gitW(repo, "init", "-q", "-b", "main");
  gitW(repo, "config", "commit.gpgsign", "false");
  commit(repo, "README.md", "# 项目\n\n## 进度\n- 2026-10-01 建仓\n\n## 其他\n说明\n", "c1: 初始化");
  commit(repo, "src.txt", "line1\nline2\nline3\n", "c2: 源码");
  // 集成分支：README 进度追加一行 + 改 src.txt 第二行
  gitW(repo, "checkout", "-q", "-b", "integ");
  commit(repo, "README.md", "# 项目\n\n## 进度\n- 2026-10-01 建仓\n- 2026-10-20 集成：合入 A\n\n## 其他\n说明\n", "integ: 进度 10-20");
  commit(repo, "src.txt", "line1\nline2 集成版\nline3\n", "integ: 改 src");
  const mk = (b: string, file: string, content: string, msg: string, from = "main") => {
    gitW(repo, "checkout", "-q", "-b", b, from);
    commit(repo, file, content, msg);
  };
  mk("feat/f1", "a1.txt", "a1\n", "feat: 功能一");
  mk("feat/f2", "a2.txt", "a2\n", "feat: 功能二");
  mk("feat/f3", "dir/a3.txt", "a3\n", "feat: 功能三");
  mk("feat/fu", "README.md", "# 项目\n\n## 进度\n- 2026-10-01 建仓\n- 2026-10-22 新功能 U\n\n## 其他\n说明\n", "feat: 进度 10-22");
  mk("feat/fc", "src.txt", "line1\nline2 冲突分支版\nline3\n", "feat: 冲突地改 src");
  mk("feat/fb", "b.txt", "b\n", "feat: 还没做完");
  mk("feat/fi", "i.txt", "i\n", "feat: 已进集成");
  gitW(repo, "checkout", "-q", "integ");
  gitW(repo, "merge", "-q", "--no-ff", "-m", "merge fi", "feat/fi");
  gitW(repo, "checkout", "-q", "main");
  const sha: Record<string, string> = {};
  for (const b of ["main", "integ", "feat/f1", "feat/f2", "feat/f3", "feat/fu", "feat/fc", "feat/fb", "feat/fi"]) sha[b] = gitW(repo, "rev-parse", b);

  const heliuHome = join(root, "heliu-home");
  const ledger = join(root, "台账");
  const cache = join(root, "cache");
  const claudeApp = join(root, "claude-app");
  const claudeHome = join(root, "claude-home");
  mkdirSync(join(heliuHome, "projects", "演示"), { recursive: true });
  mkdirSync(join(claudeHome, "sessions"), { recursive: true });
  const yaml = [
    "name: 演示",
    `ledger: ${JSON.stringify(ledger)}`,
    "repos:",
    "  - id: docs",
    "    label: 文档仓",
    `    path: ${JSON.stringify(repo)}`,
    "    main: main",
    "    integration: integ",
    "union_files:",
    "  - README.md",
    ...(opts.checks?.length ? ["checks:", ...opts.checks.map((c) => `  - ${JSON.stringify(c)}`)] : []),
    "",
  ].join("\n");
  writeFileSync(join(heliuHome, "projects", "演示", "project.yaml"), yaml);
  // 会话：fb 等你回答
  const sessDir = join(claudeApp, "claude-code-sessions", "acct", "org");
  mkdirSync(sessDir, { recursive: true });
  writeFileSync(
    join(sessDir, "local_fb.json"),
    JSON.stringify({
      sessionId: "local_fb",
      title: "还没做完的功能",
      cwd: repo,
      originCwd: repo,
      branch: "feat/fb",
      postTurnSummary: { status_category: "blocked", status_detail: "等确认", needs_action: "确认要不要做 B" },
      isArchived: false,
      lastActivityAt: 1792900000000,
    }),
  );
  // 台账
  const l = new Ledger(ledger);
  l.addMilestone({ id: "v1.2" });
  l.addMilestone({ id: "v1.3" });
  const ids: Record<string, string> = {};
  const add = (key: string, title: string, branch: string) => {
    ids[key] = l.addFeature({ title, milestone: "v1.2", bindings: [{ repo: "docs", branch, worktree: null, session: null, pr: null }], status: "待合并" }).feature.id;
  };
  add("f1", "功能一", "feat/f1");
  add("f2", "功能二", "feat/f2");
  add("f3", "功能三", "feat/f3");
  add("fu", "进度更新 U", "feat/fu");
  add("fc", "冲突功能 C", "feat/fc");
  add("fb", "还没做完的 B", "feat/fb");
  add("fi", "已进集成 I", "feat/fi");
  l.freezeMilestone("v1.2");
  // 桩解冲突器：吃掉提示词，对冲突文件 checkout --ours + add，打印 claude 风格 JSON
  const stub = join(root, "resolver-stub.sh");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      "cat > /dev/null",
      'printf "%s\\n" "$HELIU_CONFLICT_FILES" | while IFS= read -r f; do [ -n "$f" ] && git checkout --ours -- "$f" && git add -- "$f"; done',
      `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"num_turns":3,"result":"src.txt：保留集成分支一侧（桩）","total_cost_usd":0.12}'`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
  return {
    root,
    repo,
    ledger,
    cache,
    heliuHome,
    claudeApp,
    env: { HELIU_HOME: heliuHome, HELIU_CLAUDE_APP_DIR: claudeApp, HELIU_CLAUDE_HOME: claudeHome, HELIU_CACHE_DIR: cache, HELIU_RESOLVER_STUB: stub },
    sha,
    ids,
  };
}

