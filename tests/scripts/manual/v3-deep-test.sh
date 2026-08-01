#!/usr/bin/env bash
# tests/v3-deep-test.sh
# v3.0 深度对话：哲学 / 认知盲点 / 心理学概念密集

cd "$(dirname "$0")/../.."

(
  # 1. 认知偏差：沉没成本
  printf "我已经在一家公司待了 5 年，明明不开心了但又觉得走了太亏，这算什么心理\n"
  sleep 40

  # 2. 决策疲劳
  printf "我每天下班回家什么都不想做，连晚饭吃什么都纠结半小时。这是懒吗\n"
  sleep 40

  # 3. 哲学：意义感
  printf "我有时候觉得活着没什么意思，但又觉得不该有这种想法。这矛盾吗\n"
  sleep 40

  # 4. 比较心理
  printf "我朋友圈里同龄人结婚买房晒娃，我看着就烦躁。这是不是我太小气了\n"
  sleep 40

  # 5. 自我分裂：should vs actual
  printf "我感觉自己心里有两个我，一个说要努力要自律，一个说躺平也挺好。这正常吗\n"
  sleep 40

  # 6. 自由意志
  printf "你相信人真的有自由意志吗？还是我们所有决定其实都是基因 + 环境的产物\n"
  sleep 40

  # 7. 改变为什么难
  printf "我知道我应该多运动少熬夜，但每次都做不到。是意志力不够吗\n"
  sleep 40

  # 8. 存在主义
  printf "如果生命本来就没意义，那努力生活是不是自欺欺人\n"
  sleep 40

  # 9. 实用主义
  printf "那从你这么多年的经验看，什么是真正能让人变好的\n"
  sleep 40

  # 10. 收尾
  printf "我今天问了好多问题，谢谢你都没嫌我烦\n"
  sleep 30

  printf "/quit\n"
) | bun run start 2>&1 | tee tests/v3-deep-test.log