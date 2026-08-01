#!/usr/bin/env bash
# tests/v4-mode-test.sh
# v4.0 真实 API 测试：每轮 response-mode classifier 决定模式
# 故意用 5 种不同的输入触发不同模式

cd "$(dirname "$0")/../.."

(
  # 1. 触发 CHITCHAT 模式
  printf "今天天气挺不错\n"
  sleep 30

  # 2. 触发 HOLD 模式
  printf "我最近真的好累，撑不住了\n"
  sleep 30

  # 3. 触发 INSIGHT 模式
  printf "我有时候觉得自己明明很努力但就是看不到结果，这正常吗\n"
  sleep 30

  # 4. 触发 ACTIONABLE 模式
  printf "我应该怎么开始改善睡眠\n"
  sleep 30

  # 5. 触发 STORY 模式
  printf "我今天跟我妈吵架了，她不理解我\n"
  sleep 30

  printf "/quit\n"
) | bun run start 2>&1 | tee tests/v4-mode-test.log