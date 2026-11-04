#!/bin/sh
# 打包合流 macOS App（app/macos）：原生窗口装着本机看板，双击就开，不开终端、不开浏览器。
# 用法：scripts/build-app.sh [--root <合流代码目录>] [--install]
#   --root     App 用哪份代码启动看板。默认是主仓库：在 worktree 里运行也指向主仓库（worktree 会被清理，App 要比分支活得久）。
#              App 里「合流 → 选择代码目录…」随时可以改。
#   --install  装到 ~/Applications/合流.app（已有的合流 App 会被替换；不碰 /Applications）。
# 产物：~/Library/Application Support/heliu/app-build/合流.app（可用环境变量 HELIU_APP_OUT 改）。
#   不放进仓库目录：iCloud 会给里面的文件加扩展属性，codesign 拒绝签名；.app 也不该跟着 iCloud 同步。
# 只做本机自用：ad-hoc 签名，不公证。
set -eu

HERE=$(cd "$(dirname "$0")/.." && pwd)
ROOT=
INSTALL=0
while [ $# -gt 0 ]; do
  case $1 in
    --root) ROOT=${2:?--root 后面要跟目录}; shift 2 ;;
    --install) INSTALL=1; shift ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不认识的参数：$1（scripts/build-app.sh --help 看用法）" >&2; exit 2 ;;
  esac
done

if [ -z "$ROOT" ]; then
  COMMON=$(git -C "$HERE" rev-parse --path-format=absolute --git-common-dir)
  ROOT=$(dirname "$COMMON")
fi
ROOT=$(cd "$ROOT" && pwd)
if [ ! -x "$ROOT/bin/heliu" ] || [ ! -f "$ROOT/src/cli/main.ts" ]; then
  echo "$ROOT 不是合流代码目录（没有 bin/heliu 或 src/cli/main.ts）" >&2
  exit 1
fi
for t in swiftc iconutil sips codesign plutil; do
  command -v "$t" >/dev/null 2>&1 || { echo "缺少 ${t}：先安装 Xcode 命令行工具（xcode-select --install）" >&2; exit 1; }
done

VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)
BUILD=$(git -C "$HERE" rev-list --count HEAD 2>/dev/null || echo 0)
ARCH=$(uname -m)
SRC="$HERE/app/macos"
OUT=${HELIU_APP_OUT:-"$HOME/Library/Application Support/heliu/app-build"}
APP="$OUT/合流.app"
WORK="$OUT/.work"
rm -rf "$WORK" "$APP"
mkdir -p "$WORK" "$APP/Contents/MacOS" "$APP/Contents/Resources"

echo "· 画图标…"
swiftc -O -o "$WORK/make-icon" "$SRC/make-icon.swift"
"$WORK/make-icon" "$WORK/icon-1024.png" >/dev/null
SET="$WORK/AppIcon.iconset"
mkdir -p "$SET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$WORK/icon-1024.png" --out "$SET/icon_${s}x${s}.png" >/dev/null
  d=$((s * 2))
  sips -z $d $d "$WORK/icon-1024.png" --out "$SET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$SET" -o "$APP/Contents/Resources/AppIcon.icns"

echo "· 编译原生外壳（${ARCH}）…"
swiftc -swift-version 5 -O -target "$ARCH-apple-macos13" -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/Heliu" "$SRC"/Sources/*.swift

PLIST="$APP/Contents/Info.plist"
cp "$SRC/Info.plist" "$PLIST"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$PLIST"
plutil -replace CFBundleVersion -string "$BUILD" "$PLIST"
plutil -replace HeliuCodeRoot -string "$ROOT" "$PLIST"
printf 'APPL????' > "$APP/Contents/PkgInfo"
if ! SIGN=$(codesign --force --sign - "$APP" 2>&1); then echo "$SIGN" >&2; exit 1; fi
rm -rf "$WORK"

echo "合流.app ${VERSION}（构建 ${BUILD}）已打包：$APP"
echo "  启动看板用的代码目录：$ROOT"
echo "  看板端口：$(plutil -extract HeliuPort raw "$PLIST") 起（被别的程序占着就往后找；已经是合流看板就直接用）"

if [ "$INSTALL" = 1 ]; then
  DEST="$HOME/Applications/合流.app"
  if pgrep -f "$DEST/Contents/MacOS/Heliu" >/dev/null 2>&1; then
    echo "合流 App 正在运行：先退出它（⌘Q），再重新运行这条命令安装。" >&2
    exit 1
  fi
  if [ -e "$DEST" ]; then
    OLD=$(plutil -extract CFBundleIdentifier raw "$DEST/Contents/Info.plist" 2>/dev/null || echo "")
    if [ "$OLD" != "io.github.janauto.heliu" ]; then
      echo "$DEST 已存在，但不是合流 App（标识：${OLD:-读不到}），不覆盖。" >&2
      exit 1
    fi
    rm -rf "$DEST"
  fi
  mkdir -p "$HOME/Applications"
  ditto "$APP" "$DEST"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" >/dev/null 2>&1 || true
  echo "已安装：${DEST}（在启动台 / 聚焦搜索里搜「合流」即可打开）"
else
  echo "  安装到 ~/Applications：scripts/build-app.sh --install"
fi
