// src/mcp/instructions.ts
//
// MCP server 的 instructions —— 通过 initialize 响应送给客户端，
// 客户端会把它加进宿主模型的 system prompt。
//
// ⚠️ 只有一套。因为 MCP 在 2026-07-28 规范修订（SEP-2577）里废弃了 sampling，
//    官方推荐的迁移方向是「server 自己调 LLM provider API」——
//    所以「谁决定记什么」这件事完全由 server 负责，宿主只需要说「这轮值得记」。
//
// 这份文本的措辞直接决定宿主会不会在合适的时机调用 record_turn，
// 措辞要点来自 experiments/mcp-probe 的实测结论：
//   - 条件式触发（"当…时调用"）可靠
//   - "每轮都调" 不可靠 —— 模型漏调时意识不到自己漏了

export const INSTRUCTIONS = `你连接着 RememberMe —— 一个长期记忆系统。它保存用户的长期记忆、用户画像和情绪时间线。

## 何时记录（record_turn）

只有下面几种情况才调 record_turn，其余一律不调：

① **用户明确要求记住**：用户说「记住 / 记一下 / 别忘了」→ 调 record_turn，definite=true。

② **出现重大生活事件**：亲人去世、拿到 offer、和重要的人吵架、重大健康问题等，对用户有情感意义的事。
   → 调 record_turn，definite=true。
   不写：日常活动（吃了什么、开了什么会）、纯工作事务。

③ **又一次出现同类情绪反应**：用户对某类事情「反复」表现出同一情绪。
   → 调 record_turn，definite=false。
   记忆系统会自己攒着，攒够了自动归纳成模式；你不需要判断证据够不够，也不需要自己写记忆内容。

调用时如实传：
- user_message：用户这轮说的话（原文）
- assistant_reply：你这轮的回复（如果有）
- emotion / intensity / trigger：如果你已经判断出用户这轮的情绪，一并带上
- definite：① ② → true；③ → false

**不要为了"显得有用"而记录。** 无关紧要的话（寒暄、闲聊、情绪细节）不需要调用。

## 何时查询记忆

- 用户提到「过去 / 上次 / 之前 / 还记得 / 我叫什么」→ 先调 list_memories 看有哪些记忆，再对相关条目调 read_memory 取全文，然后**基于真实内容**回答。
- 用户问「我是谁 / 我的偏好 / 我是什么样的人」→ 调 read_profile。
- 查不到就直说「我不记得」。**绝不臆造记忆内容**，宁可说不记得。`;
