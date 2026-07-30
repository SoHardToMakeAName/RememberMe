// src/persona-learner.ts
// 真正开放的人设学习器
//
// 上一版用预定义枚举（length/tone/depth/format）记录偏好。
// 新版用完全开放的自由文本观察 + 具体对话示例：
// - positivePatterns: LLM 自由描述的"用户喜欢什么"
// - negativePatterns: LLM 自由描述的"用户不喜欢什么"
// - positiveExamples / negativeExamples: 具体对话示例（in-context learning）
//
// 存储：data/learned-prefs/{userId}.json
// 每用户独立（简化为 userId="default"）

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { ModelProvider } from "./provider.ts";
import type { ConversationExample, FeedbackSignal } from "./feedback-detector.ts";

export const SCHEMA_VERSION = 2;

/** 软上限：超过会触发后台合并 */
export const SOFT_CAP_POSITIVE = 15;
export const SOFT_CAP_NEGATIVE = 15;

/** 硬上限：保留最近 N 条（防止 prompt 撑爆） */
export const HARD_CAP_PATTERNS = 20;
export const HARD_CAP_EXAMPLES = 5;

/** 文本长度上限 */
const MAX_INSIGHT_LEN = 200;
const MAX_REASON_LEN = 100;
const MAX_EXAMPLE_USER_LEN = 500;
const MAX_EXAMPLE_AI_LEN = 500;
const MAX_EXAMPLE_NOTE_LEN = 200;

export type LearnerState = {
  userId: string;
  version: number;

  /** 信号计数（debug/可观测用，不进 prompt） */
  signalCounts: {
    positive: number;
    negative: number;
    neutral: number;
  };

  /** 自由文本偏好观察（核心：完全开放，无预设维度） */
  positivePatterns: string[];
  negativePatterns: string[];

  /** 具体对话示例（强信号：给 LLM 看什么是好回复） */
  positiveExamples: ConversationExample[];
  negativeExamples: ConversationExample[];

  /** 最近反馈原因（debug 用） */
  recentReasons: { signal: FeedbackSignal; text: string; at: number }[];

  createdAt: number;
  updatedAt: number;
};

export function emptyState(userId: string): LearnerState {
  const now = Date.now();
  return {
    userId,
    version: SCHEMA_VERSION,
    signalCounts: { positive: 0, negative: 0, neutral: 0 },
    positivePatterns: [],
    negativePatterns: [],
    positiveExamples: [],
    negativeExamples: [],
    recentReasons: [],
    createdAt: now,
    updatedAt: now,
  };
}

function prefsFile(dataDir: string, userId: string): string {
  return join(dataDir, "learned-prefs", `${userId}.json`);
}

/**
 * 加载 learner state。
 * - 文件不存在：返回空状态
 * - 老版本（version < SCHEMA_VERSION 或缺关键字段）：返回空状态（数据丢弃）
 */
export function loadLearner(dataDir: string, userId: string): LearnerState {
  const path = prefsFile(dataDir, userId);
  if (!existsSync(path)) {
    return emptyState(userId);
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as LearnerState;

    // 版本检查：老 schema 数据直接丢弃
    if (parsed.version !== SCHEMA_VERSION) {
      return emptyState(userId);
    }

    // 兼容性：补全缺失字段
    if (!parsed.signalCounts) {
      parsed.signalCounts = { positive: 0, negative: 0, neutral: 0 };
    }
    if (!Array.isArray(parsed.positivePatterns)) parsed.positivePatterns = [];
    if (!Array.isArray(parsed.negativePatterns)) parsed.negativePatterns = [];
    if (!Array.isArray(parsed.positiveExamples)) parsed.positiveExamples = [];
    if (!Array.isArray(parsed.negativeExamples)) parsed.negativeExamples = [];
    if (!Array.isArray(parsed.recentReasons)) parsed.recentReasons = [];

    return parsed;
  } catch {
    return emptyState(userId);
  }
}

