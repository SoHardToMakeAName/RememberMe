# 人格系统（v0.21）

RememberMe 的对话风格由**两层叠加**驱动：

1. **OCEAN 大五人设**（per-session，决定 LLM 怎么说话）
2. **反馈学习器**（per-user，从用户反馈里长出来）

**注意**：本目录 `personality/` 是早期硬编码人格文件的保留位置，**当前代码不再读取本目录下任何 `.md` 文件**（历史说明见末尾）。

---

## 第 1 层：OCEAN 大五人设

每个 session 启动时可以选"一句话描述想要的角色"，由 LLM 翻译成 5 维数值 + 自由文本偏好。

**存储**：`data/personality/{sessionId}.json`

```json
{
  "sessionId": "s-example",
  "ocean": {
    "openness": 0.8,
    "conscientiousness": 0.6,
    "extraversion": 0.5,
    "agreeableness": 0.7,
    "neuroticism": 0.3
  },
  "preferences": "用具体例子而非抽象概念；说话带黑色幽默但不刻薄。",
  "createdAt": 1784769911767,
  "updatedAt": 1784769911767
}
```

**怎么生成 / 修改**：
- **网页版**：新建会话时弹 init modal，输入一句话描述（"苏格拉底"、"温柔大姐姐"）→ LLM 自动转 OCEAN
- **CLI**：`/persona init <一句话描述>` 调 LLM 生成；`/persona describe <文本>` 不调 LLM 直接改 preferences；`/persona reset` 重置为中性（OCEAN 全 0.5）

**注入 system prompt**：`src/prompt.ts` 的 `layer0_persona`，5 维数值 + 行为描述 + 自由偏好都会拼进去。

---

## 第 2 层：反馈学习器（Learner）

每次用户回复会被后台 fire-and-forget 检测，分类为 positive / negative / neutral，提取成自然语言观察，累积到 `data/learned-prefs/default.json`。

**存储**：`data/learned-prefs/{userId}.json`

**工作流程**：
- 用户说"别回太长" → LLM 分类为 negative，提取"用户偏好简短回复" → 写入 learner
- 下一轮 system prompt 在 OCEAN 段后追加"【用户过去喜欢的】（反馈学习）"段，把这些观察作为软提示

**优先级**：反馈 > 人设。用户明确说"不要 X"时，以反馈为准。

**相关模块**：`src/feedback-detector.ts`（LLM 反馈信号分类）+ `src/persona-learner.ts`（状态管理）

---

## 与"profile ocean"的关系

`data/profile/PROFILE.md` 里也有一个 OCEAN，是 **profile ocean**——LLM 从对话历史动态推算"用户是什么样的人"，是**认知层**。

**两者独立**：
- **session persona OCEAN** → 控制对话风格（怎么说话）
- **profile ocean** → 帮助 LLM 理解用户（什么样的人）

互不替代。详见 [`src/profile.ts`](../../src/profile.ts) 和 [README.md](../../README.md) 的"大五人设"节。

---

## 历史人格文件（已废弃）

如果你看到本目录下有 `active.md`、`default-sunny-bro.md` 之类的旧文件：

- **v0.18 之前**：代码从 `personality/*.md` 加载硬编码人设
- **v0.18+**：改用 OCEAN + 反馈学习，旧文件不再被读取
- **v0.21**：彻底确认本目录 `.md` 文件是历史残留，可安全删除或保留作为参考

**清理建议**：
```bash
rm personality/*.md   # 旧人设文件（README 除外）
```

---

## 相关模块

- `src/bigfive.ts` — OCEAN 类型 + 校验 + `oceanHint()` 渲染
- `src/persona-init.ts` — 用户描述 → LLM → OCEAN（init modal）
- `src/persona-learner.ts` — 反馈学习器状态管理
- `src/feedback-detector.ts` — LLM 反馈信号分类器
- `src/prompt.ts` — `layer0_persona()` 把 OCEAN + learner 拼进 system prompt
- `src/profile.ts` — profile ocean（独立于 session persona）
