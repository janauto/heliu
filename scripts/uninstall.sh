#!/usr/bin/env bash
# 合流（heliu）卸载脚本：与 install.sh 反向——卸插件 → 删本地 marketplace → 删 user 级 MCP。
#   scripts/uninstall.sh            卸载
#   scripts/uninstall.sh --dry-run  只打印命令，什么都不改
# 不删台账、注册表、缓存（~/Library/Application Support/heliu、~/.cache/heliu），也不删 node_modules。
set -euo pipefail

DRY=0
for a in "$@"; do
  case "${a}" in
    --dry-run | -n) DRY=1 ;;
    -h | --help) sed -n '2,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：${a}（--help 看用法）" >&2; exit 2 ;;
  esac
done

MARKETPLACE="heliu-local"
PLUGIN="heliu"

# 打印用的引号：含空格/特殊字符时用双引号包起来（中文原样显示，可直接复制到终端）
q() {
  case "$1" in
    *[[:space:]\"\'\$\`\\\(\)\;\&\|\<\>\*\?\!]* | "") printf '"%s"' "$(printf '%s' "$1" | sed 's/[\\"$`]/\\&/g')" ;;
    *) printf '%s' "$1" ;;
  esac
}
run() {
  printf '  $'
  for x in "$@"; do printf ' %s' "$(q "${x}")"; done
  printf '\n'
  if [ "${DRY}" = 0 ]; then
    if ! "$@"; then echo "  ！上面这条没成功（可能本来就没装）；继续下一步" >&2; fi
  fi
}

[ "${DRY}" = 1 ] && echo "合流卸载 · 演练模式（--dry-run）：只打印命令，不执行" || echo "合流卸载"

CLAUDE=""
DESKTOP="$(ls -d "${HOME}/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "${DESKTOP}" ] && [ -x "${DESKTOP}" ]; then
  CLAUDE="${DESKTOP}"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE="$(command -v claude)"
else
  echo "没找到 claude CLI，无从卸载（下面的命令用 claude 占位）"
  if [ "${DRY}" = 0 ]; then exit 1; fi
  CLAUDE="claude"
fi
echo "claude CLI：${CLAUDE}"

printf '\n【1/3】卸载插件\n'
run "${CLAUDE}" plugin uninstall "${PLUGIN}@${MARKETPLACE}"
printf '\n【2/3】删除本地 marketplace\n'
run "${CLAUDE}" plugin marketplace remove "${MARKETPLACE}"
printf '\n【3/3】删除 user 级 MCP\n'
run "${CLAUDE}" mcp remove -s user heliu

printf '\n完成%s。台账、注册表与缓存都保留：\n' "$([ "${DRY}" = 1 ] && echo "（演练，未执行）" || true)"
echo "  ~/Library/Application Support/heliu/（注册表、台账、索引缓存）"
echo "  ~/.cache/heliu/（合并演练与临时 worktree）"
echo "要彻底删除请确认后手动处理；仓库里的 .heliu/ 台账（如有）也不会动。"
