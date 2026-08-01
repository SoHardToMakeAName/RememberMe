# RememberMe — CLI 用户手册

> 一个**有人味的情感对话应用**。专为情感陪伴场景设计。
> 当前版本：大五人设 OCEAN + 反馈学习 + 网页/CLI 双入口

---

## 🎯 这是什么

RememberMe 是一个 CLI + 网页 AI 陪伴应用。和通用聊天机器人不一样，它**真的会记住你**：

- 🌊 **大五人设（OCEAN）**— 每个 session 一份人设，由你用一句话描述（"苏格拉底"、"温柔姐姐"）→ LLM 转成 5 维数值 + 自由文本偏好
- 🪄 **反馈学习器**— 对话中你给的反馈被自动识别（"别回太长"、"叫我小李"），累积成自然语言偏好，注入到下轮 system prompt
- 💬 **2 大类 + 1 小类记忆** + 独立**情绪时间线**（你说的话、心情、时间全记录）
- 👤 **用户画像**自动累积（你的称呼、风格、关注话题慢慢被你养出来）
- 🧹 **每日反思**沉淀（每天凌晨后台把零散记忆整合成长期洞察）
- 🎭 **主动承接情绪**（side-query 实时识别你的情绪状态，先承接再回应）

> **设计理念**：人格是常量（OCEAN base），情绪是变量。
> 主人格永远稳定，但你今天开心和昨天不开心，应用会识别出来。

---

## 🚀 快速开始（5 分钟）

### 1. 安装 Bun（Bun 是必须的运行时）

```bash
# macOS / Linux
curl -fsSL https://bun.sh/install | bash

# Windows (PowerShell)
irm bun.sh/install.ps1 | iex
```

要求：`bun >= 1.1`

### 2. 安装项目

```bash
git clone <repo> rememberme
cd rememberme
bun install
```

### 3. 配置 API Key

在项目根目录创建 `settings.json`（gitignored，从不被提交）：

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-your-key-here",
    "ANTHROPIC_BASE_URL": "https://api.deepseek.com/anthropic",
    "ANTHROPIC_MODEL": "deepseek-v4-flash"
  }
}
```

**或者用 OpenAI 兼容端点**：
```json
{
  "env": {
    "OPENAI_API_KEY": "sk-xxx",
    "OPENAI_BASE_URL": "https://api.openai.com/v1",
    "OPENAI_MODEL": "gpt-4o-mini"
  }
}
```

或者用环境变量：
```bash
export ANTHROPIC_API_KEY=sk-ant-xxx
```

> 💡 项目本地 `settings.json` 是标准 Anthropic SDK 格式（`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`）。如果你的环境已经设置了这些环境变量，可以直接复用，无需额外配置。

### 4. 启动

**网页版（默认）**：
```bash
bun run start
```
打开 http://localhost:3000 即可。

**CLI 模式**：
```bash
bun run repl
```

启动后你会看到：
```
🌅 RememberMe

✓ 大五人设（OCEAN）：默认中性（全 0.5）
✓ 反馈学习：冷启动（空白起点）
✓ 模型：anthropic / deepseek-v4-flash
  baseURL: https://api.deepseek.com/anthropic

✓ 情绪时间线已就绪
✓ 用户画像已初始化（首次使用，已创建默认模板）
✓ compact 配置：triggerAt=20 / recentKept=6

