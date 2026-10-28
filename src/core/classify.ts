/**
 * 分类（M8，纯函数，不依赖 node，前端也直接用）：
 * - 类型：修复 / 功能 / 调研 / 文档 / 工程 / 其他 —— 看标题、会话标题、分支名、首条提交里的关键词。
 * - 模块：整机的组成部分 —— 内置一套通用词典，项目可用台账目录下的 modules.yaml 覆盖。
 * 推测只用于显示；用户改过（卡片 frontmatter 的 type / module）才算数，推测永不覆盖用户的选择。
 */

export const FEATURE_TYPES = ["修复", "功能", "调研", "文档", "工程", "其他"] as const;
export type FeatureType = (typeof FEATURE_TYPES)[number];

export interface ModuleDef {
  /** 模块名（显示名，同时也是写进卡片的值） */
  name: string;
  /** 命中任一关键词即归入（不区分大小写） */
  keywords: string[];
}

/** 未命中任何模块时的归处 */
export const OTHER_MODULE = "其他";

/** 内置模块词典：面向"软硬件结合的产品"的通用划分；项目可在 modules.yaml 里改 */
export const DEFAULT_MODULES: ModuleDef[] = [
  { name: "语音与对话", keywords: ["语音", "asr", "tts", "朗读", "对话", "voice", "speech", "麦克风", "扬声器", "唤醒", "播报"] },
  { name: "通话与秘书", keywords: ["电话", "来电", "通话", "秘书", "call", "tonocard", "callsec"] },
  { name: "界面与交互", keywords: ["首页", "主题", "界面", "ui", "交互", "原型", "卡片", "小组件", "widget", "触屏", "竖屏", "竖版", "公仔", "动画", "显示", "html", "屏幕", "抽屉", "drawer", "timeline", "时间线", "stage", "companion", "卸载", "焦点", "live2d", "squareline"] },
  { name: "固件与连接", keywords: ["固件", "蓝牙", "ble", "刷", "烧录", "wi-fi", "wifi", "esp", "驱动", "总线", "硬件", "电机", "背夹扬声器", "firmware", "flash", "aios", "底座", "结构", "cli 监听", "调试通道"] },
  { name: "手机 App", keywords: ["app", "手机", "android", "ios", "flutter", "安卓"] },
  { name: "平台与接口", keywords: ["epp", "mcp", "网关", "api", "key", "模型", "服务", "云", "涂鸦", "tuya", "lua", "脚本", "sdk", "provider", "homekit", "muse", "生成"] },
  { name: "产品与资料", keywords: ["prd", "说明书", "调研", "评估", "可行性", "方案", "视频", "宣传", "归档", "文档", "市场", "竞品", "场景", "洞察", "需求", "卖点", "aqara", "专利", "报告"] },
];

/** 类型关键词：按顺序判定，先命中先算（修复优先于其他） */
const TYPE_RULES: Array<{ type: FeatureType; re: RegExp }> = [
  { type: "修复", re: /(^|[/_\-\s(（:：])(fix|bug|hotfix)\b|修复|修正|错误|报错|异常|崩溃|闪退|卡死|失败|焦点错误|teardown|回退|故障/i },
  { type: "工程", re: /(^|[/_\-\s])(chore|refactor|merge|sync|ci|test|build)\b|合并|同步|重构|迁移|清理|整理|测试|验证|集成与烧录|刷最新|备份|升级依赖/i },
  { type: "调研", re: /调研|评估|可行性|研究|research|分析|对比|poc|探索|洞察|穷举|挖掘|兼容/i },
  { type: "文档", re: /(^|[/_\-\s])docs?\b|文档|说明书|prd|归档|视频|宣传|readme|手册|报告|示意图|标识图|架构图|规范/i },
];

/** 一张卡或一条分支可用于推测的全部文字（标题、会话标题、分支名、首条提交） */
export function classifyText(parts: Array<string | null | undefined>): string {
  return parts.filter((x): x is string => !!x && !!x.trim()).join(" · ");
}

export function inferType(text: string): FeatureType {
  for (const r of TYPE_RULES) if (r.re.test(text)) return r.type;
  return text.trim() ? "功能" : "其他";
}

/** 命中关键词最多的模块；一样多时看谁的关键词出现得更早（"app: 对话模型…"里开头的 app 说了算） */
export function inferModule(text: string, modules: ModuleDef[] = DEFAULT_MODULES): string {
  const t = text.toLowerCase();
  let best: { name: string; hits: number; first: number } | null = null;
  for (const m of modules) {
    let hits = 0;
    let first = Number.POSITIVE_INFINITY;
    for (const k of m.keywords) {
      if (!k) continue;
      const i = t.indexOf(k.toLowerCase());
      if (i < 0) continue;
      hits += 1;
      first = Math.min(first, i);
    }
    if (hits > 0 && (!best || hits > best.hits || (hits === best.hits && first < best.first))) best = { name: m.name, hits, first };
  }
  return best?.name ?? OTHER_MODULE;
}

export function isFeatureType(v: unknown): v is FeatureType {
  return typeof v === "string" && (FEATURE_TYPES as readonly string[]).includes(v);
}

/** 用户输入的类型 → 规范值（支持 bug / feature 等英文别名） */
export function parseFeatureType(raw: string): FeatureType {
  const v = raw.trim();
  if (isFeatureType(v)) return v;
  const alias: Record<string, FeatureType> = {
    bug: "修复", fix: "修复", bugfix: "修复", 缺陷: "修复", 问题: "修复",
    feature: "功能", feat: "功能", 迭代: "功能", 功能点: "功能", 功能迭代: "功能", 需求: "功能",
    research: "调研", 研究: "调研", 评估: "调研",
    doc: "文档", docs: "文档", 资料: "文档",
    chore: "工程", 工程化: "工程", 重构: "工程", 维护: "工程",
    other: "其他",
  };
  const hit = alias[v.toLowerCase()];
  if (hit) return hit;
  throw new Error(`不认识的类型「${raw}」：可选 ${FEATURE_TYPES.join(" / ")}`);
}

export interface Classified {
  type: FeatureType;
  /** card = 卡片上写明的（用户改过）；guess = 推测 */
  typeSource: "card" | "guess";
  module: string;
  moduleSource: "card" | "guess";
}

/** 卡片上写了就用卡片的；没写就推测 */
export function classify(card: { type?: string | null; module?: string | null } | null, text: string, modules: ModuleDef[] = DEFAULT_MODULES): Classified {
  const t = card?.type && isFeatureType(card.type) ? card.type : null;
  const m = card?.module?.trim() || null;
  return {
    type: t ?? inferType(text),
    typeSource: t ? "card" : "guess",
    module: m ?? inferModule(text, modules),
    moduleSource: m ? "card" : "guess",
  };
}

/** 星图里用的形状：修复 ◆、功能 ●、调研 ▲、文档 ■、工程 ⬢、其他 ○ */
export const TYPE_GLYPH: Record<FeatureType, string> = { 修复: "◆", 功能: "●", 调研: "▲", 文档: "■", 工程: "⬢", 其他: "○" };
