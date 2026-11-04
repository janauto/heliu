// 看板服务：探测端口上是什么、启动 / 停止 <代码目录>/bin/heliu board。
import Foundation

/// 端口上现在是什么
enum PortState {
  /// 已经是合流看板（版本、代码目录取自 /api/projects；旧看板不报版本）
  case heliu(version: String?, root: String?)
  /// 有程序在听，但不是合流看板（或者没在时限内答话）
  case other
  /// 没人在听
  case free
}

enum BoardProbe {
  private static let session: URLSession = {
    let c = URLSessionConfiguration.ephemeral
    c.connectionProxyDictionary = [:]  // 只连本机，不走系统代理
    c.requestCachePolicy = .reloadIgnoringLocalCacheData
    return URLSession(configuration: c)
  }()

  /// 问一次 http://127.0.0.1:<port>/api/projects；回调在主线程
  static func probe(port: Int, timeout: TimeInterval, done: @escaping (PortState) -> Void) {
    var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/api/projects")!)
    req.timeoutInterval = timeout
    session.dataTask(with: req) { data, _, err in
      let state: PortState
      if let err = err as NSError? {
        state = err.code == NSURLErrorCannotConnectToHost ? .free : .other
      } else if let data = data,
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                obj["command"] as? String == "project.list" {
        let d = obj["data"] as? [String: Any]
        state = .heliu(version: d?["version"] as? String, root: d?["heliuRoot"] as? String)
      } else {
        state = .other
      }
      DispatchQueue.main.async { done(state) }
    }.resume()
  }
}

/// App 自己启动的看板进程。bin/heliu 最后一步是 exec bun，所以这里拿到的 pid 就是看板本身。
final class BoardProcess {
  let root: String
  let port: Int
  let logURL: URL
  /// 进程退出（不论原因）时在主线程回调，参数是退出码
  var onExit: ((Int32) -> Void)?
  private var process: Process?

  init(root: String, port: Int, logURL: URL) {
    self.root = root
    self.port = port
    self.logURL = logURL
  }

  var isRunning: Bool { process?.isRunning ?? false }

  func start() throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: root).appendingPathComponent("bin/heliu")
    p.arguments = ["board", "--port", String(port), "--no-open"]
    // 从主目录启动：不按 App 所在目录去猜项目，页面会记住上次选的项目
    p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    var env = ProcessInfo.processInfo.environment
    // 从访达打开的 App 只有系统默认 PATH：补上 bun / git 常见的位置
    let home = NSHomeDirectory()
    let extra = ["\(home)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    env["PATH"] = (extra + [env["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin"]).joined(separator: ":")
    // App 被强退时看板据此发现父进程没了，自己退出（src/board/server.ts watchParent）
    env["HELIU_BOARD_PARENT_PID"] = String(getpid())
    p.environment = env

    let fm = FileManager.default
    try fm.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let stamp = ISO8601DateFormatter().string(from: Date())
    let head = "── \(stamp) 合流 App 启动看板：\(root)/bin/heliu board --port \(port) --no-open ──\n"
    fm.createFile(atPath: logURL.path, contents: head.data(using: .utf8))
    let out = try FileHandle(forWritingTo: logURL)
    out.seekToEndOfFile()
    p.standardOutput = out
    p.standardError = out
    p.standardInput = FileHandle.nullDevice
    p.terminationHandler = { [weak self] proc in
      try? out.close()
      let code = proc.terminationStatus
      DispatchQueue.main.async { self?.onExit?(code) }
    }
    try p.run()
    process = p
  }

  /// 先 TERM（看板会正常停下），等不到再 KILL
  func stop(wait: TimeInterval = 3) {
    guard let p = process, p.isRunning else { return }
    onExit = nil
    p.terminate()
    let deadline = Date().addingTimeInterval(wait)
    while p.isRunning && Date() < deadline { usleep(50_000) }
    if p.isRunning { kill(p.processIdentifier, SIGKILL) }
  }

  /// 日志最后几行（出错页里给人看）
  func logTail(lines: Int = 40) -> String {
    guard let s = try? String(contentsOf: logURL, encoding: .utf8) else { return "" }
    return s.split(separator: "\n", omittingEmptySubsequences: false).suffix(lines).joined(separator: "\n")
  }
}