export function saveLearner(dataDir: string, state: LearnerState): void {
  const path = prefsFile(dataDir, state.userId);
  mkdirSync(join(dataDir, "learned-prefs"), { recursive: true });
  state.updatedAt = Date.now();
  writeFileSync(path, JSON.stringify(state, null, 2), "utf-8");
}

export function resetLearner(dataDir: string, userId: string): LearnerState {
  const fresh = emptyState(userId);
  saveLearner(dataDir, fresh);
  return fresh;
}

/**
 * 把一次反馈应用到 learner state。
 *
 * @param state 当前状态
 * @param signal positive / negative / neutral
 * @param insights LLM 自由文本观察的列表（不限词汇）
 * @param example 可选的具体对话示例
 */
export function applyFeedback(
  state: LearnerState,
  signal: FeedbackSignal,
  insights: string[] = [],
  example?: ConversationExample,
): LearnerState {
  const next: LearnerState = JSON.parse(JSON.stringify(state));
  next.version = SCHEMA_VERSION;

  // 信号计数
  next.signalCounts[signal]++;

  // 自由文本偏好观察
  const cleanedInsights = insights
    .filter((s) => typeof s === "string" && s.trim())
    .map((s) => s.trim().slice(0, MAX_INSIGHT_LEN));

  if (signal === "positive") {
    next.positivePatterns.push(...cleanedInsights);
    // 硬上限：保留最近 N 条
    if (next.positivePatterns.length > HARD_CAP_PATTERNS) {
      next.positivePatterns = next.positivePatterns.slice(-HARD_CAP_PATTERNS);
    }
  } else if (signal === "negative") {
    next.negativePatterns.push(...cleanedInsights);
    if (next.negativePatterns.length > HARD_CAP_PATTERNS) {
      next.negativePatterns = next.negativePatterns.slice(-HARD_CAP_PATTERNS);
    }
  }
  // neutral: 只累加 signalCounts，不存 patterns

  // 具体对话示例
  if (example && (signal === "positive" || signal === "negative")) {
    const ex: ConversationExample = {
      userMessage: (example.userMessage ?? "").slice(0, MAX_EXAMPLE_USER_LEN),
      aiReply: (example.aiReply ?? "").slice(0, MAX_EXAMPLE_AI_LEN),
    };
    if (signal === "positive" && example.whyWorked) {
      ex.whyWorked = example.whyWorked.slice(0, MAX_EXAMPLE_NOTE_LEN);
    }
    if (signal === "negative" && example.whyDidntWork) {
      ex.whyDidntWork = example.whyDidntWork.slice(0, MAX_EXAMPLE_NOTE_LEN);
    }

    if (signal === "positive") {
      next.positiveExamples.push(ex);
      if (next.positiveExamples.length > HARD_CAP_EXAMPLES) {
        next.positiveExamples = next.positiveExamples.slice(-HARD_CAP_EXAMPLES);
      }
    } else {
      next.negativeExamples.push(ex);
      if (next.negativeExamples.length > HARD_CAP_EXAMPLES) {
        next.negativeExamples = next.negativeExamples.slice(-HARD_CAP_EXAMPLES);
      }
    }
  }

  // recentReasons（debug 用）
  if (insights.length > 0 || signal !== "neutral") {
    next.recentReasons.push({
      signal,
      text: insights.slice(0, 3).join("; ").slice(0, MAX_REASON_LEN),
      at: Date.now(),
    });
    if (next.recentReasons.length > 20) {
      next.recentReasons = next.recentReasons.slice(-20);
    }
  }

  next.updatedAt = Date.now();
  return next;
}

/**
 * 总反馈数（用于判断是否冷启动）
 */
export function totalFeedback(state: LearnerState): number {
  return (
    state.signalCounts.positive +
    state.signalCounts.negative +
    state.signalCounts.neutral
  );
}

