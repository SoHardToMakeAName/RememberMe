# 示例人格

> **注意**：硬编码 `personality/*.md` 已废弃，相应命令也已移除。
> 本目录保留示例作为参考，演示"软引导 body"格式，可直接复制到 `data/personality/default.md`。

---

## 当前用法

当前人格由三层组成：
- **OCEAN**（per-session JSON，自动生成或手动编辑）
- **反馈学习器**（自动累积）
- **软引导 body**（`data/personality/default.md`，**这里提供的示例就是给它的**）

### 用某个示例作为软引导

```bash
# 示例 1：深夜树洞风格
cp examples/personality-tree-hole.md data/personality/default.md

# 示例 2：直给教练风格
cp examples/personality-coach.md data/personality/default.md

# 重启后所有 session 都按这个人设的"软引导"回应
bun run start
```

---

## 示例人格对比

| 文件 | 风格 | 适合 |
|---|---|---|
| [`personality-tree-hole.md`](./personality-tree-hole.md) | 深夜树洞 | 凌晨倾诉、低落期、需要陪伴不想被打扰 |
| [`personality-coach.md`](./personality-coach.md) | 直给教练 | 想要被推动、想拿到直接反馈、需要行动力 |

---

## 软引导 body 格式

```markdown
# <人格名>

- **类型**：personality-body
- **版本**：1.0.0
- **作者**：你
- **描述**：一句话说清风格

## 说话风格

- 语气基准（具体！不要写"温柔"，要写"用'嗯'、'啊'、'那个'等口语连接"）
- 节奏
- 用词偏好

## 怎么接住情绪

| 你的状态 | 我的回应 |
|---|---|
| 难过 | ... |
| 开心 | ... |

## 不能做的事

（禁止清单比鼓励清单更有效）

## 边界

什么时候引导用户找专业资源

## 价值观

3-5 句话
```

---

## 历史说明

早期版本：这些示例文件是直接复制到 `personality/active.md` 作为激活人格，通过切换命令选择。

当前：
- `personality/` 目录停止使用（文件不再被读取）
- `/personality swap` 命令移除
- 人格由反馈学习器动态学习 + 共享软引导 body + OCEAN

---

## 给特定 session 自定义 OCEAN 人设

如果想给某个 session 完全不同的 OCEAN 数值（不只是软引导）：

1. 在网页版启动该 session → 弹 init modal → 描述你想要的风格
2. 或者直接编辑 `data/personality/{sessionId}.json`

OCEAN 5 维说明：
- **openness**（开放性）：0-1，高=喜欢新想法、跨领域联想
- **conscientiousness**（尽责性）：高=先组织再表达
- **extraversion**（外向性）：高=热情、主动扩展话题
- **agreeableness**（宜人性）：高=温和、不对抗
- **neuroticism**（神经质）：**0.5 平衡**；高=易波动

详见 [`src/bigfive.ts`](../src/bigfive.ts) 和 [`TECHNICAL.md`](../TECHNICAL.md#31-srcbigfivets-v018-新增--大五人格)。