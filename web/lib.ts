/** 看板前端公用：请求、数据加载 hook、时间与数字格式。 */
import { useEffect, useRef, useState } from "preact/hooks";
import type { BoardEnvelope } from "../src/board/api-types.ts";

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<BoardEnvelope<T>> {
  const hasBody = init.body !== undefined;
  const res = await fetch(path, {
    method: init.method ?? (hasBody ? "POST" : "GET"),
    headers: hasBody ? { "Content-Type": "application/json" } : {},
    body: hasBody ? JSON.stringify(init.body) : undefined,
  });
  let j: unknown = null;
  try {
    j = await res.json();
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) throw new Error((j as { error?: string } | null)?.error ?? `请求失败（HTTP ${res.status}）`);
  return j as BoardEnvelope<T>;
}

export interface Loaded<T> {
  env: BoardEnvelope<T> | null;
  error: string | null;
  loading: boolean;
}

/** 拉一个接口；deps 变化（含刷新计数）时重拉，重拉期间保留旧数据不闪烁 */
export function useApi<T>(path: string | null, deps: unknown[]): Loaded<T> & { reload: () => void } {
  const [state, setState] = useState<Loaded<T>>({ env: null, error: null, loading: !!path });
  const [n, setN] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!path) return;
    const my = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    api<T>(path)
      .then((env) => my === seq.current && setState({ env, error: null, loading: false }))
      .catch((e: Error) => my === seq.current && setState((s) => ({ env: s.env, error: e.message, loading: false })));
  }, [path, n, ...deps]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

const p2 = (n: number) => String(n).padStart(2, "0");
export function hms(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}
export function mdhm(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function ago(iso: string | null | undefined): string {
  if (!iso) return "";
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "刚刚";
  if (s < 3600) return `${Math.round(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

/** 复制到剪贴板；失败时退回 prompt 让用户手动复制 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("复制下面的内容：", text);
    return false;
  }
}

export const SESSION_STATUS_TEXT: Record<string, string> = {
  running: "运行中",
  online: "在线（空闲）",
  blocked: "等你",
  review_ready: "待验收",
  completed: "已完成",
  archived: "已归档",
  unknown: "无状态记录",
};

export const MERGED_TEXT: Record<string, string> = { in_main: "进主线", in_integration: "进集成分支", unmerged: "独立未合并" };
