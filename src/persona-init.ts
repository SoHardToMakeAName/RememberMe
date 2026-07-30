// src/persona-init.ts
// 从用户描述生成大五人格（OCEAN）JSON
//
// 用户说一句话（如"一个像苏格拉底那样的智者"）→ LLM 推断 5 维数值 + 自由文本偏好
// 失败时降级为默认 OCEAN（0.5）+ 通用 preferences

import type { ModelProvider } from "./provider.ts";
import {
  defaultPersona,
  oceanHint,
  savePersonaForSession,
  validateOCEAN,
  validatePersona,
  type BigFivePersona,
  type OCEAN,
} from "./bigfive.ts";

const INIT_SYSTEM_PROMPT = `你是"大五人格（Big Five / OCEAN）"分析器。
用户用一句话描述想要的人格，你把它转成 5 维数值 + 自由文本偏好。

**5 维（每项 0.00-1.00，保留 2 位小数）**：
- **openness**（开放性）：想象力、好奇心、抽象思维
  - 低（0.0-0.3）：偏好熟悉、具体、实用的内容
  - 中（0.3-0.7）：能接受新想法但不主动探索
  - 高（0.7-1.0）：喜欢新想法、抽象概念、跨领域联想
- **conscientiousness**（尽责性）：条理性、自律、可靠
  - 低：回复随性、跳跃
  - 中：偶尔组织
  - 高：条理清晰、先组织再表达
- **extraversion**（外向性）：热情、健谈、活跃
  - 低：偏好安静、内敛
  - 中：根据话题调整
  - 高：热情、主动扩展话题
- **agreeableness**（宜人性）：信任、合作、利他
  - 低：直接挑战而非迁就
  - 中：能共情也直接表达不同意见
  - 高：温和、不对抗、善于共情
- **neuroticism**（神经质）：情绪敏感、焦虑
  - 低：情绪稳定、冷静
  - 中：偶尔情绪化但大体稳定
  - 高：易波动、对压力反应强

**preferences**（自由文本，1-2 句话）：把用户描述翻译成"这个角色说话会怎么说话"的行为倾向。例如：
- "用具体例子而非抽象概念"
- "说话带黑色幽默但不刻薄"
- "喜欢引用历史典故"
- "不主动开玩笑但会接梗"

**输出严格 JSON**（无任何前言）：
{
  "ocean": {
    "openness": 0.0-1.0,
    "conscientiousness": 0.0-1.0,
    "extraversion": 0.0-1.0,
    "agreeableness": 0.0-1.0,
    "neuroticism": 0.0-1.0
  },
  "preferences": "..."
}`;

export type GenerateOptions = {
  /** 用户描述（中文/英文都可以） */
  description: string;
  sessionId: string;
  signal?: AbortSignal;
};

/**
 * 从用户描述生成 BigFivePersona，保存到 data/personality/{sessionId}.json。
 *
 * 失败时（LLM 调用失败 / JSON 解析失败）降级为默认 OCEAN（0.5）+ 通用 preferences。
 */
export async function initPersonaFromDescription(
  provider: ModelProvider,
  options: GenerateOptions,
  dataDir: string,
): Promise<BigFivePersona> {
  const fallback = defaultPersona(options.sessionId);

  let parsed: BigFivePersona;
  try {
    const raw = await provider.complete({
      model: provider.model,
      params: {
        system: INIT_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: `请基于这个描述生成大五人格：\n"""${options.description}"""`,
          },
        ],
        maxTokens: 500,
        temperature: 0.4,
        signal: options.signal,
      },
    });

    parsed = parseInitOutput(raw, options.sessionId);
  } catch (err) {
    // LLM 调用失败：降级为默认
    parsed = { ...fallback, preferences: `（人设生成失败：${(err as Error).message.slice(0, 50)}）${fallback.preferences}` };
  }

  savePersonaForSession(dataDir, parsed);
  return parsed;
}

/** 解析 LLM 输出为 BigFivePersona */
export function parseInitOutput(raw: string, sessionId: string): BigFivePersona {
  const fallback = defaultPersona(sessionId);

  // 提取 JSON
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\n?/i, "").replace(/\n?```\s*$/i, "").trim();
  const objMatch = text.match(/\{[\s\S]*\}/);
  if (!objMatch) return fallback;

  let parsed: any;
  try {
    parsed = JSON.parse(objMatch[0]);
  } catch {
    return fallback;
  }

  // 不依赖 validatePersona：直接尝试读取 ocean 字段
  // 不存在 → 用 fallback；存在 → 数值 clamp 到 0-1
  const oceanIn = parsed?.ocean;
  if (!oceanIn || typeof oceanIn !== "object") return fallback;

  const ocean: OCEAN = {
    openness: clampOcean(oceanIn.openness),
    conscientiousness: clampOcean(oceanIn.conscientiousness),
    extraversion: clampOcean(oceanIn.extraversion),
    agreeableness: clampOcean(oceanIn.agreeableness),
    neuroticism: clampOcean(oceanIn.neuroticism),
  };

  return {
    sessionId,
    ocean,
    preferences: parsed.preferences?.trim() || fallback.preferences,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function clampOcean(v: number): number {
  if (typeof v !== "number" || isNaN(v)) return 0.5;
  return Math.round(Math.max(0, Math.min(1, v)) * 100) / 100;
}

// Re-export oceanHint for convenience
export { oceanHint };