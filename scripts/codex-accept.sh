#!/usr/bin/env bash
# 用本机 Codex（ChatGPT）以普通用户视角做里程碑二次验收。
# 用法：scripts/codex-accept.sh <里程碑 如 M1> <轮次 如 2> [--ref <提交或分支，默认 HEAD>] [提示词文件]
# 行为：在 scratch 目录为 --ref 建一个临时 git worktree（冻结快照，node_modules 软链到本仓库的 node_modules.nosync），
#       Codex 在快照里只读运行；结论写回本仓库 docs/04-验收记录/<里程碑>-codex-round<轮次>.json 与 .log。
#       这样开发可以继续改工作区而不影响验收。
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
MS="${1:?里程碑，如 M1}"; ROUND="${2:?轮次，如 1}"; shift 2
REF="HEAD"; PROMPT_FILE=""
while [ $# -gt 0 ]; do case "$1" in --ref) REF="$2"; shift 2;; *) PROMPT_FILE="$1"; shift;; esac; done
PROMPT_FILE="${PROMPT_FILE:-docs/04-验收记录/prompts/${MS}.md}"
[ -f "$PROMPT_FILE" ] || { echo "缺少提示词文件：$PROMPT_FILE" >&2; exit 2; }
OUT="$ROOT/docs/04-验收记录/${MS}-codex-round${ROUND}.json"; LOG="$ROOT/docs/04-验收记录/${MS}-codex-round${ROUND}.log"
SCRATCH="${HELIU_ACCEPT_DIR:-${TMPDIR:-/tmp}/heliu-accept}"; mkdir -p "$SCRATCH"
SNAP="$SCRATCH/${MS}-r${ROUND}-$(git rev-parse --short "$REF")"
rm -rf "$SNAP"; git worktree prune; git worktree add --detach -q "$SNAP" "$REF"
ln -s "$ROOT/node_modules.nosync" "$SNAP/node_modules"
cleanup(){ git -C "$ROOT" worktree remove --force "$SNAP" >/dev/null 2>&1 || true; }
trap cleanup EXIT
export PATH="$HOME/.bun/bin:$PATH"
echo "快照：$SNAP（$(git rev-parse --short "$REF")）" | tee "$LOG"
codex exec -s workspace-write --ephemeral -C "$SNAP" \
  --output-schema "$ROOT/docs/04-验收记录/verdict.schema.json" -o "$OUT" \
  "$(cat "$PROMPT_FILE")" >> "$LOG" 2>&1 || true
if [ -s "$OUT" ]; then jq . "$OUT"; else echo "未得到结构化结论，见 $LOG" >&2; tail -20 "$LOG"; exit 1; fi
