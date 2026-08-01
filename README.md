# EmoTalk

[English](README.en.md) | [中文](README.md)

> 有人味的情感陪伴对话应用。

---

## 这是什么

**一个让人愿意说下去的聊天 app**。

不追求"完成任务"，目标是"接住你"。它会记住你说过的话、你的情绪模式、你在经历什么，在合适的时刻用合适的语气回应。

- **长期记忆你**（不用每次重新自我介绍）
- **主动关心你**（你不在线时也想着你）
- **按你的方式说话**（人设可自定义，行为偏好从反馈学习）

提供 **网页界面**（默认）和 **CLI 界面**。
*目前网页界面还不是很完善*

*本项目由vibe coding生成*

---

## 🧠 它的特点

> 严格说 EmoTalk 是一个**上下文编排器** —— 把你的画像、记忆、情绪模式、对话历史整合成更适合当前这一刻的 system prompt，让同一个 LLM 在你这里表现得比在通用聊天窗口里更懂你。

### 真的记得你

- 你的画像、记忆、情绪模式都作为**本地 markdown 文件**存放在 `data/` 下，每一条都能用文本编辑器打开修改
- 半年后回来重开，它还记得上次聊到一半的话题
- 跨会话、跨端（CLI ↔ Web）、跨模型（Claude / DeepSeek / GPT-4）都共享同一份记忆

### 偏好从你的反馈里自然长出来

- 你说过什么、喜欢什么、讨厌什么——这些观察记录会进入下一轮对话的 system prompt
- 不预定义"长度/语气/深度/格式"这种固定维度，完全由你的实际反馈决定

### 情绪模式被识别和命名

- 反复出现的情绪反应作为独立的 `emotion` 类型记忆存储（带 ≥2 条证据才会被保留）
- 不只是"今天心情不好"，而是带名字的情绪模式，下次再聊到时它会想起细节

### 关于隐私：清楚两个边界

- ✅ **本地数据**：你的画像、记忆、反思、反馈学习记录都只在 `data/` 目录下，`.gitignore` 已经覆盖，EmoTalk 不主动上传到任何 EmoTalk 控制的服务器
- ⚠️ **LLM 调用**：要工作就必须把对话内容发到你配置的 LLM provider（Anthropic / DeepSeek / OpenAI 等）。EmoTalk 本身不存储这些对话之外的位置，但**你信任你的 LLM provider 这一点是前提** —— 这是所有基于 LLM 的应用都共有的限制

---

## 核心特性

### 🧠 多层记忆
不只是"你说过什么"，还区分"反复出现的情绪模式"和"影响你的生活事件"和"外部资源"。
- `emotion` — 反复出现的情绪模式（需要 ≥2 次印证）
- `event` — 有情绪影响的生活事件
- `reference` — 外部资源（医生/咨询师/联系人）

### 👤 用户画像
自动累积 6 个维度的长期信息：基本资料、沟通风格、关注话题、偏好禁忌、情绪基线、近期变化。

### 🪞 每日反思
后台进程读你的情绪时间线、近期记忆、画像，归纳成"今日洞察"——越用越懂你。

### 💡 主动关心
当你 idle 超过阈值时，会在主回复结尾自然嵌入一句"对了，..."（引用画像里的真实内容），不打扰。

### 🌊 大五人设（OCEAN）
不再有预定义人格。新会话启动时，你说一句话（如"苏格拉底"、"温柔大姐姐"、"嘴毒心善的朋友"），LLM 翻译成 5 维数值（开放性 / 尽责性 / 外向性 / 宜人性 / 神经质）+ 一段自由文本偏好。**每个会话独立**，存到 `data/personality/{sessionId}.json`。

### 🪄 自动学习你的偏好
你回复里给的反馈（"别回太长""别用 emoji""叫我小李"）会被自动分类为正面/负面/中性，提取成自然语言观察，累积到 `data/learned-prefs/default.json`。下一轮 system prompt 会带上这些观察作为软提示（不是硬规则）。

### 💬 按 session 管理对话
每个会话持久化到 `data/sessions/`，含人设 + 历史 + 标题。点左侧列表切换。

