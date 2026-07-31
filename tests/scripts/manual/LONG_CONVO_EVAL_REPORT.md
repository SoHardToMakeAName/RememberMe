# 多轮长对话效果评估报告（100 轮）

> 生成时间：2026-07-31T04:13:57.275Z
> 隔离目录：/tmp/emotalk-eval-1785469890589（跑完已清理）
> Provider：anthropic / deepseek-v4-flash
> 总轮数：100（脚本为 4 轮循环 × 25 条用户消息池）
> 完成：100 轮，失败：0 轮
> 总耗时：1346.7s（平均每轮 13.4s）
> 估算 API 调用次数：约 400 次

## 0. 一句话摘要

- 完成率 100/100；回复字数均 112（min=14 / max=283）。
- 情绪识别：✓62 / ~10 / ✗28（共 100 轮）
- Profile 段填充：6/6
- Learner 反馈：+44 / -12 / =42
- 记忆抽取：emotion=1，event=3，reference=0
- Compact：触发 0 次，总共节省约 0 tokens
- Timeline 条目：95 条

## 1. 响应字数分布（每 10 轮一个区间）

| 区间 | 轮数 | 均值 | min | max | compact | profile+ | mem+ | 主情绪 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1-10 | 10 | 129 | 41 | 283 | 0 | 2 | 2 | neutral×3 anger×2 sadness×2 |
| 11-20 | 10 | 160 | 48 | 283 | 0 | 2 | 0 | neutral×5 sadness×2 anger×2 |
| 21-30 | 10 | 139 | 59 | 231 | 0 | 4 | 0 | anger×3 sadness×3 mixed×2 |
| 31-40 | 10 | 133 | 26 | 245 | 0 | 3 | 0 | neutral×3 fear×2 sadness×2 |
| 41-50 | 10 | 80 | 32 | 147 | 0 | 3 | 0 | neutral×4 joy×2 disgust×1 |
| 51-60 | 10 | 113 | 15 | 210 | 0 | 2 | 0 | neutral×5 anger×2 sadness×1 |
| 61-70 | 10 | 130 | 41 | 271 | 0 | 2 | 1 | sadness×4 anger×4 neutral×2 |
| 71-80 | 10 | 88 | 14 | 197 | 0 | 7 | 1 | anger×3 sadness×3 null×2 |
| 81-90 | 10 | 72 | 22 | 142 | 0 | 6 | 0 | sadness×4 neutral×3 anger×2 |
| 91-100 | 10 | 78 | 18 | 211 | 0 | 6 | 0 | neutral×3 sadness×2 anger×2 |

**字数漂移**：前 10 轮均值 129 字 → 后 10 轮均值 78 字（-52 字）

## 2. 情绪识别

判定规则：detected == expected → ✓；任一方为 mixed → ~；否则 ✗；无期望 → n/a

