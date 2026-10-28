/**
 * 装进 Claude（全局接入）
 * - 全局 CLAUDE.md 入口：追加 / 原地更新 / 删除都只动带 heliu 标记的那一段；写入后再删，原文逐字节还原；标记不成对时不改
 * - doctor「装进 Claude」三项：插件指向、全局入口新旧、终端软链
 * - CLI `heliu 全局入口`：预演不写、写入前备份、重复执行无害
 * - install.sh --dry-run：七步都打印，不建软链、不写文件
 * - 版本号四处一致（package.json / plugin.json / MCP server / heliu -V）
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyEntry,
  ENTRY_BEGIN,
  ENTRY_END,
  entryState,
  HELIU_REPO_ROOT,
  installChecks,
  loadEntry,
  removeEntry,
  renderEntry,
} from "../src/core/global-entry.ts";

const ROOT = HELIU_REPO_ROOT;
const BIN = join(ROOT, "bin", "heliu");
const ORIGINAL = "# Global Rules\n\n## 版本留痕规则\n\n- 一轮改动收尾时主动提交。\n\n## OBVault 分派规则\n\n1. 先读仓库内 `.claude/CLAUDE.md`。\n";
let tmp: string;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "heliu-entry-")));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("全局 CLAUDE.md 入口", () => {
  const block = loadEntry();

  test("原文带标记，讲清何时用、不替用户合并", () => {
    expect(block.startsWith(ENTRY_BEGIN)).toBe(true);
    expect(block.endsWith(ENTRY_END)).toBe(true);
    expect(block).toContain("heliu_feature_add");
    expect(block).toContain("heliu_after_merge");
    expect(block).toContain("heliu 合并 <版本>");
    expect(block).not.toContain("--yes");
  });

  test("追加到文末、其余内容不动；重复写入无变化；删除后逐字节还原", () => {
    const a = applyEntry(ORIGINAL, block);
    expect(a.action).toBe("added");
    expect(a.text.startsWith(ORIGINAL.trimEnd())).toBe(true);
    expect(entryState(a.text, block)).toBe("current");
    expect(applyEntry(a.text, block).action).toBe("unchanged");
    const r = removeEntry(a.text);
    expect(r.removed).toBe(true);
    expect(r.text).toBe(ORIGINAL);
    expect(removeEntry(ORIGINAL)).toEqual({ text: ORIGINAL, removed: false, broken: false });
  });

  test("旧版段落原地替换，前后的规则保持原位", () => {
    const old = renderEntry("## 合流（旧）\n\n1. 旧规则");
    const text = `# 规则\n\n${old}\n\n## 环境保护规则\n\n不切 ESP-IDF。\n`;
    expect(entryState(text, block)).toBe("stale");
    const u = applyEntry(text, block);
    expect(u.action).toBe("updated");
    expect(u.text).toBe(`# 规则\n\n${block}\n\n## 环境保护规则\n\n不切 ESP-IDF。\n`);
    // 段落在中间时删除：上下两节之间只留一个空行
    expect(removeEntry(u.text).text).toBe("# 规则\n\n## 环境保护规则\n\n不切 ESP-IDF。\n");
  });

  test("标记不成对时不改", () => {
    const broken = `${ORIGINAL}\n${ENTRY_BEGIN} 手动删了结尾 -->\n内容\n`;
    expect(entryState(broken, block)).toBe("broken");
    expect(applyEntry(broken, block)).toEqual({ text: broken, action: "broken" });
    expect(removeEntry(broken).broken).toBe(true);
    expect(entryState(`${ENTRY_END}\n${ORIGINAL}`, block)).toBe("broken");
  });

  test("空文件：只写这一段", () => {
    expect(applyEntry("", block).text).toBe(`${block}\n`);
    expect(removeEntry(`${block}\n`).text).toBe("");
  });
});

describe("doctor「装进 Claude」", () => {
  function setup(name: string) {
    const dir = join(tmp, name);
    const claudeHome = join(dir, ".claude");
    const bin = join(dir, "bin");
    mkdirSync(join(claudeHome, "plugins"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    return { dir, claudeHome, bin, claudeMd: join(dir, "CLAUDE.md") };
  }
  const level = (cs: ReturnType<typeof installChecks>, id: string) => cs.find((c) => c.id === id)?.level;

  test("什么都没装：三项都是提醒（不算失败），并说怎么补", () => {
    const s = setup("none");
    const cs = installChecks({ claudeHome: s.claudeHome, claudeMd: s.claudeMd, binDirs: [s.bin] });
    expect(cs.map((c) => c.id)).toEqual(["plugin", "global-entry", "terminal-cli"]);
    expect(cs.every((c) => c.level === "warn" && c.ok)).toBe(true);
    expect(cs.every((c) => c.message.includes("scripts/install.sh"))).toBe(true);
  });

  test("插件指向本目录且启用、入口最新、软链指向本目录：三项都通过", () => {
    const s = setup("all");
    writeFileSync(join(s.claudeHome, "plugins", "known_marketplaces.json"), JSON.stringify({ "heliu-local": { source: { source: "directory", path: ROOT } } }));
    writeFileSync(join(s.claudeHome, "settings.json"), JSON.stringify({ enabledPlugins: { "heliu@heliu-local": true } }));
    writeFileSync(s.claudeMd, applyEntry(ORIGINAL, loadEntry()).text);
    symlinkSync(BIN, join(s.bin, "heliu"));
    const cs = installChecks({ claudeHome: s.claudeHome, claudeMd: s.claudeMd, binDirs: [s.bin] });
    expect(cs.map((c) => c.level)).toEqual(["ok", "ok", "ok"]);
  });

  test("插件指向别的目录、入口是旧版、软链指向别处：分别提醒", () => {
    const s = setup("elsewhere");
    writeFileSync(join(s.claudeHome, "plugins", "known_marketplaces.json"), JSON.stringify({ "heliu-local": { source: { source: "directory", path: join(s.dir, "旧目录") } } }));
    writeFileSync(join(s.claudeHome, "settings.json"), JSON.stringify({ enabledPlugins: { "heliu@heliu-local": true } }));
    writeFileSync(s.claudeMd, applyEntry(ORIGINAL, renderEntry("旧的入口")).text);
    const other = join(s.dir, "other-heliu");
    writeFileSync(other, "#!/bin/sh\n");
    symlinkSync(other, join(s.bin, "heliu"));
    const cs = installChecks({ claudeHome: s.claudeHome, claudeMd: s.claudeMd, binDirs: [s.bin] });
    expect(cs.find((c) => c.id === "plugin")!.message).toContain("另一个目录");
    expect(cs.find((c) => c.id === "global-entry")!.message).toContain("旧版");
    expect(cs.find((c) => c.id === "terminal-cli")!.message).toContain("指向别处");
    expect(level(cs, "plugin")).toBe("warn");
  });

  test("插件装了但没启用", () => {
    const s = setup("disabled");
    writeFileSync(join(s.claudeHome, "plugins", "known_marketplaces.json"), JSON.stringify({ "heliu-local": { source: { source: "directory", path: ROOT } } }));
    writeFileSync(join(s.claudeHome, "settings.json"), JSON.stringify({ enabledPlugins: { "heliu@heliu-local": false } }));
    const cs = installChecks({ claudeHome: s.claudeHome, claudeMd: s.claudeMd, binDirs: [s.bin] });
    expect(cs.find((c) => c.id === "plugin")!.message).toContain("没启用");
  });
});

function run(cmd: string[], env: Record<string, string> = {}) {
  const r = Bun.spawnSync({ cmd, cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString() + r.stderr.toString() };
}

describe("CLI heliu 全局入口", () => {
  test("预演不写；写入前备份；重复执行无害；--remove 还原", () => {
    const home = join(tmp, "cli-home");
    const file = join(tmp, "cli", "CLAUDE.md");
    mkdirSync(join(tmp, "cli"), { recursive: true });
    writeFileSync(file, ORIGINAL);
    const env = { HELIU_HOME: home };
    const dry = run([process.execPath, "run", BIN, "全局入口", "--dry-run", "--file", file], env);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("预演");
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);

    const w = run([process.execPath, "run", BIN, "全局入口", "--file", file], env);
    expect(w.code).toBe(0);
    expect(w.out).toContain("已在");
    expect(entryState(readFileSync(file, "utf8"), loadEntry())).toBe("current");
    const backups = readdirSync(join(home, "backups"));
    expect(backups.length).toBe(1);
    expect(readFileSync(join(home, "backups", backups[0]!), "utf8")).toBe(ORIGINAL);

    expect(run([process.execPath, "run", BIN, "全局入口", "--file", file], env).out).toContain("已是最新");
    expect(readdirSync(join(home, "backups")).length).toBe(1);

    const rm = run([process.execPath, "run", BIN, "global-entry", "--remove", "--file", file, "--json"], env);
    expect(JSON.parse(rm.out).data.action).toBe("removed");
    expect(readFileSync(file, "utf8")).toBe(ORIGINAL);
  });

  test("文件不存在时新建（目录一并建好），不留备份", () => {
    const home = join(tmp, "cli-home-new");
    const file = join(tmp, "new", ".claude", "CLAUDE.md");
    const w = run([process.execPath, "run", BIN, "全局入口", "--file", file], { HELIU_HOME: home });
    expect(w.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(`${loadEntry()}\n`);
    expect(existsSync(join(home, "backups"))).toBe(false);
  });
});

describe("安装脚本", () => {
  test("--dry-run：七步都打印，不建软链、不写全局入口", () => {
    // 假家目录：没有桌面版 claude、没装过插件（全新机器）；~/.bun/bin 在 PATH 上、可写
    const home = join(tmp, "dry-home");
    const file = join(home, "CLAUDE.md");
    const binDir = join(home, ".bun", "bin");
    mkdirSync(binDir, { recursive: true });
    const r = run(["bash", join(ROOT, "scripts", "install.sh"), "--dry-run", `--claude-md=${file}`], { PATH: `${binDir}:${process.env.PATH ?? ""}`, HOME: home });
    expect(r.code).toBe(0);
    for (const n of ["1/7", "2/7", "3/7", "4/7", "5/7", "6/7", "7/7"]) expect(r.out).toContain(`【${n}】`);
    expect(r.out).toContain(`ln -sfn`);
    expect(r.out).toContain("预演：将在");
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(binDir, "heliu"))).toBe(false);
  }, 60_000);

  test("--help 列出新开关", () => {
    const r = run(["bash", join(ROOT, "scripts", "install.sh"), "--help"]);
    expect(r.out).toContain("--no-link");
    expect(r.out).toContain("--claude-md=");
  });
});

describe("版本号", () => {
  test("package.json、plugin.json、MCP server、heliu -V 一致", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
    const plugin = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8")).version as string;
    expect(plugin).toBe(pkg);
    expect(readFileSync(join(ROOT, "src", "mcp", "server.ts"), "utf8")).toContain(`{ name: "heliu", version: "${pkg}" }`);
    expect(run([process.execPath, "run", BIN, "-V"]).out.trim()).toBe(pkg);
  });
});
