#!/usr/bin/env bash
# 合流（heliu）安装脚本：bun → 依赖 → user 级 MCP → 本地 marketplace + 插件。
#   scripts/install.sh            安装
#   scripts/install.sh --dry-run  只打印每一步要执行的命令，什么都不改
#   --with-mcp   额外注册 user 级 MCP（默认只装插件；插件已自带同名 MCP，装两份会在会话里出现重复工具）
#   --no-mcp     （默认行为，保留以兼容）
#   --no-plugin  不装插件（只注册 MCP）
# 只改 Claude Code 的用户配置（~/.claude.json、插件设置）与本仓库的 node_modules；不碰任何被管理的仓库。
# 兼容 macOS 自带 bash 3.2。
set -euo pipefail

DRY=0
SKIP_MCP=1
SKIP_PLUGIN=0
usage() { sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; }
for a in "$@"; do
  case "${a}" in
    --dry-run | -n) DRY=1 ;;
    --no-mcp) SKIP_MCP=1 ;;
    --with-mcp) SKIP_MCP=0 ;;
    --no-plugin) SKIP_PLUGIN=1 ;;
    -h | --help) usage; exit 0 ;;
    *) echo "未知参数：${a}（--help 看用法）" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MARKETPLACE="heliu-local" # 与 .claude-plugin/marketplace.json 的 name 一致
PLUGIN="heliu"

# 打印命令；非 dry-run 时执行。失败只警告不中断（例如已经注册过）。
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
    if ! "$@"; then echo "  ！上面这条没成功（可能已经装过）；继续下一步" >&2; fi
  fi
}
step() { printf '\n【%s】%s\n' "$1" "$2"; }

[ "${DRY}" = 1 ] && echo "合流安装 · 演练模式（--dry-run）：只打印命令，不执行" || echo "合流安装：${ROOT}"

step "1/5" "检查 bun"
BUN=""
for c in "$(command -v bun 2>/dev/null || true)" "${HOME}/.bun/bin/bun" /opt/homebrew/bin/bun /usr/local/bin/bun "${BUN_BIN:-}"; do
  if [ -n "${c}" ] && [ -x "${c}" ]; then BUN="${c}"; break; fi
done
if [ -z "${BUN}" ]; then
  echo "  没找到 bun。先安装：curl -fsSL https://bun.sh/install | bash   （或 brew install oven-sh/bun/bun），再重跑本脚本。"
  if [ "${DRY}" = 0 ]; then exit 1; fi
  BUN="bun"
else
  echo "  bun：${BUN}（$("${BUN}" --version 2>/dev/null || echo 版本未知)）"
fi

step "2/5" "安装依赖（node_modules → node_modules.nosync 软链，iCloud 不同步）"
if [ -L "${ROOT}/node_modules" ]; then
  echo "  node_modules 已是软链 → $(readlink "${ROOT}/node_modules")"
elif [ -e "${ROOT}/node_modules" ]; then
  echo "  node_modules 是普通目录（仓库不在 iCloud 时没关系；在 iCloud 里建议改成软链）"
else
  run mkdir -p "${ROOT}/node_modules.nosync"
  run ln -s node_modules.nosync "${ROOT}/node_modules"
fi
run "${BUN}" install --cwd "${ROOT}"

step "3/5" "找 Claude Code CLI（优先桌面应用内置的最高版本，其次 PATH 里的 claude）"
CLAUDE=""
DESKTOP="$(ls -d "${HOME}/Library/Application Support/Claude/claude-code/"*/*/claude.app/Contents/MacOS/claude 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "${DESKTOP}" ] && [ -x "${DESKTOP}" ]; then
  CLAUDE="${DESKTOP}"
  echo "  桌面内置：${CLAUDE}"
elif command -v claude >/dev/null 2>&1; then
  CLAUDE="$(command -v claude)"
  echo "  PATH：${CLAUDE}"
else
  echo "  没找到 claude CLI：装好 Claude 桌面应用或 Claude Code 后重跑；下面的命令先用 claude 占位"
  if [ "${DRY}" = 0 ]; then SKIP_MCP=1; SKIP_PLUGIN=1; fi
  CLAUDE="claude"
fi

step "4/5" "注册 user 级 MCP（任何会话都能用 heliu_* 工具）"
if [ "${SKIP_MCP}" = 1 ]; then
  echo "  跳过（默认只装插件；需要 user 级 MCP 请加 --with-mcp）"
else
  run "${CLAUDE}" mcp add -s user heliu -- "${ROOT}/bin/heliu" mcp
fi

step "5/5" "本地 marketplace + 插件（/heliu Skill、hooks、插件自带 MCP）"
if [ "${SKIP_PLUGIN}" = 1 ]; then
  echo "  跳过（--no-plugin 或没有 claude CLI）"
else
  # 本仓库根就是 marketplace 根（.claude-plugin/marketplace.json，插件 source "./"），原地加载，改代码不用重装
  EXISTING="$("${CLAUDE}" plugin marketplace list 2>/dev/null | grep -A1 "heliu-local" | grep -i "source" | sed "s/^ *//")"
  if [ -n "${EXISTING}" ]; then
    case "${EXISTING}" in
      *"${ROOT}"*) echo "  已有 marketplace heliu-local 且指向当前目录，重复安装无害" ;;
      *) echo "  ！这台机器已有 marketplace heliu-local（${EXISTING}）。本次会把它改指到当前目录 ${ROOT}，原目录那份安装随之失效。" >&2 ;;
    esac
  fi
  run "${CLAUDE}" plugin marketplace add "${ROOT}"
  run "${CLAUDE}" plugin install "${PLUGIN}@${MARKETPLACE}"
fi

printf '\n完成%s。验证：\n' "$([ "${DRY}" = 1 ] && echo "（演练，未执行）" || true)"
printf '  %s mcp list       # 应看到 heliu ✔ Connected\n' "$(q "${CLAUDE}")"
printf '  %s plugin list    # 应看到 %s\n' "$(q "${CLAUDE}")" "${PLUGIN}@${MARKETPLACE}"
printf '  %s doctor         # 环境自检\n' "$(q "${ROOT}/bin/heliu")"
printf '打开看板：\n  %s board --project <项目名>\n' "$(q "${ROOT}/bin/heliu")"
printf '接入新项目：\n  %s project add <仓库路径>\n' "$(q "${ROOT}/bin/heliu")"
if [ "${SKIP_MCP}" = 0 ] && [ "${SKIP_PLUGIN}" = 0 ]; then
  echo "说明：heliu 工具由插件自带的 MCP（plugin:heliu:heliu）提供；若另加了 --with-mcp，会话里会出现两份同名工具。"
fi
