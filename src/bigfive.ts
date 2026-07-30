// src/bigfive.ts
// 大五人格（Big Five / OCEAN）模块
//
// 心理学公认的人格模型：5 维 0-1 数值 + 自由文本偏好。
// 每会话一个 JSON，路径 data/personality/{sessionId}.json。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 大五人格（OCEAN）五个维度的 0-1 数值。
 *
 * - openness: 开放性（想象力、好奇心、抽象思维）
 * - conscientiousness: 尽责性（条理性、自律、可靠）
 * - extraversion: 外向性（热情、健谈、活跃）
 * - agreeableness: 宜人性（信任、合作、利他）
 * - neuroticism: 神经质（情绪敏感；高=易焦虑，低=稳定）
 */
export type OCEAN = {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
};

/** 完整大五人设（按会话存储） */
export type BigFivePersona = {
  sessionId: string;
  ocean: OCEAN;
  /** 用户初始描述 + LLM 翻译成行为倾向（自由文本） */
  preferences: string;
  createdAt: number;
  updatedAt: number;
};

/** 默认 OCEAN（中性人格，数值全 0.5） */
export const DEFAULT_OCEAN: OCEAN = {
  openness: 0.5,
  conscientiousness: 0.5,
  extraversion: 0.5,
  agreeableness: 0.5,
  neuroticism: 0.5,
};

/** 默认人设（用户跳过 init 时使用） */
export function defaultPersona(sessionId: string): BigFivePersona {
  const now = Date.now();
  return {
    sessionId,
    ocean: { ...DEFAULT_OCEAN },
    preferences: "用户尚未描述人格偏好，使用中性默认设定。",
    createdAt: now,
    updatedAt: now,
  };
}

/** 文件路径：data/personality/{sessionId}.json */
function personaFile(dataDir: string, sessionId: string): string {
  return join(dataDir, "personality", `${sessionId}.json`);
}

/**
 * 加载某会话的人设。
 * - 文件不存在 → 返回 null（前端应弹 init modal）
 * - 文件存在但损坏 → 返回 null（用 fallback）
 */
export function loadPersonaForSession(
  dataDir: string,
  sessionId: string,
): BigFivePersona | null {
  const path = personaFile(dataDir, sessionId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as BigFivePersona;
    if (!validateOCEAN(parsed.ocean)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 保存人设到 data/personality/{sessionId}.json */
export function savePersonaForSession(
  dataDir: string,
  persona: BigFivePersona,
): void {
  const dir = join(dataDir, "personality");
  mkdirSync(dir, { recursive: true });
  persona.updatedAt = Date.now();
  writeFileSync(
    personaFile(dataDir, persona.sessionId),
    JSON.stringify(persona, null, 2),
    "utf-8",
  );
}

/** 校验 OCEAN 数值在 0-1 之间 */
export function validateOCEAN(ocean: any): ocean is OCEAN {
  if (!ocean || typeof ocean !== "object") return false;
  const keys: (keyof OCEAN)[] = [
    "openness",
    "conscientiousness",
    "extraversion",
    "agreeableness",
    "neuroticism",
  ];
  for (const k of keys) {
    if (typeof ocean[k] !== "number") return false;
    if (ocean[k] < 0 || ocean[k] > 1) return false;
  }
  return true;
}

/**
 * 校验 LLM 输出的 partial BigFivePersona（不要求 sessionId，由外部注入）
 */
export function validatePersona(p: any): p is Omit<BigFivePersona, "sessionId" | "createdAt" | "updatedAt"> {
  if (!p || typeof p !== "object") return false;
  if (typeof p.preferences !== "string") return false;
  if (!validateOCEAN(p.ocean)) return false;
  return true;
}

/**
 * oceanHint：把 0-1 数值翻译成行为描述（用于 prompt 注入）
 */
export function oceanHint(dimension: keyof OCEAN, value: number): string {
  const level = value < 0.33 ? "低" : value < 0.67 ? "中" : "高";
  switch (dimension) {
    case "openness":
      return level === "高"
        ? "高开放性：喜欢新想法、抽象概念、跨领域联想"
        : level === "中"
        ? "中等开放性：能接受新想法但不主动探索"
        : "低开放性：偏好熟悉、具体、实用的内容";
    case "conscientiousness":
      return level === "高"
        ? "高尽责性：条理清晰、自律、回复会先组织再表达"
        : level === "中"
        ? "中等尽责性：偶尔会先组织，但也会随口说"
        : "低尽责性：回复比较随性、跳跃、不太整理";
    case "extraversion":
      return level === "高"
        ? "高外向：热情、健谈、主动扩展话题"
        : level === "中"
        ? "中等外向：根据话题调整活跃度"
        : "低外向：偏好安静、内敛的对话节奏";
    case "agreeableness":
      return level === "高"
        ? "高宜人：温和、不对抗、善于共情"
        : level === "中"
        ? "中等宜人：能共情但也会直接表达不同意见"
        : "低宜人：更倾向直接挑战而非迁就";
    case "neuroticism":
      return level === "高"
        ? "高神经质：情绪敏感、易波动，对压力反应强"
        : level === "中"
        ? "中等神经质：偶尔情绪化但大体稳定"
        : "低神经质：情绪稳定、冷静、不易焦虑";
  }
}