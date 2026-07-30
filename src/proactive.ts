// src/proactive.ts
// 主动发起对话系统。
//
// 设计目标：
// - 当用户长时间未交互（idle > 阈值），系统可主动发一条消息
// - 内容基于 profile + 近期 memory + emotion patterns，不是随机寒暄
// - 每天最多 1-2 次，避开深夜时段
// - 主动消息有标记，区别于用户触发的回复
//
// 触发流程（v0.7 MVP：基于 REPL 启动时机）：
//   REPL 启动 → 加载 proactive state → 检查 shouldTriggerProactive
//   → 满足条件：side-query 生成消息 → 打印给用户（[💡 主动] 前缀）
//   → 记录 lastProactiveAt / todayCount++
//   → 每轮 turn 后记录 lastUserActivityAt
//
// 注：v0.7 没有真正的后台 cron（需要常驻进程）。
// 真实场景需要把"主动消息生成"和"投递"分离——生成可在任意时刻跑（用 systemd timer / launchd），
// 投递检查可在 REPL 启动 / 用户活跃时做。本版本做的是简化版。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "./provider.ts";
import type { Profile } from "./profile.ts";
import type { Timeline } from "./timeline.ts";

// 不再依赖 personality.ts（人格由 persona-learner 动态生成）。
// proactive 模块只需要 name + description 字段，本地定义最小接口。
type PersonaLite = { name: string; description?: string };
type Personality = PersonaLite;
import {
  scanMemory,
  formatManifest,
  type MemoryFile,
} from "./memory.ts";

// =====================================================================
// 配置
// =====================================================================

export type ProactiveConfig = {
  /** 总开关 */
  enabled: boolean;
  /** 静默阈值（小时）—— 距上次用户活动超过此时间可能触发 */
  idleThresholdHours: number;
  /** 每日最大主动消息数 */
  maxPerDay: number;
  /** 安静时段（小时 24h 制，可跨午夜，如 23-8） */
  quietHours: { start: number; end: number };
  /** 距上次主动消息的最小间隔（分钟）—— 防止短时间内连发 */
  cooldownMinutes: number;
};

export const DEFAULT_PROACTIVE_CONFIG: ProactiveConfig = {
  enabled: true,
  idleThresholdHours: 4,
  maxPerDay: 2,
  quietHours: { start: 23, end: 8 },
  cooldownMinutes: 60,
};

// =====================================================================
// 状态
// =====================================================================

export type ProactiveState = {
  /** 上次用户活动时间（消息或启动）的 ms 时间戳 */
  lastUserActivityAt: number;
  /** 上次主动消息时间的 ms 时间戳 */
  lastProactiveAt: number;
  /** 今日已发数量 */
  todayCount: number;
  /** 今日日期 YYYY-MM-DD（本地） */
  todayDate: string;
};

export const PROACTIVE_STATE_FILENAME = "proactive-state.json";

export function getProactiveStatePath(dataDir: string): string {
  return join(dataDir, PROACTIVE_STATE_FILENAME);
}

