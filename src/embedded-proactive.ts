// src/embedded-proactive.ts
// 嵌入式主动问题 - "对了..." 在主回复末尾自然嵌入
// 修复 Bun 解析器对全角标点 + template literal 的兼容问题

import type { ModelProvider } from "./provider.ts";
import type { Profile } from "./profile.ts";
import { validateProactiveMessage } from "./proactive.ts";

export type EmbeddedProactiveConfig = {
  /** 用户上次活跃距今多少小时才触发（默认 4h） */
  idleHours: number;
  /** 本次会话至少有几轮用户消息才触发（默认 2） */
  minUserTurns: number;
  /** 上次嵌入距今多少小时才再触发（默认 24h） */
  cooldownHours: number;
};

export const DEFAULT_EMBEDDED_PROACTIVE_CONFIG: EmbeddedProactiveConfig = {
  idleHours: 4,
  minUserTurns: 2,
  cooldownHours: 24,
};

export type EmbeddedProactiveInput = {
  lastUserActivityAt: number;
  currentUserTurns: number;
  lastEmbeddedAt: number;
  profile: Profile | null;
  memorySummary: string;
  recentUserMessage: string;
  currentReply: string;
  replyAlreadyHasProbe: boolean;
};

export type EmbeddedProactiveDecision = {
  shouldEmbed: boolean;
  reason: string;
  question?: string;
  validationScore: number;
};

const PROACTIVE_PROBE_PROMPT = [
  "你是用户的长期陪聊伙伴。",
  "用户离开了一会儿，又回来了。",
  "请基于【用户画像】和【近期记忆】，在主回复后面接一个自然的小追问。",
  "",
  "硬性规则（绝不能违反）：",
  "1. 只能引用用户画像或记忆里出现过的具体内容",
  "2. 上下文中没有的，绝对不能提",
  "3. 保持随和的语气，像朋友突然想起什么",
  "4. 简短 - 30 字以内，对了你加 1 句问句",
  "5. 不要打断主回复的逻辑",
  "6. 用户的名字、宠物、爱好等只能从 context 里有",
  "",
  "只输出问题本身（含'对了'或'话说'开头），不要任何前言。",
].join("\n");

async function generateProactiveQuestion(
  provider: ModelProvider,
  input: {
    personalityName: string;
    recentUserMessage: string;
    currentReply: string;
    idleHours: number;
    profileSummary: string;
    memorySummary: string;
  },
  options: { signal?: AbortSignal } = {},
): Promise<string | null> {
  const userContext = [
    "用户画像:",
    input.profileSummary || "(暂无)",
    "",
    "近期记忆:",
    input.memorySummary || "(暂无)",
    "",
    "用户最近说: " + input.recentUserMessage,
    "你刚才回复: " + input.currentReply,
    "用户离开了 " + input.idleHours.toFixed(1) + " 小时",
  ].join("\n");

  try {
    const raw = await provider.complete({
      model: provider.model,
      params: {
        system: PROACTIVE_PROBE_PROMPT,
        messages: [
          { role: "user", content: userContext },
        ],
        maxTokens: 200,
        temperature: 0.7,
        signal: options.signal,
      },
    });
    return raw.trim();
  } catch {
    return null;
  }
}

export async function maybeEmbedProactive(
  provider: ModelProvider,
  config: EmbeddedProactiveConfig,
  input: EmbeddedProactiveInput,
  options: { signal?: AbortSignal; now?: number } = {},
): Promise<EmbeddedProactiveDecision> {
  const now = options.now ?? Date.now();
  const idleMs = now - input.lastUserActivityAt;
  const idleHours = idleMs / (1000 * 60 * 60);
  const cooldownMs = now - input.lastEmbeddedAt;
  const cooldownHours = cooldownMs / (1000 * 60 * 60);

  const idleOk = idleHours >= config.idleHours;
  const turnsOk = input.currentUserTurns >= config.minUserTurns;
  const cooldownOk =
    input.lastEmbeddedAt === 0 || cooldownHours >= config.cooldownHours;
  const contextOk =
    (input.profile &&
      Object.values(input.profile.sections).some(
        (s) => s && !s.includes("暂无"),
      )) ||
    (input.memorySummary && input.memorySummary.trim().length > 0);
  const notInReply = !input.replyAlreadyHasProbe;

  if (!idleOk) {
    return {
      shouldEmbed: false,
      reason: "用户刚活跃（" + idleHours.toFixed(1) + "h 前 < " + config.idleHours + "h 阈值）",
      validationScore: 0,
    };
  }
  if (!turnsOk) {
    return {
      shouldEmbed: false,
      reason: "会话刚开始（" + input.currentUserTurns + " 轮 < " + config.minUserTurns + "）",
      validationScore: 0,
    };
  }
  if (!cooldownOk) {
    return {
      shouldEmbed: false,
      reason: "上次嵌入才 " + cooldownHours.toFixed(1) + "h 前（< " + config.cooldownHours + "h cooldown）",
      validationScore: 0,
    };
  }
  if (!contextOk) {
    return {
      shouldEmbed: false,
      reason: "没有可用的 profile/memory 上下文（避免编造）",
      validationScore: 0,
    };
  }
  if (!notInReply) {
    return {
      shouldEmbed: false,
      reason: "主回复已经包含探针（对了/话说），不再重复",
      validationScore: 0,
    };
  }

  const profileSummary = input.profile
    ? Object.entries(input.profile.sections)
        .filter(([_, v]) => v && !v.includes("暂无"))
        .map(([k, v]) => k + ": " + v.slice(0, 200))
        .join("\n")
    : "(暂无)";

  const question = await generateProactiveQuestion(
    provider,
    {
      personalityName: "",
      recentUserMessage: input.recentUserMessage,
      currentReply: input.currentReply,
      idleHours,
      profileSummary,
      memorySummary: input.memorySummary,
    },
    options,
  );

  if (!question) {
    return {
      shouldEmbed: false,
      reason: "LLM 无法生成有效问题",
      validationScore: 0,
    };
  }

  // 用同样的关键词验证：必须引用 context
  const ctx: ProactiveContext = {
    profile: input.profile,
    memories: [],
    timelineSummary: input.memorySummary,
    personalityName: "",
    personalityDescription: "",
  };
  const validation = validateProactiveMessage(question, ctx);
  if (!validation.valid) {
    return {
      shouldEmbed: false,
      reason: "生成的问题未通过验证: " + validation.reason,
      validationScore: 0,
    };
  }

  return {
    shouldEmbed: true,
    question,
    reason: "用户离开 " + idleHours.toFixed(1) + "h，嵌入自然问题",
    validationScore: 1,
  };
}

type ProactiveContext = Parameters<typeof validateProactiveMessage>[1];
