#!/usr/bin/env bash
# 1 轮快速测试新人格效果
cd "$(dirname "$0")/../.."

(
  printf "我最近睡不好\n"
  sleep 40
  printf "/quit\n"
) | bun run start 2>&1