/**
 * 判断是否需要触发合并
 */
export function needsMerge(state: LearnerState): boolean {
  return (
    state.positivePatterns.length > SOFT_CAP_POSITIVE ||
    state.negativePatterns.length > SOFT_CAP_NEGATIVE
  );
}

/**
 * 把 learner state 转换成动态 persona 文本。
 *
 * 设计原则（v0.19 移除硬风格版）：
 * - 不注入角色身份声明（"你是一个真实的人…"）和"核心原则"段
 *   让 LLM 按默认风格回复，偏好应该从对话中通过反馈循环自然长出来
 * - 输出只包括用户实际反馈累积的 patterns 和 examples
 *
 * 冷启动：无任何数据时返回**空字符串**，不污染 system prompt。
 */
export function buildDynamicPersona(state: LearnerState): string {
  const lines: string[] = [];

  // 自由文本偏好观察
  if (state.positivePatterns.length > 0) {
    lines.push("【这个用户过去喜欢的（学习这些）】");
    for (const p of state.positivePatterns.slice(-10)) {
      lines.push(`- ${p}`);
    }
  }

  if (state.negativePatterns.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("【这个用户过去不喜欢的（避免）】");
    for (const p of state.negativePatterns.slice(-10)) {
      lines.push(`- ${p}`);
    }
  }

  // 具体对话示例（in-context demonstration）
  // 正例取最近 2 个，负例取最近 1 个
  const posEx = state.positiveExamples.slice(-2);
  if (posEx.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("【过去用户明确满意的回复示例（学习这种风格）】");
    for (const ex of posEx) {
      lines.push(`用户：${ex.userMessage}`);
      lines.push(`你：${ex.aiReply}`);
      if (ex.whyWorked) {
        lines.push(`原因：${ex.whyWorked}`);
      }
      lines.push("---");
    }
  }

  const negEx = state.negativeExamples.slice(-1);
  if (negEx.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("【要避免的回复（用户不满意）】");
    for (const ex of negEx) {
      lines.push(`用户：${ex.userMessage}`);
      lines.push(`你：${ex.aiReply}`);
      if (ex.whyDidntWork) {
        lines.push(`原因：${ex.whyDidntWork}`);
      }
      lines.push("---");
    }
  }

  return lines.join("\n");
}

/**
 * 后台合并相似 patterns（防止冗余累积）
 *
 * @param provider LLM provider
 * @param patterns 当前 patterns 列表
 * @param signal positive 或 negative（用于 prompt 上下文）
 * @returns 合并后的 patterns 列表
 */
export async function mergePatterns(
  provider: ModelProvider,
  patterns: string[],
  signal: FeedbackSignal,
  signal2?: AbortSignal,
): Promise<string[]> {
  if (patterns.length <= 10) return patterns;

  const userPrompt = `合并以下用户偏好的自由文本描述，去重、保留核心、合并相似项。

当前 ${signal === "positive" ? "用户喜欢" : "用户不喜欢"} 的列表：
${patterns.map((p, i) => `${i + 1}. ${p}`).join("\n")}

要求：
- 合并语义重复的（例如"用户喜欢例子"和"用户希望先举例"→ 合并）
- 删除完全重复的
- 保留有差异的细节
- 输出合并后的列表（JSON 数组，每项一句话）
- 最多保留 10 条
- 只输出 JSON 数组，不要其他文字`;

  try {
    const raw = await provider.complete({
      model: provider.model,
      params: {
        system: "你是文本去重合并助手。输出严格 JSON 数组。",
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 800,
        temperature: 0.2,
        signal: signal2,
      },
    });

    // 解析 JSON 数组
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return patterns;

    const parsed = JSON.parse(match[0]);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((s): s is string => typeof s === "string" && Boolean(s.trim()))
        .map((s: string) => s.trim().slice(0, MAX_INSIGHT_LEN));
    }
    return patterns;
  } catch {
    return patterns;
  }
}