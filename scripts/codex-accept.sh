#!/usr/bin/env bash
# 用本机 Codex（ChatGPT）以普通用户视角做里程碑二次验收。
# 用法：scripts/codex-accept.sh <里程碑 如 M1> <轮次 如 2> [提示词文件，默认 docs/04-验收记录/prompts/<里程碑>.md]
# 输出：docs/04-验收记录/<里程碑>-codex-round<轮次>.json（按 verdict.schema.json）与同名 .log
set -euo pipefail
cd "$(dirname "$0")/.."
MS="${1:?里程碑，如 M1}"; ROUND="${2:?轮次，如 1}"; PROMPT_FILE="${3:-docs/04-验收记录/prompts/${MS}.md}"
[ -f "$PROMPT_FILE" ] || { echo "缺少提示词文件：$PROMPT_FILE" >&2; exit 2; }
OUT="docs/04-验收记录/${MS}-codex-round${ROUND}.json"; LOG="docs/04-验收记录/${MS}-codex-round${ROUND}.log"
export PATH="$HOME/.bun/bin:$PATH"
codex exec -s workspace-write --ephemeral -C "$PWD" \
  --output-schema "docs/04-验收记录/verdict.schema.json" -o "$OUT" \
  "$(cat "$PROMPT_FILE")" > "$LOG" 2>&1 || true
if [ -s "$OUT" ]; then jq . "$OUT"; else echo "未得到结构化结论，见 $LOG" >&2; tail -20 "$LOG"; exit 1; fi
