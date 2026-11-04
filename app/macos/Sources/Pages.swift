// 看板还没起来时窗口里显示的两张页：「正在启动」和「出了问题」。样式取自 web/styles/00-tokens.css 的令牌。
import Foundation

struct PageAction {
  let id: String
  let label: String
  var primary = false
}

enum Pages {
  static func esc(_ s: String) -> String {
    s.replacingOccurrences(of: "&", with: "&amp;")
      .replacingOccurrences(of: "<", with: "&lt;")
      .replacingOccurrences(of: ">", with: "&gt;")
      .replacingOccurrences(of: "\"", with: "&quot;")
  }

  /// 正在启动：标题 + 一句说明 + 秒表（页面自己计时）
  static func loading(title: String, detail: String) -> String {
    frame(body: """
      <div class="card">
        \(mark)
        <h1>\(esc(title))</h1>
        <p>\(esc(detail))</p>
        <div class="bar"><i></i></div>
        <p class="faint">已等 <b id="t">0</b> 秒</p>
      </div>
      <script>const s=Date.now();setInterval(()=>{document.getElementById('t').textContent=Math.floor((Date.now()-s)/1000)},500)</script>
      """)
  }

  /// 出了问题：先说发生了什么（事实），再给能点的下一步；日志原样附在下面
  static func problem(title: String, facts: [String], log: String, actions: [PageAction]) -> String {
    let ps = facts.map { "<p>\(esc($0))</p>" }.joined()
    let bs = actions.map {
      "<button class=\"\($0.primary ? "primary" : "")\" onclick=\"act('\($0.id)')\">\(esc($0.label))</button>"
    }.joined()
    let pre = log.isEmpty ? "" : "<details open><summary>看板日志（最后几行）</summary><pre>\(esc(log))</pre></details>"
    return frame(body: """
      <div class="card wide">
        \(mark)
        <h1 class="bad">\(esc(title))</h1>
        \(ps)
        <div class="actions">\(bs)</div>
        \(pre)
      </div>
      <script>function act(id){window.webkit.messageHandlers.heliu.postMessage({type:'action',id})}</script>
      """)
  }

  private static let mark = """
    <svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">\
    <stop offset="0%" stop-color="#19b4e6"/><stop offset="55%" stop-color="#3f62ff"/><stop offset="100%" stop-color="#8b5cf6"/></linearGradient></defs>\
    <rect width="32" height="32" rx="9" fill="url(#g)"/>\
    <path d="M7 9 C 13 9, 14 16, 19 16 L 25 16" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round"/>\
    <path d="M7 23 C 13 23, 14 16, 19 16" stroke="#fff" stroke-opacity="0.75" stroke-width="2.4" fill="none" stroke-linecap="round"/>\
    <circle cx="25" cy="16" r="2.6" fill="#fff"/></svg>
    """

  private static func frame(body: String) -> String {
    """
    <!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合流</title><style>
    :root{color-scheme:light dark;--bg:#f3f4f9;--dot:rgba(22,26,64,.11);--surface:#fff;--surface-2:#f6f7fb;--fg:#15182b;--fg-2:#3b4062;
      --muted:#6a7090;--faint:#9ba1bd;--line:#e3e5ef;--line-strong:#cbd0e2;--accent:#3157ff;--accent-fg:#fff;--red:#dc4046;
      --font:"PingFang SC",-apple-system,system-ui,sans-serif;--display:ui-rounded,"SF Pro Rounded","PingFang SC",-apple-system,sans-serif}
    @media (prefers-color-scheme:dark){:root{--bg:#0e1020;--dot:rgba(255,255,255,.07);--surface:#171a2e;--surface-2:#1d2138;--fg:#eef0fb;
      --fg-2:#c5c9df;--muted:#8e94b5;--faint:#5f6587;--line:#262b47;--line-strong:#353c62;--accent:#8ea0ff;--accent-fg:#0b0f2a;--red:#ff6f76}}
    *{box-sizing:border-box}
    html,body{margin:0;height:100%}
    body{font-family:var(--font);color:var(--fg);background:var(--bg);background-image:radial-gradient(var(--dot) 1px,transparent 1.2px);
      background-size:20px 20px;display:flex;align-items:center;justify-content:center;padding:24px;-webkit-user-select:none;cursor:default}
    .card{width:min(440px,100%);background:var(--surface);border:1px solid var(--line);border-radius:18px;padding:32px 32px 26px;
      box-shadow:0 1px 0 var(--line),0 24px 48px -28px rgba(22,26,64,.35);text-align:center}
    .card.wide{width:min(680px,100%);text-align:left}
    .mark{width:44px;height:44px;border-radius:13px;box-shadow:0 10px 24px -12px rgba(63,98,255,.6)}
    h1{font-family:var(--display);font-size:20px;margin:16px 0 8px;font-weight:700}
    h1.bad{color:var(--red)}
    p{margin:6px 0;font-size:14px;line-height:1.6;color:var(--fg-2)}
    .faint{color:var(--faint);font-size:12.5px;font-variant-numeric:tabular-nums}
    .bar{height:6px;border-radius:99px;background:var(--surface-2);overflow:hidden;margin:18px 0 10px}
    .bar i{display:block;height:100%;width:38%;border-radius:99px;background:linear-gradient(90deg,#19b4e6,#3f62ff,#8b5cf6);animation:slide 1.3s ease-in-out infinite}
    @keyframes slide{0%{transform:translateX(-100%)}100%{transform:translateX(270%)}}
    @media (prefers-reduced-motion:reduce){.bar i{animation:none;width:100%;opacity:.5}}
    .actions{display:flex;flex-wrap:wrap;gap:8px;margin:18px 0 6px}
    button{font:inherit;font-size:13.5px;font-weight:600;height:34px;padding:0 14px;border-radius:10px;border:1px solid var(--line-strong);
      background:var(--surface);color:var(--fg);cursor:pointer}
    button:hover{background:var(--surface-2)}
    button.primary{background:var(--accent);border-color:transparent;color:var(--accent-fg)}
    details{margin-top:14px}
    summary{font-size:12.5px;color:var(--muted);cursor:pointer}
    pre{font:12px/1.55 ui-monospace,"SF Mono",Menlo,monospace;background:var(--surface-2);border:1px solid var(--line);border-radius:10px;
      padding:10px 12px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--fg-2);-webkit-user-select:text}
    </style></head><body>\(body)</body></html>
    """
  }
}
