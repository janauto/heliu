/**
 * heliu CLI 入口。
 * M1（只读对账）：heliu status|branches|sessions|hygiene|doctor|project add <path>|project list
 * M2（台账）：heliu init | feature add|list|reserve|bind|status|accept|rename | milestone add|list|todo|freeze|rename
 *            | sync [--dry-run] | whereami | mcp
 * 中文别名：新点子 "<标题>" [--预约 v1.2] · 待办 [v1.2|下一版] · 预约 F-0003 v1.3 · 我在哪
 * M3（看板）：heliu board [--port 7788] [--open|--no-open]
 * 全局：--project <name>  --cwd <dir>  --json  --precheck  --dirty  --timeout <ms>  --wide
 */
import { Command, Option } from "commander";
import { writeSync } from "node:fs";
import { runDoctor } from "../core/doctor.ts";
import { DEFAULT_TIMEOUT_MS } from "../core/git.ts";
import { heliuPaths } from "../core/paths.ts";
import { addRepoToProject, listProjectNames, loadProject, ProjectError, resolveProject, type ProjectConfig } from "../core/project.ts";
import { reconcile } from "../core/reconcile.ts";
import { TODO_GROUP_DEFS } from "../core/todo.ts";
import { SCHEMA_VERSION, type JsonEnvelope, type MergedState, type ProjectRef, type ScanOptions } from "../types.ts";
import {
  opFeatureAdd,
  opFeatureBind,
  opFeatureList,
  opFeatureReserve,
  opFeatureSet,
  opInit,
  opMilestoneAdd,
  opMilestoneFreeze,
  opMilestoneList,
  opMilestoneRename,
  opMilestoneTodo,
  opSync,
  opWhereami,
  type OpContext,
  type OpResult,
} from "../app/ops.ts";
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
import { registerReleaseCommands } from "./release.ts";

interface GlobalOpts {
  project?: string;
  cwd?: string;
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
  return resolveProject(heliuPaths(), g.project, g.cwd ?? process.cwd());
}

/** 台账类命令的上下文（与 MCP 共用 src/app/ops.ts） */
function opCtx(g: GlobalOpts): OpContext {
  return { paths: heliuPaths(), cwd: g.cwd ?? process.cwd(), projectName: g.project, source: "cli", render: { wide: g.wide } };
}

/** 输出：--json 走稳定外壳，否则中文文本 */
function emit(g: GlobalOpts, command: string, r: OpResult): void {
  if (g.json) printJson(envelope(command, r.project, r.data));
  else out(r.text);
}

const program = new Command();
program
  .name("heliu")
  .description("合流：分支 × worktree × 桌面会话 对账单 + 功能卡/版本台账")
  .version("0.2.0", "-V, --version", "显示版本")
  .helpOption("-h, --help", "显示帮助")
  .addHelpCommand(false)
  .option("-p, --project <name>", "项目名（默认按当前目录自动识别）")
  .option("--cwd <dir>", "按这个目录识别项目与当前分支（默认当前目录）")
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
  .description("本项目的桌面会话：默认列出全部「等你处理」与「运行中」，完整显示待办文案")
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

/* ───────────────────────── M2：台账 ───────────────────────── */

program
  .command("init")
  .description("建立台账目录（milestones.yaml + features/）；位置：project.yaml 的 ledger，缺省 <主仓库>/.heliu/")
  .action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "init", await opInit(opCtx(g)));
  });

interface AddOpts {
  milestone?: string;
  预约?: string;
  bind?: boolean;
  session?: string;
  body?: string;
  unreserved?: boolean;
}
async function featureAddAction(titleParts: string[], o: AddOpts, cmd: Command): Promise<void> {
  const g = globals(cmd);
  const milestone = o.unreserved ? null : (o.预约 ?? o.milestone ?? "next");
  emit(g, "feature.add", await opFeatureAdd(opCtx(g), { title: titleParts.join(" "), milestone, bind: o.bind, session: o.session ?? null, body: o.body }));
}
function addFeatureOptions(c: Command): Command {
  return c
    .option("-m, --milestone <版本>", "预约到哪一版（默认下一版）")
    .option("--预约 <版本>", "同 --milestone")
    .option("--unreserved", "先不预约任何版本")
    .option("--no-bind", "不自动绑定当前分支")
    .option("--session <id>", "绑定的桌面会话 id（local_…）")
    .option("--body <文本>", "补充说明");
}

const featureCmd = program.command("feature").description("功能卡：登记、预约、绑定、改状态");
addFeatureOptions(featureCmd.command("add <标题...>").description("登记一张功能卡（默认预约下一版，自动绑定当前分支）")).action(featureAddAction);
addFeatureOptions(program.command("新点子 <标题...>").description("= feature add：把一句话需求登记成功能卡，默认预约下一版")).action(featureAddAction);

featureCmd
  .command("list")
  .description("列出功能卡")
  .option("-m, --milestone <版本>", "只看预约到某版的（可写 下一版）")
  .option("--status <状态>", "只看某些状态（逗号分隔）")
  .action(async (o: { milestone?: string; status?: string }, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "feature.list", await opFeatureList(opCtx(g), o));
  });

async function reserveAction(id: string, milestone: string, _o: unknown, cmd: Command): Promise<void> {
  const g = globals(cmd);
  emit(g, "feature.reserve", await opFeatureReserve(opCtx(g), id, milestone));
}
featureCmd.command("reserve <卡号> <版本>").description("改预约版本（版本不存在则新建；写 无 取消预约）").action(reserveAction);
program.command("预约 <卡号> <版本>").description("= feature reserve：把功能卡预约到某一版").action(reserveAction);

