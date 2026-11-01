/** @jsxImportSource preact */
/**
 * 共用积木（M10）：图标、方块（Block）、胶囊、分段条、大数字、分段开关、页头、空态、弹出层。
 * 方块是全站唯一的功能画法：看板卡、时间线行、装配轨道槽位都是同一个 <Block>，只换密度。
 * 人话（能拼上 / 要先对齐 / 撞了 / 等你拍板 / 还在做 / 还没登记）只从服务端的 light / group / variant 推，前端不自己判断 git 事实。
 */
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { glyphOf, type BlockModel, type Tone } from "./block-model.ts";
import { dragProps, type DragOptions, type DragPayload } from "./dnd.ts";
import { ago } from "./lib.ts";

/* ───────────── 语义与方块模型：见 block-model.ts（纯函数，可单测） ───────────── */
export * from "./block-model.ts";

/* ───────────── 图标（24 viewBox，描边 1.8） ───────────── */

export type IconName =
  | "home" | "kanban" | "timeline" | "assembly" | "structure" | "sessions" | "hygiene" | "start" | "galaxy"
  | "search" | "refresh" | "sun" | "moon" | "auto" | "close" | "chevron" | "chevron-right" | "plus" | "grip" | "check" | "alert" | "copy" | "undo"
  | "arrow" | "external" | "branch" | "clock" | "filter" | "spark" | "info" | "more" | "terminal" | "calendar" | "folder" | "sync" | "book" | "zoom-in" | "zoom-out";

const P = (d: string) => <path d={d} />;
const ICONS: Record<IconName, JSX.Element> = {
  home: P("M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"),
  kanban: (
    <>
      <rect x="3.5" y="4.5" width="4.5" height="15" rx="1.2" />
      <rect x="9.75" y="4.5" width="4.5" height="10" rx="1.2" />
      <rect x="16" y="4.5" width="4.5" height="12" rx="1.2" />
    </>
  ),
  timeline: (
    <>
      <rect x="3" y="5" width="9" height="3.5" rx="1.5" />
      <rect x="8" y="10.25" width="12" height="3.5" rx="1.5" />
      <rect x="5" y="15.5" width="7" height="3.5" rx="1.5" />
    </>
  ),
  assembly: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="14" r="2" />
      {P("M6 7v10M6 9c0 5 12 0 12 3")}
    </>
  ),
  structure: (
    <>
      <rect x="4" y="3.5" width="7" height="5" rx="1.2" />
      <rect x="13" y="15.5" width="7" height="5" rx="1.2" />
      {P("M7.5 8.5v6a3.5 3.5 0 0 0 3.5 3.5h2")}
    </>
  ),
  sessions: P("M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H9.5L5 20v-4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"),
  hygiene: P("M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6zM5 16l.8 2.2L8 19l-2.2.8L5 22l-.8-2.2L2 19l2.2-.8z"),
  start: P("M5 21V4M5 4h11l-2 4 2 4H5"),
  galaxy: (
    <>
      <circle cx="12" cy="12" r="3" />
      {P("M12 3a9 9 0 0 1 9 9M12 21a9 9 0 0 1-9-9")}
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P("M16 16l4.5 4.5")}
    </>
  ),
  refresh: P("M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      {P("M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4")}
    </>
  ),
  moon: P("M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"),
  auto: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  close: P("M6 6l12 12M18 6L6 18"),
  chevron: P("M6 9l6 6 6-6"),
  "chevron-right": P("M9 6l6 6-6 6"),
  plus: P("M12 5v14M5 12h14"),
  grip: (
    <g fill="currentColor" stroke="none">
      <circle cx="9" cy="6" r="1.5" />
      <circle cx="15" cy="6" r="1.5" />
      <circle cx="9" cy="12" r="1.5" />
      <circle cx="15" cy="12" r="1.5" />
      <circle cx="9" cy="18" r="1.5" />
      <circle cx="15" cy="18" r="1.5" />
    </g>
  ),
  check: P("M5 12.5l4.5 4.5L19 7"),
  alert: P("M12 4l9 16H3zM12 10v4M12 17v.5"),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      {P("M5 15V6a2 2 0 0 1 2-2h9")}
    </>
  ),
  undo: P("M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3"),
  arrow: P("M5 12h14M13 6l6 6-6 6"),
  external: P("M14 4h6v6M20 4l-9 9M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"),
  branch: (
    <>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="8" r="2" />
      {P("M6 7v10M18 10c0 4-12 2-12 6")}
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      {P("M12 8v4l3 2")}
    </>
  ),
  filter: P("M4 6h16M7 12h10M10 18h4"),
  spark: P("M12 3v3M12 18v3M3 12h3M18 12h3M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"),
  info: (
    <>
      <circle cx="12" cy="12" r="8" />
      {P("M12 11v5M12 8v.5")}
    </>
  ),
  more: (
    <g fill="currentColor" stroke="none">
      <circle cx="6" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="18" cy="12" r="1.7" />
    </g>
  ),
  terminal: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      {P("M7 9l3 3-3 3M12 15h5")}
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="2" />
      {P("M4 10h16M8 3v4M16 3v4")}
    </>
  ),
  folder: P("M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"),
  sync: P("M4 12a8 8 0 0 1 13.7-5.7M20 12a8 8 0 0 1-13.7 5.7M17 4v3h-3M7 20v-3h3"),
  book: P("M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19a2 2 0 0 1 2-2h13M8 7h7"),
  "zoom-in": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P("M16 16l4.5 4.5M11 8v6M8 11h6")}
    </>
  ),
  "zoom-out": (
    <>
      <circle cx="11" cy="11" r="6.5" />
      {P("M16 16l4.5 4.5M8 11h6")}
    </>
  ),
};

