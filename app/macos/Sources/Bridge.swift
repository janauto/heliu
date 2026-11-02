// 注入每个页面的脚本：页面和原生窗口之间的几根线。
// - 剪贴板：WKWebView 里 navigator.clipboard 要「用户手势」且时有时无，统一改成交给原生写系统剪贴板
// - 标题栏颜色：读看板标题栏的底色，让原生标题栏跟着浅 / 深色走，看起来是一整条
// - window.__HELIU_APP__：页面据此知道自己在 App 里（目前只用于排查）
import Foundation

enum Bridge {
  static func script(appVersion: String) -> String {
    """
    (() => {
      const post = (m) => { try { window.webkit.messageHandlers.heliu.postMessage(m); } catch (e) {} };
      window.__HELIU_APP__ = { version: \(jsString(appVersion)) };

      const writeText = (t) => { post({ type: "copy", text: String(t) }); return Promise.resolve(); };
      const write = async (items) => {
        for (const it of items || []) {
          if (it && it.types && it.types.includes("text/plain")) {
            const blob = await it.getType("text/plain");
            post({ type: "copy", text: await blob.text() });
            return;
          }
        }
        throw new DOMException("只支持复制文字", "NotAllowedError");
      };
      if (navigator.clipboard) {
        navigator.clipboard.writeText = writeText;
        navigator.clipboard.write = write;
      } else {
        Object.defineProperty(navigator, "clipboard", { value: { writeText, write }, configurable: true });
      }

      let last = "";
      const chrome = () => {
        const el = document.querySelector(".titlebar") || document.body;
        if (!el) return;
        const c = getComputedStyle(el).backgroundColor;
        const m = c.match(/rgba?\\(([\\d.]+),\\s*([\\d.]+),\\s*([\\d.]+)/);
        if (!m || c === last) return;
        last = c;
        post({ type: "chrome", r: +m[1], g: +m[2], b: +m[3] });
      };
      addEventListener("DOMContentLoaded", chrome);
      addEventListener("load", chrome);
      setInterval(chrome, 800);
    })();
    """
  }

  private static func jsString(_ s: String) -> String {
    let data = try? JSONSerialization.data(withJSONObject: [s])
    let arr = data.flatMap { String(data: $0, encoding: .utf8) } ?? "[\"\"]"
    return String(arr.dropFirst().dropLast())
  }
}
