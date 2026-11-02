// 菜单栏：合流 / 编辑 / 显示 / 窗口 / 帮助。编辑菜单必须有——没有它 ⌘C / ⌘V 在网页输入框里不起作用。
import AppKit

enum Menus {
  static func build(target t: AppDelegate) -> NSMenu {
    let bar = NSMenu()

    let app = submenu(bar, "合流")
    app.addItem(item("关于合流", #selector(AppDelegate.showAbout), t))
    app.addItem(.separator())
    app.addItem(item("选择代码目录…", #selector(AppDelegate.chooseRoot), t))
    app.addItem(item("在访达中显示代码目录", #selector(AppDelegate.revealRoot), t))
    app.addItem(.separator())
    app.addItem(item("隐藏合流", #selector(NSApplication.hide(_:)), nil, "h"))
    app.addItem(item("隐藏其他", #selector(NSApplication.hideOtherApplications(_:)), nil, "h", [.command, .option]))
    app.addItem(item("全部显示", #selector(NSApplication.unhideAllApplications(_:)), nil))
    app.addItem(.separator())
    app.addItem(item("退出合流", #selector(NSApplication.terminate(_:)), nil, "q"))

    let edit = submenu(bar, "编辑")
    edit.addItem(item("撤销", Selector(("undo:")), nil, "z"))
    edit.addItem(item("重做", Selector(("redo:")), nil, "z", [.command, .shift]))
    edit.addItem(.separator())
    edit.addItem(item("剪切", #selector(NSText.cut(_:)), nil, "x"))
    edit.addItem(item("拷贝", #selector(NSText.copy(_:)), nil, "c"))
    edit.addItem(item("粘贴", #selector(NSText.paste(_:)), nil, "v"))
    edit.addItem(item("全选", #selector(NSText.selectAll(_:)), nil, "a"))
    edit.addItem(.separator())
    edit.addItem(item("搜方块", #selector(AppDelegate.focusSearch), t, "f"))

    let view = submenu(bar, "显示")
    view.addItem(item("重新载入", #selector(AppDelegate.reloadPage), t, "r"))
    view.addItem(item("重启看板服务", #selector(AppDelegate.restartBoard), t, "r", [.command, .option]))
    view.addItem(.separator())
    view.addItem(item("实际大小", #selector(AppDelegate.zoomReset), t, "0"))
    view.addItem(item("放大", #selector(AppDelegate.zoomIn), t, "="))
    view.addItem(item("缩小", #selector(AppDelegate.zoomOut), t, "-"))
    view.addItem(.separator())
    view.addItem(item("进入全屏幕", #selector(NSWindow.toggleFullScreen(_:)), nil, "f", [.command, .control]))

    let win = submenu(bar, "窗口")
    win.addItem(item("最小化", #selector(NSWindow.performMiniaturize(_:)), nil, "m"))
    win.addItem(item("缩放", #selector(NSWindow.performZoom(_:)), nil))
    win.addItem(.separator())
    win.addItem(item("关闭", #selector(NSWindow.performClose(_:)), nil, "w"))
    NSApp.windowsMenu = win

    let help = submenu(bar, "帮助")
    help.addItem(item("合流使用教程", #selector(AppDelegate.openTutorial), t))
    help.addItem(item("在浏览器中打开看板", #selector(AppDelegate.openInBrowser), t, "o", [.command, .shift]))
    help.addItem(item("打开看板日志", #selector(AppDelegate.openLog), t))
    NSApp.helpMenu = help

    return bar
  }

  private static func submenu(_ bar: NSMenu, _ title: String) -> NSMenu {
    let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    let m = NSMenu(title: title)
    holder.submenu = m
    bar.addItem(holder)
    return m
  }

  private static func item(_ title: String, _ action: Selector, _ target: AnyObject?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
    let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
    i.keyEquivalentModifierMask = key.isEmpty ? [] : mods
    i.target = target
    return i
  }
}
