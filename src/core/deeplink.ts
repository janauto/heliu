/**
 * F-0003「从看板直接交给 Claude」：Claude 桌面应用的 claude:// 深链。
 *
 * 只生成链接，合流自己不执行任何东西：
 * - `claude://code/new?q=<指令>&folder=<目录>`：在桌面应用里开一个新 Code 会话、目录选好、输入框预填指令，
 *   要不要发出由用户按回车决定（2026-11-04 在本机实测：中文、换行、& = # 与 1500 字长文都完整落地）。
 * - `claude://code/continue?session=local_…`：打开某个已有会话（会话 id 规则与桌面应用一致：local_ + 1~64 位字母数字或连字符）。
 *
 * 这两条路由来自桌面应用自己的深链处理（应用包里的 claudeURLHandler），不是公开文档接口；
 * 应用改版后可能失效，所以看板总是同时保留「复制指令」作兜底。
 */

/** 与桌面应用一致的本地会话 id 规则 */
const LOCAL_SESSION_RE = /^local_[A-Za-z0-9-]{1,64}$/;

/** 预填指令的上限（字符）。桌面应用自己也会截断；这里先截，免得链接过长被系统拒绝 */
export const PROMPT_MAX = 4000;

/** 打开已有会话的链接；id 不合规则（比如云端会话）返回 null，不造假链接 */
export function continueSessionLink(sessionId: string | null | undefined): string | null {
  if (!sessionId || !LOCAL_SESSION_RE.test(sessionId)) return null;
  return `claude://code/continue?session=${sessionId}&source=heliu`;
}

/** 开新会话并预填指令的链接；folder 为空时只预填指令、目录由用户在应用里选 */
export function newSessionLink(prompt: string, folder?: string | null): string {
  const q = new URLSearchParams();
  q.set("q", prompt.length > PROMPT_MAX ? `${prompt.slice(0, PROMPT_MAX - 1)}…` : prompt);
  if (folder?.trim()) q.set("folder", folder.trim());
  q.set("source", "heliu");
  // URLSearchParams 把空格编成 +；桌面应用用 URL.searchParams 解析，两种写法都认，这里统一成 %20 更稳
  return `claude://code/new?${q.toString().replace(/\+/g, "%20")}`;
}