export async function loadProactiveState(
  dataDir: string,
): Promise<ProactiveState> {
  const path = getProactiveStatePath(dataDir);
  if (!existsSync(path)) {
    return {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ProactiveState>;
    return {
      lastUserActivityAt: parsed.lastUserActivityAt ?? 0,
      lastProactiveAt: parsed.lastProactiveAt ?? 0,
      todayCount: parsed.todayCount ?? 0,
      todayDate: parsed.todayDate ?? "",
    };
  } catch {
    return {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
  }
}

export async function saveProactiveState(
  dataDir: string,
  state: ProactiveState,
): Promise<void> {
  const path = getProactiveStatePath(dataDir);
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

// =====================================================================
// 时间辅助
// =====================================================================

/**
 * 本地日期 YYYY-MM-DD（用本地时区，不用 UTC，避免跨日混乱）。
 */
export function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 判断当前小时是否在安静时段。
 * 支持跨午夜（start > end，如 23-8）：
 *   - 23-8 跨午夜：hour=23 → 在；hour=0 → 在；hour=10 → 不在
 *   - 13-18 不跨：hour=15 → 在；hour=10 → 不在
 */
export function isQuietHour(
  hour: number,
  quietHours: { start: number; end: number },
): boolean {
  const { start, end } = quietHours;
  if (start <= end) {
    return hour >= start && hour < end;
  }
  // 跨午夜
  return hour >= start || hour < end;
}

// =====================================================================
// 触发决策
// =====================================================================

export type TriggerDecision = {
  should: boolean;
  reason:
    | "disabled"
    | "daily_limit"
    | "quiet_hour"
    | "not_idle_long_enough"
    | "cooldown"
    | "ok";
};

/**
 * 决定是否应该主动发起消息。
 *
 * 5 个条件（AND）：
 *   1. enabled
 *   2. todayCount < maxPerDay（新的一天重置）
 *   3. 当前时间不在 quietHours
 *   4. 距上次用户活动 >= idleThresholdHours（如果 lastUserActivityAt > 0）
 *   5. 距上次主动消息 >= cooldownMinutes（如果 lastProactiveAt > 0）
 *
 * 注意：当 lastUserActivityAt === 0（首次启动），跳过条件 4（视为一直空闲）。
 */
export function shouldTriggerProactive(
  state: ProactiveState,
  config: ProactiveConfig,
  now: Date = new Date(),
): TriggerDecision {
  if (!config.enabled) {
    return { should: false, reason: "disabled" };
  }

  const today = todayLocal(now);
  const effectiveCount = state.todayDate === today ? state.todayCount : 0;
  if (effectiveCount >= config.maxPerDay) {
    return { should: false, reason: "daily_limit" };
  }

  const hour = now.getHours();
  if (isQuietHour(hour, config.quietHours)) {
    return { should: false, reason: "quiet_hour" };
  }

  // 静默阈值：只有曾经有过用户活动时才检查（首次启动跳过）
  if (state.lastUserActivityAt > 0) {
    const idleMs = now.getTime() - state.lastUserActivityAt;
    if (idleMs < config.idleThresholdHours * 3600 * 1000) {
      return { should: false, reason: "not_idle_long_enough" };
    }
  }

  // Cooldown
  if (state.lastProactiveAt > 0) {
    const sinceProactiveMs = now.getTime() - state.lastProactiveAt;
    if (sinceProactiveMs < config.cooldownMinutes * 60 * 1000) {
      return { should: false, reason: "cooldown" };
    }
  }

  return { should: true, reason: "ok" };
}

// =====================================================================
// 状态更新辅助
// =====================================================================

/**
 * 记录一次主动消息已发出。
 */
export function recordProactiveSent(
  state: ProactiveState,
  now: Date = new Date(),
): void {
  const today = todayLocal(now);
  state.lastProactiveAt = now.getTime();
  state.todayCount = state.todayDate === today ? state.todayCount + 1 : 1;
  state.todayDate = today;
}

/**
 * 记录用户活动（消息发送 / 启动 REPL）。
 */
export function recordUserActivity(
  state: ProactiveState,
  now: Date = new Date(),
): void {
  state.lastUserActivityAt = now.getTime();
}

// =====================================================================
// 主动消息生成（side-query）
// =====================================================================

const PROACTIVE_SYSTEM_PROMPT = `你是 [PERSONALITY_NAME]，[PERSONALITY_DESCRIPTION]。

现在需要你主动给用户发一条消息。这不是回应用户的提问，是你（人格）主动想起用户、想关心一下。

**严格基于以下上下文**生成：
{context}

# 最重要的红线（绝对不能违反）

1. **绝对不能编造**——上下文中没有的东西，**绝对不能提**。例如：
   - 上下文中没有提到养猫，**绝对不能**说"饺子今天怎么样"
   - 上下文中没有提到工作内容，**绝对不能**说"那个报告写完了吗"
   - 上下文中没有提到任何具体人/事/物，**绝对不能**凭空引用
2. **只能引用上下文中出现过的具体内容**——人物名字、事件、情绪、偏好、话题
3. 如果上下文中**没有足够内容**生成有意义的消息（都是"（暂无）"或空），直接说"想你了，最近还好吗？"这种**无具体引用**但**不编造**的话
4. **绝不能**为了"显得关心"而编造细节——宁可短而空，也不能假

# 风格要求

1. **简短**——≤ 80 字
2. **语气**：符合人格（如果人格是"小阳"，就用他的轻松语气；如果是"教练"，就直接）
3. **不要问太多问题**——一两个就够
4. **不要重复最近对话的内容**——这是新的开场，不是回顾
5. **结尾自然**——让用户可以选择接或不接

格式：直接输出消息内容，不要 Markdown 标题或前缀`;

export type ProactiveContext = {
  profile: Profile | null;
  memories: MemoryFile[];
  timelineSummary: string;
  personalityName: string;
  personalityDescription: string;
};

function buildContextText(ctx: ProactiveContext): string {
  const parts: string[] = [];
  if (ctx.profile) {
    const sectionEntries = Object.entries(ctx.profile.sections);
    const nonEmpty = sectionEntries.filter(([_, body]) => {
      const trimmed = body.trim();
      return trimmed && !trimmed.startsWith("（暂无");
    });
    if (nonEmpty.length > 0) {
      parts.push("## 用户画像");
      for (const [name, body] of nonEmpty) {
        parts.push(`### ${name}\n${body.trim()}`);
      }
    }
  }
  if (ctx.memories.length > 0) {
    parts.push("\n## 近期记忆（最近 5 条）");
    parts.push(formatManifest(ctx.memories.slice(0, 5)));
  }
  if (ctx.timelineSummary) {
    parts.push("\n## 近期情绪");
    parts.push(ctx.timelineSummary);
  }
  return parts.join("\n");
}

/**
 * 从 profile / memory / timeline 提取所有"可引用关键词"，
 * 用于检测生成的消息是否真的引用了上下文。
 */
export function extractContextKeywords(ctx: ProactiveContext): Set<string> {
  const keywords = new Set<string>();
  const chineseStopwords = new Set([
    "的", "了", "在", "是", "我", "你", "他", "她", "它", "我们", "你们", "他们",
    "和", "与", "或", "但", "而", "就", "都", "也", "还", "又", "才", "要",
    "一个", "一些", "什么", "怎么", "为什么", "怎样", "哪里", "哪个",
    "今天", "昨天", "明天", "现在", "以前", "以后",
    "啊", "嗯", "哦", "呢", "吧", "嘛", "哈", "嘿", "呀", "啦",
    "很", "太", "非常", "特别", "比较", "更", "最",
  ]);

  const addWords = (text: string) => {
    // 2+ 字的连续中文字符串
    const matches = text.match(/[一-龥]{2,}/g) || [];
    for (const m of matches) {
      if (m.length > 2) {
        // 长串拆成 2-字滑窗（避免 "跟妈的关系" 整段当成 1 个关键词）
        for (let i = 0; i < m.length - 1; i++) {
          const sub = m.slice(i, i + 2);
          if (!chineseStopwords.has(sub)) keywords.add(sub);
        }
      } else {
        if (!chineseStopwords.has(m)) keywords.add(m);
      }
    }
    // 数字
    const nums = text.match(/\d+/g) || [];
    for (const n of nums) keywords.add(n);
    // 英文 4+ 字符
    const en = text.match(/[a-zA-Z]{4,}/g) || [];
    for (const e of en) keywords.add(e.toLowerCase());
  };

  if (ctx.profile) {
    for (const body of Object.values(ctx.profile.sections)) {
      addWords(body);
    }
  }
  for (const mem of ctx.memories) {
    addWords(mem.name + " " + mem.description + " " + mem.body);
  }
  if (ctx.timelineSummary) {
    addWords(ctx.timelineSummary);
  }

  return keywords;
}

/**
 * 验证生成的消息是否真的引用了上下文。
 *
 * 算法：消息中至少要包含 1 个从上下文提取的关键词（长度 >= 2）。
 * 短句模板（如"想你了，最近还好吗？"）也会通过——因为不编造就 OK。
 */
export function validateProactiveMessage(
  message: string,
  ctx: ProactiveContext,
): { valid: boolean; reason: string; matchedKeywords: string[] } {
  const keywords = extractContextKeywords(ctx);

  // 收集消息中所有"具体词"（中文 2-字 + 3-字 substring + 英文/数字 4+ 字符）
  const specificTokens = new Set<string>();

  // 中文：滑窗 2-字 + 3-字 substring
  for (let i = 0; i < message.length - 1; i++) {
    const sub = message.slice(i, i + 2);
    if (/[一-龥]{2}/.test(sub)) specificTokens.add(sub);
  }
  for (let i = 0; i < message.length - 2; i++) {
    const sub = message.slice(i, i + 3);
    if (/[一-龥]{3}/.test(sub)) specificTokens.add(sub);
  }
  // 英文：3+ 字符单词
  const enWords = message.match(/[a-zA-Z]{3,}/g) || [];
  for (const w of enWords) specificTokens.add(w.toLowerCase());
  // 数字
  const nums = message.match(/\d+/g) || [];
  for (const n of nums) specificTokens.add(n);

  // 通用 2-字和 3-字短语（不视为具体名词）
  const genericBigrams = new Set([
    "你的", "你妈", "我妈", "他她", "我们", "你们", "他们",
    "最近", "之前", "以后", "现在", "以前", "今天", "明天",
    "怎么", "如何", "怎样", "什么", "哪样", "这个", "那个",
    "好了", "完了", "觉得", "感觉", "以为", "觉得", "知道",
    "想我", "想你", "想到", "突然", "一会", "一下", "一会",
    "可以", "应该", "能够", "大概", "也许", "或者",
    "时候", "地方", "东西", "事情", "问题", "情况", "觉得",
    "一些", "这个", "那个", "这样", "那样", "怎么",
    "说话", "聊天", "生活", "工作", "学习", "睡觉", "吃饭",
    "今天", "明天", "后天", "早上", "晚上", "中午", "下午",
  ]);
  const genericTrigrams = new Set([
    "想你了", "在干嘛", "还好吗", "在吗", "最近怎么样",
    "吃饭了吗", "睡觉了吗", "今天怎么样",
  ]);

  // 过滤掉通用短语（2-字 和 3-字）
  // 关键：如果 2-字 substring 完整包含在某个 3-字通用短语里，也算通用
  // （例如 "想你" 和 "你了" 都在 "想你了" 里）
  const genericBigramsExpanded = new Set(genericBigrams);
  for (const tri of genericTrigrams) {
    for (let i = 0; i < tri.length - 1; i++) {
      genericBigramsExpanded.add(tri.slice(i, i + 2));
    }
  }
  const specificSubstrings: string[] = [];
  for (const tok of specificTokens) {
    if (genericBigramsExpanded.has(tok) || genericTrigrams.has(tok)) continue;
    specificSubstrings.push(tok);
  }

  // 检查每个具体词是否在 context 里
  const matched: string[] = [];
  for (const tok of specificSubstrings) {
    if (keywords.has(tok)) {
      if (!matched.includes(tok)) matched.push(tok);
    }
  }

  // 规则 1：消息有具体词 → 至少 1 个要在 context 里
  if (specificSubstrings.length > 0 && matched.length === 0) {
    return {
      valid: false,
      reason: `消息包含具体词 [${specificSubstrings
        .slice(0, 5)
        .join(", ")}] 但上下文里没有 — 疑似编造`,
      matchedKeywords: [],
    };
  }

  // 规则 2：消息全是通用词（"想你了"、"在吗"）→ OK
  if (matched.length === 0) {
    return { valid: true, reason: "消息无具体引用（仅通用短语）", matchedKeywords: [] };
  }

  return { valid: true, reason: "引用了上下文关键词", matchedKeywords: matched };
}

/**
 * 安全的 fallback 消息（绝不编造）。
 */
function safeFallback(personalityName: string, hasContext: boolean): string {
  if (!hasContext) {
    return "想你了，最近还好吗？";
  }
  return "在吗？突然想到你了。";
}

/**
 * 调用 LLM 生成主动消息。
 *
 * 关键不变量（**绝不能违反**）：
 * 1. 消息中提到的任何具体内容（人/事/物/数字/书名/猫名等）必须来自上下文
 * 2. 如果上下文为空，**只能**用"想你了"这种无具体引用的安全 fallback
 * 3. validateProactiveMessage 失败时回退到 safeFallback，**绝不**输出原 LLM 结果
 *
 * 失败容错：返回 safeFallback（绝不返回空字符串，避免 REPL 出错）。
 */
export async function generateProactiveMessage(
  provider: ModelProvider,
  personality: Personality,
  ctx: ProactiveContext,
): Promise<string> {
  const contextText = buildContextText(ctx);
  const hasContext = contextText && contextText !== "（暂无上下文）";

  // 上下文为空时直接用 fallback（不浪费 LLM 调用）
  if (!hasContext) {
    return safeFallback(personality.name, false);
  }

  const prompt = PROACTIVE_SYSTEM_PROMPT
    .replace("[PERSONALITY_NAME]", personality.name)
    .replace(
      "[PERSONALITY_DESCRIPTION]",
      personality.description || "情感陪伴对话助手",
    )
    .replace("{context}", contextText);

  let raw = "";
  try {
    raw = await provider.complete({
      model: provider.model,
      params: {
        system: prompt,
        messages: [
          { role: "user", content: "请基于上下文生成一条主动消息" },
        ],
        maxTokens: 200,
        temperature: 0.7,
      },
    });
  } catch {
    return safeFallback(personality.name, true);
  }

  const message = raw.trim().slice(0, 500);

  // 验证：消息是否真的引用了上下文？没引用就丢弃（防止编造）
  const validation = validateProactiveMessage(message, ctx);
  if (!validation.valid) {
    console.warn(
      `[proactive] 拒绝编造的消息：${message.slice(0, 50)}... 原因: ${validation.reason}`,
    );
    return safeFallback(personality.name, true);
  }

  return message;
}

// =====================================================================
// 一站式：gather context + generate
// =====================================================================

export type GatherProactiveInput = {
  dataDir: string;
  memoryDir: string;
  timeline: Timeline;
  profile: Profile | null;
  personality: Personality;
};

/**
 * 收集主动消息所需的所有上下文 + 调用 LLM 生成。
 */
export async function prepareProactiveMessage(
  provider: ModelProvider,
  input: GatherProactiveInput,
): Promise<string> {
  const memories = await scanMemory(input.memoryDir);
  const timelineSummary = await input.timeline.renderSummary(7);

  return generateProactiveMessage(provider, input.personality, {
    profile: input.profile,
    memories,
    timelineSummary,
    personalityName: input.personality.name,
    personalityDescription: input.personality.description || "",
  });
}