// src/classify.ts
// Side-query 工具：情绪识别 + 记忆召回。
//
// 模式：和主对话并行跑小模型查询，不阻塞用户流。
// 这是 LLM agent 通用设计模式（LangChain RunnableParallel、LlamaIndex
// QueryTransform 等都有类似机制）。本项目独立实现。

import type { ModelProvider } from "./provider.ts";
import {
  type MemoryFile,
  formatManifest,
} from "./memory.ts";
import {
  type EmotionCategory,
  EMOTION_LABEL,
} from "./timeline.ts";

// =====================================================================
// 情绪识别
// =====================================================================

export type EmotionDetection = {
  emotion: EmotionCategory;
  /** 强度 0-1 */
  intensity: number;
  /** 触发器（一句话推测） */
  trigger: string;
  /** 原文片段（最多 100 字） */
  excerpt: string;
};

const EMOTION_SYSTEM_PROMPT = `你是一个情绪识别助手。分析用户的最新一条消息，返回情绪判断。

输出要求（严格 JSON，无多余文本）：
{
  "emotion": "<joy|sadness|anger|fear|surprise|disgust|neutral|mixed>",
  "intensity": <0 到 1 之间的小数>,
  "trigger": "<一句话推测的触发器，≤20 字>",
  "excerpt": "<最能代表情绪的原文片段，≤100 字>"
}

判断原则：
- 用户没明显情绪表达 → neutral，强度 ≤ 0.3
- 用户表达多种冲突情绪 → mixed
- 强度：平淡 = 0.2-0.4，明显 = 0.5-0.7，强烈 = 0.8-1.0`;

const EMOTION_USER_TEMPLATE = (text: string) =>
  `请分析以下用户消息的情绪：\n\n"""\n${text}\n"""`;

/**
 * Side-query：用主模型做情绪识别。
 *
 * 注意：MVP 阶段用主模型而非小模型（避免引入额外 provider）。
 * 未来可优化为双模型路由（主回复用大模型，side-query 用小模型）。
 */
export async function detectEmotion(
  provider: ModelProvider,
  userText: string,
): Promise<EmotionDetection | null> {
  let result: string;
  try {
    result = await provider.complete({
      model: provider.model,
      params: {
        system: EMOTION_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: EMOTION_USER_TEMPLATE(userText) },
        ],
        maxTokens: 500,
        temperature: 0.3,
      },
    });
  } catch (e) {
    console.warn(`[classify] 情绪识别 LLM 调用失败:`, (e as Error).message);
    return null;
  }

  // 解析 JSON（容错：code block、截断、字段缺失）
  let jsonText = result.trim()
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  const objMatch = jsonText.match(/\{[\s\S]*\}/);
  if (objMatch) jsonText = objMatch[0];

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    console.warn(
      `[classify] 情绪识别 JSON 解析失败，原始输出: ${jsonText.slice(0, 200)}`,
    );
    return null;
  }

  // 校验
  if (!Object.keys(EMOTION_LABEL).includes(parsed?.emotion)) {
    return null;
  }
  if (typeof parsed.intensity !== "number") {
    parsed.intensity = 0.5;
  }
  parsed.intensity = Math.max(0, Math.min(1, parsed.intensity));

  return parsed;
}

// =====================================================================
// 记忆召回
// =====================================================================

const RECALL_SYSTEM_PROMPT = `你是一个记忆检索助手。从可用记忆列表中选出最相关、最可能帮助当下对话的记忆文件。

输出要求（严格 JSON，无多余文本）：
{
  "selected": ["<filename>", ...]   // 最多 5 个，按相关度排序
}

选择原则：
- 只选当下对话很可能用得上的
- 如果没有明确相关的，返回空数组
- 优先选 feedback 类（用户偏好）和 emotional_state 类（情绪记忆），这两类对情感对话最重要
- 不要选 user 类里"基础身份信息"以外的内容（那些通常已经在主人格 prompt 里）`;

const RECALL_USER_TEMPLATE = (query: string, manifest: string) =>
  `用户最新消息：\n"""\n${query}\n"""\n\n可用记忆：\n${manifest}\n\n请选出最相关的最多 5 条记忆。`;

/**
 * Side-query：从记忆列表中选出最相关的 ≤5 个文件。
 */
export async function recallMemories(
  provider: ModelProvider,
  query: string,
  candidates: MemoryFile[],
  maxResults: number = 5,
): Promise<MemoryFile[]> {
  if (candidates.length === 0) return [];

  const manifest = formatManifest(candidates);
  let result: string;
  try {
    result = await provider.complete({
      model: provider.model,
      params: {
        system: RECALL_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: RECALL_USER_TEMPLATE(query, manifest),
          },
        ],
        maxTokens: 800,  // 充分大，避免 JSON 被截断
        temperature: 0.2,
      },
    });
  } catch (e) {
    console.warn(`[classify] 记忆召回 LLM 调用失败:`, (e as Error).message);
    return [];
  }

  // 解析 JSON（容错：code block、截断、字段缺失）
  let jsonText = result.trim()
    .replace(/^```(?:json)?\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  const objMatch = jsonText.match(/\{[\s\S]*\}/);
  if (objMatch) jsonText = objMatch[0];

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (parseErr) {
    // 解析失败时 debug 打印原始输出（不超 200 字）
    console.warn(
      `[classify] 记忆召回 JSON 解析失败，原始输出: ${jsonText.slice(0, 200)}`,
    );
    return [];
  }

  // 字段校验：selected 必须是数组
  if (!Array.isArray(parsed?.selected)) {
    return [];
  }
  const filenames = parsed.selected.slice(0, maxResults);
  return candidates.filter((f) => filenames.includes(f.filename));
}