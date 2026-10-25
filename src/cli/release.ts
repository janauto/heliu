/**
 * M4 CLI：heliu release preview|run|rehearse|rollback|set，以及中文别名
 *   heliu 合并 <版本> --预演   = release preview
 *   heliu 合并 <版本>          = release run（可加 --dry-run / --yes / --to-main）
 *   heliu 演练 <版本>          = release rehearse
 *   heliu 回滚 <版本>          = release rollback
 * 执行类命令无 --yes 时先打印执行前摘要，再要求输入 yes（直接回车 = 取消；需要终端）；
 * 输出边执行边写（同步写 stdout），--json 时进度写 stderr、结果写 stdout。
 * 只在 src/cli/index.ts 里 import 并调用 registerReleaseCommands(program)。
 */
import type { Command } from "commander";
import { writeSync } from "node:fs";
import { heliuPaths } from "../core/paths.ts";
import { resolveProject, type ProjectConfig } from "../core/project.ts";
import { previewRelease, setPlanDecision } from "../core/release.ts";
import { isYes, rollbackRelease, runRelease, type ConfirmFn } from "../core/release-run.ts";
import { rehearseRelease } from "../core/rehearse.ts";
import { SCHEMA_VERSION } from "../types.ts";
import { renderPreview, renderRehearsal, renderRollback, renderRunReport, renderSetDecision } from "./render-release.ts";

interface G {
  project?: string;
  cwd?: string;
  json?: boolean;
  timeout?: string;
}

function writeAll(fd: number, text: string): void {
  const buf = Buffer.from(text.endsWith("\n") ? text : `${text}\n`, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EAGAIN") {
        Bun.sleepSync(2);
        continue;
      }
      return;
    }
  }
}

function project(g: G): Promise<ProjectConfig> {
  return resolveProject(heliuPaths(), g.project, g.cwd ?? process.cwd());
}

function emitJson(command: string, p: ProjectConfig, data: unknown): void {
  writeAll(1, JSON.stringify({ schemaVersion: SCHEMA_VERSION, command, generatedAt: new Date().toISOString(), project: { name: p.name, source: p.source }, data }, null, 2));
}

/** 终端确认：只有输入 yes 才执行，直接回车 / 其他输入 = 取消；非终端返回 undefined（执行类命令会要求 --yes） */
function terminalConfirm(): ConfirmFn | undefined {
  if (!process.stdin.isTTY) return undefined;
  const ask = (globalThis as { prompt?: (m?: string) => string | null }).prompt;
  if (!ask) return undefined;
  return async (q) => {
    const ok = isYes(ask(`${q}\n>`));
    if (!ok) writeAll(2, "  已取消（只有输入 yes 才会执行）");
    return ok;
  };
}

const progress = (g: G) => (line: string) => writeAll(g.json ? 2 : 1, line);
const budgetOf = (v?: string) => (v !== undefined && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);

async function previewAction(ms: string, g: G): Promise<void> {
  const p = await project(g);
  const r = await previewRelease(p, heliuPaths(), ms, { timeoutMs: g.timeout ? Number(g.timeout) : undefined });
  if (g.json) emitJson("release.preview", p, { file: r.file, kept: r.kept, plan: r.plan });
  else writeAll(1, renderPreview(r, p));
}

interface RunOpts {
  dryRun?: boolean;
  yes?: boolean;
  toMain?: boolean;
  allowCheckedOut?: boolean;
  budget?: string;
}
async function runAction(ms: string, o: RunOpts, g: G): Promise<void> {
  const p = await project(g);
  const r = await runRelease(p, ms, {
    dryRun: !!o.dryRun,
    yes: !!o.yes,
    toMain: !!o.toMain,
    allowCheckedOut: !!o.allowCheckedOut,
    confirm: terminalConfirm(),
    log: progress(g),
    resolverBudgetUsd: budgetOf(o.budget),
  });
  if (g.json) emitJson("release.run", p, r);
  else writeAll(1, renderRunReport(r, p));
  if (r.aborted.length || r.failed.length || r.cancelled) process.exitCode = 1;
}

async function rehearseAction(ms: string, o: { report?: string; budget?: string }, g: G): Promise<void> {
  const p = await project(g);
  const r = await rehearseRelease(p, heliuPaths(), ms, { log: progress(g), reportFile: o.report, resolverBudgetUsd: budgetOf(o.budget) });
  if (g.json) emitJson("release.rehearse", p, r);
  else writeAll(1, renderRehearsal(r));
  if (!r.zeroWrite || r.run.aborted.length) process.exitCode = 1;
}

