# RememberMe — 架构文档

> 面向开发者与深度技术读者：架构总览、模块详解、设计决策、数据模型、评测方法。
>
> 用户文档：[README.md](./README.md) · CLI 使用手册：[USER_MANUAL.md](./USER_MANUAL.md)

---

## 目录

1. [项目定位与设计哲学](#1-项目定位与设计哲学)
2. [架构总览](#2-架构总览)
3. [数据模型](#3-数据模型)
4. [模块详解](#4-模块详解)
   - 4.1 [Provider 抽象](#41-provider-抽象srcproviderts)
   - 4.2 [主对话循环](#42-主对话循环srcloopts--srcwebts)
   - 4.3 [Prompt 拼装](#43-prompt-拼装srcpromptts)
   - 4.4 [记忆系统](#44-记忆系统srcmemoryts)
   - 4.5 [用户画像](#45-用户画像srcprofilets)
   - 4.6 [大五人设（OCEAN）](#46-大五人设oceansrcbigfivets--srcpersona-initts)
   - 4.7 [反馈学习](#47-反馈学习srcfeedback-detectorts--srcpersona-learnerts)
   - 4.8 [情绪时间线](#48-情绪时间线srctimelinets)
   - 4.9 [主动关心](#49-主动关心srcembedded-proactivets)
   - 4.10 [Auto Compact](#410-auto-compactsrccompactts)
   - 4.11 [每日反思](#411-每日反思srcreflectionts)
   - 4.12 [Session 管理](#412-session-managementsrcsessionsts)
   - 4.13 [Context File I/O](#413-context-file-iosrccontext-filets)
   - 4.14 [自进化层](#414-自进化层srcevolution)
5. [LLM 调用策略](#5-llm-调用策略)
6. [评测方法论](#6-评测方法论)
7. [部署与运行](#7-部署与运行)
8. [关键设计决策与权衡](#8-关键设计决策与权衡)
9. [路线图](#9-路线图)

---

## 1. 项目定位与设计哲学

### 1.1 一句话定位

**RememberMe 是一个 context orchestrator（上下文编排器）**，不是 agent。它不调用工具、不主动规划、不做多步推理。它的核心价值是：**把分散在本地 markdown 文件里的"关于这个用户的认知"整合成更适配当前这一刻的 system prompt**，让同一个 LLM 在 RememberMe 里表现得比通用聊天窗口里更懂你。

### 1.2 不做什么

- **不调 tool use**：不实现 function calling / MCP / agent loop
- **不用向量数据库**：记忆召回靠 LLM 直接读候选文件 + 语义判断
- **不预定义人格模板**：不预设"温柔型""毒舌型"等硬编码 persona
- **不存储对话内容到云端**：所有用户数据在本地 `data/` 目录（详见隐私边界）

### 1.3 核心承诺

> 半年后回来，问"还记得我吗"，能从上次聊到一半的话题继续。

这条承诺决定了所有架构选择：所有关于用户的认知必须**持久化、可读、可手改**。

### 1.4 设计哲学

| 原则 | 实现 |
|---|---|
| **数据可读可改** | profile / memory / reflection 都是 markdown；JSON 文件可手改 |
| **失败容错** | 每个 LLM 调用失败都有 fallback（emotion null / recall [] / 反馈静默）|
| **不阻塞主对话** | 所有非关键路径 LLM 调用全部 fire-and-forget |
| **行为层 vs 认知层分离** | session persona OCEAN ≠ profile ocean，独立并存 |
| **反馈优先于人设** | 用户说"不要 X"时，覆盖人设规则 |

---

## 2. 架构总览

### 2.1 系统组件

```
┌─────────────────────────────────────────────────────────────────┐
│                         入口层                                   │
│  src/index.ts (REPL)        src/web.ts (Bun.serve + SSE)        │
└────────────────┬─────────────────────────┬───────────────────────┘
                 │                         │
                 └────────────┬────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      主对话循环 (runTurn)                        │
│  src/loop.ts: 同步关键路径                                       │
│  src/web.ts: 异步 / 流式 / fire-and-forget                       │
└──────┬──────────────────────────────────────────────────────────┘
       │
       ├─→ 同步（关键路径）
       │    ├─ Provider.stream() 主回复
       │    ├─ detectEmotion + recallMemories (side-query 并行)
       │    └─ maybeCompact (历史超长时)
       │
       └─→ fire-and-forget（后台）
            ├─ profile 更新（v0.21 抽象化）
            ├─ embedded-proactive（嵌入主动关心）
            ├─ 记忆自动抽取（每 5 轮 / 高强度）
            └─ feedback 检测 + learner 更新

┌─────────────────────────────────────────────────────────────────┐
│                       支撑层                                     │
│  Prompt 组装 · Memory · Profile · Persona · Timeline · Learner  │
└─────────────────────────────────────────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────────────────────────────────┐
│                       数据层 (data/)                             │
│  sessions/ · profile/ · personality/ · memory/ · timeline/       │
│  learned-prefs/ · reflections/ · proactive-state.json           │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 一轮对话的数据流

```
用户输入
  │
  ▼
1. 加载 profile（data/profile/PROFILE.md）
  │
  ▼
2. maybeCompact：history 超长时调 LLM 摘要
  │
  ▼
3. side-query 并行：
   ├─ detectEmotion（情绪识别）
   ├─ recallMemories（记忆召回）
   └─ readMemoryIndex（读 MEMORY.md 索引）
  │
  ▼
4. 拼装 system prompt（5 层，见 §4.3）
  │
  ▼
5. provider.stream({ system, messages }) → 流式输出
  │
  ▼
6. 同步落盘：timeline.append + history 持久化
  │
  ▼
7. fire-and-forget 后台任务：
   ├─ maybeUpdateProfile（profile 抽象）
   ├─ maybeAutoExtract（记忆抽取）
   ├─ embedded-proactive（主动关心，v0.21 不再追加 finalText）
   └─ detectFeedback + applyFeedback（反馈学习）
```

### 2.3 同步 vs 异步边界

| 路径 | 类型 | 阻塞主对话？ |
|---|---|---|
| `provider.stream()` 主回复 | 同步 | ✅ 阻塞（必要）|
| `detectEmotion` | 同步 | ✅ 阻塞（喂给 prompt）|
| `recallMemories` | 同步 | ✅ 阻塞（喂给 prompt）|
| `maybeCompact` | 同步 | ✅ 阻塞（必须 compact 后才能用 history）|
| `timeline.append` | 同步 | ✅ 阻塞（毫秒级，可忽略）|
| `maybeUpdateProfile` | 异步 | ❌ fire-and-forget |
| `maybeAutoExtract` | 异步 | ❌ fire-and-forget |
| `embedded-proactive` | 异步 | ❌ fire-and-forget |
| `detectFeedback` | 异步 | ❌ fire-and-forget |

**为什么这样切分**：所有"喂给当前轮 prompt" 的数据必须同步拿到；所有"影响下一轮 / 长期状态"的工作异步跑，避免阻塞用户响应。

---

## 3. 数据模型

### 3.1 数据目录结构

```
data/
├── profile/
│   └── PROFILE.md            ← 用户画像（v0.21+ 含 ocean_* frontmatter）
├── sessions/
│   └── {sessionId}.json      ← 会话历史 + persona ref + model
├── personality/
│   └── {sessionId}.json      ← 大五人设（OCEAN + preferences）
├── memory/
│   ├── MEMORY.md             ← 记忆索引（manifest）
│   ├── emotion/{name}.md     ← 反复出现的情绪模式
│   ├── event/{name}.md       ← 生活事件
│   └── reference/{name}.md   ← 外部资源
├── timeline/
│   └── {YYYY-MM}.jsonl       ← 情绪时间线（append-only）
├── learned-prefs/
│   └── {userId}.json         ← 反馈学习观察
├── reflections/
│   └── {YYYY-MM-DD}.md       ← 每日反思
└── proactive-state.json      ← 主动关心状态
```

### 3.2 关键文件格式

> 以下示例均为**通用模板**，不含真实用户数据。

**`profile/PROFILE.md`**（含 frontmatter 自定义字段）：

```markdown
---
name: 用户画像
version: 0.7
kind: profile
ocean_openness: 0.75
ocean_conscientiousness: 0.50
ocean_extraversion: 0.45
ocean_agreeableness: 0.70
ocean_neuroticism: 0.55
ocean_basis: LLM 从历史/memory/learner 推算的依据摘要
ocean_updated_at: 2026-01-01T00:00:00Z
---

# 用户画像（Profile）

## 基本资料
- 昵称：[用户昵称]
- 职业：[职业]

## 长期情绪基线
- [情绪模式 A] → 触发：[触发场景] → 表现：[典型反应]
- [情绪模式 B] → 触发：[触发场景] → 表现：[典型反应]

## 近期变化
- [最近一周 / 一月的变化趋势]
```

**`sessions/{sessionId}.json`**：

```json
{
  "id": "s-{timestamp}-{random}",
  "title": "[会话标题，由首条用户消息生成]",
  "persona": "default",
  "personaName": "[人设名称]",
  "model": "[模型名]",
  "history": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "createdAt": 0,
  "lastActiveAt": 0
}
```

**`personality/{sessionId}.json`**：

```json
{
  "sessionId": "s-{timestamp}-{random}",
  "ocean": {
    "openness": 0.5,
    "conscientiousness": 0.5,
    "extraversion": 0.5,
    "agreeableness": 0.5,
    "neuroticism": 0.5
  },
  "preferences": "[由 /persona init 或 /persona describe 设定的角色偏好]",
  "createdAt": 0,
  "updatedAt": 0
}
```

**`memory/{type}/{name}.md`**（3 类通用模板）：

```markdown
---
name: [memory-name]
type: [emotion | event | reference]
version: 0.1
confidence: 0.5
evidence_count: 1
created_at: [ISO timestamp]
updated_at: [ISO timestamp]
---

# [memory-name]

## 描述
[一段对该记忆的抽象描述]

## 触发器
- [触发场景 1]
- [触发场景 2]

## 表现
- [典型表现 1]
- [典型表现 2]

## 应对
[建议的应对方式]
```

**`learned-prefs/{userId}.json`**：

```json
{
  "userId": "default",
  "version": 2,
  "signalCounts": { "positive": 0, "negative": 0, "neutral": 0 },
  "positivePatterns": [
    "[从 positive 反馈提取的自然语言观察 1]",
    "[从 positive 反馈提取的自然语言观察 2]"
  ],
  "negativePatterns": [
    "[从 negative 反馈提取的自然语言观察 1]",
    "[从 negative 反馈提取的自然语言观察 2]"
  ],
  "positiveExamples": [],
  "negativeExamples": [],
  "updatedAt": 0
}
```

### 3.3 数据生命周期

| 数据 | 何时写入 | 何时读取 | 持久化 |
|---|---|---|---|
| `profile/PROFILE.md` | 首次启动 / profile fire-and-forget | 每轮 runTurn | markdown + frontmatter |
| `sessions/{id}.json` | 每次对话 + 切 session | 启动时 / 切 session | JSON |
| `personality/{id}.json` | `/persona init` / `/persona describe` | 每轮 runTurn | JSON |
| `memory/*.md` | 记忆抽取触发 | 记忆召回 | markdown + frontmatter |
| `timeline/*.jsonl` | 每轮对话（同步） | `/reflect` / prompt 渲染 | append-only JSONL |
| `learned-prefs/*.json` | 每轮 feedback fire-and-forget | 每轮 runTurn | JSON |
| `reflections/*.md` | `/reflect` 命令 | 后续 prompt 注入 | markdown |

---

## 4. 模块详解

### 4.1 Provider 抽象（src/provider.ts）

**职责**：抽象 Anthropic + OpenAI 兼容协议，让上层代码不依赖具体 SDK。

**核心接口**：

```typescript
export interface ModelProvider {
  readonly model: string;
  stream(opts: StreamOptions): AsyncIterable<StreamChunk>;
  complete(opts: StreamOptions): Promise<string>;
}

export type StreamOptions = {
  model: string;
  params: {
    system: string;
    messages: ChatMessage[];
    maxTokens?: number;
    temperature?: number;
    presencePenalty?: number;
    signal?: AbortSignal;
  };
};

export type StreamChunk = {
  delta: string;
  done: boolean;
};
```

**实现**：
- `AnthropicProvider`：用 `@anthropic-ai/sdk`，支持自定义 baseURL（DeepSeek / Moonshot 等）
- `OpenAIProvider`：用 `openai` 包，支持自定义 endpoint

**关键决策**：
- 用 `AsyncIterable<StreamChunk>` 而不是 ReadableStream：让上层可以用 `for await` 简洁消费
- signal 透传：用户取消能即时中断 LLM 调用
- `complete()` 给 side-query 用：`detectEmotion` / `recallMemories` / `compact` / `summarizeForProfile` 都不需要流式

**调用统计**：每轮对话约 3-5 次 LLM 调用（详见 §5）

### 4.2 主对话循环（src/loop.ts / src/web.ts）

**两套实现**：
- `src/loop.ts` 的 `runTurn`：CLI 用，返回 LoopResult 给 REPL 控制后续
- `src/web.ts` 的 `runTurn`：Web 用，自己做 SSE 流式 + state 管理

**为什么 CLI 和 Web 各自实现**：CLI 需要返回 LoopResult 让 REPL 决定是否自动保存、自动抽取；Web 直接走 SSE + state mutation。两套共用 prompt 组装 + provider + memory/timeline 等支撑模块。

**异步架构**：所有非关键路径 LLM 调用（profile 更新 / embedded-proactive / 记忆抽取 / feedback 检测）均采用 fire-and-forget（IIFE + `.then().catch()`），主对话最后一字延迟 22ms。

### 4.3 Prompt 拼装（src/prompt.ts）

**5 层架构**：

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: memory 索引                                 │
│   MEMORY.md + 候选记忆文件清单                        │
│   作用：让 LLM 知道有哪些记忆可召回                   │
├─────────────────────────────────────────────────────┤
│ Layer 1.5: 用户画像（profile）                        │
│   6 段基本画像 + OCEAN 认知画像                       │
│   作用：让 LLM 理解"用户是什么样的人"                  │
├─────────────────────────────────────────────────────┤
│ Layer 2: 当下上下文                                   │
│   - 用户当下情绪（来自 detectEmotion）                │
│   - 召回的具体记忆（来自 recallMemories）             │
│   - 情绪时间线摘要（最近 5 条）                        │
│   作用：让 LLM 知道"这一轮要回应什么"                  │
├─────────────────────────────────────────────────────┤
│ Layer 0: 大五人设 + 反馈学习                         │
│   - session persona OCEAN（行为层）                   │
│   - personaLearner 反馈观察（认知层补充）             │
│   作用：让 LLM 知道"该怎么说话"                        │
└─────────────────────────────────────────────────────┘
```

**拼接顺序逻辑**：
- Layer 0（人设）放最后 → LLM "看到"前面的事实后，被人设引导风格
- Layer 1（记忆）+ 1.5（画像）放前面 → 长期信息先建立"理解"
- Layer 2（当下）放中间 → 在"理解"基础上"看当下"

**关键决策**：
- 不缓存 system prompt：profile / memory / timeline 每轮都在变
- timeline 异步渲染（避免阻塞）
- layer 之间用 `---` 分隔，LLM 能看清结构

### 4.4 记忆系统（src/memory.ts）

**5 类记忆**（实际 3 类 + 索引）：

| 类型 | 用途 | 证据要求 |
|---|---|---|
| `emotion` | 反复出现的情绪模式 | ≥2 条证据才保留 |
| `event` | 有情绪影响的生活事件 | 单次即可 |
| `reference` | 外部资源（医生/咨询师/联系人） | 单次即可 |

**索引**：`memory/MEMORY.md` 列出所有记忆文件名 + 一句话描述，LLM 召回时先读这个清单。

**召回机制**（`recallMemories`）：
1. LLM 读 `MEMORY.md` 索引
2. LLM 根据用户消息判断哪些记忆相关（输出 `selected: ["filename1", "filename2"]`）
3. 把这些记忆文件内容注入 Layer 2

**抽取机制**（`memory-extract.ts`）：
- 触发条件：每 5 轮兜底 / 情绪强度 ≥ 0.7 / 手动 `/memory suggest`
- 流程：把最近 N 轮对话喂给 LLM，让它输出 `emotion` / `event` / `reference` 候选
- 合并：新候选若与已有记忆相似 → merge；若新 → 创建文件

### 4.5 用户画像（src/profile.ts）

**画像架构**：用 LLM **抽象** memory + learner + timeline 数据源，得到主题级模式：

```typescript
type ProfileOcean = {
  openness: number;             // 0-1
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
  basis: string;                // 推算依据
};

type Profile = {
  sections: Record<ProfileSection, string>;
  ocean: ProfileOcean | null;   // v0.21+
  oceanUpdatedAt: number;
  path: string;
  updatedAt: number;
  initialized: boolean;
};
```

**关键函数 `summarizeForProfile`**：
- 输入：memory + learner + timeline 摘要
- 输出：抽象后的 OCEAN + 主题级模式 + 偏好 + 情绪模式 + 近期变化
- prompt 约束："必须做抽象、归并、聚类"，不允许机械列举

**两个 OCEAN 的区别**（核心澄清）：

| 维度 | session persona ocean | profile ocean |
|---|---|---|
| 位置 | `personality/{sessionId}.json` | `profile/PROFILE.md` frontmatter |
| 来源 | 用户 `/persona init` 时 LLM 翻译 | 从历史/memory/learner 推算 |
| 决定 | **怎么说话**（行为层）| **理解用户是什么人**（认知层）|
| 稳定性 | 每会话独立 | 跨会话持续更新 |

### 4.6 大五人设（src/bigfive.ts + src/persona-init.ts）

**反向翻译**：用户一句话（"温柔大姐姐"）→ LLM 输出 5 维 OCEAN + 自由文本偏好

**OCEAN 维度**：

| 维度 | 含义 | 高分特征 |
|---|---|---|
| Openness | 想象力 / 好奇心 | 喜欢新想法、跨领域联想 |
| Conscientiousness | 条理 / 自律 | 先组织再表达 |
| Extraversion | 热情 / 健谈 | 主动扩展话题 |
| Agreeableness | 信任 / 合作 | 温和、不对抗 |
| Neuroticism | 情绪敏感 / 焦虑 | 高=易焦虑 / 低=稳定 |

**注入 prompt**：`layer0_persona()` 把数值 + `oceanHint()` 行为描述 + preferences 一起拼进 system prompt。

**Skip 路径**：不填描述 → 用默认 OCEAN（全 0.5）+ 通用 preferences。

### 4.7 反馈学习（src/feedback-detector.ts + src/persona-learner.ts）

**闭环**：

```
本轮对话结束
  │
  ▼
detectFeedback(provider, prevAI, userMsg)
  │ ← LLM 把 (上一轮AI, 本轮用户) 分类成 positive/negative/neutral
  │ ← 提取自然语言观察（insights）
  ▼
applyFeedback(learner, signal, insights, example)
  │ ← 累积到 positivePatterns / negativePatterns / examples
  ▼
saveLearner(dataDir, updated)
  │
  ▼
下轮 prompt：layer0_persona 把这些观察作为"【用户过去喜欢的】"段注入
```

**关键决策**：
- 用自然语言观察，不是结构化维度（避免开发者偏见）
- positive/negative 都累积；neutral 不写
- 反馈**优先于人设**：用户明确说"不要 X"时覆盖 OCEAN

**已知边界**：
- 只看"上一轮 AI + 本轮用户"——不分析对话更深层语义
- 同一反馈可能被多次累积（去重不严格）
- LLM 分类偶尔会误判（如把吐槽当 feedback）

### 4.8 情绪时间线（src/timeline.ts）

**append-only JSONL**：每轮情绪检测结果追加到当月文件 `data/timeline/{YYYY-MM}.jsonl`。

**每条记录**：

```json
{
  "emotion": "joy",
  "intensity": 0.6,
  "trigger": "[一句话推测的情绪触发器，≤20 字]",
  "userExcerpt": "[用户原文片段，≤100 字]",
  "myResponseExcerpt": "[AI 回复片段，≤100 字]",
  "relatedMemory": "[关联的记忆文件名，可选]",
  "ts": 0,
  "date": "[ISO timestamp]"
}
```

**作用**：
- `/timeline` 命令看情绪轨迹
- `/reflect` 命令读时间线做每日反思
- 喂给 `summarizeForProfile` 推算 profile ocean

**关键决策**：
- append-only：不修改历史，保证时间线是真实记录
- 用 `myResponseExcerpt` 而不是完整回复：避免存储重复内容
- 同步写入（不 fire-and-forget）：timeline 是核心数据，必须确保不丢

### 4.9 主动关心（src/embedded-proactive.ts）

**功能**：用户 idle 超过阈值（默认 4h）时，在主回复结尾自然嵌入一句"对了，..."（引用画像里的真实内容）。

**触发条件**（`DEFAULT_EMBEDDED_PROACTIVE_CONFIG`）：
- `idleHours > 4`（用户离开超过 4h）
- `currentUserTurns >= 2`（不是首次对话）
- `maxPerDay = 2`（每天最多 2 次）
- `cooldownMin = 60`（两次之间至少 60 分钟）
- 不在 quiet hours（默认 23:00-8:00）

**TODO**：通过 `deps.onProactiveGenerated` 回调把问题缓存到 state，下轮注入 system prompt（替代直接追加 finalText）。

### 4.10 Auto Compact（src/compact.ts）

**目的**：history 超长时调 LLM 摘要，节省后续轮次的 token。

**触发**：`triggerAt = 20` 条消息 / `recentKept = 6` 条保留原样

**流程**：
1. 估算当前 history token 数（粗略按字符 / 4 估算）
2. 超阈值 → 调 LLM 摘要前面的消息，保留最近 6 条
3. 返回新 history 给 runTurn 使用

**关键决策**：
- prompt 注入 profile 摘要，让 compact 结果与长期画像一致
- REPL/web 拿到 `effectiveHistory` 后**必须替换**原 history，不能 append

### 4.11 每日反思（src/reflection.ts）

**功能**：把最近 N 天（默认 7）的 timeline + 近期记忆 + profile 喂给 LLM，生成"今日洞察"。

**触发**：手动 `/reflect [days]` 命令（未做定时自动触发，避免打扰）。

**输出**：`data/reflections/{YYYY-MM-DD}.md`

**关键决策**：
- 不自动触发：避免消耗 LLM 调用 + 反思质量参差不齐
- 反思结果**不进 prompt**（避免递归依赖 + 控制 token）

### 4.12 Session 管理（src/sessions.ts）

**CLI/Web 共享**：`data/sessions/` 是唯一来源，CLI 启动会自动加载最近一个有对话的 session。

**每条 session**：`{id, title, persona, personaName, model, history, createdAt, lastActiveAt}`

**关键决策**：
- 用 JSON 而不是 markdown：history 是结构化数据
- lazy 创建：网页版首次发消息才创建 session（避免空对话）
- persona 引用而不是内嵌：避免重复存储 OCEAN

### 4.13 Context File I/O（src/context-file.ts）

**功能**：通用 markdown + frontmatter 读写，支持自定义字段（如 `ocean_openness`）。

**为什么需要**：profile / memory / reflection 都是 markdown 文件，但需要 frontmatter 携带结构化元数据。

**关键决策**：
- v0.21 起 `context-file.ts` 接受未知 key（之前严格白名单会丢 `ocean_*`）
- frontmatter 用 YAML 解析（不自定义格式）
- 提供 `readContextFile` / `writeContextFile` / `updateContextFile` 三个 API

### 4.14 自进化层（src/evolution/）

**功能**：在主对话循环之外，独立运行的"自我优化"层。

**当前状态**：预留架构，未启用核心逻辑。

---

## 5. LLM 调用策略

### 5.1 每轮对话的调用次数

| 调用 | 类型 | 阻塞？ | 何时跑 |
|---|---|---|---|
| 主回复（stream） | 关键 | ✅ | 每轮 |
| `detectEmotion` | side-query | ✅ | 每轮 |
| `recallMemories` | side-query | ✅ | 每轮 |
| `compact` | 摘要 | ✅ | history 超长时 |
| `maybeUpdateProfile` | 摘要 | ❌ fire-and-forget | 每轮（5/轮抽象） |
| `maybeAutoExtract` | 抽取 | ❌ fire-and-forget | 每 5 轮 / 高强度 |
| `embedded-proactive` | 决策 | ❌ fire-and-forget | idle > 4h 时 |
| `detectFeedback` | 分类 | ❌ fire-and-forget | 每轮（除首轮） |

**总计**：每轮 3-5 次 LLM 调用，关键路径 3 次（主回复 + emotion + recall）。

### 5.2 优化策略

- **并行**：emotion / recall 用 `Promise.all` 并行
- **异步**：profile / extract / proactive / feedback 全 fire-and-forget
- **跳过**：turn 1 不跑 feedback（没"上一轮 AI"）
- **节流**：profile 抽象受 `oceanUpdatedAt` 控制（30 天内不重复推算）

### 5.3 成本估算

假设每轮主回复 1500 tokens in + 500 tokens out，加上 side-query 500 in + 100 out × 2：
- 每轮约 2700 tokens in + 700 tokens out
- 100 轮对话约 270k tokens in + 70k tokens out
- 以 Claude Sonnet 计价：约 $1.5 / 100 轮

---

## 6. 评测方法论

### 6.1 单元测试

- **框架**：`bun:test`
- **覆盖**：323 个测试 pass / 4 skip / 0 fail（v0.21 实测）
- **覆盖模块**：profile / memory / timeline / learner / classify / prompt / compact / sessions / feedback / persona-init / proactive

### 6.2 A/B test 框架

- **目的**：量化对比"完整 RememberMe 路径" vs "裸 API"
- **方法**：同一组用户消息，两条路径分别跑，对比输出
- **已跑过的对比**：
  - 裸 API vs 完整路径（验证 profile / memory / persona 是否真的有效）
  - embedded-proactive 开 vs 关（验证嵌入效果）

### 6.3 长对话压测

- **轮数**：20 / 100 / 500 轮
- **指标**：profile 学习率、记忆召回准确率、响应延迟、token 消耗
- **脚本**：`tests/scripts/manual/stress-20round.sh` / `long-convo-eval.ts`

### 6.4 真实反馈验证

- **不依赖 LLM 自评**：评测信号来自用户真实反馈（如"别回太长"反馈后回复长度显著下降）
- **覆盖三类子任务**：情绪识别 / 记忆召回 / 偏好学习

---

## 7. 部署与运行

### 7.1 环境要求

- Bun ≥ 1.1
- TypeScript（由 Bun 内置）
- LLM API key（Anthropic / OpenAI 兼容）

### 7.2 启动

```bash
# 安装
bun install

# 配置 API key（任选其一）
export ANTHROPIC_API_KEY=sk-ant-xxx
# 或放 settings.json（gitignored）

# 启动
bun run start        # → http://localhost:3000（Web）
bun run repl         # → CLI 模式
bun run dev          # → 开发模式（文件变更热重启）
bun test             # → 跑单元测试
```

### 7.3 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `ANTHROPIC_API_KEY` | - | Anthropic key |
| `ANTHROPIC_BASE_URL` | - | 自定义 endpoint（DeepSeek/Moonshot） |
| `ANTHROPIC_MODEL` | claude-sonnet-4-5 | 模型名 |
| `OPENAI_API_KEY` | - | OpenAI key |
| `OPENAI_BASE_URL` | - | 自定义 endpoint |
| `OPENAI_MODEL` | gpt-4o-mini | 模型名 |
| `EC_PROACTIVE` | 0 | 启用嵌入式主动关心 |
| `EC_PROACTIVE_IDLE_HOURS` | 4 | idle 阈值 |
| `EC_PROACTIVE_MAX_PER_DAY` | 2 | 每天上限 |
| `EC_PROACTIVE_QUIET_START` | 23 | 安静时段开始 |
| `EC_PROACTIVE_QUIET_END` | 8 | 安静时段结束 |
| `EC_PROACTIVE_COOLDOWN_MIN` | 60 | 最小间隔 |
| `EC_COMPACT_TRIGGER_AT` | 20 | compact 触发消息数 |
| `EC_DEBUG` | 0 | 启用 debug 日志 |

---

## 8. Q & A

### 8.1 为什么不调 tool use / function calling

**理由**：RememberMe 的核心是"上下文编排"，不是"任务执行"。让 LLM 调工具会引入 agent loop 的不确定性（什么时候调、怎么调、结果怎么处理），与"长期陪伴"的稳定性诉求冲突。

**替代方案**：把所有"动作"做成确定性代码（profile 更新 / 记忆抽取 / 主动关心），LLM 只做"理解 + 生成回复"。

### 8.2 为什么不用向量数据库

**理由**：
- 我希望这个项目保持轻量、简单、易读

### 8.3 为什么不用 YAML / JSON 配置

**理由**：profile / memory / reflection 都是**用户可读可改**的数据，不是配置。Markdown 让用户能自然编辑，frontmatter 携带结构化元数据。

### 8.4 为什么 provider 同时支持 Anthropic + OpenAI

**理由**：DeepSeek / Moonshot 等国内模型走 Anthropic 协议 + 自定义 baseURL；OpenAI 兼容端点（vLLM / Ollama）走 OpenAI 协议。一套抽象让用户能在不写代码的前提下切换底层。

### 8.5 为什么把 profile ocean 和 session ocean 分开

**理由**：防止混淆"行为层"和"认知层"。
- session persona ocean = 用户**主动选择**的 LLM 该怎么说话
- profile ocean = LLM 从历史**推算**的用户是什么样的人

混淆会导致用户 init persona 时不知道改哪个；分开后用户主动控制行为，系统观察认知。

### 8.6 为什么所有非关键 LLM 调用 fire-and-forget

**理由**：用户感知的延迟 = "最后一字到能发下一条的时间"。任何阻塞这个边界的 LLM 调用都会被用户感知为"卡"。

**实测**：最后一字延迟 22ms。
---

## 附录 A：测试运行

```bash
bun test                          # 跑全部（~143s）
bun test tests/profile.test.ts    # 跑单个模块
bun test --watch                  # watch 模式
```

## 附录 B：手动评测脚本

```
tests/scripts/
├── README.md
└── manual/
    ├── embedded-proactive-compare.sh
    ├── embedded-proactive-test.sh
    ├── feel-test.sh
    ├── quick-test.sh
    ├── run-long-convo-eval.sh
    ├── stress-20round.sh
    ├── test-script.sh
    ├── v3-10round-test.sh
    ├── v3-deep-test.sh
    ├── v3-fusion-test.sh
    ├── v4-mode-test.sh
    └── variance-test.sh
```

## 附录 C：参考

- [Anthropic Prompt Engineering Guide](https://docs.anthropic.com/claude/docs/prompt-engineering)
- [Big Five (OCEAN) 模型](https://en.wikipedia.org/wiki/Big_Five_personality_traits)
- 项目 GitHub: https://github.com/SoHardToMakeAName/RememberMe