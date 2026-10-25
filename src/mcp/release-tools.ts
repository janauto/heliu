/**
 * M4 MCP 工具：只提供「看合并单」与「改某项决定」。
 * **不提供执行合并的工具**：写被管理仓库只能由用户在 CLI 里确认（heliu 合并 <版本>）。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { OpContext, OpResult } from "../app/ops.ts";
import { projectOf } from "../app/ops.ts";
import { renderPreview, renderSetDecision } from "../cli/render-release.ts";
import { previewRelease, setPlanDecision } from "../core/release.ts";
import { DECISIONS } from "../core/release-plan.ts";

export const RELEASE_TOOL_NAMES = ["heliu_release_preview", "heliu_release_plan_set_decision"] as const;

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface ReleaseToolDeps {
  ctxOf: (a: { cwd?: string; project?: string }) => OpContext;
  run: (cliHint: string, fn: () => Promise<OpResult | string>) => Promise<ToolText>;
  common: { cwd: z.ZodOptional<z.ZodString>; project: z.ZodOptional<z.ZodString> };
}

export function registerReleaseTools(server: McpServer, deps: ReleaseToolDeps): void {
  server.registerTool(
    "heliu_release_preview",
    {
      title: "合并预演（生成合并单）",
      description:
        "为某一版生成/刷新合并单草稿：每个功能分支是已进集成、无冲突、有冲突（哪些文件、是否 union 索引文件）还是未完成，默认决定是并入还是顺延。只读仓库（试合在临时对象区），只写台账里的合并单文件。用户说「1.2 能合了吗」「预演一下合并 v1.2」时用。真正执行合并请让用户自己在终端运行 heliu 合并 <版本>。",
      inputSchema: { milestone: z.string().describe("版本，如「v1.2」「1.2」"), ...deps.common },
    },
    async (a) =>
      deps.run(`heliu 合并 ${a.milestone} --预演`, async () => {
        const ctx = deps.ctxOf(a);
        const p = await projectOf(ctx);
        const r = await previewRelease(p, ctx.paths, a.milestone);
        return `${renderPreview(r, p)}\n（执行合并需要用户在终端确认：heliu 合并 ${r.milestone.id}；MCP 不提供执行合并的工具）`;
      }),
  );

  server.registerTool(
    "heliu_release_plan_set_decision",
    {
      title: "改合并单里某项的决定",
      description: `改合并单中一项的决定（${DECISIONS.join(" / ")}）。用户说「F-0012 这版先不合，顺延」「等 F-0003 好了一起发」（= 等它）「这个不要了」（= 不并）「试合没结果的那几个我看过了，可以合」（未能试合 → 并入）时用。只改台账里的合并单，不碰仓库。`,
      inputSchema: {
        milestone: z.string().describe("版本，如「v1.2」"),
        item: z.string().describe("功能卡号（如「F-0012」「12」）或勾选表序号（如「#3」）"),
        decision: z.enum(DECISIONS).describe("并入 = 本次合入；顺延 = 改到下一版；等它 = 本版先不收尾；不并 = 不合、改为未预约；待定 = 还没决定（执行时跳过、留在本版）"),
        repo: z.string().optional().describe("卡片绑了多个分支时，只改这个仓库的那一条"),
        branch: z.string().optional().describe("只改这个分支的那一条"),
        ...deps.common,
      },
    },
    async (a) =>
      deps.run(`heliu release set ${a.milestone} ${a.item} ${a.decision}`, async () => {
        const ctx = deps.ctxOf(a);
        const p = await projectOf(ctx);
        return renderSetDecision(setPlanDecision(p, a.milestone, a.item, a.decision, { repo: a.repo, branch: a.branch }), p);
      }),
  );
}
