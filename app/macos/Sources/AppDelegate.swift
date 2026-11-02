// 合流 App：一个原生窗口装着本机看板。
// 启动顺序：找代码目录 → 从专用端口起往后找（已经是合流看板就直接用，空着就自己起一个）→ 等 /api/projects 答话 → 载入看板。
// 自己起的看板在退出 App 时一起停掉；别人起的（例如终端里的 heliu board）只是借用，不去动它。
import AppKit
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
  var window: NSWindow!
  var web: WKWebView!
  /// 页面的导航 / 弹窗 / 消息都交给它（WKWebView 的 delegate 是弱引用，这里持有）
  private var handler: WebHandler!
  private var titleObs: NSKeyValueObservation?

  private var board: BoardProcess?
  private(set) var port = 0
  /// 看板页面已经载入（之后出事算「意外退出」，之前出事算「没启动起来」）
  private var ready = false
  private var quitting = false
  private var pollTimer: Timer?
  private var startedAt = Date()
  /// 每次重新开始都换一代，旧一代的异步回调直接丢掉
  private var generation = 0

  let appVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
  private var basePort: Int {
    let v = UserDefaults.standard.integer(forKey: "port")
    if v > 0 { return v }
    return (Bundle.main.object(forInfoDictionaryKey: "HeliuPort") as? NSNumber)?.intValue ?? 7790
  }
  private let portSpan = 10
  private let readyTimeout: TimeInterval = 120
  let logURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/heliu/app-board.log")

  // MARK: 生命周期

  func applicationDidFinishLaunching(_ note: Notification) {
    NSApp.mainMenu = Menus.build(target: self)
    makeWindow()
    start()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  func applicationWillTerminate(_ note: Notification) {
    quitting = true
    pollTimer?.invalidate()
    board?.stop()
  }

  private func makeWindow() {
    let vis = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    let size = NSSize(width: min(1440, vis.width * 0.9), height: min(920, vis.height * 0.9))
    window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "合流"
    window.titlebarAppearsTransparent = true
    window.titlebarSeparatorStyle = .none
    window.tabbingMode = .disallowed
    window.isReleasedWhenClosed = false
    window.minSize = NSSize(width: 760, height: 520)
    window.delegate = self
    window.center()
    window.setFrameAutosaveName("合流主窗口")

    let cfg = WKWebViewConfiguration()
    cfg.websiteDataStore = .default()  // 页面记住的项目、折叠状态等跨次保留
    handler = WebHandler(app: self)
    let ucc = WKUserContentController()
    ucc.addUserScript(WKUserScript(source: Bridge.script(appVersion: appVersion), injectionTime: .atDocumentStart, forMainFrameOnly: true))
    ucc.add(handler, name: "heliu")
    cfg.userContentController = ucc
    web = WKWebView(frame: .zero, configuration: cfg)
    web.navigationDelegate = handler
    web.uiDelegate = handler
    web.allowsBackForwardNavigationGestures = false
    if #available(macOS 13.3, *) { web.isInspectable = true }
    window.contentView = web
    titleObs = web.observe(\.title, options: [.new]) { [weak self] w, _ in
      let t = w.title ?? ""
      self?.window.title = t.isEmpty ? "合流" : t
    }
    window.makeKeyAndOrderFront(nil)
  }

  // MARK: 启动看板

  /// 从头来：找代码目录 → 找端口 → 起看板 / 借用已有看板
  @objc func start() {
    generation += 1
    ready = false
    pollTimer?.invalidate()
    guard let root = CodeRoot.resolve() else {
      showProblem(title: "找不到合流的代码目录",
                  facts: ["App 要用合流代码目录里的 bin/heliu 启动看板。打包时记下的目录不在了，或者里面没有 bin/heliu。",
                          "打包时记下的目录：\(CodeRoot.baked ?? "（没有）")"],
                  actions: [PageAction(id: "chooseRoot", label: "选择代码目录…", primary: true), PageAction(id: "retry", label: "重试")])
      return
    }
    showLoading(title: "正在找看板", detail: "看看 \(basePort) 端口上是不是已经有合流看板。")
    pick(port: basePort, root: root, gen: generation)
  }

  private func pick(port p: Int, root: String, gen: Int) {
    BoardProbe.probe(port: p, timeout: 3) { [weak self] state in
      guard let self = self, gen == self.generation else { return }
      switch state {
      case .heliu:
        self.port = p
        self.load()
      case .free:
        self.launch(root: root, port: p, gen: gen)
      case .other:
        if p + 1 < self.basePort + self.portSpan {
          self.pick(port: p + 1, root: root, gen: gen)
        } else {
          self.showProblem(title: "没有空端口",
                           facts: ["\(self.basePort)–\(self.basePort + self.portSpan - 1) 端口都被别的程序占着，而且都不是合流看板。",
                                   "可以先关掉占用这些端口的程序再重试。"],
                           actions: [PageAction(id: "retry", label: "重试", primary: true)])
        }
      }
    }
  }

  private func launch(root: String, port p: Int, gen: Int) {
    let b = BoardProcess(root: root, port: p, logURL: logURL)
    b.onExit = { [weak self] code in self?.boardExited(code: code, gen: gen) }
    do {
      try b.start()
    } catch {
      showProblem(title: "看板没能启动",
                  facts: ["运行 \(root)/bin/heliu 失败：\(error.localizedDescription)"],
                  actions: [PageAction(id: "retry", label: "重试", primary: true), PageAction(id: "chooseRoot", label: "选择代码目录…")])
      return
    }
    board = b
    port = p
    startedAt = Date()
    showLoading(title: "正在启动看板", detail: "第一次启动要打包前端，可能要十几秒。")
    pollTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in self?.poll(gen: gen) }
  }

  private var polling = false
  private func poll(gen: Int) {
    guard gen == generation, !polling else { return }
    if Date().timeIntervalSince(startedAt) > readyTimeout {
      pollTimer?.invalidate()
      let tail = board?.logTail() ?? ""
      board?.stop()
      board = nil
      showProblem(title: "看板启动超时",
                  facts: ["等了 \(Int(readyTimeout)) 秒，看板还没有答话，已经把它停掉。"],
                  log: tail,
                  actions: [PageAction(id: "retry", label: "重试", primary: true), PageAction(id: "openLog", label: "打开完整日志")])
      return
    }
    polling = true
    // 看板刚起来时在预热扫描，答话可能慢一两秒：超时放宽，免得一直超时、迟迟进不去
    BoardProbe.probe(port: port, timeout: 3) { [weak self] state in
      guard let self = self else { return }
      self.polling = false
      guard gen == self.generation, !self.ready else { return }
      if case .heliu = state {
        self.pollTimer?.invalidate()
        self.load()
      }
    }
  }

  private func boardExited(code: Int32, gen: Int) {
    guard !quitting, gen == generation else { return }
    let tail = board?.logTail() ?? ""
    board = nil
    pollTimer?.invalidate()
    if ready {
      showProblem(title: "看板意外退出了",
                  facts: ["看板进程已经退出（退出码 \(code)）。台账写到一半的操作以台账文件为准。"],
                  log: tail,
                  actions: [PageAction(id: "retry", label: "重新启动看板", primary: true), PageAction(id: "openLog", label: "打开完整日志")])
      return
    }
    // 还没起来就退了：可能是同一时刻别处也起了看板、它让给了对方——再问一次端口
    BoardProbe.probe(port: port, timeout: 2) { [weak self] state in
      guard let self = self, gen == self.generation else { return }
      if case .heliu = state {
        self.load()
        return
      }
      self.showProblem(title: "看板没能启动",
                       facts: ["看板进程启动后就退出了（退出码 \(code)）。下面是它最后打印的内容。"],
                       log: tail,
                       actions: [PageAction(id: "retry", label: "重试", primary: true),
                                 PageAction(id: "openLog", label: "打开完整日志"),
                                 PageAction(id: "chooseRoot", label: "换个代码目录…")])
    }
  }

  private func load() {
    ready = true
    web.load(URLRequest(url: boardURL))
  }

  var boardURL: URL { URL(string: "http://127.0.0.1:\(port)/")! }

  func isBoardURL(_ u: URL) -> Bool { ready && u.host == "127.0.0.1" && u.port == port }

  /// 这一代看板是不是 App 自己起的
  var ownsBoard: Bool { board?.isRunning ?? false }

  private func showLoading(title: String, detail: String) {
    web.loadHTMLString(Pages.loading(title: title, detail: detail), baseURL: nil)
  }

  private func showProblem(title: String, facts: [String], log: String = "", actions: [PageAction]) {
    ready = false
    web.loadHTMLString(Pages.problem(title: title, facts: facts, log: log, actions: actions), baseURL: nil)
  }

  // MARK: 页面发来的动作 / 菜单

  func pageAction(_ id: String) {
    switch id {
    case "retry": restartBoard()
    case "chooseRoot": chooseRoot()
    case "openLog": openLog()
    default: break
    }
  }

  @objc func reloadPage() {
    if ready { web.reload() } else { start() }
  }

  @objc func restartBoard() {
    board?.stop()
    board = nil
    start()
  }

  @objc func openInBrowser() {
    guard ready else { return }
    NSWorkspace.shared.open(web.url ?? boardURL)
  }

  @objc func openLog() {
    if FileManager.default.fileExists(atPath: logURL.path) {
      NSWorkspace.shared.open(logURL)
    } else {
      alert("还没有日志", "App 还没有自己启动过看板（日志位置：\(logURL.path)）。")
    }
  }

  @objc func openTutorial() {
    NSWorkspace.shared.open(URL(string: "https://github.com/janauto/heliu/blob/main/docs/教程.md")!)
  }

  @objc func revealRoot() {
    guard let r = CodeRoot.resolve() else { return chooseRoot() }
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: r)])
  }

  @objc func chooseRoot() {
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.allowsMultipleSelection = false
    panel.message = "选择合流的代码目录（里面有 bin/heliu）"
    panel.prompt = "用这个目录"
    if let r = CodeRoot.resolve() ?? CodeRoot.baked { panel.directoryURL = URL(fileURLWithPath: r) }
    panel.beginSheetModal(for: window) { [weak self] resp in
      guard resp == .OK, let url = panel.url else { return }
      guard CodeRoot.isValid(url.path) else {
        self?.alert("这不是合流的代码目录", "\(url.path) 里没有 bin/heliu 和 src/cli/main.ts。")
        return
      }
      UserDefaults.standard.set(url.path, forKey: CodeRoot.defaultsKey)
      self?.restartBoard()
    }
  }

  @objc func showAbout() {
    let root = CodeRoot.resolve() ?? "（没找到）"
    let who = ready ? (ownsBoard ? "App 自己启动的" : "借用已在运行的") : "还没连上"
    let credits = NSAttributedString(
      string: "代码目录：\(root)\n看板：http://127.0.0.1:\(port)/（\(who)）\n日志：\(logURL.path)",
      attributes: [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: NSColor.secondaryLabelColor])
    NSApp.orderFrontStandardAboutPanel(options: [.credits: credits])
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func focusSearch() {
    web.evaluateJavaScript("(()=>{const i=document.querySelector('.search input');if(i&&!i.disabled){i.focus();i.select();}})()")
  }

  @objc func zoomIn() { web.pageZoom = min(web.pageZoom + 0.1, 2.0) }
  @objc func zoomOut() { web.pageZoom = max(web.pageZoom - 0.1, 0.6) }
  @objc func zoomReset() { web.pageZoom = 1.0 }

  func alert(_ title: String, _ text: String) {
    let a = NSAlert()
    a.messageText = title
    a.informativeText = text
    a.addButton(withTitle: "好")
    a.beginSheetModal(for: window)
  }

  /// 标题栏跟着看板标题栏的底色走；深浅决定原生控件（红绿灯、弹窗）的外观
  func applyChrome(r: Double, g: Double, b: Double) {
    let c = NSColor(srgbRed: r / 255, green: g / 255, blue: b / 255, alpha: 1)
    window.backgroundColor = c
    let lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    window.appearance = NSAppearance(named: lum < 128 ? .darkAqua : .aqua)
  }
}

/// 代码目录：用户在 App 里选过的 > 打包时记下的（scripts/build-app.sh 写进 Info.plist）
enum CodeRoot {
  static let defaultsKey = "codeRoot"
  static var baked: String? { Bundle.main.object(forInfoDictionaryKey: "HeliuCodeRoot") as? String }

  static func isValid(_ p: String) -> Bool {
    let fm = FileManager.default
    return fm.isExecutableFile(atPath: p + "/bin/heliu") && fm.fileExists(atPath: p + "/src/cli/main.ts")
  }

  static func resolve() -> String? {
    [UserDefaults.standard.string(forKey: defaultsKey), baked].compactMap { $0 }.first(where: isValid)
  }
}