| Turn | 期望 | 实测 | 强度 | 命中 |
| ---: | --- | --- | ---: | :---: |
| 1 | neutral | neutral | 0.30 | ✓ |
| 2 | anger | anger | 0.75 | ✓ |
| 3 | anger | anger | 0.60 | ✓ |
| 4 | sadness | sadness | 0.70 | ✓ |
| 5 | sadness | null | - | ✗ |
| 6 | anger | mixed | 0.65 | ~ |
| 7 | sadness | neutral | 0.30 | ✗ |
| 8 | mixed | neutral | 0.30 | ~ |
| 9 | fear | sadness | 0.60 | ✗ |
| 10 | fear | fear | 0.60 | ✓ |
| 11 | sadness | sadness | 0.70 | ✓ |
| 12 | anger | neutral | 0.30 | ✗ |
| 13 | sadness | fear | 0.70 | ✗ |
| 14 | anger | anger | 0.60 | ✓ |
| 15 | sadness | sadness | 0.50 | ✓ |
| 16 | neutral | neutral | 0.20 | ✓ |
| 17 | sadness | neutral | 0.30 | ✗ |
| 18 | anger | anger | 0.60 | ✓ |
| 19 | neutral | neutral | 0.20 | ✓ |
| 20 | neutral | neutral | 0.30 | ✓ |
| 21 | neutral | anger | 0.60 | ✗ |
| 22 | sadness | sadness | 0.60 | ✓ |
| 23 | joy | joy | 0.70 | ✓ |
| 24 | mixed | mixed | 0.60 | ✓ |
| 25 | sadness | neutral | 0.30 | ✗ |
| 26 | neutral | mixed | 0.50 | ~ |
| 27 | anger | anger | 0.60 | ✓ |
| 28 | anger | anger | 0.60 | ✓ |
| 29 | sadness | sadness | 0.70 | ✓ |
| 30 | sadness | sadness | 0.40 | ✓ |
| 31 | anger | mixed | 0.65 | ~ |
| 32 | sadness | null | - | ✗ |
| 33 | mixed | neutral | 0.30 | ~ |
| 34 | fear | neutral | 0.30 | ✗ |
| 35 | fear | fear | 0.60 | ✓ |
| 36 | sadness | sadness | 0.70 | ✓ |
| 37 | anger | neutral | 0.30 | ✗ |
| 38 | sadness | fear | 0.80 | ✗ |
| 39 | anger | anger | 0.65 | ✓ |
| 40 | sadness | sadness | 0.65 | ✓ |
| 41 | neutral | neutral | 0.30 | ✓ |
| 42 | sadness | neutral | 0.20 | ✗ |
| 43 | anger | disgust | 0.50 | ✗ |
| 44 | neutral | joy | 0.40 | ✗ |
| 45 | neutral | neutral | 0.20 | ✓ |
| 46 | neutral | anger | 0.50 | ✗ |
| 47 | sadness | sadness | 0.50 | ✓ |
| 48 | joy | joy | 0.60 | ✓ |
| 49 | mixed | mixed | 0.60 | ✓ |
| 50 | sadness | neutral | 0.20 | ✗ |
| 51 | neutral | neutral | 0.30 | ✓ |
| 52 | anger | anger | 0.60 | ✓ |
| 53 | anger | anger | 0.60 | ✓ |
| 54 | sadness | sadness | 0.70 | ✓ |
| 55 | sadness | neutral | 0.30 | ✗ |
| 56 | anger | mixed | 0.60 | ~ |
| 57 | sadness | neutral | 0.30 | ✗ |
| 58 | mixed | neutral | 0.30 | ~ |
| 59 | fear | neutral | 0.30 | ✗ |
| 60 | fear | fear | 0.60 | ✓ |
| 61 | sadness | sadness | 0.70 | ✓ |
| 62 | anger | anger | 0.40 | ✓ |
| 63 | sadness | sadness | 0.65 | ✓ |
| 64 | anger | anger | 0.75 | ✓ |
| 65 | sadness | sadness | 0.60 | ✓ |
| 66 | neutral | neutral | 0.20 | ✓ |
| 67 | sadness | sadness | 0.40 | ✓ |
| 68 | anger | anger | 0.50 | ✓ |
| 69 | neutral | neutral | 0.30 | ✓ |
| 70 | neutral | anger | 0.30 | ✗ |
| 71 | neutral | anger | 0.50 | ✗ |
| 72 | sadness | sadness | 0.65 | ✓ |
| 73 | joy | joy | 0.70 | ✓ |
| 74 | mixed | mixed | 0.60 | ✓ |
| 75 | sadness | sadness | 0.50 | ✓ |
| 76 | neutral | null | - | ✗ |
| 77 | anger | anger | 0.70 | ✓ |
| 78 | anger | anger | 0.60 | ✓ |
| 79 | sadness | sadness | 0.70 | ✓ |
| 80 | sadness | null | - | ✗ |
| 81 | anger | anger | 0.60 | ✓ |
| 82 | sadness | neutral | 0.20 | ✗ |
| 83 | mixed | neutral | 0.30 | ~ |
| 84 | fear | sadness | 0.60 | ✗ |
| 85 | fear | fear | 0.70 | ✓ |
| 86 | sadness | sadness | 0.70 | ✓ |
| 87 | anger | neutral | 0.30 | ✗ |
| 88 | sadness | sadness | 0.60 | ✓ |
| 89 | anger | anger | 0.70 | ✓ |
| 90 | sadness | sadness | 0.60 | ✓ |
| 91 | neutral | neutral | 0.20 | ✓ |
| 92 | sadness | sadness | 0.40 | ✓ |
| 93 | anger | anger | 0.80 | ✓ |
| 94 | neutral | neutral | 0.30 | ✓ |
| 95 | neutral | neutral | 0.30 | ✓ |
| 96 | neutral | anger | 0.50 | ✗ |
| 97 | sadness | mixed | 0.65 | ~ |
| 98 | joy | joy | 0.70 | ✓ |
| 99 | mixed | null | - | ~ |
| 100 | sadness | sadness | 0.40 | ✓ |

