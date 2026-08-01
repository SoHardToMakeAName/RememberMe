#!/usr/bin/env bash
# tests/stress-20round.sh
# 20 轮长对话压力测试：测延迟、token 累积、模式分类分布

cd "$(dirname "$0")/../.."

LOG="tests/stress-20round.log"
echo "=== 压力测试：20 轮对话 ===" > "$LOG"
date >> "$LOG"

(
  # 1-5: 闲聊
  printf "在吗？\n"
  sleep 18
  printf "今天天气不错\n"
  sleep 18
  printf "刚吃完饭\n"
  sleep 18
  printf "你最近看了什么书吗？\n"
  sleep 18
  printf "推荐本好的吧\n"
  sleep 18

  # 6-10: 情绪话题
  printf "我最近睡不好\n"
  sleep 18
  printf "其实是有个事一直在脑子里\n"
  sleep 18
  printf "我跟我妈吵架了\n"
  sleep 18
  printf "她说我不该换工作\n"
  sleep 18
  printf "我不知道谁对\n"
  sleep 18

  # 11-15: 知识/观点
  printf "你怎么看'课题分离'\n"
  sleep 18
  printf "阿德勒说的对吗\n"
  sleep 18
  printf "我读过一些他的书\n"
  sleep 18
  printf "但感觉没解决实际问题\n"
  sleep 18
  printf "你怎么看读书和实践\n"
  sleep 18

  # 16-20: 收尾
  printf "我有点想法了\n"
  sleep 18
  printf "想先跟自己待一会\n"
  sleep 18
  printf "你说得对\n"
  sleep 18
  printf "谢谢你听我聊\n"
  sleep 18
  printf "晚安\n"
  sleep 18

  printf "/stats\n"
  sleep 5
  printf "/quit\n"
) | bun run start > "$LOG" 2>&1

echo "" >> "$LOG"
echo "=== 压测结果分析 ===" >> "$LOG"
echo "" >> "$LOG"
grep -c "^小阳：\|^> " "$LOG" | xargs -I{} echo "总回复数: {}" >> "$LOG"
grep "情绪: 😐" "$LOG" | wc -l | xargs -I{} echo "平静次数: {}" >> "$LOG"
grep "情绪: 😔" "$LOG" | wc -l | xargs -I{} echo "难过次数: {}" >> "$LOG"
grep "情绪: 🤔" "$LOG" | wc -l | xargs -I{} echo "复杂次数: {}" >> "$LOG"
grep "情绪: 😊" "$LOG" | wc -l | xargs -I{} echo "开心次数: {}" >> "$LOG"
grep "消息数：" "$LOG" | tail -1 >> "$LOG"

cat "$LOG" | tail -30