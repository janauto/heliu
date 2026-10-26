#!/bin/sh
# 重新生成 README「终端里也能看」一节用的真实输出：docs/assets/cli-status.txt
# 用法（在仓库根目录）：sh docs/assets/cli-status.sh [项目名]，缺省项目名为「磁吸背夹」。
# heliu status 对被管理仓库只读；这里只截取到「现在最该做的」为止，
# 后面的「等你处理」会话原文、分支长表不放进 README（篇幅长，且含会话里的私人内容）。
set -eu
cd "$(dirname "$0")/../.."
PROJECT="${1:-磁吸背夹}"
OUT=docs/assets/cli-status.txt
{
  printf '$ bin/heliu status --project %s\n' "${PROJECT}"
  bin/heliu status --project "${PROJECT}" | awk '/^①/ { exit } { print }'
  printf '…（后面还有「① 等你处理」「② 独立未合并」「③ 已进集成分支待回主线」「④ 落后需同步」四段，此处略）\n'
} > "${OUT}"
echo "已保存 ${OUT}（$(wc -l < "${OUT}" | tr -d ' ') 行）"
