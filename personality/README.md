# 人格系统（ OCEAN）

> **重要**： 起，**硬编码 personality 目录已废弃**。
> 本目录保留 README 是为了说明历史演进。
> 当前人格系统由三层叠加：**OCEAN（per-session JSON）** + **反馈学习器** + **共享软引导 body**。

---

## 当前人格架构

```
┌─────────────────────────────────────────────────┐
│ 第 1 层：OCEAN（大五人设，per-session JSON）      │
│   data/personality/{sessionId}.json              │
│   - 5 维数值（Openness/Conscientiousness/        │
│     Extraversion/Agreeableness/Neuroticism）     │
│   - preferences 自由文本                         │
│   - 由用户一句话描述 → LLM 生成                  │
├─────────────────────────────────────────────────┤
│ 第 2 层：反馈学习器（，动态叠加）           │
│   data/learned-prefs/default.json                │
│   - 自然语言描述的偏好（ 开放版）           │
│   - 每轮自动累积                                 │
├─────────────────────────────────────────────────┤
│ 第 3 层：软引导 body（，共享）              │
│   data/personality/default.md                    │
│   - 全局可编辑的"行为引导"文本                    │
│   - 类似以前 personality/*.md 的角色说明          │
└─────────────────────────────────────────────────┘
```

---

## 人格怎么切换？

**答：不需要切换，每个 session 独立 OCEAN**。

- 新会话 → 网页版弹 init modal / CLI 用默认中性 OCEAN
- 想给特定 session 改人设 → 编辑 `data/personality/{sessionId}.json`
- 想改全局软引导 → 编辑 `data/personality/default.md`

---


---

## 历史人格文件（已废弃）

如果你有旧版创建的 `personality/active.md`、`personality/default-sunny-bro.md` 等：

** 已从代码中移除对 `personality/*.md` 的加载逻辑**。
这些文件现在不会被读取，可以安全删除，或作为历史参考保留。

---

## 如何给所有 session 提供统一的"角色感"？

> ⚠️ **预留功能，尚未实现。** 模板可参考，但当前没有任何代码会读取
> `data/personality/default.md` 或调用 `loadPersonaBody`。
> 当前系统人设由 **OCEAN** + **反馈学习器** 共同驱动，详见上方架构图。

预留的 `data/personality/default.md` 模板：

```markdown
# 软引导

- **类型**：personality-body
- **版本**：1.0.0

## 说话风格

- 用口语化连接词（嗯、啊、那个）
- 不用 emoji
- 单条回复 ≤ 3 句

## 不能做的事

- 不教训人
- 不强行正能量
- 不复述对方的话

## 边界

- 涉及专业医疗 / 法律建议时，引导找专业人士
```

---

## 如何给某个特定 session 设定人设？

直接编辑 `data/personality/{sessionId}.json`：

```json
{
  "sessionId": "s-example-replace-with-real-id",
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

或者在网页版 init modal 里描述（"像苏格拉底那样的智者"），由 LLM 自动转成 OCEAN。

---

## 相关模块

- `src/bigfive.ts` — OCEAN 类型 + 读写 + `oceanHint()` 渲染
- `src/persona-init.ts` — 用户描述 → LLM → OCEAN
- `src/persona-learner.ts` — 反馈学习器
- `src/feedback-detector.ts` — LLM 反馈信号分类器