#!/usr/bin/env bash
# 用本机 Codex（ChatGPT）以普通用户视角做里程碑二次验收。
# 用法：scripts/codex-accept.sh <里程碑 如 M1> <轮次 如 2> [--ref <提交，默认 HEAD>] [--serve <端口>] [提示词文件]
# 行为：
#   1) 为 --ref 建临时 git worktree（冻结快照），node_modules 软链到本仓库 node_modules.nosync；
#   2) 把 ~/Library/Application Support/heliu 复制一份作为 HELIU_HOME（注册表 + 台账副本），
#      并把 project.yaml 里指向真实 heliu 目录的绝对路径改写到副本 → Codex 的任何写操作只落在副本；
#   3) --serve <端口>：在沙箱外用快照 + 副本启动看板（只监听 127.0.0.1），Codex 只连接不监听，
#      并给 codex 打开 sandbox_workspace_write.network_access；结束后关闭服务；
#   4) 结论写回本仓库 docs/04-验收记录/<里程碑>-codex-round<轮次>.json 与 .log。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "${ROOT}"
MS="${1:?里程碑，如 M1}"; ROUND="${2:?轮次，如 1}"; shift 2
REF="HEAD"; PROMPT_FILE=""; SERVE_PORT=""
while [ $# -gt 0 ]; do case "$1" in --ref) REF="$2"; shift 2;; --serve) SERVE_PORT="$2"; shift 2;; *) PROMPT_FILE="$1"; shift;; esac; done
PROMPT_FILE="${PROMPT_FILE:-docs/04-验收记录/prompts/${MS}.md}"
[ -f "${PROMPT_FILE}" ] || { echo "缺少提示词文件：${PROMPT_FILE}" >&2; exit 2; }
OUT="${ROOT}/docs/04-验收记录/${MS}-codex-round${ROUND}.json"; LOG="${ROOT}/docs/04-验收记录/${MS}-codex-round${ROUND}.log"
SCRATCH="${HELIU_ACCEPT_DIR:-${TMPDIR:-/tmp}/heliu-accept}"; mkdir -p "${SCRATCH}"
SHORT="$(git rev-parse --short "${REF}")"
SNAP="${SCRATCH}/${MS}-r${ROUND}-${SHORT}"; HOMECOPY="${SCRATCH}/${MS}-r${ROUND}-${SHORT}-heliu-home"
REAL_HOME="${HOME}/Library/Application Support/heliu"
rm -rf "${SNAP}" "${HOMECOPY}"; git worktree prune; git worktree add --detach -q "${SNAP}" "${REF}"
ln -s "${ROOT}/node_modules.nosync" "${SNAP}/node_modules"
mkdir -p "${HOMECOPY}"; [ -d "${REAL_HOME}" ] && cp -R "${REAL_HOME}/." "${HOMECOPY}/"
# 把 project.yaml 里指向真实 heliu 目录的绝对路径改写到副本（ledger 等）
find "${HOMECOPY}/projects" -name project.yaml -print0 2>/dev/null | xargs -0 -I{} sed -i '' -e "s#${REAL_HOME}#${HOMECOPY}#g" -e "s#~/Library/Application Support/heliu#${HOMECOPY}#g" {} 2>/dev/null || true
export HELIU_HOME="${HOMECOPY}"
export PATH="${HOME}/.bun/bin:${PATH}"
SERVER_PID=""
cleanup(){ [ -n "${SERVER_PID}" ] && kill "${SERVER_PID}" >/dev/null 2>&1 || true; git -C "${ROOT}" worktree remove --force "${SNAP}" >/dev/null 2>&1 || true; }
trap cleanup EXIT
{ echo "快照：${SNAP}（${SHORT}）"; echo "HELIU_HOME 副本：${HOMECOPY}"; } | tee "${LOG}"
CODEX_EXTRA=()
if [ -n "${SERVE_PORT}" ]; then
  ( cd "${SNAP}" && HELIU_HOME="${HOMECOPY}" nohup bun run bin/heliu board --project 磁吸背夹 --port "${SERVE_PORT}" --no-open >"${SCRATCH}/${MS}-r${ROUND}-board.log" 2>&1 & echo $! > "${SCRATCH}/${MS}-r${ROUND}-board.pid" )
  SERVER_PID="$(cat "${SCRATCH}/${MS}-r${ROUND}-board.pid")"
  for i in $(seq 1 20); do lsof -nP -iTCP:"${SERVE_PORT}" -sTCP:LISTEN >/dev/null 2>&1 && break; sleep 1; done
  if lsof -nP -iTCP:"${SERVE_PORT}" -sTCP:LISTEN >/dev/null 2>&1; then echo "看板已在沙箱外启动：http://127.0.0.1:${SERVE_PORT}/" | tee -a "${LOG}"; else echo "看板启动失败，见 ${SCRATCH}/${MS}-r${ROUND}-board.log" | tee -a "${LOG}"; fi
  CODEX_EXTRA+=(-c "sandbox_workspace_write.network_access=true")
fi
PROMPT="$(cat "${PROMPT_FILE}")"
[ -n "${SERVE_PORT}" ] && PROMPT="${PROMPT}

【验收脚本补充】看板已由脚本在沙箱外启动：http://127.0.0.1:${SERVE_PORT}/ （不要自己再启动服务，你的沙箱不能监听端口）。台账与注册表是副本（HELIU_HOME 已指向副本），PATCH / POST 可以放心做，不会影响真实台账；被管理的磁吸背夹仓库仍然不得写入。"
codex exec -s workspace-write --ephemeral -C "${SNAP}" ${CODEX_EXTRA[@]+"${CODEX_EXTRA[@]}"} \
  --output-schema "${ROOT}/docs/04-验收记录/verdict.schema.json" -o "${OUT}" \
  "${PROMPT}" >> "${LOG}" 2>&1 || true
if [ -s "${OUT}" ]; then jq . "${OUT}"; else echo "未得到结构化结论，见 ${LOG}" >&2; tail -20 "${LOG}"; exit 1; fi
