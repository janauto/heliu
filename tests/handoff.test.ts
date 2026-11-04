/**
 * F-0003「交给 Claude」：claude:// 深链与开工指令（只生成文本 / 链接，不执行）。
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardService } from "../src/board/data.ts";
import { continueSessionLink, newSessionLink, PROMPT_MAX } from "../src/core/deeplink.ts";
import { startPrompt } from "../web/prompt.ts";

describe("claude:// 深链", () => {
  test("开新会话：中文、换行、& = # + 与带空格的 iCloud 目录都能原样解回", () => {
    const prompt = "请开始做功能卡 F-0003「发给 Claude」\n第二行 & = # + 100%";
    const folder = "/Users/x/Library/Mobile Documents/com~apple~CloudDocs/项目管理工具";
    const link = newSessionLink(prompt, folder);
    expect(link.startsWith("claude://code/new?")).toBe(true);
    expect(link).not.toContain("+"); // 空格统一编成 %20，「+」本身编成 %2B
    const u = new URL(link);
    expect(u.protocol).toBe("claude:");
    expect(u.host).toBe("code");
    expect(u.pathname).toBe("/new");
    expect(u.searchParams.get("q")).toBe(prompt);
    expect(u.searchParams.get("folder")).toBe(folder);
    expect(u.searchParams.get("source")).toBe("heliu");
  });

  test("开新会话：没有目录时不带 folder；超长指令截到上限", () => {
    const u = new URL(newSessionLink("长".repeat(PROMPT_MAX + 50), "  "));
    expect(u.searchParams.has("folder")).toBe(false);
    const q = u.searchParams.get("q")!;
    expect(q.length).toBe(PROMPT_MAX);
    expect(q.endsWith("…")).toBe(true);
  });

  test("打开已有会话：只给本机会话 id（local_…），其余返回 null，不造假链接", () => {
    expect(continueSessionLink("local_fe1b1910-6db7-47ee-8133-a1a08bb94b32")).toBe("claude://code/continue?session=local_fe1b1910-6db7-47ee-8133-a1a08bb94b32&source=heliu");
    expect(continueSessionLink("cse_abc")).toBeNull();
    expect(continueSessionLink("local_有中文")).toBeNull();
    expect(continueSessionLink(`local_${"a".repeat(65)}`)).toBeNull();
    expect(continueSessionLink(null)).toBeNull();
  });
});

describe("看板会话链接（BoardService.sessionLink）", () => {
  const dir = mkdtempSync(join(tmpdir(), "heliu-handoff-"));
  const plain = join(dir, "local_plain.json");
  writeFileSync(plain, JSON.stringify({ sessionId: "local_plain", title: "没写链接的会话" }));
  const withLink = join(dir, "local_linked.json");
  writeFileSync(withLink, JSON.stringify({ sessionId: "local_linked", url: "claude://code/continue?session=local_linked&from=json" }));
  const stray = join(dir, "local_stray.json");
  writeFileSync(stray, JSON.stringify({ sessionId: "local_stray", postTurnSummary: "测了 claude://code/new?q=test 深链" }));
  const scan = { sessionFiles: new Map([["local_plain", plain], ["local_linked", withLink], ["local_stray", stray]]) };
  const call = (id: string | null) => BoardService.prototype.sessionLink.call({ linkCache: new Map() } as never, scan as never, id);

  test("会话 JSON 没写 claude:// 链接 → 用 code/continue 深链", () => {
    expect(call("local_plain")).toBe("claude://code/continue?session=local_plain&source=heliu");
  });
  test("会话 JSON 写了链接 → 照用", () => {
    expect(call("local_linked")).toBe("claude://code/continue?session=local_linked&from=json");
  });
  test("会话摘要里混进别的深链 → 不拿来用，仍打开本会话", () => {
    expect(call("local_stray")).toBe("claude://code/continue?session=local_stray&source=heliu");
  });
  test("找不到会话文件 → null（不给不认识的会话造链接）", () => {
    expect(call("local_missing")).toBeNull();
    expect(call(null)).toBeNull();
  });
});

describe("开工指令", () => {
  test("说清卡号、项目、预约、卡片原文；要求绑回这张卡、不新建卡、推送前先问", () => {
    const p = startPrompt({ id: "F-0003", title: "看板里直接发给 Claude", file: "/tmp/F-0003.md" }, { project: "合流", milestone: "vNext" });
    expect(p.split("\n")[0]).toBe("请开始做功能卡 F-0003「看板里直接发给 Claude」（合流项目「合流」，预约 vNext）。");
    expect(p).toContain("卡片原文在 /tmp/F-0003.md");
    expect(p).toContain("heliu_feature_bind（卡号 F-0003");
    expect(p).toContain("heliu feature bind F-0003");
    expect(p).toContain("不要再新建功能卡");
    expect(p).toContain("推送和合并主线前先问我");
    expect(p).not.toContain("--yes");
  });
  test("未预约、不知道项目时不写空括号", () => {
    const p = startPrompt({ id: "F-0009", title: "X" }, { project: null, milestone: null });
    expect(p.split("\n")[0]).toBe("请开始做功能卡 F-0009「X」。");
    expect(p).not.toContain("卡片原文");
  });
});
