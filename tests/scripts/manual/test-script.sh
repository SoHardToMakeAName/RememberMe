#!/usr/bin/env bash
# tests/test-script.sh
# 10 轮对话手动测试
# 设置紧凑阈值：triggerAt=8（4 轮），recentKept=4（2 轮）
# 预期 compact 触发时机：第 4 轮结束时（history=8 条），第 8 轮结束时

cd "$(dirname "$0")/../.."

export EC_COMPACT_TRIGGER_AT=8
export EC_COMPACT_RECENT_KEPT=4

# 用文件描述符把消息按节奏喂给 bun
exec 3>&1

(
  printf "我最近心情不太好\n"
  sleep 15
  printf "主要是因为工作压力\n"
  sleep 15
  printf "老板让我今天交一份报告\n"
  sleep 15
  printf "我其实拖了快两周了\n"
  sleep 15
  printf "每次打开文档就发呆不知道怎么开始\n"
  sleep 15
  printf "算了不聊这个你晚饭吃了吗\n"
  sleep 15
  printf "我吃了碗面一个人吃的\n"
  sleep 15
  printf "突然想到今天早上我妈给我打电话了\n"
  sleep 15
  printf "也没什么事就问问我在干嘛\n"
  sleep 15
  printf "/stats\n"
  sleep 3
  printf "/timeline stats\n"
  sleep 3
  printf "/quit\n"
) | bun run start 2>&1 | tee tests/round-10-output.log
