/**
 * heliu doctor：环境与注册表自检（只读）。
 */
import { accessSync, constants, existsSync } from "node:fs";
import type { DoctorCheck } from "../types.ts";
import { gitVersion, lines, runGit, sandboxAvailable, versionAtLeast } from "./git.ts";
import { binLinkDirs, globalClaudeMdPath, installChecks } from "./global-entry.ts";
import { probeResolver } from "./resolver.ts";
import { looksLikeICloud, type HeliuPaths } from "./paths.ts";
import { listProjectNames, loadProject, type ProjectConfig } from "./project.ts";
import { loadDesktopSessions, loadDesktopWorktrees, loadRunningSessions } from "./sessions.ts";

const MIN_GIT: [number, number] = [2, 38];

function readable(p: string): boolean {
  try {
    accessSync(p, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

const check = (id: string, level: DoctorCheck["level"], message: string): DoctorCheck => ({ id, ok: level !== "fail", level, message });

export interface DoctorOptions {
  /** 跳过无头 claude 探测（最长约 20 秒）；看板「开始」页默认跳过，点「完整检查」才做 */
  skipClaude?: boolean;
}

export async function runDoctor(paths: HeliuPaths, projectName: string | undefined, timeoutMs: number, opts: DoctorOptions = {}): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const v = await gitVersion();
  if (!v) out.push(check("git", "fail", "找不到 git 或无法执行 git version"));
  else {
    const ok = versionAtLeast(v, MIN_GIT);
    out.push(check("git", ok ? "ok" : "fail", `git ${v.join(".")}${ok ? "" : `（需要 ≥ ${MIN_GIT.join(".")}，merge-tree --write-tree 依赖它）`}`));
    if (ok && !versionAtLeast(v, [2, 41])) out.push(check("git-ahead-behind", "warn", "git < 2.41：ahead/behind 回退为逐分支 rev-list，较慢"));
  }
  const bunOk = versionAtLeast(Bun.version.split(".").map(Number), [1, 3]);
  out.push(check("bun", bunOk ? "ok" : "warn", `bun ${Bun.version}${bunOk ? "" : "（建议 ≥ 1.3）"}`));

  // M4：写保护沙箱（试合 / 合并 / 演练都依赖它）
  if (sandboxAvailable()) out.push(check("sandbox", "ok", "sandbox-exec 可用：试合在写保护沙箱里进行，合并执行与演练也包在沙箱里"));
  else {
    out.push(check("sandbox", "warn", `sandbox-exec 不可用${process.env.HELIU_NO_SANDBOX === "1" ? "（HELIU_NO_SANDBOX=1）" : "（非 macOS，或已处在不允许嵌套的沙箱里）"}：预演会把待合项标为「未能试合」，演练会拒绝执行，真实合并只靠白名单约束`));
  }
  // M4：无头 claude（解冲突子代理）
  if (opts.skipClaude) out.push(check("headless-claude", "warn", "无头 claude：这次没检查（约 20 秒，点「完整检查」才做）"));
  else if (process.env.HELIU_DOCTOR_SKIP_CLAUDE === "1") out.push(check("headless-claude", "warn", "无头 claude：未检查（HELIU_DOCTOR_SKIP_CLAUDE=1）"));
  else {
    const pr = await probeResolver({ timeoutMs: 20_000 });
    out.push(
      check(
        "headless-claude",
        pr.available ? "ok" : "warn",
        `无头 claude（解冲突子代理，${pr.binary}）：${pr.message}${pr.available ? "" : "。不影响无冲突合并与 union 索引文件；普通冲突会判「失败·待处理」并顺延"}`,
      ),
    );
  }

  // 装进 Claude：插件 / 全局 CLAUDE.md 入口 / 终端命令（只读）
  out.push(...installChecks({ claudeHome: paths.claudeHome, claudeMd: globalClaudeMdPath(), binDirs: binLinkDirs() }));

  // 数据目录
  const ds = loadDesktopSessions(paths);
  if (!ds.dirExists) out.push(check("desktop-sessions", "warn", `桌面会话目录不存在：${paths.desktopSessionsDir}`));
  else if (!readable(paths.desktopSessionsDir)) out.push(check("desktop-sessions", "fail", `桌面会话目录不可读：${paths.desktopSessionsDir}`));
  else {
    const level = ds.parseErrors ? "warn" : "ok";
    out.push(check("desktop-sessions", level, `桌面会话 ${ds.sessions.length} 条可读（${ds.files} 个文件${ds.parseErrors ? `，${ds.parseErrors} 个解析失败` : ""}）：${paths.desktopSessionsDir}`));
  }
  if (existsSync(paths.gitWorktreesJson)) {
    out.push(check("git-worktrees-json", readable(paths.gitWorktreesJson) ? "ok" : "fail", `git-worktrees.json 登记 ${loadDesktopWorktrees(paths).length} 个 worktree`));
  } else out.push(check("git-worktrees-json", "warn", `未找到 ${paths.gitWorktreesJson}`));
  if (existsSync(paths.runningSessionsDir)) {
    const rs = loadRunningSessions(paths);
    out.push(check("running-sessions", "ok", `运行中会话目录可读：${rs.filter((r) => r.alive).length} 个存活 / ${rs.length} 个记录`));
  } else out.push(check("running-sessions", "warn", `未找到运行中会话目录 ${paths.runningSessionsDir}`));

  // 注册表
  const names = listProjectNames(paths);
  out.push(check("registry", names.length ? "ok" : "warn", `注册表：${paths.projectsDir}（${names.length ? names.join("、") : "尚无项目"}）`));
  if (looksLikeICloud(paths.heliuHome)) out.push(check("registry-icloud", "warn", "注册表位于 iCloud 目录，建议放在本机 Application Support（ADR-3）"));

  const targets = projectName ? [projectName] : names;
  for (const n of targets) {
    let p: ProjectConfig;
    try {
      p = loadProject(paths, n);
    } catch (e) {
      out.push(check(`project:${n}`, "fail", (e as Error).message));
      continue;
    }
    out.push(check(`project:${n}`, "ok", `项目「${p.name}」：${p.repos.length} 个仓库（${p.source}）`));
    for (const r of p.repos) {
      const id = `repo:${n}/${r.id}`;
      const tag = `${r.label}（${r.id}）`;
      if (!existsSync(r.path)) {
        out.push(check(id, "fail", `${tag} 路径不存在：${r.path}（其他命令将跳过该仓库）`));
        continue;
      }
      const rp = await runGit(r.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { timeoutMs });
      if (!rp.ok) {
        out.push(check(id, "fail", `${tag} ${rp.timedOut ? "git 超时" : "不是 git 仓库"}：${r.path}（其他命令将跳过该仓库）`));
        continue;
      }
      const problems: string[] = [];
      const has = async (ref: string) => (await runGit(r.path, ["show-ref", "--verify", "-q", ref], { timeoutMs })).ok;
      if (!(await has(`refs/heads/${r.main}`))) problems.push(`主线 ${r.main} 不存在`);
      if (r.integration && !(await has(`refs/heads/${r.integration}`))) problems.push(`集成分支 ${r.integration} 不存在`);
      if (r.remote) {
        const rr = await runGit(r.path, ["remote"], { timeoutMs });
        if (!lines(rr.stdout).includes(r.remote)) problems.push(`远端 ${r.remote} 未配置`);
        else if (!(await has(`refs/remotes/${r.remote}/${r.main}`))) problems.push(`本地没有 ${r.remote}/${r.main}（只用已有引用，不会 fetch）`);
      }
      out.push(check(id, problems.length ? "warn" : "ok", `${tag} 可达：${r.path}${problems.length ? "；" + problems.join("；") : ""}`));
      // M4：合并目标
      if (!r.integration) out.push(check(`${id}:integration`, "warn", `${tag} 未配置集成分支：heliu 合并不会合入该仓库的分支（这些项默认顺延）；需要时在 project.yaml 给该仓库加 integration`));
      else if (problems.some((x) => x.startsWith("集成分支"))) out.push(check(`${id}:integration`, "warn", `${tag} 集成分支 ${r.integration} 不存在：heliu 合并会把该仓库的项标「无法合并」`));
      else out.push(check(`${id}:integration`, "ok", `${tag} 集成分支 ${r.integration}（heliu 合并的目标）`));
      const icloudPath = looksLikeICloud(r.path);
      if (icloudPath || r.icloud) {
        out.push(check(`${id}:icloud`, "warn", `${tag} 在 iCloud 上：工作区脏检查默认跳过（--dirty 才做，单个 worktree 可能超时）${icloudPath && !r.icloud ? "；project.yaml 未标 icloud: true" : ""}`));
      }
    }
  }
  return out;
}