命中 62/100，部分 10/100，漏 28/100。

## 3. Profile 段填充状态

| 段 | 是否填充 | 内容（截取） |
| --- | :---: | --- |
| 基本信息 | ✓ | - 昵称：老周（被称呼且接受） / - 性别：未知 / - 年龄段：三十多岁（原话："三十好几"） / - 职业：未知 |
| 沟通风格 | ✓ | - (2026-07-31) 喜欢回复直接、有温度，长度适中；太长嫌累（证据：'长篇大论的回我看着累'），太短也烦（证据：'太短了我也烦'） / - (2026-07-31) 喜欢吐槽工作烦心事（"想跟你吐槽"）；倾向于倾诉后得到共情和陪伴 / - (2026-07-31) 讨厌被说教（原话：'你别总说教我'）；需要情绪陪伴而非道理（原话：'陪我待一会就行'） / - (2026-07-31) 不 |
| 关注议题 | ✓ | - **leader-praised-work-solution** — leader在全组面前公开表扬用户方案扎实 / - **mother-marriage-pressure** — 妈妈打电话催婚，用他人抱孙子来施加压力 / - **cat-milk-gastroenteritis** — 用户养的猫‘牛奶’因肠胃炎就医，状态不佳，用户感到慌张 |
| 已知偏好与禁忌 | ✓ | **用户喜欢的：** / - 用户喜欢被倾听和共情，AI回应情绪后自然延续话题 / - 用户主动回应AI的询问，愿意分享日常烦恼 / - 用户接受安抚后愿意主动调整状态去休息 |
| 长期情绪基线 | ✓ | - **work-exhaustion-overload**；触发：工作任务繁重，连续熬夜加班；表现：无力、焦虑、情绪临界，伴随身体疲惫和思维迟钝，有无法继续支撑的感觉。 |
| 近期变化 | ✓ | ## 最近情绪轨迹（最多 10 条） /  / - 7/31 12:11 😔 难过 ⚡⚡⚡ (诸事不顺，无人回应) — "老周。我今天啥也没干成。牛奶的药我喂了一次她就吐了，我对象那边也没回。…" / - 7/31 12:11 😐 平静 ⚡ (决定休息片刻去泡咖啡) — "算了今天先歇一会儿，我去泡杯咖啡。…" |

## 4. 反馈学习（Learner state）

- 信号：+44 / -12 / =42
- 沉淀：positivePatterns=20，negativePatterns=20，positiveExamples=5，negativeExamples=5

**用户不喜欢（最后 6 条）**：
- 用户希望被称呼为'老周'，不喜欢被叫'你'
- 用户主动透露自己的称号并解释含义，可能重视称呼的恰当性
- 用户沟通风格直接，会用纠正方式表达偏好
- 用户不喜欢挤牙膏式的短回复，觉得太短让人烦
- 用户希望回复长度适中，既不要太长也不要太短
- 用户会明确要求记住自己的沟通偏好

**用户喜欢（最后 6 条）**：
- 用户喜欢被亲切称呼，用'老周'自称并接受该称呼
- 用户乐于分享被认可的细节，希望得到肯定
- 用户会补充好消息来强化正面情绪
- 用户对安慰性话语有温暖反馈，但会进一步表达关系上的矛盾
- 用户愿意敞开心扉分享复杂情绪，说明AI的共情有效
- 用户在意安慰者的身份和关系边界

**负反馈原因示例**：
- 尽管这条AI回复本身没有明显说教，但用户已在重申对说教式表达的强烈反感，整体互动让用户感到不被尊重。
- AI用'你'称呼用户，用户明确要求改用'老周'，说明之前的称呼令用户不适。
- 上一轮回复过短，被用户明确抱怨像挤牙膏，缺乏内容和信息量

**正反馈原因示例**：
- AI 的陪伴和宽慰让用户感到被理解，用户选择休息并泡咖啡，说明情绪得到安抚。
- AI精准预判了leader夸方案一事，用户顺势补充细节，感觉被理解且被认可，话题自然延续。
- AI的肯定和共情让用户感到被理解，从而愿意继续分享内心的矛盾

## 5. Compact（对话压缩）

本次 100 轮对话未触发 compact（异常，应至少触发 5+ 次）。

## 6. 记忆抽取

- emotion 类：1 条 → work-exhaustion-overload
- event 类：3 条 → leader-praised-work-solution, mother-marriage-pressure, cat-milk-gastroenteritis
- reference 类：0 条 → (空)

