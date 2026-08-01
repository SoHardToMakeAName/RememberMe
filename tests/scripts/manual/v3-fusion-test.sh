#!/usr/bin/env bash
# tests/v3-fusion-test.sh
# v3.0 真实 API 测试：验证"知识密度 + 人味"的融合
# 故意用一些需要"知识+情绪"的话题

cd "$(dirname "$0")/../.."

(
  printf "我最近觉得自己特别内耗\n"
  sleep 25
  printf "其实就是上班的时候各种小事情堆积起来，比如同事发消息不回、领导说话不算数、自己做的东西被否掉\n"
  sleep 25
  printf "我读了一本书叫被讨厌的勇气，里面说一切烦恼都来自人际关系。但我看完还是不知道怎么解决\n"
  sleep 25
  printf "而且我自己都不知道自己想要什么\n"
  sleep 25
  printf "我养了一只猫，叫小年\n"
  sleep 20
  printf "/quit\n"
) | bun run start 2>&1 | tee tests/v3-fusion-test.log