/**
 * heliu CLI 入口。
 * heliu status|branches|sessions|hygiene|doctor|project add <path>|project list
 * 全局：--project <name>  --json  --precheck  --dirty  --timeout <ms>  --wide
 */
import { Command, Option } from "commander";
import { writeSync } from "node:fs";
import { runDoctor } from "../core/doctor.ts";
import { DEFAULT_TIMEOUT_MS } from "../core/git.ts";
import { heliuPaths } from "../core/paths.ts";
import { addRepoToProject, listProjectNames, loadProject, ProjectError, resolveProject, type ProjectConfig } from "../core/project.ts";
import { reconcile } from "../core/reconcile.ts";
import { SCHEMA_VERSION, type JsonEnvelope, type MergedState, type ProjectRef, type ScanOptions } from "../types.ts";
import {
  LEGEND,
  renderBranchTable,
  renderDoctor,
  renderHeader,
  renderHygiene,
  renderSessions,
  renderStatusFull,
  renderStatusSummary,
  repoTitle,
} from "./render.ts";

interface GlobalOpts {
  project?: string;
  json?: boolean;
  precheck?: boolean;
  dirty?: boolean;
  timeout?: string;
  wide?: boolean;
}

function envelope<T>(command: string, project: ProjectRef | null, data: T): JsonEnvelope<T> {
  return { schemaVersion: SCHEMA_VERSION, command, generatedAt: new Date().toISOString(), project, data };
}

/**
 * 输出先进缓冲，命令结束后同步写完再退出：
 * 管道写是异步的，process.exit 会把超过 64KB 的 --json 输出截断；
 * 实测 Bun 1.3.4 的 Bun.write(Bun.stdout) 在管道满时会从头重写，故用 writeSync 按字节偏移循环写。
 */
const outBuf: string[] = [];
function out(text: string): void {
  outBuf.push(text.endsWith("\n") ? text : text + "\n");
}
function printJson(v: unknown): void {
  out(JSON.stringify(v, null, 2));
}

function scanOptions(g: GlobalOpts): ScanOptions {
  const t = Number(g.timeout ?? DEFAULT_TIMEOUT_MS);
  return { precheck: !!g.precheck, dirty: !!g.dirty, timeoutMs: Number.isFinite(t) && t > 0 ? t : DEFAULT_TIMEOUT_MS };
}

async function project(g: GlobalOpts): Promise<ProjectConfig> {
  return resolveProject(heliuPaths(), g.project, process.cwd());
}

const program = new Command();
program
  .name("heliu")
  .description("合流：分支 × worktree × 桌面会话 只读对账单")
  .version("0.1.0", "-V, --version", "显示版本")
  .helpOption("-h, --help", "显示帮助")
  .addHelpCommand(false)
  .option("-p, --project <name>", "项目名（默认按当前目录自动识别）")
  .option("--json", "输出稳定 JSON（schemaVersion=1）")
  .option("--precheck", "对未合并分支跑 merge-tree 试合，统计冲突文件数（在临时对象区进行）")
  .option("--dirty", "iCloud 仓也做工作区脏检查（可能较慢）")
  .option("--timeout <ms>", "单条 git 命令超时（毫秒）", String(DEFAULT_TIMEOUT_MS))
  .option("--wide", "表格不截断");

const globals = (cmd: Command): GlobalOpts => cmd.optsWithGlobals() as GlobalOpts;

program
  .command("status")
  .description("健康条 + 行动摘要（等你处理 / 独立未合并 / 已进集成待回主线 / 落后需同步）")
  .option("--full", "改为显示每个仓库的全部分支长表")
  .action(async (o: { full?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    const p = await project(g);
    const { report, sessions } = await reconcile(p, heliuPaths(), scanOptions(g));
    if (g.json) printJson(envelope("status", report.project, report));
    else if (o.full) out(renderStatusFull(report, { wide: g.wide }));
    else out(renderStatusSummary(report, { wide: g.wide, sessions }));
  });

program
  .command("branches")
  .description("只看分支表（可按仓库、合并状态过滤）")
  .addOption(new Option("--repo <id>", "只看某个仓库"))
  .addOption(new Option("--state <state>", "按合并状态过滤").choices(["in_main", "in_integration", "unmerged"]))
  .action(async (o: { repo?: string; state?: MergedState }, cmd: Command) => {
    const g = globals(cmd);
    const p = await project(g);
    const { report } = await reconcile(p, heliuPaths(), scanOptions(g));
    const repos = report.repos.filter((r) => !o.repo || r.id === o.repo);
    if (o.repo && !repos.length) throw new ProjectError(`项目中没有仓库 ${o.repo}（可选：${report.repos.map((r) => r.id).join("、")}）`);
    const filter = (b: { mergedState: MergedState }) => !o.state || b.mergedState === o.state;
    if (g.json) {
      printJson(
        envelope("branches", report.project, {
          repos: repos.map((r) => ({ id: r.id, label: r.label, reachable: r.reachable, error: r.error, counts: r.counts, branches: r.branches.filter(filter) })),
        }),
      );
      return;
    }
    const parts = [renderHeader(report), LEGEND];
    for (const r of repos) {
      parts.push("", repoTitle(r));
      if (!r.reachable) parts.push(`  ✗ ${r.error ?? "不可达"}，已跳过`);
      else parts.push(renderBranchTable(r, { wide: g.wide, filter }));
    }
    out(parts.join("\n"));
  });

program
  .command("sessions")
  .description("本项目的桌面会话：默认只列「等你处理」与「运行中」，完整显示待办文案")
  .option("--all", "再列出其余会话（待验收 / 已完成 / 已归档）")
  .action(async (o: { all?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    const p = await project(g);
    const { report, sessions } = await reconcile(p, heliuPaths(), { ...scanOptions(g), precheck: false, dirty: false });
    if (g.json) printJson(envelope("sessions", report.project, { total: sessions.length, sessions }));
    else out(renderSessions(p.name, sessions, { all: o.all, wide: g.wide }));
  });

program
  .command("hygiene")
  .description("worktree 卫生检查（只报告，不动手）")
  .action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const p = await project(g);
    const { report } = await reconcile(p, heliuPaths(), scanOptions(g));
    if (g.json) {
      printJson(
        envelope("hygiene", report.project, {
          repos: report.repos.map((r) => ({ id: r.id, label: r.label, reachable: r.reachable, error: r.error, hygiene: r.hygiene })),
        }),
      );
    } else out(renderHygiene(report));
  });