### 📝 纯 Markdown 配置
画像、记忆、反思都是 `.md` 文件。**没有 YAML，没有 JSON 配置**（除了运行时数据）。

### 🌐 网页界面（默认）
默认启动 Bun.serve() HTTP 服务器。打开 `http://localhost:3000` 即可。SSE 流式 + 实时状态栏。

---

## 快速开始

```bash
# 1. 安装依赖（需要 bun ≥ 1.1）
bun install

# 2. 配置 API key（任选一个，推荐 Anthropic）
export ANTHROPIC_API_KEY=sk-ant-xxx
# 或（OpenAI 兼容端点：DeepSeek/Moonshot/自建）
export OPENAI_API_KEY=sk-xxx

# 3. 启动（默认网页版）
bun run start            # → http://localhost:3000
bun run repl             # → CLI 模式
```

也可以把 API key 放进 `settings.json`（Anthropic SDK 格式）：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-flash"
  }
}
```

首次启动会自动创建 `data/profile/PROFILE.md` 和 `data/sessions/`。直接开始对话即可。

---

## 怎么用

### 网页版（默认）

访问 `http://localhost:3000`：
- 左侧 sidebar：会话列表（+ 新对话按钮）、人设初始化入口、模型输入框、清空/导出按钮
- 右侧主区：聊天消息流 + 输入框
- Enter 发送，Shift+Enter 换行
- 状态栏实时显示：`思考中… (N 字, Ns)` → `就绪 (N s)`
- **新会话 + 人设初始化**：点 "+ 新对话" → 弹窗 → 简单描述你想要的人格（"苏格拉底"）→ LLM 翻译成 OCEAN 数值 + 自由文本偏好 → 保存到 `data/personality/{sessionId}.json`
- **切换会话**：点左侧列表里的某条 → 立刻载入那条历史
- **切换模型**：模型输入框填入新模型名 → 点"应用"

> 新会话启动时通过一句话描述生成 OCEAN 人设；不描述就用默认中性人设（OCEAN 全 0.5）。

### CLI 模式

```bash
bun run repl
```

#### REPL 命令

| 命令 | 作用 |
|---|---|
| 直接输入 | 开始对话 |
| `/persona show` | 显示当前 OCEAN 人设 + preferences |
| `/persona init <一句话描述>` | 用 LLM 生成 OCEAN，写入当前 session（首次启动会提示） |
| `/persona describe <文本>` | 不调 LLM，直接修改 preferences |
| `/persona reset` | 重置人设为默认中性（OCEAN 全 0.5） |
| `/session list` | 列出所有 session（按最近活跃倒序） |
| `/session current` | 显示当前 session 详情（id + 标题 + 历史条数 + 人设） |
| `/session new [描述]` | 新建 session（可选立刻 init 人设；CLI 与 web 共享同一份会话数据） |
| `/session switch <id>` | 切换到指定 session（保存当前 → 加载目标 → 重载人设） |
| `/session save` | 手动保存当前 session（退出时也会自动保存） |
| `/session delete <id>` | 删除指定 session + 关联人设（不能删当前） |
| `/memory list` / `read <name>` / `types` / `save <type> <name> <desc>` | 记忆管理（2 主类 + 1 辅类） |
| `/memory auto <on\|off\|status>` | 自动抽取开关（默认开） |
| `/memory suggest` | 手动触发抽取 |
| `/timeline` / `/timeline stats` | 情绪轨迹 / 统计 |
| `/profile` / `/profile path` / `/profile scan` / `/profile reset` | 用户画像管理 |
| `/learner` / `/learner reset` | 人设学习器状态 |
| `/reflect [days]` | 手动触发反思（默认：看最近 7 天） |
| `/reflections list` / `read <date>` | 浏览反思历史 |
| `/proactive status\|trigger\|reset` | 主动关心状态 |
| `/stats` | 会话统计（含 compact 建议） |
| `/compact` | 手动 compact 历史 |
| `/quiet` | 切换 `[emotion: ...]` 调试标签 |
| `/clear` | 清空当前会话历史 |
| `/help` | 完整帮助 |
| `/quit` | 退出（自动保存当前 session） |

### CLI 与网页端共享会话

