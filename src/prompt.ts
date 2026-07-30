// src/prompt.ts
// 5 层系统 prompt 组装器，但第 0 层从"硬编码 persona"改成"动态 persona"。
//
// 第 0 层：动态人设（基于反馈学习，每次都可能不同）
// 第 1 层：核心记忆索引（MEMORY.md）
// 第 1.5 层：用户画像（Profile）—— 长期事实快照
// 第 2 层：情境上下文（当轮 side-query 结果：情绪 + 召回记忆 + 情绪轨迹）
// 第 3 层：当前会话（消息历史，由模型 API 自己处理）

import type { MemoryFile } from "./memory.ts";
import type { Timeline } from "./timeline.ts";
import type { EmotionDetection } from "./classify.ts";
import type { Profile, ProfileSection } from "./profile.ts";
import type { LearnerState } from "./persona-learner.ts";
import { buildDynamicPersona } from "./persona-learner.ts";
import type { BigFivePersona } from "./bigfive.ts";
import { oceanHint, validateOCEAN } from "./bigfive.ts";

// =====================================================================
// 第 0 层：动态人设（基于反馈学习）
// =====================================================================

/**
 * 第 0 层：动态 persona。
 *
 * v0.15.0 设计：不再有预定义的人格文件。人设由 persona-learner 根据用户历史反馈动态生成。
 * - 冷启动（无任何反馈）：返回空白起点提示（"你是一个真实的人……"）
 * - 有反馈后：根据用户的偏好 top 选择生成自然语言指令
 *
 * 这一层不约束格式（不强制 markdown/动作描写限制），让 LLM 自由发挥。
 */
function layer0_dynamic_persona(learner: LearnerState): string {
  return `## 主人格（动态生成）

${buildDynamicPersona(learner)}`;
}

// =====================================================================
// 第 1 层：核心记忆（MEMORY.md 索引）
// =====================================================================

function layer1_memory(memoryIndex: string): string {
  if (!memoryIndex.trim()) {
    return `## 记忆系统

（还没有记忆。在对话中，如果用户提到重要的个人信息、偏好、生活事件，你可以告诉我帮你记住。）`;
  }

  return `## 记忆系统（按类型组织的索引）

${memoryIndex}

> 阅读说明：
> - 上方索引列出所有主题文件
> - 详细记忆已在另一个上下文块按需注入
> - 引用记忆前，确认它仍然准确（用户的偏好和情绪都可能变化）`;
}

// =====================================================================
// 第 1.5 层：用户画像（Profile）—— 长期事实快照
// =====================================================================

/**
 * 把 Profile 渲染成 prompt 注入段。
 *
 * 设计要点：
 * - 即使 profile 完全为空，也保留一个"（暂无）"的占位段，
 *   让模型知道有这个概念存在，下次对话就会主动识别并补全。
 * - 强调"历史快照不是当前状态"，避免模型被旧画像绑架。
 *
 * 注意：不再从 profile 文本自动派生"行为提醒"硬指令。
 * 用户偏好应该通过反馈学习循环（feedback-detector + persona-learner）
 * 从对话中自然积累，而不是由开发者 regex 强制。
 */
function layer1_5_profile(profile: Profile | null): string {
  if (!profile) {
    return `## 用户画像（Profile）

（暂无——这是首次对话，profile 会在对话过程中自动累积。）`;
  }

  const sections = PROFILE_SECTIONS.map((name) => {
    const body = profile.sections[name]?.trim();
    if (!body || body === "（暂无）" || body.startsWith("（暂无")) return null;
    return { name: name as ProfileSection, body };
  }).filter((x): x is { name: ProfileSection; body: string } => x !== null);

  if (sections.length === 0) {
    return `## 用户画像（Profile）

（暂无内容——等用户透露更多信息后自动填充。）`;
  }

  const body = sections
    .map((s) => `### ${s.name}\n${s.body}`)
    .join("\n\n");

  return `## 用户画像（Profile）

> 用户长期画像，从历史对话累积而来。**这是历史快照，不是当前状态。**
> 用户当下的情绪/态度以本轮 side-query 识别结果为准，不要被画像里的旧印象绑架。

${body}`;
}

// 需要重新定义（避免循环依赖）
const PROFILE_SECTIONS = [
  "基本信息",
  "沟通风格",
  "关注议题",
  "已知偏好与禁忌",
  "长期情绪基线",
  "近期变化",
] as const;

// =====================================================================
// 第 2 层：情境上下文
// =====================================================================

function layer2_context(params: {
  emotion: EmotionDetection | null;
  recalledMemories: MemoryFile[];
  timelineSummary: string;
}): string {
  const { emotion, recalledMemories, timelineSummary } = params;
  const parts: string[] = [];

  parts.push(`## 当前情境\n`);

  if (emotion) {
    const intensityBar = "▓".repeat(Math.round(emotion.intensity * 10));
    parts.push(
      `**用户当下情绪**：${emotion.emotion}（强度 ${(emotion.intensity * 100).toFixed(0)}% ${intensityBar}）`,
    );
    if (emotion.trigger) {
      parts.push(`**推测触发器**：${emotion.trigger}`);
    }
    parts.push(
      `\n> 用户当下情绪强度较高时，自然地先承接情绪再回应内容。\n`,
    );
  } else {
    parts.push(`**用户当下情绪**：未识别（可能很平淡）\n`);
  }

  // 召回的记忆：v0.5 优先级 event > emotion > reference
  if (recalledMemories.length > 0) {
    parts.push(`\n## 召回的相关记忆\n`);
    const priority: Record<string, number> = {
      event: 0,
      emotion: 1,
      reference: 2,
    };
    const sorted = [...recalledMemories].sort(
      (a, b) =>
        (priority[a.subtype] ?? 99) - (priority[b.subtype] ?? 99),
    );
    for (const m of sorted) {
      parts.push(
        `### [${m.subtype}] ${m.name}\n> ${m.description}\n\n${m.body}\n`,
      );
    }
  }

  // 情绪时间线
  parts.push(`\n## 用户情绪轨迹\n\n${timelineSummary}\n`);

  return parts.join("\n");
}

