// src/provider.ts
// 模型提供者抽象。允许接入任意 OpenAI 兼容端点。
//
// 已实现：
// - AnthropicProvider: Claude 系列
// - OpenAIProvider: OpenAI 兼容（含自定义 baseURL）
// - 创建 provider 的工厂函数 createProvider()

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

export type Role = "user" | "assistant";

export type ChatMessage = {
  role: Role;
  content: string;
};

export type StreamParams = {
  system: string;
  messages: ChatMessage[];
  maxTokens?: number;
  signal?: AbortSignal;
  /** 温度，0-1，默认 0.7 */
  temperature?: number;
  /** 启用 extended thinking（Anthropic 原生支持，需要 baseURL 也是真 Anthropic） */
  thinking?: { type: "enabled"; budget_tokens: number };
  /** presence penalty（OpenAI / Anthropic），0-1 */
  presencePenalty?: number;
  /** frequency penalty（OpenAI / Anthropic），0-1 */
  frequencyPenalty?: number;
};

export type StreamChunk = {
  /** 文本增量 */
  delta: string;
  /** 是否结束 */
  done: boolean;
};

export type StreamOptions = {
  /** 模型名称 */
  model: string;
  /** 完整 prompt（system + 消息历史） */
  params: StreamParams;
};

export interface ModelProvider {
  /** 提供者名称 */
  readonly name: string;
  /** 当前使用的模型 */
  readonly model: string;
  /** 流式生成（用于主对话） */
  stream(options: StreamOptions): AsyncIterable<StreamChunk>;
  /** 一次性生成（用于 side-query） */
  complete(options: StreamOptions): Promise<string>;
}

// =====================================================================
// Anthropic 实现
// =====================================================================

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly model: string;
  private client: Anthropic;

  constructor(opts: { apiKey?: string; model?: string; baseURL?: string } = {}) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: opts.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    });
    this.model = opts.model ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5-20250929";
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const {
      system,
      messages,
      maxTokens = 3000,
      temperature = 0.7,
      signal,
      thinking,
      presencePenalty,
      frequencyPenalty,
    } = options.params;

    // 构造请求体：max_tokens 必须 ≥ thinking.budget_tokens + 实际输出预算
    const finalMaxTokens = thinking
      ? Math.max(maxTokens, thinking.budget_tokens + 1000)
      : maxTokens;

    const requestBody: any = {
      model: options.model || this.model,
      max_tokens: finalMaxTokens,
      temperature,
      system,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    };

    // 启用 extended thinking（仅当 baseURL 是真 Anthropic 时才生效；
    // 自定义代理可能忽略此参数，调用也不会报错）
    if (thinking) {
      requestBody.thinking = thinking;
    }

    // presence_penalty / frequency_penalty（Anthropic 原生参数）
    // 减少"重复概念"和"模板化用词"，让回复更像人
    if (typeof presencePenalty === "number" && presencePenalty > 0) {
      requestBody.presence_penalty = Math.min(1, Math.max(0, presencePenalty));
    }
    if (typeof frequencyPenalty === "number" && frequencyPenalty > 0) {
      requestBody.frequency_penalty = Math.min(1, Math.max(0, frequencyPenalty));
    }

    const stream = await this.client.messages.stream(requestBody, { signal });

    for await (const event of stream) {
      // 跳过 thinking block 的 delta（只显示给用户的最终回复）
      if (event.type === "content_block_start") {
        if (event.content_block?.type === "thinking") continue;
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        yield { delta: event.delta.text, done: false };
      }
    }

    yield { delta: "", done: true };
  }

  async complete(options: StreamOptions): Promise<string> {
    let result = "";
    for await (const chunk of this.stream(options)) {
      result += chunk.delta;
      if (chunk.done) break;
    }
    return result;
  }
}

// =====================================================================
// OpenAI 实现（支持自定义 baseURL）
// =====================================================================

export class OpenAIProvider implements ModelProvider {
  readonly name: string;
  readonly model: string;
  private client: OpenAI;

  constructor(opts: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    name?: string;
  } = {}) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error(
        "OpenAI provider 需要 API key（OPENAI_API_KEY 环境变量或 apiKey 参数）",
      );
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: opts.baseURL ?? process.env.OPENAI_BASE_URL,
    });
    this.model = opts.model ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    this.name = opts.name ?? (opts.baseURL ? "custom" : "openai");
  }

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const {
      system,
      messages,
      maxTokens = 3000,
      temperature = 0.7,
      signal,
      presencePenalty,
      frequencyPenalty,
    } = options.params;

    const stream = await this.client.chat.completions.create(
      {
        model: options.model || this.model,
        max_tokens: maxTokens,
        temperature,
        stream: true,
        presence_penalty: typeof presencePenalty === "number" && presencePenalty > 0
          ? Math.min(1, Math.max(0, presencePenalty))
          : undefined,
        frequency_penalty: typeof frequencyPenalty === "number" && frequencyPenalty > 0
          ? Math.min(1, Math.max(0, frequencyPenalty))
          : undefined,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        ],
      },
      { signal },
    );

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) yield { delta, done: false };
    }

    yield { delta: "", done: true };
  }

  async complete(options: StreamOptions): Promise<string> {
    let result = "";
    for await (const chunk of this.stream(options)) {
      result += chunk.delta;
      if (chunk.done) break;
    }
    return result;
  }
}

// =====================================================================
// 工厂
// =====================================================================

export type ProviderConfig =
  | { kind: "anthropic"; model?: string; apiKey?: string }
  | {
      kind: "openai";
      model?: string;
      apiKey?: string;
      baseURL?: string;
    }
  | {
      kind: "custom";
      baseURL: string;
      apiKey?: string;
      model: string;
      name?: string;
    };

/**
 * 从配置创建 provider。
 *
 * 优先级：环境变量 > 显式配置
 *
 * 自动检测：
 * - 如果设置了 ANTHROPIC_API_KEY 且没指定 kind，默认 anthropic
 * - 如果设置了 OPENAI_API_KEY 且没指定 kind，默认 openai
 */
export function createProvider(config?: ProviderConfig): ModelProvider {
  if (config) {
    switch (config.kind) {
      case "anthropic":
        return new AnthropicProvider({
          apiKey: config.apiKey,
          model: config.model,
        });
      case "openai":
        return new OpenAIProvider({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model,
        });
      case "custom":
        return new OpenAIProvider({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model,
          name: config.name ?? "custom",
        });
    }
  }

  // 自动检测
  if (process.env.ANTHROPIC_API_KEY) {
    return new AnthropicProvider();
  }
  if (process.env.OPENAI_API_KEY) {
    return new OpenAIProvider();
  }

  throw new Error(
    "未设置 API key。请设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY，或显式传入 provider config。",
  );
}