提示：直接输入消息开始对话。输入 /help 查看命令。Ctrl+C 退出。
```

直接输入消息开始对话。CLI 默认用中性 OCEAN（全 0.5），不需要 init 弹窗；网页版首次新会话会弹 init modal 让你描述人设。

---

## 🎮 命令速查

| 命令 | 作用 |
|---|---|
| 直接输入 | 开始对话 |
| `/help` | 完整帮助 |
| `/quit` | 退出（Ctrl+C 也行） |

### 记忆管理

| 命令 | 作用 |
|---|---|
| `/memory list` | 列出所有记忆（按 emotion/event/reference 分组） |
| `/memory types` | 看 2 大类 + 1 小类 |
| `/memory read <filename>` | 读某条记忆的详细内容 |
| `/memory save <type> <name> <description>` | 手动保存（type ∈ emotion/event/reference） |
| `/memory auto on\|off\|status` | 自动抽取开关（默认开） |
| `/memory suggest` | 手动触发一次抽取 |

### 用户画像

| 命令 | 作用 |
|---|---|
| `/profile` | 看用户画像（6 段：基本信息/沟通风格/关注议题/偏好禁忌/情绪基线/近期变化） |
| `/profile path` | 查看画像文件路径 |
| `/profile scan` | 立即从当前会话扫描偏好 |
| `/profile reset` | 重置到默认模板 |

### 情绪

| 命令 | 作用 |
|---|---|
| `/timeline` | 最近情绪轨迹 |
| `/timeline stats` | 情绪分布统计 |

### 人设学习器

| 命令 | 作用 |
|---|---|
| `/learner` | 看人设学习器状态（累积的反馈 + 自然语言偏好） |
| `/learner reset` | 重置学习器（清空反馈） |

### 反思

| 命令 | 作用 |
|---|---|
| `/reflect` | 立即生成今日洞察（默认回看 7 天） |
| `/reflect <days>` | 用指定回看天数生成 |
| `/reflections list` | 列出历史反思 |
| `/reflections read <YYYY-MM-DD>` | 读某条反思 |

### 主动对话

| 命令 | 作用 |
|---|---|
| `/proactive status` | 看今日已发次数、上次用户活动 |
| `/proactive trigger` | 手动触发一次主动消息 |
| `/proactive reset` | 重置状态 |

### 会话（CLI 与网页版共享 `data/sessions/`）

| 命令 | 作用 |
|---|---|
| `/session list` | 列出所有 session（按最近活跃倒序） |
| `/session current` | 显示当前 session 详情（id + 标题 + 历史条数 + 关联人设） |
| `/session new [描述]` | 新建 session（可选立刻 init 人设；首条消息自动创建） |
| `/session switch <id>` | 切换到指定 session（保存当前 → 加载目标 → 重载人设） |
| `/session save` | 手动保存当前 session（退出时也会自动保存） |
| `/session delete <id>` | 删除指定 session + 关联人设（不能删当前） |
| `/stats` | 会话统计 + compact 建议 + 记忆数 |
| `/compact` | 手动压缩历史 |
| `/quiet` | 切换 [情绪:...] 调试标签 |
| `/clear` | 清空会话历史 |

### 大五人设（OCEAN）

| 命令 | 作用 |
|---|---|
| `/persona show` | 显示当前 OCEAN 5 维 + oceanHint 行为描述 + preferences |
| `/persona init <一句话描述>` | 调 LLM 把描述翻译成 OCEAN JSON，写入 `data/personality/{sessionId}.json` |
| `/persona describe <文本>` | 不调 LLM，直接修改 preferences 字段 |
| `/persona reset` | 删人设文件，回到默认中性（OCEAN 全 0.5） |

### CLI 与网页版互通

`data/sessions/` 是两个入口共用的存储：
- 在 web 聊了一段 → 启动 CLI → CLI 自动加载最近一个有对话的 session（banner 显示「标题」和"已加载 N 条历史对话"）
- 在 CLI 聊了一段 → 关掉 web → 重启 web → web 也加载同一段
- 切换会话：在 CLI 用 `/session switch <id>`，在 web 用左侧 sidebar

如果两个端同时跑，**写入是 last-write-wins**（文件系统无锁）。建议一次只开一个端。

---

## 🌊 人设系统（OCEAN）

人格由两部分组成：

| 部分 | 来源 | 何时生效 |
|---|---|---|
| **OCEAN 5 维数值 + preferences** | 用户主动 init（CLI `/persona init`，web 弹窗）| 写入 `data/personality/{sessionId}.json`，永久绑定到该 session |
| **反馈学习观察** | 用户每次给的反馈（"别回太长"、"叫我小李"）| 自动累积到 `data/learned-prefs/default.json`，下次 system prompt 注入 |

### 启动时的加载行为

- **CLI 启动**：`listSessions()` 找最近一个有真实对话的 session → 自动加载，banner 显示「标题」和已加载条数
- **网页版启动**：加载最近一个 session；首次发消息才创建新 session

### OCEAN 5 维

每个 session 在 init 时会调 LLM 把你的描述（如"像苏格拉底那样的智者"）翻译成：

- 5 维数值（Openness / Conscientiousness / Extraversion / Agreeableness / Neuroticism），每维 0-1
- `preferences` 自由文本（行为倾向描述，如"用具体例子而非抽象概念"）
- 保存到 `data/personality/{sessionId}.json`

后续该 session 所有对话都用这个人设。**跳过 init**（web 关掉弹窗 / CLI 不调 init）→ 用默认中性 OCEAN（全 0.5）。

### OCEAN 影响表述而非内容

OCEAN 翻译（`oceanHint`）让模型知道"这种性格的人会怎么表达"，比如 `openness=0.85` 会让回复带更多跨领域联想。但 OCEAN **不规定**回复长度、风格、是否用 emoji —— 这些应该从用户的反馈循环中自然长出来。

### 反馈学习器

每轮对话后（你发了新消息），系统自动：
1. 拿"上一轮 AI 回复" + "你这轮的消息"调用 LLM
2. 分类为正 / 负 / 中性信号
3. 提取自然语言描述的偏好（不再限于固定维度）
4. 累加到 `data/learned-prefs/default.json`

下一轮 system prompt 会带上这些观察作为软提示。模型在 OCEAN 基础上叠加学习到的偏好。

**示例**：你连续 3 次对长回复表示"别回太长" → 系统记下"用户偏好短回复（≤ 1-3 句）" → 下轮回复变短。

### 重置偏好

```bash
bun run repl
/learner reset   # 清空所有反馈计数和偏好
```

或者直接删除 `data/learned-prefs/default.json`。

### 重置 OCEAN 人设

直接删 `data/personality/{sessionId}.json` 即可，下次该 session 启动会触发 init。

---

## 📁 数据存在哪里

所有对话产生的文件都在 `data/` 目录，**完全可读**：

```
data/
├── profile/PROFILE.md                    # 用户画像（6 段，自动更新）
├── memory/
│   ├── MEMORY.md                         # 记忆索引
│   ├── emotion/*.md                      # 情绪模式（≥2 证据）
│   ├── event/*.md                        # 生活事件（情感意义）
│   └── reference/*.md                    # 外部资源
├── timeline/emotional_timeline.jsonl     # 情绪时间线
├── reflections/YYYY-MM-DD.md             # 每日反思
├── sessions/*.json                       # 每个 session 的对话 + 标题
├── personality/
│   ├── default.md                        # 共享软引导 body
│   └── {sessionId}.json                  # 每 session 的 OCEAN 人设
└── learned-prefs/default.json            # 累积的反馈偏好
```

### 直接编辑

你可以用任何编辑器直接修改这些文件。比如：

- 想删一条记忆：删除 `data/memory/emotion/xxx.md` + 在 `MEMORY.md` 删对应行
- 想改画像：直接编辑 `data/profile/PROFILE.md`
- 想清空所有：删除整个 `data/` 目录

### 备份 / 迁移

整个 `data/` 目录就是你的"灵魂"。把它打包带走：
```bash
tar czf my-companion-backup.tar.gz data/
```

---

## 💡 使用建议

### 怎么聊得更好

1. **第一次对话** 像和陌生人自我介绍：
   > "我叫 XX，平时做 XX 工作，最近在 XX"

2. **随时纠正** 应用：
   > "你别用感叹号"
   > "叫我小王就行"
   > "这种事不用每次问"

   这些会被反馈学习器自动捕获，下次不会再犯。

3. **话题自由切换** —— 不用刻意收尾。让情绪自然流动：
   > 今天累吗 → 算了不聊这个 → 你晚饭吃了吗

4. **长期情绪变化** —— 反思 agent 会自动识别：
   > 连续一周说"睡不好" → 反思 agent 会写一条 emotion 记忆

5. **网页版首次**：花 10 秒描述你想要的人设（"苏格拉底"、"直给损友"、"温柔姐姐"），后续该 session 风格都基于这个人设。

### 何时该 `/reflect`

不用操心。重启应用时会自动提示：
> 上次反思是 3 天前，要不要现在跑一次？

也可以手动触发：
```
/reflect
/reflect 14   # 自定义回看 14 天
```

### 何时该清数据

- 想要完全"重新开始" → `/clear`（仅清会话历史）或删 `data/`
- 想换个 OCEAN 人设 → 删 `data/personality/{sessionId}.json`
- 想清反馈偏好 → `/learner reset`
- 隐私考虑 → 删 `data/`（应用会重建）

---

## 🛠️ 高级配置

### 调整 compact 行为

环境变量（启动时设置）：

| 变量 | 默认值 | 含义 |
|---|---|---|
| `EC_COMPACT_TRIGGER_AT` | 20 | 多少条消息触发压缩 |
| `EC_COMPACT_RECENT_KEPT` | 6 | 压缩时保留最近多少条 |
| `EC_COMPACT_MAX_CHARS` | 20000 | token 触发的字符数上限 |

示例：
```bash
EC_COMPACT_TRIGGER_AT=10 bun run start
```

### 调整主动对话

| 变量 | 默认值 | 含义 |
|---|---|---|
| `EC_PROACTIVE` | 0（关） | 设 1 开启"对了"嵌入机制 |
| `EC_PROACTIVE_IDLE_HOURS` | 4 | 静默阈值（小时） |
| `EC_PROACTIVE_MAX_PER_DAY` | 2 | 每日主动消息上限 |
| `EC_PROACTIVE_QUIET_START` | 23 | 安静时段开始 |
| `EC_PROACTIVE_QUIET_END` | 8 | 安静时段结束 |
| `EC_PROACTIVE_COOLDOWN_MIN` | 60 | 两次主动消息最小间隔（分钟） |

### 调整调试标签

| 变量 | 默认值 | 含义 |
|---|---|---|
| `EC_QUIET` | 0（关） | 设 1 显示 `[情绪:...]` `[召回记忆:...]` 调试标签 |

CLI 里 `/quiet` 命令也切换。

### 用不同模型

任何 OpenAI 兼容端点都能用。修改 `settings.json`：

```json
{
  "env": {
    "OPENAI_API_KEY": "sk-xxx",
    "OPENAI_BASE_URL": "https://your-api.com/v1",
    "OPENAI_MODEL": "your-model-name"
  }
}
```

或者编程方式（在 `src/index.ts` 或 `src/web.ts` 里改 `createProvider()` 调用）。

### 备份 / 多用户

当前版本没有用户隔离，所有对话混在 `data/` 里。简单粗暴的多用户做法：

```bash
# 用户 A
mv data data-backup-A
bun run start

# 用户 B
# ... 用完后 ...

# 切回 A
rm -rf data
mv data-backup-A data
```

未来 v1.0 会加 `data/users/{userId}/` 目录结构。

---

## ❓ 常见问题

### Q: 启动时报 "未设置 API key"
A: 检查 `settings.json` 是否在项目根目录，格式是否正确；或检查 `process.env.ANTHROPIC_API_KEY`。

### Q: 网页版首次启动弹 init modal，不填可以吗？
A: 可以。关掉 modal → 用默认中性 OCEAN（全 0.5）。后续想加描述，删 `data/personality/{sessionId}.json` 再开新会话即可。

### Q: CLI 没有 init 弹窗？
A: 是的。CLI 默认用中性 OCEAN；要自定义只能改 `data/personality/repl.json`（REPL 固定 sessionId = "repl"）。

### Q: 反馈学习器会越学越偏吗？
A: 不会。它只是把累积的偏好注入到 system prompt 作为"软提示"，OCEAN 基础设定 + LLM 自己的判断会平衡。如果发现偏了，`/learner reset`。

### Q: 记忆太多 / 太乱
A: 1) `/memory list` 看都有什么 2) 直接编辑 `data/memory/` 删掉不想要的 3) 等反思 agent 自动整理。

### Q: 模型回答得不像我描述的人设
A: 1) 检查 `data/personality/{sessionId}.json` 的 OCEAN 数值是否符合预期 2) 编辑 `data/personality/default.md` 加更具体的"不能做的事"清单 3) 检查反馈学习器累积的偏好是否冲突。

### Q: 可以导出我的对话历史吗
A: `data/timeline/emotional_timeline.jsonl` 是情绪记录。完整对话历史在 `data/sessions/*.json`。v1.0 会加导出/导入 UI。

### Q: 怎么升级到最新版本？
A: 拉取最新代码 → `bun install` → 启动。`data/` 目录会被自动识别（除非 schema 不兼容，详见 CHANGELOG）。

---

## 🆘 调试

如果应用出问题：

1. **查看 prompt 实际内容**：`EC_QUIET=1 bun run repl`，每轮回复底部会打印 `[情绪: ...]` `[召回记忆: ...]` 等调试信息
2. **查看数据文件**：`data/` 目录都是明文 .md / .json / .jsonl
3. **运行测试**：`bun test ./tests/` — 20 个测试文件应该全部通过
4. **查看反思日志**：`data/reflections/*.md` 记录了反思 agent 的所有输出

---

## 📚 进阶阅读

- [README.md](README.md) — 用户视角的功能介绍
- [TECHNICAL.md](TECHNICAL.md) — 技术文档（架构、模块、数据流、API）
- [examples/README.md](examples/README.md) — 示例人格 body（共享）
- [GitHub Issues](https://github.com/...) — 反馈问题

---

## 🤝 反馈

如果发现 bug 或有想法：
1. 直接编辑 `data/` 调试
2. 看 `tests/*.test.ts` 找灵感
3. 提 issue

---

**Happy chatting. 别忘了让 ta 记住你最想被记住的事。** 💬