featureCmd
  .command("bind <卡号>")
  .description("绑定分支/会话/PR；不给 --branch 时绑定当前目录所在分支")
  .option("--repo <id>", "仓库 id")
  .option("--branch <分支>", "分支名")
  .option("--worktree <路径>", "worktree 路径")
  .option("--session <id>", "桌面会话 id")
  .option("--pr <编号>", "PR 编号")
  .action(async (id: string, o: { repo?: string; branch?: string; worktree?: string; session?: string; pr?: string }, cmd: Command) => {
    const g = globals(cmd);
    const pr = o.pr !== undefined ? Number(String(o.pr).replace(/^#/, "")) : null;
    emit(g, "feature.bind", await opFeatureBind(opCtx(g), id, { ...o, pr: pr !== null && Number.isFinite(pr) ? pr : null }));
  });

featureCmd
  .command("status <卡号> <状态>")
  .description("改功能状态：想法 / 开发中 / 待合并 / 已合入 / 已进主线 / 已发布 / 已放弃")
  .action(async (id: string, status: string, _o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "feature.status", await opFeatureSet(opCtx(g), id, { status }));
  });

featureCmd
  .command("accept <卡号> <档位>")
  .description("改验收档位：未 / 已合并 / 已构建 / 宿主测试 / 实机通过（与合并状态无关）")
  .action(async (id: string, acceptance: string, _o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "feature.accept", await opFeatureSet(opCtx(g), id, { acceptance }));
  });

featureCmd
  .command("rename <卡号> <新标题...>")
  .description("改功能卡标题（sync 草稿确认时常用）")
  .action(async (id: string, title: string[], _o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "feature.rename", await opFeatureSet(opCtx(g), id, { title: title.join(" ") }));
  });

const milestoneCmd = program.command("milestone").description("里程碑（版本）：新建、列表、待办、冻结、改名");
milestoneCmd
  .command("add <版本>")
  .description("新建里程碑（规划中）")
  .option("--title <标题>", "标题")
  .option("--target <日期>", "目标日期 YYYY-MM-DD")
  .option("--integration <分支>", "集成分支（缺省用项目配置）")
  .action(async (id: string, o: { title?: string; target?: string; integration?: string }, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "milestone.add", await opMilestoneAdd(opCtx(g), { id, ...o }));
  });
milestoneCmd
  .command("list")
  .description("列出里程碑与待办数，标出「下一版」")
  .action(async (_o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "milestone.list", await opMilestoneList(opCtx(g)));
  });

async function todoAction(ms: string | undefined, _o: unknown, cmd: Command): Promise<void> {
  const g = globals(cmd);
  emit(g, "milestone.todo", await opMilestoneTodo(opCtx(g), ms ?? "下一版", { precheck: !!g.precheck }));
}
// 组名取自分组函数本身（src/core/todo.ts），改名时帮助文案自动跟上
milestoneCmd
  .command("todo [版本]")
  .description(`某一版还欠什么（默认下一版），按 ${TODO_GROUP_DEFS.map((d) => d.title).join("/")} 分组（可合并再细分 已进主线/已进集成分支/试合无冲突）`)
  .action(todoAction);
program.command("待办 [版本]").description("= milestone todo：某一版还欠什么（默认 下一版）").action(todoAction);

milestoneCmd
  .command("freeze <版本>")
  .description("冻结：不再接新预约")
  .action(async (id: string, _o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "milestone.freeze", await opMilestoneFreeze(opCtx(g), id));
  });
milestoneCmd
  .command("rename <原名> <新名>")
  .description("里程碑改名（如 vNext → v1.3），同步更新所有功能卡")
  .action(async (from: string, to: string, _o, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "milestone.rename", await opMilestoneRename(opCtx(g), from, to));
  });

program
  .command("sync")
  .description("把在 worktree 里开发、没有功能卡、未进主线的分支登记成草稿卡（预约下一版）")
  .option("--dry-run", "只列出将要建的草稿，不写入")
  .action(async (o: { dryRun?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    emit(g, "sync", await opSync(opCtx(g), { dryRun: !!o.dryRun }));
  });

async function whereamiAction(_o: unknown, cmd: Command): Promise<void> {
  const g = globals(cmd);
  emit(g, "whereami", await opWhereami(opCtx(g)));
}
program.command("whereami").description("我在哪：当前目录的仓库/分支/功能卡/预约版本/落后数/会话（--cwd 指定目录）").action(whereamiAction);
program.command("我在哪").description("= whereami").action(whereamiAction);

registerReleaseCommands(program);

program
  .command("board")
  .description("中文看板（本机网页，只监听 127.0.0.1）：总览 / 版本列 / 卫生 / 会话 / 合并预演；合并只预演不执行")
  .option("--port <port>", "端口", "7788")
  .option("--open", "启动后用浏览器打开（默认）")
  .option("--no-open", "不自动打开浏览器")
  .action(async (o: { port?: string; open?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    const port = Number(o.port ?? 7788);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new ProjectError(`端口不合法：${o.port}`);
    const { runBoard } = await import("../board/server.ts");
    // 看板一直运行到 Ctrl+C；地址等提示直接打印（不进命令结束时才写出的缓冲）
    await runBoard({ paths: heliuPaths(), projectName: g.project, cwd: g.cwd ?? process.cwd(), port, open: o.open !== false });
  });

program
  .command("mcp")
  .description("以 MCP server（stdio）运行，供 Claude Code / Codex 调用")
  .action(async () => {
    const { runMcpServer } = await import("../mcp/server.ts");
    await runMcpServer();
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