export function Icon({ name, size = 18, class: cls }: { name: IconName; size?: number; class?: string }) {
  return (
    <svg class={`icon${cls ? ` ${cls}` : ""}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

/* ───────────── 方块 ───────────── */

export interface BlockProps {
  m: BlockModel;
  density?: "card" | "compact" | "mini";
  selected?: boolean;
  onClick?: () => void;
  /** 传了就能拖：payload 由调用方决定（通常 {kind:"card", id, label, data: card}） */
  drag?: { payload: DragPayload | (() => DragPayload | null); opts?: DragOptions };
  class?: string;
  style?: string | Record<string, string | number>;
  /** 右上角工具（hover 才显示） */
  tools?: ComponentChildren;
  children?: ComponentChildren;
  title?: string;
  /** 元信息行里不显示预约（看板里列名已经说明了） */
  hideMilestone?: boolean;
}

export function Block({ m, density = "card", selected, onClick, drag, class: cls, style, tools, children, title, hideMilestone }: BlockProps) {
  const handlers = drag ? dragProps(drag.payload, drag.opts) : {};
  const classes = ["block", density, `tone-${m.light}`];
  if (selected) classes.push("selected");
  if (m.variant === "merged-pending") classes.push("merged");
  if (m.variant === "done") classes.push("done");
  if (drag) classes.push("draggable");
  if (cls) classes.push(cls);
  const meta: ComponentChildren[] = [];
  if (m.repoLabel) meta.push(<span>{m.repoLabel}</span>);
  if (!hideMilestone) meta.push(m.milestone ? <span class="ms">{m.milestone}</span> : <span>未预约</span>);
  if (m.lastActivityAt) meta.push(<span title={m.lastActivityAt}>{ago(m.lastActivityAt)}</span>);
  return (
    <div
      class={classes.join(" ")}
      data-key={m.key}
      tabIndex={0}
      role="button"
      aria-label={`${m.title}，${m.human}`}
      title={title}
      style={style}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick?.();
        }
      }}
      {...handlers}
    >
      <span class="studs" aria-hidden="true">
        <i />
        <i />
      </span>
      {density === "mini" ? (
        <>
          <span class="block-type" title={`类型：${m.type}`}>
            <b class="glyph">{glyphOf(m.type)}</b>
          </span>
          <h4 class="block-title">{m.title}</h4>
          {children}
        </>
      ) : (
        <>
          <header class="block-top">
            <span class={`block-type${m.typeGuess ? " guess" : ""}`} title={`类型：${m.type}${m.typeGuess ? "（推测，可在详情里改）" : ""} · 模块：${m.module}`}>
              <b class="glyph">{glyphOf(m.type)}</b>
              <span class="name">{m.type}</span>
            </span>
            {m.id ? <span class="block-id">{m.id}</span> : <span class="block-id new">新</span>}
            {density === "compact" ? <h4 class="block-title">{m.title}</h4> : <span class="spacer" />}
            {density === "compact" ? (
              <span class="block-human">
                <b>{m.human}</b>
              </span>
            ) : null}
            {tools ? <span class="block-tools">{tools}</span> : null}
            {drag ? (
              <span class="block-handle" title="按住拖动">
                <Icon name="grip" size={16} />
              </span>
            ) : null}
          </header>
          {density === "card" ? (
            <>
              <h4 class="block-title">{m.title}</h4>
              <p class="block-human">
                <b>{m.human}</b>
                {m.fact ? <span class="fact">{m.fact}</span> : null}
              </p>
              <p class="block-meta">
                {meta.map((x, i) => (
                  <>
                    {i ? <span class="sep">·</span> : null}
                    {x}
                  </>
                ))}
              </p>
              {m.chips.length ? (
                <div class="block-chips">
                  {m.chips.map((c) => (
                    <span class={`chip tone-${c.tone}`} title={c.title}>
                      {c.text}
                    </span>
                  ))}
                </div>
              ) : null}
            </>
          ) : null}
          {children}
        </>
      )}
    </div>
  );
}

/* ───────────── 小积木 ───────────── */

export function Pill({ tone = "gray", outline, brand, children, class: cls, title }: { tone?: Tone; outline?: boolean; brand?: boolean; children: ComponentChildren; class?: string; title?: string }) {
  return (
    <span class={`pill tone-${tone}${outline ? " outline" : ""}${brand ? " brand" : ""}${cls ? ` ${cls}` : ""}`} title={title}>
      {children}
    </span>
  );
}
export function Dot({ tone = "gray", big }: { tone?: Tone; big?: boolean }) {
  return <i class={`dot tone-${tone}${big ? " big" : ""}`} />;
}
export function Chip({ tone = "gray", children, onClick, title }: { tone?: Tone; children: ComponentChildren; onClick?: () => void; title?: string }) {
  return (
    <span class={`chip tone-${tone}${onClick ? " interactive" : ""}`} onClick={onClick} title={title} role={onClick ? "button" : undefined}>
      {children}
    </span>
  );
}

export interface BarPart {
  tone: Tone;
  n: number;
  label?: string;
}
/** 分段进度条：按张数占比，0 的段不画 */
export function Bar({ parts, thick, thin, title }: { parts: BarPart[]; thick?: boolean; thin?: boolean; title?: string }) {
  const total = parts.reduce((a, p) => a + p.n, 0);
  return (
    <div class={`bar${thick ? " thick" : ""}${thin ? " thin" : ""}`} title={title} role="img" aria-label={parts.filter((p) => p.n).map((p) => `${p.label ?? p.tone} ${p.n}`).join("，")}>
      {total ? parts.filter((p) => p.n > 0).map((p) => <i class={`tone-${p.tone}`} style={`flex:${p.n}`} title={`${p.label ?? ""} ${p.n}`} />) : null}
    </div>
  );
}
export function BarLegend({ parts, onPick }: { parts: BarPart[]; onPick?: (p: BarPart) => void }) {
  return (
    <div class="bar-legend">
      {parts.map((p) => (
        <span class={onPick ? "clickable" : ""} onClick={onPick ? () => onPick(p) : undefined} style={onPick ? "cursor:pointer" : undefined}>
          <Dot tone={p.tone} />
          {p.label} <b>{p.n}</b>
        </span>
      ))}
    </div>
  );
}

export function Stat({ n, label, tone, onClick, sm, title }: { n: number | string; label: string; tone?: Tone; onClick?: () => void; sm?: boolean; title?: string }) {
  return (
    <div class={`stat${tone ? ` tone-${tone}` : ""}${onClick ? " clickable" : ""}${sm ? " sm" : ""}`} onClick={onClick} title={title} role={onClick ? "button" : undefined}>
      <span class="v">{n}</span>
      <span class="k">{label}</span>
    </div>
  );
}

export interface SegOption<T extends string> {
  value: T;
  label: ComponentChildren;
  tone?: Tone;
  disabled?: boolean;
  title?: string;
}
export function Seg<T extends string>({ options, value, onChange, small, tone }: { options: Array<SegOption<T>>; value: T; onChange: (v: T) => void; small?: boolean; tone?: boolean }) {
  return (
    <div class={`seg${small ? " small" : ""}${tone ? " tone" : ""}`} role="radiogroup">
      {options.map((o) => (
        <button class={`${o.value === value ? "on" : ""}${o.tone ? ` tone-${o.tone}` : ""}`} role="radio" aria-checked={o.value === value} disabled={o.disabled} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function PageHead({ icon, title, desc, children }: { icon?: IconName; title: ComponentChildren; desc?: ComponentChildren; children?: ComponentChildren }) {
  return (
    <div class="page-head">
      <div>
        <h1>
          {icon ? <Icon name={icon} size={22} /> : null}
          {title}
        </h1>
        {desc ? <p class="desc">{desc}</p> : null}
      </div>
      {children ? <div class="tools">{children}</div> : null}
    </div>
  );
}

export function Empty({ icon = "info", title, hint, children, inline }: { icon?: IconName; title: ComponentChildren; hint?: ComponentChildren; children?: ComponentChildren; inline?: boolean }) {
  return (
    <div class={`empty${inline ? " inline" : ""}`}>
      <Icon name={icon} size={inline ? 18 : 28} />
      <div>
        <h3>{title}</h3>
        {hint ? <p>{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function GroupHead({ tone, title, n, open, onToggle, hint }: { tone: Tone; title: string; n: number; open: boolean; onToggle: () => void; hint?: string }) {
  return (
    <button class={`group-head${open ? "" : " closed"}`} onClick={onToggle} title={hint} aria-expanded={open}>
      <Dot tone={tone} />
      {title} <span class="n">{n}</span>
      <Icon name="chevron" size={14} class="chev" />
    </button>
  );
}

/** 弹出层：点外面 / Esc 关闭 */
export function Popover({ open, onClose, children, class: cls, style }: { open: boolean; onClose: () => void; children: ComponentChildren; class?: string; style?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      // 点在弹层外就关；同一个容器里的锚点按钮（打开它的那个）豁免，别的容器的锚点照关
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !ref.current.parentElement?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", down);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointerdown", down);
      window.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!open) return null;
  return (
    <div class={`popover${cls ? ` ${cls}` : ""}`} ref={ref} style={style} role="menu">
      {children}
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Icon name="refresh" size={size} class="spin" />;
}

/** 复制按钮：点了变「已复制」两秒 */
export function CopyBtn({ text, label = "复制", small = true, class: cls }: { text: string | (() => Promise<string> | string); label?: string; small?: boolean; class?: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const click = async () => {
    const t = typeof text === "function" ? await text() : text;
    let ok = true;
    try {
      await navigator.clipboard.writeText(t);
    } catch {
      ok = false;
      window.prompt("复制下面的内容：", t);
    }
    const b = ref.current;
    if (!b) return;
    const old = b.textContent;
    b.textContent = ok ? "已复制" : "请手动复制";
    setTimeout(() => {
      if (ref.current) ref.current.textContent = old;
    }, 1800);
  };
  return (
    <button ref={ref} class={`btn${small ? " small" : ""}${cls ? ` ${cls}` : ""}`} onClick={() => void click()}>
      {label}
    </button>
  );
}