// =====================================================================
// 组装完整 system prompt
// =====================================================================

// =====================================================================
// 第 0 层：人设 + 反馈学习（v0.17.0 合并）
// =====================================================================

/**
 * 第 0 层：人设 body + 反馈学习合并。
 *
 * - 人设是**软引导**（personaBody 来自 personality/default.md）
 *   给 LLM 一个角色锚点（"你是 X"），但不是硬规则
 * - 反馈学习是**具体偏好**（patterns + examples）
 *   来自 persona-learner，基于用户实际反馈
 * - **反馈优先于人设**：用户说"不要 X"时，LLM 必须尊重
 *
 * 输出：人设 → 反馈 patterns → 示例 → 核心原则
 */
function layer0_persona(persona: BigFivePersona | null, learner: LearnerState): string {
  const lines: string[] = [];

  // 1. OCEAN 大五人设
  if (persona && validateOCEAN(persona.ocean)) {
    lines.push("【大五人格】（参考，soft）");
    const o = persona.ocean;
    lines.push(`- Openness: ${o.openness.toFixed(2)}（${oceanHint("openness", o.openness)}）`);
    lines.push(`- Conscientiousness: ${o.conscientiousness.toFixed(2)}（${oceanHint("conscientiousness", o.conscientiousness)}）`);
    lines.push(`- Extraversion: ${o.extraversion.toFixed(2)}（${oceanHint("extraversion", o.extraversion)}）`);
    lines.push(`- Agreeableness: ${o.agreeableness.toFixed(2)}（${oceanHint("agreeableness", o.agreeableness)}）`);
    lines.push(`- Neuroticism: ${o.neuroticism.toFixed(2)}（${oceanHint("neuroticism", o.neuroticism)}）`);

    if (persona.preferences.trim()) {
      lines.push("");
      lines.push("【用户描述的角色偏好】");
      lines.push(persona.preferences);
    }
  }

  // 2. 反馈学习（buildDynamicPersona 已经包含核心原则段）
  const dynamic = buildDynamicPersona(learner);
  if (dynamic.trim()) {
    if (lines.length > 0) lines.push("");
    lines.push(dynamic);
  }

  // 3. 优先级声明（如果两者都有）
  if (persona && learnerHasFeedback(learner)) {
    lines.push("");
    lines.push("【优先级】反馈学习 > 人设。当用户明确说'不喜欢 X'时，以反馈为准，灵活调整人设风格。");
  }

  return lines.join("\n");
}

function learnerHasFeedback(learner: LearnerState): boolean {
  return (
    learner.positivePatterns.length > 0 ||
    learner.negativePatterns.length > 0 ||
    learner.positiveExamples.length > 0 ||
    learner.negativeExamples.length > 0
  );
}

export function buildSystemPrompt(params: {
  /** v0.18.0：OCEAN 大五人设（按 sessionId 加载） */
  persona: BigFivePersona | null;
  /** v0.15.0：动态人设学习器（来自反馈） */
  personaLearner: LearnerState;
  memoryIndex: string;
  /** v0.3：用户画像（首次启动可能为 null → 用占位符） */
  profile: Profile | null;
  emotion: EmotionDetection | null;
  recalledMemories: MemoryFile[];
  timeline: Timeline;
}): Promise<string> {
  const layer2 = layer2_context({
    emotion: params.emotion,
    recalledMemories: params.recalledMemories,
    timelineSummary: "(情绪时间线加载中...)",
  });

  // 第 0 + 1 + 1.5 + 2 层都是静态或缓存友好的，可以走 prompt cache
  // 第 2 层里的 timelineSummary 每次都变（如果它变了整层都要变）
  // 但我们可以把 timelineSummary 单独处理：默认不注入，每次主动查询时再注入
  //
  // MVP 简化：每次都重新组装整个 prompt。生产环境再优化缓存。

  // 不再注入"应对模式"硬规则。LLM 让人设 + 用户消息自己驱动回复深度。
  // 模式分类（HOLD/INSIGHT/CHITCHAT 等）作为 metadata 保留（用于调试/分析），但不进 prompt。

  const prompt = [
    layer1_memory(params.memoryIndex),
    layer1_5_profile(params.profile),
    layer2,
    layer0_persona(params.persona, params.personaLearner),
  ]
    .filter((s) => s.trim().length > 0)
    .join("\n\n---\n\n");

  // 异步渲染 timeline 摘要（因为 Timeline.read 是 async）
  return Promise.all([Promise.resolve(prompt), params.timeline.renderSummary(5)]).then(
    ([base, timelineSummary]) => {
      const layer2Final = layer2_context({
        emotion: params.emotion,
        recalledMemories: params.recalledMemories,
        timelineSummary,
      });
      return [
        layer1_memory(params.memoryIndex),
        layer1_5_profile(params.profile),
        layer2Final,
        layer0_persona(params.persona, params.personaLearner),
      ]
        .filter((s) => s.trim().length > 0)
        .join("\n\n---\n\n");
    },
  );
}