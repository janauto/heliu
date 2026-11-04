// 看板页面在 App 里要的几样东西：只在窗口里打开看板自己的地址、外链交给默认浏览器、
// alert / confirm / prompt 弹窗（复制失败时页面会用 prompt 让人手动复制）、文件选择、剪贴板与标题栏颜色消息。
import AppKit
import WebKit

final class WebHandler: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  weak var app: AppDelegate?
  init(app: AppDelegate) { self.app = app }

  private var window: NSWindow? { app?.window }

  // MARK: 导航

  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    guard let url = action.request.url, let app = app else { return decisionHandler(.cancel) }
    if url.scheme == "about" || app.isBoardURL(url) { return decisionHandler(.allow) }
    // 看板以外的地址（教程、GitHub 等）交给默认浏览器；拖进窗口的文件之类一律不打开
    if ["http", "https", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
    decisionHandler(.cancel)
  }

  /// target="_blank"：看板自己的页就在本窗口打开，其余交给默认浏览器
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url {
      if app?.isBoardURL(url) == true { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
    }
    return nil
  }

  /// 网页进程崩了：重新载入，不留白屏
  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    app?.reloadPage()
  }

  // MARK: 弹窗

  func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
    guard let w = window else { return completionHandler() }
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "好")
    a.beginSheetModal(for: w) { _ in completionHandler() }
  }

  func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
    guard let w = window else { return completionHandler(false) }
    let a = NSAlert()
    a.messageText = message
    a.addButton(withTitle: "好")
    a.addButton(withTitle: "取消")
    a.beginSheetModal(for: w) { r in completionHandler(r == .alertFirstButtonReturn) }
  }

  func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
    guard let w = window else { return completionHandler(nil) }
    let text = defaultText ?? ""
    let a = NSAlert()
    a.messageText = prompt
    a.addButton(withTitle: "好")
    a.addButton(withTitle: "取消")
    // 长文字（Prompt、多行指令）用可滚动的多行框，短的用单行框
    let read: () -> String
    if text.count > 80 || text.contains("\n") {
      let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 440, height: 180))
      scroll.hasVerticalScroller = true
      scroll.borderType = .bezelBorder
      let tv = NSTextView(frame: scroll.bounds)
      tv.autoresizingMask = [.width]
      tv.isRichText = false
      tv.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
      tv.string = text
      tv.selectAll(nil)
      scroll.documentView = tv
      a.accessoryView = scroll
      a.window.initialFirstResponder = tv
      read = { tv.string }
    } else {
      let tf = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 24))
      tf.stringValue = text
      a.accessoryView = tf
      a.window.initialFirstResponder = tf
      read = { tf.stringValue }
    }
    a.beginSheetModal(for: w) { r in completionHandler(r == .alertFirstButtonReturn ? read() : nil) }
  }

  func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
    guard let w = window else { return completionHandler(nil) }
    let p = NSOpenPanel()
    p.allowsMultipleSelection = parameters.allowsMultipleSelection
    p.canChooseDirectories = parameters.allowsDirectories
    p.canChooseFiles = true
    p.beginSheetModal(for: w) { r in completionHandler(r == .OK ? p.urls : nil) }
  }

  // MARK: 页面消息

  func userContentController(_ c: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let app = app, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
    let origin = message.frameInfo.securityOrigin
    let fromBoard = origin.host == "127.0.0.1" && origin.port == app.port
    let fromOwnPage = origin.host.isEmpty  // loadHTMLString 的启动 / 出错页
    guard fromBoard || fromOwnPage else { return }
    switch type {
    case "copy":
      guard let t = body["text"] as? String else { return }
      NSPasteboard.general.clearContents()
      NSPasteboard.general.setString(t, forType: .string)
    case "chrome":
      if let r = body["r"] as? Double, let g = body["g"] as? Double, let b = body["b"] as? Double { app.applyChrome(r: r, g: g, b: b) }
    case "restartBoard":
      // 看板页面「更新后重启」：只认看板自己的页面
      if fromBoard { app.restartBoardAfterUpdate() }
    case "action":
      // 只有 App 自己的启动 / 出错页能触发「重试 / 选目录 / 开日志」
      if fromOwnPage, let id = body["id"] as? String { app.pageAction(id) }
    default:
      break
    }
  }
}
