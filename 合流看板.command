#!/bin/sh
# 双击打开合流看板（macOS Finder 里双击 .command 文件会用「终端」运行它）。
# - 看板已经在运行：直接打开浏览器，不会重复启动。
# - 关掉这个终端窗口（或按 Ctrl+C）就退出看板。
cd "$(dirname "$0")" || exit 1
exec ./bin/heliu board "$@"