`data/sessions/` 是 CLI 和网页版共用的存储目录：
- 在 web 聊了一段 → 启动 CLI → CLI 自动加载最近一个有对话的 session
- 在 CLI 聊了一段 → 关掉 web → 重启 web → web 也加载同一段
- 切换会话用 `/session switch <id>`（CLI）或左侧 sidebar（web）

### 主动关心

网页版和 CLI 都会在用户 idle 超过阈值时（默认 4 小时），在主回复结尾自然嵌入一句"对了，..."。

```bash
export EC_PROACTIVE=1                  # 启用嵌入式主动关心（默认关）
export EC_PROACTIVE_IDLE_HOURS=4       # idle 阈值
export EC_PROACTIVE_MAX_PER_DAY=2      # 每天上限
export EC_PROACTIVE_QUIET_START=23     # 安静时段开始（24h）
export EC_PROACTIVE_QUIET_END=8        # 安静时段结束
export EC_PROACTIVE_COOLDOWN_MIN=60    # 主动关心最小间隔
```

---

## 人设怎么工作（OCEAN）

### Big Five（OCEAN）

学术界公认的 5 维人格模型（每维 0-1）：

| 维度 | 含义 | 高分特征 |
|---|---|---|
| **Openness（开放性）** | 想象力、好奇心、抽象思维 | 喜欢新想法、跨领域联想 |
| **Conscientiousness（尽责性）** | 条理、自律、可靠 | 先组织再表达 |
| **Extraversion（外向性）** | 热情、健谈、活力 | 主动扩展话题 |
| **Agreeableness（宜人性）** | 信任、合作、利他 | 温和、不对抗 |
| **Neuroticism（神经质）** | 情绪敏感、焦虑 | 高=易焦虑 / 低=稳定 |

### 怎么运作

1. **新建会话时**：弹窗"简单描述你想要的人格"（1 句话即可）
2. **LLM 翻译**：把你说的描述转成 5 维数值 + 自由文本偏好
3. **保存**：写入 `data/personality/{sessionId}.json`
4. **之后稳定不变**：这个文件是会话的"人设真相来源"
5. **每次 system prompt 注入**：把数值 + 行为描述 + 自由偏好告诉 LLM

### Skip 怎么办

不填描述直接关掉弹窗 → 用默认 OCEAN（全 0.5）+ 通用 preferences 继续对话。可以之后用 `/learner reset` 重置。

### 反馈叠加

每次用户消息后，背景跑反馈检测器（fire-and-forget）：
- 正面反馈（"对，就是这个"）→ `positivePatterns` 累积
- 负面反馈（"太啰嗦"）→ `negativePatterns` 累积
- 中性（新话题）→ 不写

这些观察**不写回人设 JSON**，而是累积在 `data/learned-prefs/{userId}.json`。下一轮 system prompt 合并人设 + 反馈观察：

```
【大五人格】
- Openness: 0.85（高开放性：喜欢新想法、跨领域联想）
- ...

【用户过去喜欢的】（反馈学习）
- 用户喜欢举具体例子
- 用户喜欢引用典故

【核心原则】人设 + 反馈都是参考，不是束缚。灵活调整。
```

**反馈优先于人设**：用户说"不要 X"时，以反馈为准。

---

## 目录结构

