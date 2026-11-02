/**
 * 指针拖拽（M10）：鼠标、触控板、触屏统一走 Pointer Events，不用 HTML5 draggable（幽灵、文案、落点都自己画，跨浏览器一致）。
 * - 可放目标用 useDropTarget(spec) 登记（元素带 data-drop-id）。拖起时每个目标先回答 canDrop：
 *   返回 { ok, hint } 的加 drop-can / drop-no；返回 null 的表示对这种东西不感兴趣（不高亮）。
 * - 指针悬在目标上时加 drop-hot（不可放再加 drop-bad），并在指针旁显示文案（「放到这里：预约到 v1.2」/「已发布的版本不能再预约」）。
 * - 松手落在可放目标上 → onDrop(payload)；Esc 取消。拖拽本身不发请求，请求由 onDrop 决定（乐观更新 + 失败回滚由调用方负责）。
 * - 指针贴着可滚动容器（横向列容器、.main 工作台）的边缘时自动滚动，滚动后按当前指针位置重新找落点。
 */
import { useRef } from "preact/hooks";

export interface DragPayload<T = unknown> {
  /** card = 功能卡；branch = 没卡的分支；milestone = 版本；其他页面可自定义 */
  kind: "card" | "branch" | "milestone" | (string & {});
  id: string;
  /** 幽灵旁与 toast 里用的名字 */
  label: string;
  data: T;
}
export interface DropVerdict {
  ok: boolean;
  hint: string;
}
export interface DropSpec {
  /** null = 这个目标对这种东西不感兴趣 */
  canDrop(p: DragPayload): DropVerdict | null;
  onDrop(p: DragPayload): void | Promise<void>;
}

interface Target {
  el: HTMLElement;
  spec: DropSpec;
}
const targets = new Map<string, Target>();
let seq = 0;
let dragging = false;
export const isDragging = (): boolean => dragging;

export function registerDropTarget(el: HTMLElement, spec: DropSpec): () => void {
  const id = `dz${++seq}`;
  el.dataset.dropId = id;
  targets.set(id, { el, spec });
  return () => {
    targets.delete(id);
    if (el.dataset.dropId === id) delete el.dataset.dropId;
  };
}

/**
 * 在组件里把元素登记为可放目标：<div ref={useDropTarget(spec)}>。
 * 返回的 ref 回调是稳定的；spec 每次渲染可以换（闭包里拿最新的 props）。传 null = 暂时不接受任何拖放。
 */
export function useDropTarget(spec: DropSpec | null): (el: HTMLElement | null) => void {
  const specRef = useRef<DropSpec | null>(spec);
  specRef.current = spec;
  const cbRef = useRef<((el: HTMLElement | null) => void) | null>(null);
  if (!cbRef.current) {
    let unreg: (() => void) | null = null;
    const proxy: DropSpec = {
      canDrop: (p) => specRef.current?.canDrop(p) ?? null,
      onDrop: (p) => specRef.current?.onDrop(p),
    };
    cbRef.current = (el) => {
      unreg?.();
      unreg = null;
      if (el) unreg = registerDropTarget(el, proxy);
    };
  }
  return cbRef.current;
}

export interface DragOptions {
  /** 用来做幽灵的元素；缺省是 pointerdown 的 currentTarget */
  source?: HTMLElement | null;
  /** 移动多少像素才算拖（之前仍是点击） */
  threshold?: number;
  onStart?(): void;
  /** dropped = 是否落在可放目标上 */
  onEnd?(dropped: boolean): void;
}

/** 给方块用的 props：{...dragProps(payload)}；payload 可以是函数（拖起时才算） */
export function dragProps(payload: DragPayload | (() => DragPayload | null), opts: DragOptions = {}): { onPointerDown: (e: PointerEvent) => void } {
  return { onPointerDown: (e: PointerEvent) => beginDrag(e, payload, opts) };
}

