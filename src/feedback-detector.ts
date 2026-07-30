// src/feedback-detector.ts
// 真正开放的反馈检测器（自然语言观察，不限预定义维度）
//
// 之前用预定义枚举维度（已废弃）（length/tone/depth/format）投票，
// 用户的真实偏好很多不在这些枚举里。
// 新版：让 LLM 用自然语言自由描述观察到的偏好，
// 同时记录具体对话示例（in-context learning 用）。
//
// 调用方式：fire-and-forget 后台调用，不阻塞用户流。

import type { ModelProvider } from "./provider.ts";

export type FeedbackSignal = "positive" | "negative" | "neutral";

export type ConversationExample = {
  userMessage: string;
  aiReply: string;
  /** 仅 positive：为什么这次回复对用户有效 */
  whyWorked?: string;
  /** 仅 negative：为什么这次回复对用户无效 */
  whyDidntWork?: string;
};

export type FeedbackResult = {
  signal: FeedbackSignal;
  /** LLM 自由文本观察的偏好（不限词汇）。可能是 "用户喜欢具体例子"、"不要用 emoji" 等任何描述 */
  insights: string[];
  /** 具体对话示例（仅在信号明确时给出） */
  example?: ConversationExample;
  /** 简短原因说明（用于调试） */
  reason: string;
};

const CLASSIFY_SYSTEM_PROMPT = `你是"用户反馈检测器"。判断用户最新消息对上一轮 AI 回复的态度。

**3 种信号（选 1 个）**：
- **positive**：用户在延续、感谢、深入话题、引用上一轮内容、说"对/确实/就是"、继续深入讨论
- **negative**：用户在纠正、失望、否定、不耐烦、嫌长/嫌短/嫌太浅/嫌太深
- **neutral**：新话题、不相关、不评价上一轮

**提取 LLM 自由文本观察**（不限词汇！）：
- 你看到任何用户偏好/性格/沟通风格观察，写一条一句话描述
- 不要限制在"长度/语气/深度/形式"这种预定义维度
- 可以是任何观察，例如：
  - "用户希望先给具体例子再讲道理"
  - "用户不喜欢用 emoji"
  - "用户喜欢引用文学典故"
  - "用户认为回答太空洞"
  - "用户叫自己小王"
- 信号 positive：写用户**喜欢**什么
- 信号 negative：写用户**不喜欢**什么
- 信号 neutral：insights 可以为空
- 最多 3 条 insights

**可选：给出具体示例**（信号明确时）：
- 如果这轮回复特别能/不能体现用户偏好，记录下来作为 in-context example
- positive：whyWorked；negative：whyDidntWork
- 截断 userMessage 和 aiReply 到 ~200 字内

**输出严格 JSON**（不要任何前言）：
{
  "signal": "positive|negative|neutral",
  "insights": ["观察 1", "观察 2"],
  "example": {
    "userMessage": "用户消息（截断到 200 字）",
    "aiReply": "AI 回复（截断到 200 字）",
    "whyWorked": "为什么这次回复对用户有效" // 仅 positive
    // 或
    "whyDidntWork": "为什么这次回复对用户无效" // 仅 negative
  },
  "reason": "一句话解释你判断信号的理由（≤50 字）"
}`;

/**
 * 检测用户最新消息对上一轮回复的反馈。
 *
 * @param provider LLM provider
 * @param previousReply 上一轮 AI 回复
 * @param currentMessage 用户最新消息
 * @param signal AbortSignal（可选）
 */
export async function detectFeedback(
  provider: ModelProvider,
  previousReply: string,
  currentMessage: string,
  signal?: AbortSignal,
): Promise<FeedbackResult> {
  const userPrompt = `## 上一轮 AI 回复：
${previousReply.slice(0, 1500)}

## 用户最新消息：
${currentMessage.slice(0, 1000)}

判断用户对上一轮回复的态度，按要求输出 JSON。`;

  try {
    const raw = await provider.complete({
      model: provider.model,
      params: {
        system: CLASSIFY_SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 500,
        temperature: 0.3,
        signal,
      },
    });

    return parseFeedbackResult(raw);
  } catch (err) {
    return {
      signal: "neutral",
      insights: [],
      reason: `检测失败: ${(err as Error).message.slice(0, 50)}`,
    };
  }
}

/**
 * 解析 LLM 输出为 FeedbackResult。
 * 容错：JSON 解析失败、字段缺失、字段类型错误等。
 */
export function parseFeedbackResult(raw: string): FeedbackResult {
  let text = raw.trim();

  // 去掉 markdown code fence
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  // 提取 JSON 对象
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return { signal: "neutral", insights: [], reason: "无 JSON 输出" };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return { signal: "neutral", insights: [], reason: "JSON 解析失败" };
  }

  // signal
  const signal: FeedbackSignal =
    parsed.signal === "positive" || parsed.signal === "negative" || parsed.signal === "neutral"
      ? parsed.signal
      : "neutral";

  // insights：任意字符串数组
  const insights: string[] = [];
  if (Array.isArray(parsed.insights)) {
    for (const ins of parsed.insights) {
      if (typeof ins === "string" && ins.trim()) {
        insights.push(ins.trim().slice(0, 200));
      }
    }
  }

  // example：可选
  let example: ConversationExample | undefined;
  if (parsed.example && typeof parsed.example === "object") {
    const ex = parsed.example;
    const userMessage = typeof ex.userMessage === "string" ? ex.userMessage.slice(0, 500) : "";
    const aiReply = typeof ex.aiReply === "string" ? ex.aiReply.slice(0, 500) : "";
    if (userMessage || aiReply) {
      example = {
        userMessage,
        aiReply,
        ...(typeof ex.whyWorked === "string" && ex.whyWorked ? { whyWorked: ex.whyWorked.slice(0, 200) } : {}),
        ...(typeof ex.whyDidntWork === "string" && ex.whyDidntWork ? { whyDidntWork: ex.whyDidntWork.slice(0, 200) } : {}),
      };
    }
  }

  // reason
  const reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 100) : "";

  return { signal, insights, example, reason };
}