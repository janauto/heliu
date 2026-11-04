# 合流 App（macOS）

一个原生窗口装着本机看板：双击就开，不开终端、不开浏览器。

## 安装

```bash
scripts/build-app.sh --install
```

- 要有 Xcode 命令行工具（`swiftc`、`iconutil`、`codesign`）。
- 产物先放在 `~/Library/Application Support/heliu/app-build/合流.app`，`--install` 再复制到 `~/Applications/合流.app`，不碰 `/Applications`。
- 只给本机自用：ad-hoc 签名，不公证。
- 不放进仓库目录有两个原因：iCloud 会给里面的文件加扩展属性，codesign 会拒绝签名；`.app` 也不该跟着 iCloud 同步。
- 改了 `app/macos/` 里的代码才需要重新打包。只改看板代码（`src/`、`web/`）时，`git pull` 之后重开 App 就是新版。

## 更新

看板标题栏右侧会提示「有新版本」，表示 GitHub 主线比代码目录新。看板启动时检查一次，之后每 30 分钟再查一次，检查只用 `git ls-remote`，不下载。

1. 点开「有新版本」，能看到落后几个提交。代码目录不在 main 上、有没提交的改动、或本机 main 有 GitHub 上没有的提交时，「更新」按钮是灰的，下面写着原因。
2. 点「更新」并确认后，才从 GitHub 下载 main 并快进代码目录。依赖清单（`package.json` / `bun.lock`）变了会顺带运行 `bun install`。不碰被管理的仓库，不 push。
3. 提示变成「重启后生效」后，点「重启看板」，App 会重启自己起的看板。如果看板是终端里的 `heliu board`，要先在那个终端按 Ctrl+C 停掉，再按 ⌥⌘R。
4. 更新里如果有 `app/macos/` 的改动，会提示退出 App 后运行 `scripts/build-app.sh --install` 重新打包。App 不替你打包。

终端里同样可用：`heliu update` 只检查（交互终端会问要不要更新），`heliu update --yes` 直接更新。每次更新都在 `~/Library/Application Support/heliu/self-update.log` 里记一行。

这个版本的外壳才有「重启看板」按钮。外壳还是旧版时，页面会改成提示用菜单「显示 → 重启看板服务」（⌥⌘R）。

## 它做了什么

1. **找代码目录。** 先看「合流 → 选择代码目录…」里选过的目录，再看打包时写进 Info.plist 的 `HeliuCodeRoot`。打包默认写主仓库，在 worktree 里打包也写主仓库，因为 worktree 会被清理。
2. **找端口。** 从 7790 起往后找，最多到 7799。不用 7788，免得和终端里的 `heliu board` 抢端口。
   - 端口上已经是合流看板：直接借用，退出 App 时不去动它。
   - 端口空着：自己运行 `<代码目录>/bin/heliu board --port <端口> --no-open`。
   - 端口被别的程序占着：换下一个。
3. **等看板答话。** 窗口里先显示「正在启动」。`/api/projects` 答话后载入看板，等满 120 秒仍没答话就停掉看板，显示出错页。
4. **出错页。** 先写发生了什么，再给能点的下一步：重试、打开日志、选择代码目录。下面附上看板日志的最后几行。
5. **退出。** ⌘Q 或关窗口时，先向自己起的看板发 TERM，3 秒内没停再发 KILL。
   - 如果 App 被强退，看板通过环境变量 `HELIU_BOARD_PARENT_PID` 发现父进程没了，几秒内自己退出（`src/board/server.ts` 的 `watchParent`）。
   - 这一条要等代码目录里的看板代码含有 `watchParent` 才生效。

## 网页和窗口之间

| 页面里 | App 里怎么处理 |
|---|---|
| 复制按钮（`navigator.clipboard`） | 注入脚本改成交给原生写系统剪贴板，不受 WKWebView「用户手势」限制 |
| `target="_blank"` 和外链（教程、GitHub） | 交给默认浏览器；窗口里只打开看板自己的地址 |
| `alert` / `confirm` / `prompt` | 原生弹窗。长文字用可滚动的多行框，复制失败的兜底会用到 |
| 浅色 / 深色 | 注入脚本读看板标题栏的底色，原生标题栏跟着变，看起来是一整条 |
| 记住的项目、折叠状态（localStorage） | 存在 App 自己的网页数据里，跨次保留；和浏览器里的看板互不相通 |

菜单栏有五个菜单：合流、编辑（⌘C / ⌘V / ⌘F 搜方块）、显示（⌘R 重新载入、⌥⌘R 重启看板服务、缩放、全屏）、窗口、帮助（教程、在浏览器中打开看板、打开看板日志）。

看板日志：`~/Library/Logs/heliu/app-board.log`，每次启动重写。

## 文件

- `Sources/AppDelegate.swift`：窗口、启动流程、菜单动作
- `Sources/Board.swift`：探测端口、启停看板进程
- `Sources/WebHandler.swift`：导航策略、弹窗、页面消息
- `Sources/Bridge.swift`：注入页面的脚本（剪贴板、标题栏颜色）
- `Sources/Pages.swift`：启动页和出错页
- `Sources/Menus.swift`：菜单栏
- `Info.plist`：模板，打包时填入版本号、代码目录、端口
- `make-icon.swift`：画图标