export function beginDrag(e: PointerEvent, payloadOrFn: DragPayload | (() => DragPayload | null), opts: DragOptions = {}): void {
  if (dragging || e.button !== 0 || !e.isPrimary) return;
  const t = e.target as HTMLElement | null;
  if (t?.closest("button, a, input, select, textarea, [data-nodrag]")) return;
  // 触屏：只从拖柄（[data-drag-handle]）起拖，方块主体留给页面滚动（Codex 第 3 轮建议）；鼠标 / 触控板仍可整块拖
  if (e.pointerType === "touch" && !t?.closest("[data-drag-handle]")) return;
  const source = opts.source ?? (e.currentTarget as HTMLElement | null);
  if (!source) return;
  const sx = e.clientX;
  const sy = e.clientY;
  const rect = source.getBoundingClientRect();
  const offX = sx - rect.left;
  const offY = sy - rect.top;
  const threshold = opts.threshold ?? 6;
  let active = false;
  let payload: DragPayload | null = null;
  let ghost: HTMLElement | null = null;
  let hint: HTMLElement | null = null;
  let hot: { id: string; ok: boolean } | null = null;
  const verdicts = new Map<string, DropVerdict>();
  // 边缘自动滚动：拖起时收集源元素的可滚动祖先（横向列容器、.main 工作台…），指针贴边时滚它，滚完按当前指针重新找落点
  let scrollers: HTMLElement[] = [];
  let lastX = sx;
  let lastY = sy;
  let raf = 0;
  const EDGE = 56;
  const MAX_V = 16;
  const speed = (d: number) => Math.ceil(Math.min(MAX_V, (Math.max(0, d) / EDGE) * MAX_V));
  const collectScrollers = () => {
    const out: HTMLElement[] = [];
    let el: HTMLElement | null = source.parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      const sx_ = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1;
      const sy_ = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1;
      if (sx_ || sy_) out.push(el);
      el = el.parentElement;
    }
    return out;
  };
  const autoScroll = () => {
    raf = 0;
    if (!active) return;
    let moved = false;
    for (const el of scrollers) {
      const r = el.getBoundingClientRect();
      if (lastX < r.left - 8 || lastX > r.right + 8 || lastY < r.top - 8 || lastY > r.bottom + 8) continue;
      let vx = 0;
      let vy = 0;
      if (el.scrollWidth > el.clientWidth + 1) {
        if (lastX < r.left + EDGE) vx = -speed(r.left + EDGE - lastX);
        else if (lastX > r.right - EDGE) vx = speed(lastX - (r.right - EDGE));
      }
      if (el.scrollHeight > el.clientHeight + 1) {
        if (lastY < r.top + EDGE) vy = -speed(r.top + EDGE - lastY);
        else if (lastY > r.bottom - EDGE) vy = speed(lastY - (r.bottom - EDGE));
      }
      if (vx) {
        const b = el.scrollLeft;
        el.scrollLeft += vx;
        moved = moved || el.scrollLeft !== b;
      }
      if (vy) {
        const b = el.scrollTop;
        el.scrollTop += vy;
        moved = moved || el.scrollTop !== b;
      }
    }
    if (moved) {
      setHot(hitTest(lastX, lastY), lastX, lastY);
      raf = requestAnimationFrame(autoScroll);
    }
  };
  const onAnyScroll = () => {
    if (active) setHot(hitTest(lastX, lastY), lastX, lastY);
  };

  const start = (): boolean => {
    payload = typeof payloadOrFn === "function" ? payloadOrFn() : payloadOrFn;
    if (!payload) return false;
    dragging = true;
    active = true;
    document.body.classList.add("dragging");
    source.classList.add("is-dragging");
    ghost = source.cloneNode(true) as HTMLElement;
    ghost.classList.remove("is-dragging", "selected", "landed");
    ghost.classList.add("drag-ghost");
    ghost.style.width = `${rect.width}px`;
    ghost.style.height = `${rect.height}px`;
    ghost.style.transformOrigin = `${offX}px ${offY}px`;
    ghost.setAttribute("aria-hidden", "true");
    document.body.appendChild(ghost);
    hint = document.createElement("div");
    hint.className = "drag-hint";
    hint.hidden = true;
    document.body.appendChild(hint);
    for (const [id, tg] of targets) {
      const v = tg.spec.canDrop(payload);
      if (!v) continue;
      verdicts.set(id, v);
      tg.el.classList.add(v.ok ? "drop-can" : "drop-no");
    }
    scrollers = collectScrollers();
    document.addEventListener("scroll", onAnyScroll, { capture: true, passive: true });
    opts.onStart?.();
    return true;
  };

  const hitTest = (x: number, y: number): string | null => {
    for (const el of document.elementsFromPoint(x, y)) {
      const z = (el as HTMLElement).closest?.("[data-drop-id]") as HTMLElement | null;
      if (!z) continue;
      const id = z.dataset.dropId ?? "";
      if (verdicts.has(id)) return id;
      // 落在一个对此不感兴趣的目标上：继续往下找（可能嵌套）
    }
    return null;
  };

  const setHot = (id: string | null, x: number, y: number) => {
    if (hot && hot.id !== id) {
      targets.get(hot.id)?.el.classList.remove("drop-hot", "drop-bad");
      hot = null;
    }
    if (id && !hot) {
      const v = verdicts.get(id)!;
      const el = targets.get(id)!.el;
      el.classList.add("drop-hot");
      if (!v.ok) el.classList.add("drop-bad");
      hot = { id, ok: v.ok };
    }
    if (hint) {
      if (hot) {
        const v = verdicts.get(hot.id)!;
        hint.textContent = v.hint;
        hint.className = `drag-hint ${v.ok ? "ok" : "no"}`;
        hint.hidden = false;
      } else hint.hidden = true;
      hint.style.left = `${x}px`;
      hint.style.top = `${y}px`;
    }
  };

  const cleanup = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", cancel);
    window.removeEventListener("keydown", key);
    if (!active) return;
    document.removeEventListener("scroll", onAnyScroll, { capture: true });
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    for (const [id, v] of verdicts) targets.get(id)?.el.classList.remove(v.ok ? "drop-can" : "drop-no", "drop-hot", "drop-bad");
    ghost?.remove();
    hint?.remove();
    document.body.classList.remove("dragging");
    source.classList.remove("is-dragging");
    dragging = false;
  };

  const finish = (dropped: boolean) => {
    const target = dropped && hot?.ok ? targets.get(hot.id) : null;
    const p = payload;
    cleanup();
    if (active) {
      // 拖完同一位置会紧接着冒一个 click：吞掉它，免得顺手打开详情
      const swallow = (c: MouseEvent) => {
        c.stopPropagation();
        c.preventDefault();
      };
      window.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 60);
      source.classList.add("landed");
      setTimeout(() => source.classList.remove("landed"), 400);
    }
    if (target && p) void target.spec.onDrop(p);
    if (active) opts.onEnd?.(!!target);
  };

  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    if (!active) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < threshold) return;
      if (!start()) {
        cleanup();
        return;
      }
    }
    ev.preventDefault();
    lastX = ev.clientX;
    lastY = ev.clientY;
    if (ghost) ghost.style.transform = `translate(${ev.clientX - offX}px, ${ev.clientY - offY}px) rotate(1.2deg) scale(1.02)`;
    setHot(hitTest(ev.clientX, ev.clientY), ev.clientX, ev.clientY);
    if (!raf && scrollers.length) raf = requestAnimationFrame(autoScroll);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== e.pointerId) return;
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") finish(false);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", cancel);
  window.addEventListener("keydown", key);
}
