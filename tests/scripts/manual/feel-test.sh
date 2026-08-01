#!/usr/bin/env bash
# 多情绪场景测试（评估"人味"）
cd "$(dirname "$0")/../.."

(
  printf "我最近总觉得自己在拖后腿，团队里别人都很厉害，就我跟不上\n"
  sleep 25
  printf "嗯…就是开会的时候别人说的那些我都不太懂，我都不敢说话\n"
  sleep 25
  printf "上次提了个方案被 leader 当场否了，说太幼稚。从那以后我就不太敢发言了\n"
  sleep 25
  printf "其实我挺喜欢这份工作的，就是每次开会都紧张得不行\n"
  sleep 25
  printf "算了不聊工作。今天天气挺不错的\n"
  sleep 25
  printf "我去公园走了一圈，看到有人在放风筝，突然觉得活着挺好的\n"
  sleep 25
  printf "你有过这种'突然觉得生活挺好'的时刻吗？\n"
  sleep 25
  printf "其实我养了一只猫，叫饺子\n"
  sleep 20
  printf "/quit\n"
) | EC_COMPACT_TRIGGER_AT=12 EC_COMPACT_RECENT_KEPT=4 bun run start 2>&1 | tee tests/feel-test.log