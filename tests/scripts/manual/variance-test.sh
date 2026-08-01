#!/usr/bin/env bash
# tests/variance-test.sh
# 方差测试：同一段对话跑 3 次，看模型回复的差异。
# 如果 3 次都差不多 = 模式化（缺人味）
# 如果 3 次都不一样 = 自然（更人味）

set -e
cd "$(dirname "$0")/../.."

OUT_DIR="tests/variance-out"
mkdir -p "$OUT_DIR"

# 三次运行
for RUN in 1 2 3; do
  LOG="$OUT_DIR/run-${RUN}.log"
  echo ""
  echo "=========================================="
  echo "  Run ${RUN}/3 → ${LOG}"
  echo "=========================================="

  (
    printf "我最近总觉得自己在拖后腿\n"
    sleep 25
    printf "哎，就是工作上的事\n"
    sleep 25
    printf "其实你有过这种感觉吗\n"
    sleep 20
    printf "/quit\n"
  ) | bun run start 2>&1 | tee "$LOG" > /dev/null
done

echo ""
echo "=========================================="
echo "  对比报告"
echo "=========================================="

# 提取每轮的小阳回复
echo ""
echo "### Round 1 回复对比：'我最近总觉得自己在拖后腿'"
echo ""
for RUN in 1 2 3; do
  echo "--- Run ${RUN} ---"
  grep -A 3 "小阳：" "$OUT_DIR/run-${RUN}.log" | head -8 || echo "(无回复)"
  echo ""
done

echo ""
echo "### Round 2 回复对比：'哎，就是工作上的事'"
echo ""
for RUN in 1 2 3; do
  echo "--- Run ${RUN} ---"
  # 找到第二个 小阳：之前跳过一个
  grep -A 3 "小阳：" "$OUT_DIR/run-${RUN}.log" | head -16 | tail -8 || echo "(无回复)"
  echo ""
done

echo ""
echo "### Round 3 回复对比：'其实你有过这种感觉吗'"
echo ""
for RUN in 1 2 3; do
  echo "--- Run ${RUN} ---"
  grep -A 3 "小阳：" "$OUT_DIR/run-${RUN}.log" | tail -8 || echo "(无回复)"
  echo ""
done

echo ""
echo "### 总结"
echo "如果 3 个回复完全相同或高度相似 → 模型太模式化（人味扣分）"
echo "如果 3 个回复有差异但内核一致 → 自然人味 ✓"
echo "完整日志：$OUT_DIR/"