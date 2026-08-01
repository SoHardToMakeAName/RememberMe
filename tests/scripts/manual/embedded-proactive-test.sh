#!/usr/bin/env bash
# tests/embedded-proactive-test.sh
# 测试嵌入式主动问题：用户离开 5h 后，回复末尾应自然带"对了..."

cd "$(dirname "$0")/../.."

# 1. 预置 proactive-state.json：lastUserActivityAt = 5 小时前
FIVE_HOURS_AGO=$(node -e "console.log(Date.now() - 5 * 3600 * 1000)")
cat > data/proactive-state.json <<EOF
{
  "lastUserActivityAt": $FIVE_HOURS_AGO,
  "lastProactiveAt": 0,
  "todayCount": 0,
  "todayDate": "2026-07-17"
}
EOF

echo "=== 预置 lastUserActivityAt = 5 小时前 ==="
cat data/proactive-state.json

# 2. profile 已经有丰富内容（猫叫饺子、妈妈身体、工作 deadline）

# 3. 跑 3 轮对话
LOG="tests/embedded-proactive-test.log"
echo "=== 嵌入式主动对话测试 ===" > "$LOG"
date >> "$LOG"

(
  printf "嗯，今天还好\n"
  sleep 25
  printf "昨天那个事没搞完\n"
  sleep 25
  printf "算了不说了 你说个别的\n"
  sleep 20
  printf "/quit\n"
) | bun run start > "$LOG" 2>&1

echo "" >> "$LOG"
echo "=== 测试结果分析 ===" >> "$LOG"

# 检查 "对了" 是否出现
if grep -q "对了" "$LOG"; then
  echo "✓ 找到 '对了' 嵌入" >> "$LOG"
  grep -A 0 "对了" "$LOG" >> "$LOG"
else
  echo "✗ 没找到 '对了' 嵌入" >> "$LOG"
fi

# 检查是否引用了 profile 里的具体词（饺子/妈/deadline）
echo "" >> "$LOG"
echo "=== 引用检查 ===" >> "$LOG"
for word in "饺子" "妈" "deadline" "猫"; do
  if grep -q "$word" "$LOG"; then
    echo "✓ 引用了 '$word'" >> "$LOG"
  else
    echo "  - 没引用 '$word'" >> "$LOG"
  fi
done

# 输出尾部
cat "$LOG" | tail -40