async function rollbackAction(ms: string, o: { yes?: boolean; allowCheckedOut?: boolean }, g: G): Promise<void> {
  const p = await project(g);
  const r = await rollbackRelease(p, ms, { yes: !!o.yes, confirm: terminalConfirm(), log: progress(g), allowCheckedOut: !!o.allowCheckedOut });
  if (g.json) emitJson("release.rollback", p, r);
  else writeAll(1, renderRollback(r, p));
  if (!r.complete) process.exitCode = 1;
}

const globals = (cmd: Command): G => cmd.optsWithGlobals() as G;

function runOptions(c: Command): Command {
  return c
    .option("--dry-run", "只演示每一项会怎么处理，不移动任何引用")
    .option("--yes", "不再确认，按合并单执行（不加时：先看摘要，输入 yes 才执行）")
    .option("--to-main", "发布后若主线能快进到集成分支，就快进主线（否则列出来问你）")
    .option("--allow-checked-out", "集成分支/主线在某个 worktree 里检出时仍继续（那个目录需你自己同步）")
    .option("--budget <美元>", "本次解冲突器总预算（默认 10；每次调用另有 --max-budget-usd 2）");
}

export function registerReleaseCommands(program: Command): void {
  const rel = program.command("release").description("按里程碑合并：preview 合并单 → run 执行 → rollback 回滚；rehearse 在克隆上演练（唯一会写被管理仓库的命令组）");
  rel
    .command("preview <版本>")
    .description("生成/刷新合并单草稿（只读仓库：试合在临时对象区）；保留你改过的决定")
    .action(async (ms: string, _o, cmd: Command) => previewAction(ms, globals(cmd)));
  runOptions(rel.command("run <版本>").description("按合并单合入集成分支 → tag → 顺延 → 发布说明；绝不 push")).action(async (ms: string, o: RunOpts, cmd: Command) =>
    runAction(ms, o, globals(cmd)),
  );
  rel
    .command("rehearse <版本>")
    .description("把主仓库 clone --mirror --shared 到 ~/.cache/heliu/rehearsal/，在克隆上完整跑 preview + run --yes，并对真仓库做零写入比对")
    .option("--report <文件>", "演练报告另存一份到这个文件")
    .option("--budget <美元>", "解冲突器总预算（默认 10）")
    .action(async (ms: string, o: { report?: string; budget?: string }, cmd: Command) => rehearseAction(ms, o, globals(cmd)));
  rel
    .command("rollback <版本>")
    .description("按合并单 refs_moved 逆序把引用指回旧值（只回退 heliu 自己移动过的），删 heliu 打的 tag，恢复功能卡")
    .option("--yes", "不再确认")
    .option("--allow-checked-out", "引用在某个 worktree 里检出时仍继续")
    .action(async (ms: string, o: { yes?: boolean; allowCheckedOut?: boolean }, cmd: Command) => rollbackAction(ms, o, globals(cmd)));
  rel
    .command("set <版本> <项> <决定>")
    .description("改合并单里某项的决定：<项> = 卡号（F-0003）或 #序号；<决定> = 并入 / 顺延 / 等它 / 不并")
    .option("--repo <id>", "卡片绑了多个分支时只改这个仓库的")
    .option("--branch <分支>", "只改这个分支")
    .action(async (ms: string, target: string, decision: string, o: { repo?: string; branch?: string }, cmd: Command) => {
      const g = globals(cmd);
      const p = await project(g);
      const r = setPlanDecision(p, ms, target, decision, o);
      if (g.json) emitJson("release.set", p, { file: r.plan.file, changed: r.changed });
      else writeAll(1, renderSetDecision(r, p));
    });

  runOptions(
    program
      .command("合并 <版本>")
      .description("= release run；加 --预演 = release preview（生成合并单）")
      .option("--预演", "只生成/刷新合并单（= release preview）"),
  ).action(async (ms: string, o: RunOpts & { 预演?: boolean }, cmd: Command) => {
    const g = globals(cmd);
    if (o.预演) return previewAction(ms, g);
    return runAction(ms, o, g);
  });
  program
    .command("演练 <版本>")
    .description("= release rehearse：在主仓库克隆上完整演练一遍合并")
    .option("--report <文件>", "演练报告另存一份到这个文件")
    .option("--budget <美元>", "解冲突器总预算（默认 10）")
    .action(async (ms: string, o: { report?: string; budget?: string }, cmd: Command) => rehearseAction(ms, o, globals(cmd)));
  program
    .command("回滚 <版本>")
    .description("= release rollback")
    .option("--yes", "不再确认")
    .option("--allow-checked-out", "引用在某个 worktree 里检出时仍继续")
    .action(async (ms: string, o: { yes?: boolean; allowCheckedOut?: boolean }, cmd: Command) => rollbackAction(ms, o, globals(cmd)));
}
