#!/usr/bin/env bash
# 对比测试：阳光大男孩 vs 傲娇老头 的人格下，v0.12.6 嵌入式机制效果
set -e
cd "$(dirname "$0")/../.."

run_for_persona() {
  local persona_file=$1
  local label=$2
  local out="tests/embedded-compare-${label}.log"

  echo "" > "$out"
  echo "=== 人格: $label ===" >> "$out"
  echo "" >> "$out"

  # 激活目标人格
  cp "personality/${persona_file}" personality/active.md
  # 预置 5h 前活跃
  FIVE_HOURS_AGO=$(node -e "console.log(Date.now() - 5 * 3600 * 1000)")
  cat > data/proactive-state.json <<EOF
{"lastUserActivityAt": ${FIVE_HOURS_AGO}, "lastProactiveAt": 0, "todayCount": 0, "todayDate": "2026-07-17"}
EOF

  (
    printf "嗯，今天还好\n"
    sleep 25
    printf "昨天那个事没搞完\n"
    sleep 25
    printf "算了不说了\n"
    sleep 25
    printf "/quit\n"
  ) | bun run start >> "$out" 2>&1

  echo "" >> "$out"
  echo "=== 分析 ===" >> "$out"
  if grep -q "对了" "$out"; then
    echo "✓ 含 '对了'" >> "$out"
    grep "对了" "$out" | head -2 >> "$out"
  else
    echo "✗ 没 '对了'" >> "$out"
  fi
  echo "对话轮数: $(grep -c '^> ' "$out" || echo 0)" >> "$out"

  echo "--- $label ---"
  cat "$out" | grep -E "^> |对了|轮数" | head -10
}

run_for_persona "tsundere-elder.md" "傲娇老头"
echo "==================================="
run_for_persona "default-sunny-bro.md" "阳光大男孩"
