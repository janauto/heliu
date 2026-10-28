#!/usr/bin/env bash
# 合流（heliu）卸载脚本：与 install.sh 反向——卸插件 → 删本地 marketplace → 删 user 级 MCP → 删终端软链 → 删全局 CLAUDE.md 入口。
#   scripts/uninstall.sh            卸载
#   scripts/uninstall.sh --dry-run  只打印命令，什么都不改
#   --claude-md=<路径>   全局入口在这个文件里（默认 ~/CLAUDE.md，没有它时用 ~/.claude/CLAUDE.md）
# 不删台账、注册表、缓存（~/Library/Application Support/heliu、~/.cache/heliu），也不删 node_modules。
set -euo pipefail

DRY=0
CLAUDE_MD=""
for a in "$@"; do
  case "${a}" in
    --dry-run | -n) DRY=1 ;;
    --claude-md=*) CLAUDE_MD="${a#--claude-md=}" ;;
    -h | --help) sed -n '2,6p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：${a}（--help 看用法）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
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

printf '\n【1/5】卸载插件\n'
run "${CLAUDE}" plugin uninstall "${PLUGIN}@${MARKETPLACE}"
printf '\n【2/5】删除本地 marketplace\n'
run "${CLAUDE}" plugin marketplace remove "${MARKETPLACE}"
printf '\n【3/5】删除 user 级 MCP\n'
if "${CLAUDE}" mcp get heliu 2>/dev/null | grep -qi "scope: *user"; then
  run "${CLAUDE}" mcp remove -s user heliu
else
  echo "  没有 user 级 MCP heliu（默认安装只装插件），跳过"
fi
printf '\n【4/5】删除终端软链（只删指向本目录的）\n'
FOUND=0
for d in "${HOME}/.bun/bin" "${HOME}/.local/bin"; do
  if [ -L "${d}/heliu" ] && [ "$(readlink "${d}/heliu")" = "${ROOT}/bin/heliu" ]; then
    FOUND=1
    run rm "${d}/heliu"
  fi
done
[ "${FOUND}" = 1 ] || echo "  没有指向本目录的 heliu 软链，跳过"
printf '\n【5/5】删除全局 CLAUDE.md 里的合流入口（只删带 heliu 标记的那一段，改前备份）\n'
if [ "${DRY}" = 1 ]; then
  if [ -n "${CLAUDE_MD}" ]; then "${ROOT}/bin/heliu" 全局入口 --remove --dry-run --file "${CLAUDE_MD}" 2>&1 | sed 's/^/  /' || true
  else "${ROOT}/bin/heliu" 全局入口 --remove --dry-run 2>&1 | sed 's/^/  /' || true; fi
elif [ -n "${CLAUDE_MD}" ]; then
  run "${ROOT}/bin/heliu" 全局入口 --remove --file "${CLAUDE_MD}"
else
  run "${ROOT}/bin/heliu" 全局入口 --remove
fi

printf '\n完成%s。台账、注册表与缓存都保留：\n' "$([ "${DRY}" = 1 ] && echo "（演练，未执行）" || true)"
echo "  ~/Library/Application Support/heliu/（注册表、台账、索引缓存）"
echo "  ~/.cache/heliu/（合并演练与临时 worktree）"
echo "要彻底删除请确认后手动处理；仓库里的 .heliu/ 台账（如有）也不会动。"
