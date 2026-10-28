/**
 * 项目的模块定义（M8）：台账目录下可放 modules.yaml 覆盖内置词典。
 *
 *   modules:
 *     - name: 语音与对话
 *       keywords: [语音, asr, tts]
 *     - name: 界面与交互
 *       keywords: [首页, 主题]
 *
 * 文件不存在或写错时用内置词典（写错会在 warnings 里说明），不影响其他功能。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { DEFAULT_MODULES, type ModuleDef } from "./classify.ts";

export function modulesFile(ledgerDir: string): string {
  return join(ledgerDir, "modules.yaml");
}

export function loadModules(ledgerDir: string): { modules: ModuleDef[]; source: "default" | "file"; warning: string | null } {
  const f = modulesFile(ledgerDir);
  if (!existsSync(f)) return { modules: DEFAULT_MODULES, source: "default", warning: null };
  try {
    const raw = YAML.parse(readFileSync(f, "utf8")) as { modules?: unknown };
    const list = Array.isArray(raw?.modules) ? raw.modules : null;
    if (!list) return { modules: DEFAULT_MODULES, source: "default", warning: `${f} 里没有 modules 列表，已用内置模块` };
    const out: ModuleDef[] = [];
    for (const m of list) {
      if (!m || typeof m !== "object") continue;
      const name = String((m as { name?: unknown }).name ?? "").trim();
      if (!name) continue;
      const kw = (m as { keywords?: unknown }).keywords;
      out.push({ name, keywords: Array.isArray(kw) ? kw.map((k) => String(k).trim()).filter(Boolean) : [] });
    }
    return out.length ? { modules: out, source: "file", warning: null } : { modules: DEFAULT_MODULES, source: "default", warning: `${f} 没有有效的模块，已用内置模块` };
  } catch (e) {
    return { modules: DEFAULT_MODULES, source: "default", warning: `${f} 读不出来（${(e as Error).message}），已用内置模块` };
  }
}
