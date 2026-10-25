/**
 * heliu MCP server（stdio）：`heliu mcp`。
 *
 * - 工具名 heliu_*，描述与参数说明全部中文口语，便于模型从用户的话里挑工具。
 * - 每个工具都可带 cwd：MCP 进程只知道主检出目录（CLAUDE_PROJECT_DIR），不知道会话所在 worktree；
 *   SessionStart hook 注入的上下文会提示模型把 cwd 传进来。缺省用 CLAUDE_PROJECT_DIR，再缺省用进程 cwd。
 * - 返回文本 ≤8000 字符，超出截断并提示用 CLI --json。
 * - 只读被管理仓库；写入只发生在台账目录（feature_* / sync）。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  opFeatureAdd,
  opFeatureBind,
  opFeatureReserve,
  opFeatureSet,
  opMilestoneList,
  opMilestoneTodo,
  opSync,
  opWhereami,
  projectOf,
  type OpContext,
  type OpResult,
} from "../app/ops.ts";
import { clampText } from "../cli/render-ledger.ts";
import { renderHygiene, renderSessions, renderStatusSummary } from "../cli/render.ts";
import { heliuPaths } from "../core/paths.ts";
import { reconcile } from "../core/reconcile.ts";
import { ACCEPTANCE_LEVELS, FEATURE_STATUSES } from "../types.ts";
import { RELEASE_TOOL_NAMES, registerReleaseTools } from "./release-tools.ts";

export const MCP_TOOL_NAMES = [
  "heliu_whereami",
  "heliu_status",
  "heliu_sessions",
  "heliu_hygiene",
  "heliu_feature_add",
  "heliu_feature_reserve",
  "heliu_feature_bind",
  "heliu_feature_set_status",
  "heliu_milestone_todo",
  "heliu_milestone_list",
  "heliu_sync",
  ...RELEASE_TOOL_NAMES,
] as const;

/** MCP 渲染宽度：模型读文本，不受终端宽度限制，但保持表格可读 */
const MCP_WIDTH = 100;

const common = {
  cwd: z
    .string()
    .optional()
    .describe("你当前所在的目录（会话的 worktree 路径）。SessionStart 提示里给过就原样传；不传则用项目主目录"),
  project: z.string().optional().describe("项目名（如「磁吸背夹」）。一般不用传，会按 cwd 自动识别"),
};

function ctxOf(args: { cwd?: string; project?: string }): OpContext {
  return {
    paths: heliuPaths(),
    cwd: args.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    projectName: args.project || undefined,
    source: "mcp",
    render: { width: MCP_WIDTH },
  };
}

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(text: string, cliHint: string): ToolText {
  return { content: [{ type: "text", text: clampText(text, cliHint) }] };
}

/** 统一错误处理：返回中文错误文本（isError），不让异常打断会话 */
async function run(cliHint: string, fn: () => Promise<OpResult | string>): Promise<ToolText> {
  try {
    const r = await fn();
    return ok(typeof r === "string" ? r : r.text, cliHint);
  } catch (e) {
    return { content: [{ type: "text", text: `合流出错：${(e as Error).message}` }], isError: true };
  }
}