```
emotalk/
├── README.md / README.en.md           ← 用户文档
├── TECHNICAL.md                        ← 开发者文档（架构、API、模块）
├── USER_MANUAL.md                      ← CLI 用户手册
├── STRESS_REPORT.md                    ← 压力测试报告
├── package.json                        ← scripts: start, dev, repl, web, test
├── data/                               ← 运行时数据（gitignored）
│   ├── sessions/                       ← 会话历史
│   ├── learned-prefs/                  ← 反馈学习数据
│   ├── memory/                         ← 记忆文件
│   ├── timeline/                       ← 情绪时间线
│   ├── profile/                        ← 用户画像
│   └── personality/                    ← OCEAN 人设（per-session）
├── web/                                ← 网页前端
│   ├── index.html
│   ├── style.css
│   └── app.js                          ← SSE 流式消费
├── src/                                ← 核心代码
│   ├── index.ts                        ← REPL 入口
│   ├── web.ts                          ← 网页后端 (Bun.serve + SSE)
│   ├── provider.ts                     ← LLM provider 抽象（Anthropic + OpenAI 兼容）
│   ├── profile.ts                      ← 用户画像
│   ├── memory.ts                       ← 5 类记忆
│   ├── timeline.ts                     ← 情绪时间线
│   ├── reflection.ts                   ← 每日反思
│   ├── prompt.ts                       ← 5 层 system prompt 组装
│   ├── compact.ts                      ← auto-compact
│   ├── sessions.ts                     ← 会话管理
│   ├── feedback-detector.ts            ← 反馈分类器
│   ├── persona-learner.ts              ← 动态人设学习器
│   ├── bigfive.ts                      ← OCEAN 数据模型
│   ├── persona-init.ts                 ← 人设初始化（描述 → OCEAN）
│   ├── classify.ts                     ← 情绪识别 + 记忆召回（side-query）
│   ├── embedded-proactive.ts           ← 主动关心
│   ├── evolution/                      ← 自进化层（curator / lifecycle）
│   └── loop.ts                         ← runTurn 核心
├── examples/                           ← 使用示例
├── tests/                              ← 测试
│   ├── *.test.ts                       ← 单元测试
│   ├── e2e.test.ts                     ← E2E 测试
│   └── web-sessions.test.ts            ← Web API 测试
└── personality/                        ← 性格 markdown 文档
```

---

## 🔒 隐私

EmoTalk 自身**不上传**任何用户数据。所有运行时产物都在 `data/` 目录里，且 `data/` 在 `.gitignore` 里——**永远不会进 git 仓库**：

```
.gitignore 忽略的运行时数据：
├── data/profile/PROFILE.md          ← 你的画像（profile.example.md 模板才入仓）
├── data/personality/*.json          ← 你的 OCEAN 人设
├── data/sessions/*.json            ← 对话历史
├── data/memory/MEMORY.md + emotion/*.md + event/*.md + reference/*.md  ← 记忆
├── data/timeline/*.jsonl            ← 情绪时间线
├── data/reflections/*.md            ← 反思
├── data/learned-prefs/*.json        ← 反馈学习观察
├── data/proactive-state.json        ← 主动关心状态
└── settings.json                    ← API key（用 .example 占位入仓）
```

**本地数据：可以放心**
- 在 issue / PR / 截图里贴 PROFILE.md 内容（不会被自动收集）
- 把仓库 push 到公开 GitHub（不会泄露任何对话数据）
- 在简历里列这个项目（评审者只能看到代码和文档）

**但有一点要清楚：LLM 调用边界**
- EmoTalk 要工作必须把对话内容发到你配置的 LLM provider（Anthropic / DeepSeek / OpenAI 等）
- EmoTalk 本身不存储这些对话之外的副本，但**你信任你的 LLM provider 是前提**——这是所有基于 LLM 的应用都共有的限制
- 选 self-hosted / 本地模型（如 Ollama）可以完全规避这个外部依赖

---

## 🛠 技术栈

| 层 | 选型 | 理由 |
|---|---|---|
| 运行时 | **Bun 1.1+** | 内置 TypeScript / 测试 / HTTP 服务器，零构建步骤 |
| LLM | **Anthropic SDK**（兼容 OpenAI/DeepSeek/Moonshot）| 通过 baseURL 切换，自定义端点保留 Anthropic 协议 |
| HTTP | **Bun.serve** | 内置 SSE 流式支持，零额外依赖 |
| 前端 | 纯 HTML / CSS / Vanilla JS | 不引入 React/Vue，3 个文件搞定，便于阅读修改 |
| 存储 | **纯 Markdown + JSON** | 用户数据可读、可手改、可 git diff |
| 测试 | **bun:test** | 318 个测试，运行时跑，约 100s |
| 大五人格 | 5 维 0-1 数值 + 自由文本偏好 | 学术标准 + LLM 翻译 + 每会话独立存储 |
| 反馈学习 | LLM 自然语言观察 + 正/负例示例 | 不预定义枚举，开放维度 |

---

## License

Apache License 2.0. 见 [LICENSE](./LICENSE)。