program
  .command("doctor")
  .description("环境自检：git/bun 版本、数据目录、注册表、每个仓库可达性")
  .action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const checks = await runDoctor(heliuPaths(), g.project, scanOptions(g).timeoutMs);
    if (g.json) printJson(envelope("doctor", null, { checks }));
    else out(renderDoctor(checks));
    if (checks.some((c) => c.level === "fail")) process.exitCode = 1;
  });

const projectCmd = program.command("project").description("项目注册表");
projectCmd
  .command("add <path>")
  .description("把一个 git 仓库登记进项目（只写 heliu 注册表，不碰仓库）")
  .option("--name <name>", "项目名（默认取仓库目录名）")
  .option("--id <id>", "仓库 id")
  .option("--label <label>", "仓库显示名")
  .option("--main <branch>", "主线分支（默认自动探测）")
  .option("--integration <branch>", "集成分支")
  .option("--remote <remote>", "远端名（默认 origin 或第一个远端）")
  .action(async (path: string, o: { name?: string; id?: string; label?: string; main?: string; integration?: string; remote?: string }, cmd: Command) => {
    const g = globals(cmd);
    const res = await addRepoToProject(heliuPaths(), { path, ...o });
    if (g.json) printJson(envelope("project.add", { name: res.project.name, source: res.file }, { created: res.created, repo: res.repo }));
    else {
      out(`${res.created ? "已创建" : "已更新"}项目「${res.project.name}」：${res.file}`);
      out(`  + ${res.repo.label}（${res.repo.id}）主线=${res.repo.main}${res.repo.remote ? ` 远端=${res.repo.remote}` : ""}${res.repo.icloud ? " · iCloud" : ""}`);
    }
  });
projectCmd
  .command("list")
  .description("列出已注册项目")
  .action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    const paths = heliuPaths();
    const items = listProjectNames(paths).map((n) => {
      try {
        const p = loadProject(paths, n);
        return { name: p.name, source: p.source, repos: p.repos, error: null as string | null };
      } catch (e) {
        return { name: n, source: "", repos: [], error: (e as Error).message };
      }
    });
    if (g.json) {
      printJson(envelope("project.list", null, { registry: paths.projectsDir, projects: items }));
      return;
    }
    out(`注册表：${paths.projectsDir}`);
    if (!items.length) out("  （尚无项目：heliu project add <仓库路径> --name <项目名>）");
    for (const it of items) {
      out(`  ${it.name}${it.error ? `  ✗ ${it.error}` : `  ${it.source}`}`);
      for (const r of it.repos) {
        out(`    - ${r.label}（${r.id}）主线=${r.main}${r.integration ? ` 集成=${r.integration}` : ""}${r.icloud ? " · iCloud" : ""}  ${r.path}`);
      }
    }
  });

async function flushOut(): Promise<void> {
  if (!outBuf.length) return;
  const buf = Buffer.from(outBuf.splice(0).join(""), "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(1, buf, off, buf.length - off);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        await Bun.sleep(2); // 管道满：等下游读走
        continue;
      }
      return; // EPIPE 等：下游提前关闭（如 | head），丢弃剩余输出
    }
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    await program.parseAsync(argv);
    await flushOut();
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (e) {
    await flushOut();
    if (e instanceof ProjectError) {
      console.error(`heliu：${e.message}`);
      return 2;
    }
    console.error(`heliu 出错：${(e as Error).stack ?? e}`);
    return 1;
  }
}
