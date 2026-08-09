// src/compact.ts
// 自动压缩长对话历史（emotional-aware）。
//
// 通用 LLM agent 模式：长对话超过窗口时，用另一个 LLM 生成结构化摘要。
// 本项目根据情感场景定制摘要字段（保留用户偏好纠正、情绪转折点）。
//
// 情感场景的特别需求：
// 1. 必须保留用户的情绪强度与转折点（"用户说累但其实是压抑的愤怒"）
// 2. 必须保留用户对主人的偏好纠正（"用户说别再总结"）
// 3. 必须保留未完结的话题（下次接茬用）
// 4. 必须保留人格语气基准不能漂移

import type { ChatMessage, ModelProvider } from "./provider.ts";
import { estimateTokens } from "./utils.ts";
import { t } from "./i18n.ts";

// estimateTokens 的实现已移到 utils.ts（memory.ts 的索引预算也要用）。
// 这里继续导出，保持 compact 模块既有的公开面不变。
export { estimateTokens };

// =====================================================================
// 配置
// =====================================================================

export type CompactConfig = {
  /** 触发压缩的历史长度（消息数 = 2×轮数）。默认 20 条 = 10 轮对话 */
  triggerAt: number;
  /** 压缩时保留最近多少条。默认 6 条 = 3 轮 */
  recentKept: number;
  /** 估算 token 上限（粗略按字符数 / 2）。默认 20000 字符 ≈ 10000 tokens */
  maxChars: number;
  /** 当历史总 token 估算低于此值时，跳过 compact（summary 反而更长，不划算）。默认 1500 */
  minCompactWorth: number;
};

export const DEFAULT_COMPACT_CONFIG: CompactConfig = {
  triggerAt: 20,
  recentKept: 6,
  maxChars: 20000,
  /** 当历史总 token 估算低于此值时，compact 不划算（summary 反而更长），跳过 */
  minCompactWorth: 1500,
};

// =====================================================================
// Token 估算（粗略字符法，避免引入 tokenizer 依赖）
// =====================================================================

export function estimateHistoryTokens(history: ChatMessage[]): number {
  let total = 0;
  for (const m of history) {
    total += estimateTokens(m.content);
  }
  return total;
}

// =====================================================================
// 触发判断
// =====================================================================

export type CompactDecision = {
  shouldCompact: boolean;
  reason: "ok" | "too_many_messages" | "too_many_tokens";
  /** 待压缩的旧消息数 */
  oldCount?: number;
  /** 保留的最近消息数 */
  recentCount?: number;
};

export function shouldCompact(
  history: ChatMessage[],
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
): CompactDecision {
  // 1. 先检查 short-circuit：旧历史总 token 太小时，compact 不划算（summary 反而更长）
  const tokens = estimateHistoryTokens(history);
  if (tokens < config.minCompactWorth) {
    return { shouldCompact: false, reason: "ok" };
  }

  // 2. 消息数触发
  if (history.length >= config.triggerAt) {
    return {
      shouldCompact: true,
      reason: "too_many_messages",
      oldCount: history.length - config.recentKept,
      recentCount: config.recentKept,
    };
  }

  // 3. token 数触发（粗略估算 = 2 × token 数 → 比较 maxChars）
  if (tokens * 2 >= config.maxChars) {
    return {
      shouldCompact: true,
      reason: "too_many_tokens",
      oldCount: history.length - config.recentKept,
      recentCount: config.recentKept,
    };
  }

  return { shouldCompact: false, reason: "ok" };
}

// =====================================================================
// 压缩执行
// =====================================================================

/**
 * 情感场景定制的压缩 prompt（关键段不可省略）。
 *
 * 6 段分类（情感场景定制，不参考任何特定项目）：
 * 1. 用户情绪轨迹（含转折）
 * 2. 用户关键信息（角色、关系、生活事件）
 * 3. 用户偏好与纠正（最关键——这是人格调整的输入）
 * 4. 未完结话题与承诺（下次接茬用）
 * 5. 当前主导情绪与主人在这次对话中的语气
 * 6. 其他需要传递给下一个 LLM 的上下文
 */