export function buildServer(): McpServer {
  const server = new McpServer(
    { name: "heliu", version: "0.2.0" },
    {
      instructions:
        "合流（heliu）：把 git 分支 × worktree × 桌面会话 对上账，并管理「功能卡 → 预约到哪一版」。用户说「我有个新点子/做个 X」→ heliu_feature_add；「这个预约到 1.2」→ heliu_feature_reserve；「1.2 还欠什么」→ heliu_milestone_todo。调用时尽量传 cwd（会话所在 worktree）。永不 push、不删分支。",
    },
  );

  server.registerTool(
    "heliu_whereami",
    {
      title: "我在哪",
      description: "看看当前会话在哪个仓库、哪个分支，对应哪张功能卡、预约到哪一版、落后主线/集成分支多少提交。用户问「我现在在做哪个功能」「这个分支落后多少」时用。",
      inputSchema: { ...common },
    },
    async (a) => run("heliu whereami", () => opWhereami(ctxOf(a))),
  );

  server.registerTool(
    "heliu_status",
    {
      title: "项目对账摘要",
      description: "一屏看懂整个项目：健康条、现在最该做的、等你处理的会话、独立未合并分支、已进集成分支待回主线、落后需同步。用户问「项目现在什么情况」「有哪些分支没合」时用。只读。",
      inputSchema: { ...common },
    },
    async (a) =>
      run("heliu status", async () => {
        const ctx = ctxOf(a);
        const p = await projectOf(ctx);
        const { report, sessions } = await reconcile(p, ctx.paths, { precheck: false, dirty: false, timeoutMs: 8000 });
        return renderStatusSummary(report, { width: MCP_WIDTH, sessions });
      }),
  );

  server.registerTool(
    "heliu_sessions",
    {
      title: "会话清单",
      description: "列出本项目的桌面会话：哪些在等你回答（附它要你做什么）、哪些在运行。用户问「哪些会话在等我」「还有谁在跑」时用。只读。",
      inputSchema: { ...common, all: z.boolean().optional().describe("true = 连已完成、已归档的会话也列出来") },
    },
    async (a) =>
      run("heliu sessions", async () => {
        const ctx = ctxOf(a);
        const p = await projectOf(ctx);
        const { sessions } = await reconcile(p, ctx.paths, { precheck: false, dirty: false, timeoutMs: 8000 });
        return renderSessions(p.name, sessions, { all: a.all, width: MCP_WIDTH });
      }),
  );

  server.registerTool(
    "heliu_hygiene",
    {
      title: "worktree 卫生检查",
      description: "检查哪些分支/目录该清理：已进主线但目录还在、目录名和分支名对不上、孤儿条目、残留锁文件、iCloud 冲突副本。只报告，不动手删任何东西。用户问「哪些分支该清了」时用。",
      inputSchema: { ...common },
    },
    async (a) =>
      run("heliu hygiene", async () => {
        const ctx = ctxOf(a);
        const p = await projectOf(ctx);
        const { report } = await reconcile(p, ctx.paths, { precheck: false, dirty: false, timeoutMs: 8000 });
        return renderHygiene(report);
      }),
  );

  server.registerTool(
    "heliu_feature_add",
    {
      title: "登记新功能（新点子）",
      description:
        "把用户的一句话需求登记成一张功能卡，默认预约到「下一版」，并自动绑定当前会话所在的分支。用户说「我有个新点子：让背夹支持闹钟」「做个 X，先并行做着」时用。标题直接用用户的原话（简短）。当前分支已有卡时不会重复绑定。",
      inputSchema: {
        title: z.string().min(1).describe("功能标题，用用户的一句话，如「让背夹支持闹钟」"),
        milestone: z.string().optional().describe("预约到哪一版，如「v1.2」「1.2」「下一版」。不传 = 下一版"),
        bind: z.boolean().optional().describe("是否自动绑定当前分支，默认 true；用户只是记个想法、不在这个分支上做时传 false"),
        session: z.string().optional().describe("要绑定的桌面会话 id（local_…），不传则按 cwd 自动匹配"),
        body: z.string().optional().describe("补充说明（一句话需求、验收要点），可不传"),
        ...common,
      },
    },
    async (a) =>
      run("heliu feature list", () =>
        opFeatureAdd(ctxOf(a), { title: a.title, milestone: a.milestone, bind: a.bind, session: a.session, body: a.body }),
      ),
  );

  server.registerTool(
    "heliu_feature_reserve",
    {
      title: "改预约版本",
      description: "把某张功能卡预约到某一版。用户说「这个预约到 1.2」「这个不急，放 2.0」「挪到下一版」时用。版本不存在会自动新建（规划中）；已冻结的版本不接新预约。",
      inputSchema: {
        id: z.string().describe("功能卡号，如「F-0003」，也可写「3」"),
        milestone: z.string().describe("目标版本，如「v1.2」「1.2」「下一版」；传「无」= 取消预约"),
        ...common,
      },
    },
    async (a) => run("heliu feature list", () => opFeatureReserve(ctxOf(a), a.id, a.milestone)),
  );

  server.registerTool(
    "heliu_feature_bind",
    {
      title: "把功能卡绑到分支/会话",
      description:
        "把功能卡和一个分支（及其 worktree、会话、PR）绑定起来。为某张卡开了新会话后，用它把新会话的 id 回写到卡上；不给 branch 时绑定 cwd 所在的分支。",
      inputSchema: {
        id: z.string().describe("功能卡号，如「F-0003」"),
        repo: z.string().optional().describe("仓库 id（如 docs / firmware / app），给 branch 时需要，默认第一个仓库"),
        branch: z.string().optional().describe("分支名；不传则用 cwd 所在分支"),
        worktree: z.string().optional().describe("worktree 绝对路径，可不传"),
        session: z.string().optional().describe("桌面会话 id（local_…），可不传"),
        pr: z.number().int().optional().describe("PR 编号，可不传"),
        ...common,
      },
    },
    async (a) =>
      run("heliu feature list", () =>
        opFeatureBind(ctxOf(a), a.id, { repo: a.repo, branch: a.branch, worktree: a.worktree, session: a.session, pr: a.pr }),
      ),
  );

  server.registerTool(
    "heliu_feature_set_status",
    {
      title: "改功能状态/验收档位/标题",
      description: `更新功能卡：状态（${FEATURE_STATUSES.join(" / ")}）、验收档位（${ACCEPTANCE_LEVELS.join(" / ")}）或改标题。用户说「这个不做了」→ 已放弃；「这个实机测过了」→ 验收 实机通过；sync 草稿要改名时传 title。`,
      inputSchema: {
        id: z.string().describe("功能卡号，如「F-0003」"),
        status: z.enum(FEATURE_STATUSES).optional().describe("新状态"),
        acceptance: z.enum(ACCEPTANCE_LEVELS).optional().describe("新验收档位（和合并状态无关，不会自动提升）"),
        title: z.string().optional().describe("新标题"),
        ...common,
      },
    },
    async (a) => run("heliu feature list", () => opFeatureSet(ctxOf(a), a.id, { status: a.status, acceptance: a.acceptance, title: a.title })),
  );

  server.registerTool(
    "heliu_milestone_todo",
    {
      title: "某一版还欠什么",
      description:
        "列出预约到某一版、还没合入的功能（台账状态为 想法/开发中/待合并 的都算），按「等你回答 / 有冲突 / 可合并 / 落后需同步 / 停滞 / 开发中 / 尚未关联开发分支」分组。用户问「1.2 还欠什么」「下一版还差啥」「哪些能合了」时用。返回里的「建议」只转述给用户，不要自己改状态。",
      inputSchema: {
        milestone: z.string().optional().describe("版本，如「v1.2」「1.2」；不传 = 下一版"),
        precheck: z.boolean().optional().describe("true = 对未合并分支做试合（在临时区进行，不碰仓库），才能分出「有冲突」，稍慢"),
        ...common,
      },
    },
    async (a) => run(`heliu 待办 ${a.milestone ?? "下一版"}`, () => opMilestoneTodo(ctxOf(a), a.milestone ?? "下一版", { precheck: a.precheck, limitPerGroup: 12 })),
  );

  server.registerTool(
    "heliu_milestone_list",
    {
      title: "版本列表",
      description: "列出所有版本（里程碑）：状态、目标日期、待办数，并指出「下一版」是哪个。用户问「有哪些版本」「下一版是哪个」时用。",
      inputSchema: { ...common },
    },
    async (a) => run("heliu milestone list", () => opMilestoneList(ctxOf(a))),
  );

  server.registerTool(
    "heliu_sync",
    {
      title: "把在途分支登记成草稿卡",
      description:
        "扫描本项目的会话与分支：在 worktree 里开发、还没有功能卡、也没进主线的分支，自动建草稿卡（标题取会话标题，预约下一版）。同一分支只建一次。建议先 dry_run=true 预览；写入后把草稿逐条报给用户确认标题与预约。",
      inputSchema: {
        dry_run: z.boolean().optional().describe("true = 只列出将要建的草稿，不写入；默认 false"),
        ...common,
      },
    },
    async (a) => run("heliu sync --dry-run", () => opSync(ctxOf(a), { dryRun: !!a.dry_run })),
  );

  registerReleaseTools(server, { ctxOf, run, common });

  return server;
}

/** 启动 stdio 服务，直到客户端关闭 stdin */
export async function runMcpServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.on("end", () => resolve());
    process.stdin.on("close", () => resolve());
  });
  await server.connect(transport);
  await closed;
}