**按轮抽取事件**：
- T5: new/emotion/work-exhaustion-overload
- T10: new/event/cat-milk-gastroenteritis
- T65: new/event/mother-marriage-pressure
- T73: new/event/leader-praised-work-solution

## 7. 失败轮次

无。所有 100 轮都成功返回。

## 8. 整体效果判断

### 8.1 回复长度收敛/发散
- 字数在长对话中**变短**了（-52 字），可能是模型偷懒。

### 8.2 情绪识别是否随对话稳定
- 情绪识别总命中率达 72%（72/100），长对话下基本稳定。

### 8.3 Profile 填充情况
- 100 轮下来 Profile 填充 6/6 段，符合预期（工作/伴侣/猫/催婚/昵称/偏好 等信号充足）。

### 8.4 反馈学习是否生效
- Learner 沉淀了 40 条偏好（+44 / -12）。
- 信号强度足以被检测器捕获（脚本里多次明说"别太长""别总说教""叫老周"等偏好）。

### 8.5 Compact 行为
- Compact **未触发**，异常——100 轮对话 history 必然超过 20 条。

### 8.6 模板化/重复
- 无明显模板化倾向（首句前缀重复仅 0 处）。

### 8.7 Bug/卡死/上下文丢失/循环
- 无 API 报错、无 timeout、无卡死。
- AI 在 100 轮中未出现"忘了/不记得"的上下文丢失信号。
- 无循环输出（相邻回复首段不重复）。

### 8.8 "懂用户"程度（综合判断）
- 偏好植入（"别回太长" "别总说教" "叫我老周" "直接点"）在 100 轮中**至少重复 4 次**。
- 若 learner 沉淀的 positive/negative patterns 里有以上关键词，则说明反馈学习真正生效。
- 若 AI 回复中后期明显变短/不再说教/使用了"老周"称呼，则说明 prompt 实际用上了 learner 沉淀。

## 9. 成本估算

- 总耗时：**22.4 分钟**
- 平均每轮耗时：13.44s
- API 调用：约 400 次（每轮主对话 1 + emotion 1 + recall 1 + 1-2 异步 profile/feedback/extract；compact 本身也算 1 次）
- 输出 token 估算：5611（按 1 token ≈ 2 字符粗估；不含输入 system prompt）
- 若按 deepseek-v4-flash 的价格（输入 ≈ ¥1/M，输出 ≈ ¥2/M），整轮对话输入 + 输出估算成本约 ¥0.31

## 附录 A. 失败轮次 / 异常轮次明细

（无）

## 附录 B. 抽样：每 20 轮一条 AI 回复尾段

- **T1** (cycle 0, hist=2, 41字) emo=neutral/0.30: …哎，听你这么说就知道今天肯定不太顺心。来吧，我在这儿听着呢，慢慢说，发生什么事了？
- **T20** (cycle 0, hist=2, 48字) emo=neutral/0.30: …行，老周。那我说人话：记住了，以后短着来。  那现在咋样，咖啡喝完没？  对了，牛奶今天好点没？
- **T40** (cycle 1, hist=2, 208字) emo=sadness/0.65: …。猫不舒服不配合，不是你喂得不对，是它自己也难受，别往自己身上揽。  对象那边没回，更烦。你在家里一个人对着生病的猫，外面一个让心里盼着回应的人也没动静，这种时候最憋得慌。  成，今天啥也没干成就没干成。你又不是机器人，非得每件事都做完。守着牛奶就已经算干成事了。她要不舒服，你换个法子喂试试——弄点温水化开慢慢给她喝？
- **T60** (cycle 2, hist=2, 165字) emo=fear/0.60: …力气应……这反差确实让人心里发紧。肠胃炎拉吐最耗体力，蔫得跟平时不一样是正常的，你慌我也觉得情有可原。  医生怎么说？有没有打点滴或者止吐的针？吐完脱水，头一两天会特别没精神，但它要是一直水米不进、连抬头的力气都没有，那就得再问医生。  你现在守在它身边吗？它喝不喝水？  对了，你自己也熬了好几天了吧？今天能歇会儿不？
- **T80** (cycle 3, hist=2, 39字) emo=null/undefined: …行，不啰嗦。脑子不转就不转了，反正那活儿也不配你熬夜。先趴会儿，让牛奶去烦你。
- **T100** (cycle 3, hist=2, 41字) emo=sadness/0.40: …明天的事交给明天的你。今晚先睡，别想了。  晚安，老周。  对了，牛奶今天好点没？