const COMPACT_SYSTEM_PROMPT = t("compact.system_prompt");

function buildCompactInput(
  history: ChatMessage[],
  profileSummary?: string,
): string {
  const lines = history.map(
    (m, i) => `${i + 1}. [${m.role}] ${m.content}`,
  );
  const profileBlock = profileSummary
    ? `\n\n${t("compact.user_prefix")}\n${profileSummary}\n`
    : "";
  return `${t("compact.user_prefix")}${profileBlock}\n\n${lines.join("\n\n")}`;
}

export type CompactResult = {
  /** 替换后的历史（摘要消息 + 保留的最近消息） */
  history: ChatMessage[];
  /** 摘要原文 */
  summary: string;
  /** 压缩轮数 */
  compactedCount: number;
  /** 节省的估算 token 数 */
  savedTokens: number;
};

export async function compactHistory(
  history: ChatMessage[],
  provider: ModelProvider,
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
  /** 可选的用户画像摘要，让 compact 的摘要与长期信息一致 */
  profileSummary?: string,
): Promise<CompactResult> {
  if (history.length <= config.recentKept) {
    return {
      history,
      summary: "",
      compactedCount: 0,
      savedTokens: 0,
    };
  }

  const oldMessages = history.slice(0, history.length - config.recentKept);
  const recentMessages = history.slice(history.length - config.recentKept);

  // token 估算（压缩前）
  const tokensBefore = estimateHistoryTokens(history);

  // 用主模型做摘要（也可以走小模型，未来扩展）
  const summary = await provider.complete({
    model: provider.model,
    params: {
      system: COMPACT_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: buildCompactInput(oldMessages, profileSummary),
        },
      ],
      maxTokens: 800, // 硬限制：summary 必须 < 800 tokens（约 1600 中文字）
      temperature: 0.3, // 低温度，要求稳定输出
    },
  });

  // 摘要作为一个 user 角色消息（不是 assistant 角色）。
  // 为什么是 user 而不是 assistant：避免模型把 summary 当成"我刚才说的话"，
  // 进而污染下一轮的回应（比如把 summary 里的"工作压力"当成最近的话题，
  // 然后用户说"我吃了碗面"时回"聊了什么"）。
  // 前缀用方括号和 [BACKGROUND] 标记，让模型明确这是上下文信息而非对话内容。
  const summaryMessage: ChatMessage = {
    role: "user",
    content: `[BACKGROUND — 由另一个 LLM 生成的早前对话压缩摘要，仅供参考，不要据此回答当前问题。继续按你的当前人格与用户对话。]\n\n${summary.trim()}\n\n[END BACKGROUND]`,
  };

  const newHistory = [summaryMessage, ...recentMessages];
  const tokensAfter = estimateHistoryTokens(newHistory);

  return {
    history: newHistory,
    summary,
    compactedCount: oldMessages.length,
    savedTokens: Math.max(0, tokensBefore - tokensAfter),
  };
}

// =====================================================================
// 整合入口
// =====================================================================

/**
 * 一站式：决定+执行压缩。供 loop.ts 调用。
 *
 * 如果不需要压缩直接返回原 history。
 */
export async function maybeCompact(
  history: ChatMessage[],
  provider: ModelProvider,
  config: CompactConfig = DEFAULT_COMPACT_CONFIG,
  /** 可选的用户画像摘要 */
  profileSummary?: string,
): Promise<{ history: ChatMessage[]; result: CompactResult | null }> {
  const decision = shouldCompact(history, config);
  if (!decision.shouldCompact) {
    return { history, result: null };
  }

  const result = await compactHistory(history, provider, config, profileSummary);
  return { history: result.history, result };
}