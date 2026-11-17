// src/profile.ts
// 用户画像系统（Profile）。
//
// v0.21 重构：抽象 + 动态分析用户人格
//
// profile 不再是 memory 堆积的目录视图，而是**对 memory/learner/timeline 的抽象沉淀**。
//
// 两个 OCEAN 严格区分：
// - **session BigFivePersona.ocean**（`data/personality/{sessionId}.json`，用户 init 时 LLM 翻译的）
//   → 决定 LLM **该怎么说话**（行为层 / 对话风格）
// - **profile ocean**（`data/profile/PROFILE.md` frontmatter，从历史/memory/learner 推算）
//   → 帮 LLM **理解用户是什么样的人**（认知层 / 用户画像）
//
// 两者独立并存，profile ocean 不替代 persona。
//
// 段 1/2/6 由 LLM 抽取更新（基本信息、沟通风格、近期变化）
// 段 3/4/5 由 LLM 摘要更新（关注议题、已知偏好、长期情绪基线）—— 不再是机械列表
// 同时 push profile.ocean 到 frontmatter

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ModelProvider } from "./provider.ts";
import type { LearnerState } from "./persona-learner.ts";
import { loadLearner } from "./persona-learner.ts";
import { scanMemory, type MemoryFile } from "./memory.ts";
import type { Timeline } from "./timeline.ts";
import {
  parseContextFile,
  serializeContextFile,
  PROFILE_SECTIONS as CONTEXT_PROFILE_SECTIONS,
  PROFILE_FILENAME,
  getProfilePath,
  type ProfileSection,
  type ContextFileMeta,
} from "./context-file.ts";
import { oceanHint } from "./bigfive.ts";

// =====================================================================
// 类型定义
// =====================================================================

export const PROFILE_SECTIONS = CONTEXT_PROFILE_SECTIONS;
export { PROFILE_FILENAME, getProfilePath };
export type { ProfileSection };

/**
 * 动态推算的"用户是什么样的人"。
 *
 * 注意：这是**认知层**，跟 session BigFivePersona.ocean（行为层）独立。
 * profile.ocean 帮 LLM 理解用户；session persona 告诉 LLM 怎么说话。
 */
export type ProfileOcean = {
  openness: number;
  conscientiousness: number;
  extraversion: number;
  agreeableness: number;
  neuroticism: number;
  /** 推算依据摘要（哪段 history / memory 导致这个数值） */
  basis: string;
};

export type Profile = {
  /** 6 段内容（key = 段落名，value = 段落正文） */
  sections: Record<ProfileSection, string>;
  /** 动态推算的"用户是什么样的人" */
  ocean: ProfileOcean | null;
  /** 最后一次 OCEAN 推算时间（ms） */
  oceanUpdatedAt: number;
  /** 文件路径 */
  path: string;
  /** 最后更新时间（ms） */
  updatedAt: number;
  /** 是否是首次初始化 */
  initialized: boolean;
  /** frontmatter 元数据 */
  meta: ContextFileMeta;
};

// =====================================================================
// 默认模板
// =====================================================================

const DEFAULT_META: ContextFileMeta = {
  name: "用户画像",
  version: "0.7",
  description: "用户长期画像，v0.21 抽象 + 动态推算",
  author: "rememberme",
  kind: "profile",
};

const DEFAULT_BODY = `> 自动从对话中累积维护。每次对话开始前注入到 system prompt。
> 段 1/2 由 LLM 抽取，段 3/4/5/6 由 LLM 摘要（v0.21 改造）。
> frontmatter 的 ocean_* 字段是动态推算的"用户认知画像"，与 session persona 独立。

## 1. 基本信息
- 昵称：未知
- 性别：未知
- 年龄段：未知
- 职业：未知
- 所在地：未知

## 2. 沟通风格
- （暂无——等用户表现出偏好后再填）

## 3. 关注议题
- （暂无——从 memory/event 抽象汇总）

## 4. 已知偏好与禁忌
- （暂无——从反馈学习抽象汇总）

## 5. 长期情绪基线
- （暂无——从 memory/emotion 抽象汇总）

## 6. 近期变化
- （暂无——从 timeline 抽象汇总）`;

// =====================================================================
// 加载 / 保存
// =====================================================================

/**
 * 从 frontmatter 解析 ProfileOcean 字段。
 */
function readOceanFromMeta(meta: ContextFileMeta): ProfileOcean | null {
  const get = (key: string): string | undefined => {
    const v = (meta as Record<string, unknown>)[key];
    return typeof v === "string" ? v : undefined;
  };
  const o = meta as Record<string, unknown>;
  const openness = Number(o.ocean_openness);
  const conscientiousness = Number(o.ocean_conscientiousness);
  const extraversion = Number(o.ocean_extraversion);
  const agreeableness = Number(o.ocean_agreeableness);
  const neuroticism = Number(o.ocean_neuroticism);
  if (
    [openness, conscientiousness, extraversion, agreeableness, neuroticism].some(
      (n) => Number.isNaN(n),
    )
  ) {
    return null;
  }
  return {
    openness,
    conscientiousness,
    extraversion,
    agreeableness,
    neuroticism,
    basis: get("ocean_basis") ?? "",
  };
}

/**
 * 把 ProfileOcean 写入 meta。
 */
function writeOceanToMeta(
  meta: ContextFileMeta,
  ocean: ProfileOcean,
  oceanUpdatedAt: number,
): void {
  const m = meta as Record<string, unknown>;
  m.ocean_openness = ocean.openness.toFixed(2);
  m.ocean_conscientiousness = ocean.conscientiousness.toFixed(2);
  m.ocean_extraversion = ocean.extraversion.toFixed(2);
  m.ocean_agreeableness = ocean.agreeableness.toFixed(2);
  m.ocean_neuroticism = ocean.neuroticism.toFixed(2);
  m.ocean_basis = ocean.basis;
  m.ocean_updated_at = new Date(oceanUpdatedAt).toISOString();
}

/**
 * 加载 profile，自动从其他数据源同步段 3/4/5/6 + 推算 ocean。
 *
 * @param dataDir  data 根目录
 * @param options.userId  用户 ID（用于加载 learner state）
 * @param options.memoryDir  memory 目录
 * @param options.timeline  Timeline 实例
 * @param options.provider  LLM provider（用于 v0.21 摘要推算；不传则用机械列表 fallback）
 */
export async function loadProfile(
  dataDir: string,
  options?: {
    userId?: string;
    memoryDir?: string;
    timeline?: Timeline;
    provider?: ModelProvider;
  },
): Promise<Profile> {
  const path = getProfilePath(dataDir);
  const dir = path.replace(/[/\\][^/\\]+$/, "");

  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    const initialContent = serializeContextFile(DEFAULT_META, DEFAULT_BODY);
    await writeFile(path, initialContent, "utf-8");
    const ctx = parseContextFile(initialContent, path);
    const profile: Profile = {
      sections: ctx.structuredSections ?? emptySections(),
      ocean: readOceanFromMeta(ctx.meta),
      oceanUpdatedAt: 0,
      path,
      updatedAt: Date.now(),
      initialized: true,
      meta: ctx.meta,
    };
    await syncFromSources(profile, dataDir, options);
    await saveProfile(profile);
    return profile;
  }

  const raw = await readFile(path, "utf-8");
  const ctx = parseContextFile(raw, path);
  const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
  const profile: Profile = {
    sections: ctx.structuredSections ?? emptySections(),
    ocean: readOceanFromMeta(ctx.meta),
    oceanUpdatedAt:
      (ctx.meta as Record<string, unknown>).ocean_updated_at &&
      typeof (ctx.meta as Record<string, unknown>).ocean_updated_at === "string"
        ? new Date(
            (ctx.meta as Record<string, unknown>).ocean_updated_at as string,
          ).getTime()
        : 0,
    path,
    updatedAt: stats.mtimeMs,
    initialized: false,
    meta: ctx.meta,
  };
  await syncFromSources(profile, dataDir, options);
  await saveProfile(profile);
  return profile;
}

/**
 * 把 profile 写入磁盘。
 */
export async function saveProfile(profile: Profile): Promise<void> {
  // 把 ocean 写回 meta（ocean_* 字段会被 serializeContextFile 之外的逻辑处理）
  if (profile.ocean) {
    writeOceanToMeta(profile.meta, profile.ocean, profile.oceanUpdatedAt);
  }
  const body = serializeProfileBody(profile.sections);
  const content = serializeContextFile(profile.meta, body);
  // 在 serializeContextFile 之后再附加 ocean_* 字段（因为它只处理固定 5 个字段）
  if (profile.ocean) {
    const oceanLines: string[] = [];
    const o = profile.ocean;
    oceanLines.push(`- **ocean_openness**：${o.openness.toFixed(2)}`);
    oceanLines.push(`- **ocean_conscientiousness**：${o.conscientiousness.toFixed(2)}`);
    oceanLines.push(`- **ocean_extraversion**：${o.extraversion.toFixed(2)}`);
    oceanLines.push(`- **ocean_agreeableness**：${o.agreeableness.toFixed(2)}`);
    oceanLines.push(`- **ocean_neuroticism**：${o.neuroticism.toFixed(2)}`);
    oceanLines.push(`- **ocean_basis**：${o.basis}`);
    oceanLines.push(`- **ocean_updated_at**：${new Date(profile.oceanUpdatedAt).toISOString()}`);
    // 在 body 之后插入（frontmatter 之后，body 之前）
    const idx = content.indexOf("\n\n# 用户画像（Profile）");
    if (idx > 0) {
      const final = content.slice(0, idx) + "\n" + oceanLines.join("\n") + content.slice(idx);
      await writeFile(profile.path, final, "utf-8");
    } else {
      await writeFile(profile.path, content, "utf-8");
    }
  } else {
    await writeFile(profile.path, content, "utf-8");
  }
  profile.updatedAt = Date.now();
}

function serializeProfileBody(
  sections: Record<ProfileSection, string>,
): string {
  const lines: string[] = [
    "# 用户画像（Profile）",
    "",
    "> 自动从对话中累积维护。每次对话开始前注入到 system prompt。",
    "> 段 1/2 由 LLM 抽取，段 3/4/5/6 由 LLM 摘要（v0.21 改造）。",
    "> frontmatter 的 ocean_* 字段是动态推算的『用户认知画像』，与 session persona 独立。",
    "",
  ];
  PROFILE_SECTIONS.forEach((name, i) => {
    const content = sections[name]?.trim() || "（暂无）";
    lines.push(`## ${i + 1}. ${name}`);
    lines.push(content);
    lines.push("");
  });
  return lines.join("\n");
}

function emptySections(): Record<ProfileSection, string> {
  const out = {} as Record<ProfileSection, string>;
  for (const s of PROFILE_SECTIONS) out[s] = "";
  return out;
}

function joinSafe(parent: string, child: string): string {
  return parent.endsWith("/") || parent.endsWith("\\")
    ? parent + child
    : parent + "/" + child;
}

// =====================================================================
// v0.21 摘要：调 LLM 把所有数据消化成结构化输出
// =====================================================================

/**
 * summarizeForProfile 输入。
 */
export type ProfileSources = {
  memories: MemoryFile[];
  learner: LearnerState;
  timelineSummary: string;
};

/**
 * summarizeForProfile 输出（LLM JSON）。
 */
export type ProfileSummary = {
  ocean: ProfileOcean | null;
  abstractTopics: string[];
  persistentPreferences: string[];
  persistentEmotionPatterns: string[];
  recentChanges: string[];
};

const SUMMARY_SYSTEM_PROMPT = `你是用户认知分析师。下面是用户的所有历史记忆、反馈学习观察、近期情绪时间线。

**任务**：抽象、归并、聚类出"用户是什么样的人"，**不是** LLM 该怎么说话。

**v0.21 输出严格按以下 JSON**（不要 Markdown 代码块）：

{
  "ocean": {
    "openness": 0.0-1.0,
    "conscientiousness": 0.0-1.0,
    "extraversion": 0.0-1.0,
    "agreeableness": 0.0-1.0,
    "neuroticism": 0.0-1.0,
    "basis": "推算依据（哪段对话 / 哪些 memory 导致这个数值，1-2 句话）"
  },
  "abstractTopics": [
    "主题级抽象议题 1（不是文件名，是归纳出的主题）",
    "主题级抽象议题 2"
  ],
  "persistentPreferences": [
    "持久偏好 1（从反馈学习观察归纳，不是单条原话）",
    "持久偏好 2"
  ],
  "persistentEmotionPatterns": [
    "情绪模式名 → 触发：xxx → 表现：xxx",
    "情绪模式名 → 触发：xxx → 表现：xxx"
  ],
  "recentChanges": [
    "最近变化趋势 1（不超过 7 天）",
    "最近变化趋势 2"
  ]
}

**严格要求**：

1. **抽象，不堆积**：
   - 10 条 emotion memory → 总结为 2-3 个情绪模式（不列文件名）
   - 20 条 learner pattern → 总结为 3-5 条持久偏好（去重、合并、归纳）
   - 5 条 event memory → 总结为 2-4 个议题主题

2. **OCEAN 数值要基于实际行为信号**：
   - 用户反复提到哲学/文学/跨领域话题 → openness 高
   - 用户对话题回避、转移 → 可能在某些维度低
   - 不猜测；信号不足就 0.5（中性）

3. **basis 必须引用证据**：不要凭空给数字，说"基于 X、Y"

4. **空数组合法**：没有信号时该段就是空数组（不要硬凑）

5. **不要重复**同样的事情到不同段

下面是用户的全部数据：

=== Memory 文件清单 ===
{memoryList}

=== Memory 文件正文（仅情绪模式 + 生活事件）===
{memoryBodies}

=== 反馈学习观察 ===
{learnerPatterns}

=== 近期情绪时间线 ===
{timelineSummary}`;

/**
 * 调 LLM 把所有数据源消化成结构化摘要。
 * 失败容错：返回空摘要。
 */
export async function summarizeForProfile(
  provider: ModelProvider,
  sources: ProfileSources,
): Promise<ProfileSummary> {
  const empty: ProfileSummary = {
    ocean: null,
    abstractTopics: [],
    persistentPreferences: [],
    persistentEmotionPatterns: [],
    recentChanges: [],
  };

  try {
    const memList = sources.memories
      .map((m) => `[${m.subtype}] ${m.name} — ${m.description || "(无描述)"}`)
      .join("\n");
    const memBodies = sources.memories
      .filter((m) => m.subtype === "emotion" || m.subtype === "event")
      .map(
        (m) =>
          `### [${m.subtype}] ${m.name}\ntrigger: ${(m.fields as Record<string, unknown>).trigger ?? ""}\nmanifestation: ${(m.fields as Record<string, unknown>).manifestation ?? ""}\nemotional_impact: ${(m.fields as Record<string, unknown>).emotional_impact ?? ""}\nbody: ${m.body.slice(0, 300)}`,
      )
      .join("\n\n");
    const learnerPatterns = [
      ...((sources.learner.positivePatterns ?? []).slice(-15).map((p) => `+ ${p}`)),
      ...((sources.learner.negativePatterns ?? []).slice(-15).map((p) => `- ${p}`)),
    ].join("\n");

    const userPrompt = SUMMARY_SYSTEM_PROMPT
      .replace("{memoryList}", memList || "（无）")
      .replace("{memoryBodies}", memBodies || "（无）")
      .replace("{learnerPatterns}", learnerPatterns || "（无）")
      .replace("{timelineSummary}", sources.timelineSummary || "（无）");

    const raw = await provider.complete({
      model: provider.model,
      params: {
        system: "你是用户认知分析师，输出严格 JSON。",
        messages: [{ role: "user", content: userPrompt }],
        maxTokens: 1500,
        temperature: 0.3,
      },
    });

    const cleaned = raw
      .trim()
      .replace(/^```(?:json)?\n?/i, "")
      .replace(/\n?```\s*$/, "")
      .trim();

    if (process.env.EC_DEBUG_PROFILE) {
      console.log("[profile.summarize] cleaned:", cleaned.slice(0, 200));
    }

    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return empty;

    const parsed = JSON.parse(match[0]);

    // 校验 OCEAN
    let ocean: ProfileOcean | null = null;
    const o = parsed.ocean;
    if (o && typeof o === "object") {
      const vals = [o.openness, o.conscientiousness, o.extraversion, o.agreeableness, o.neuroticism];
      if (vals.every((v) => typeof v === "number" && v >= 0 && v <= 1)) {
        ocean = {
          openness: vals[0],
          conscientiousness: vals[1],
          extraversion: vals[2],
          agreeableness: vals[3],
          neuroticism: vals[4],
          basis: typeof o.basis === "string" ? o.basis.slice(0, 300) : "",
        };
      }
    }

    return {
      ocean,
      abstractTopics: Array.isArray(parsed.abstractTopics)
        ? parsed.abstractTopics.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 200))
        : [],
      persistentPreferences: Array.isArray(parsed.persistentPreferences)
        ? parsed.persistentPreferences.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 200))
        : [],
      persistentEmotionPatterns: Array.isArray(parsed.persistentEmotionPatterns)
        ? parsed.persistentEmotionPatterns.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 200))
        : [],
      recentChanges: Array.isArray(parsed.recentChanges)
        ? parsed.recentChanges.filter((x: unknown) => typeof x === "string").map((x: string) => x.slice(0, 200))
        : [],
    };
  } catch {
    return empty;
  }
}

// =====================================================================
// 同步：从其他数据源填充段 3/4/5/6 + 推算 profile.ocean
// =====================================================================

/**
 * v0.21：从数据源同步。
 * - 有 provider：调 summarizeForProfile 摘要（推荐路径）
 * - 无 provider：fallback 到 v0.20 机械列表
 */
export async function syncFromSources(
  profile: Profile,
  dataDir: string,
  options?: {
    userId?: string;
    memoryDir?: string;
    timeline?: Timeline;
    provider?: ModelProvider;
  },
): Promise<void> {
  const memoryDir = options?.memoryDir ?? joinSafe(dataDir, "memory");
  const userId = options?.userId ?? "default";
  const learner = loadLearner(dataDir, userId);
  const memories = await scanMemory(memoryDir);
  const timelineSummary = options?.timeline
    ? await options.timeline.renderSummary(10)
    : "";

  // v0.21 推荐路径：调 LLM 摘要
  if (options?.provider) {
    try {
      const summary = await summarizeForProfile(options.provider, {
        memories,
        learner,
        timelineSummary,
      });

      if (summary.ocean) {
        profile.ocean = summary.ocean;
        profile.oceanUpdatedAt = Date.now();
      }
      if (summary.abstractTopics.length > 0) {
        profile.sections["关注议题"] = summary.abstractTopics
          .map((t) => `- ${t}`)
          .join("\n");
      }
      if (summary.persistentPreferences.length > 0) {
        profile.sections["已知偏好与禁忌"] = [
          "**用户持久偏好（从反馈学习总结）：**",
          ...summary.persistentPreferences.map((p) => `- ${p}`),
        ].join("\n");
      }
      if (summary.persistentEmotionPatterns.length > 0) {
        profile.sections["长期情绪基线"] = summary.persistentEmotionPatterns
          .map((p) => `- ${p}`)
          .join("\n");
      }
      if (summary.recentChanges.length > 0) {
        profile.sections["近期变化"] = [
          "**最近变化趋势：**",
          ...summary.recentChanges.map((c) => `- ${c}`),
        ].join("\n");
      }
      return;
    } catch {
      // fall through to fallback
    }
  }

  // Fallback：v0.20 机械列表（用于无 provider 或 LLM 调用失败）
  await syncFromSourcesFallback(profile, memories, learner, timelineSummary);
}

async function syncFromSourcesFallback(
  profile: Profile,
  memories: MemoryFile[],
  learner: LearnerState,
  timelineSummary: string,
): Promise<void> {
  // 段 3：从 memory/event/*.md 聚合
  const events = memories.filter((m) => m.subtype === "event");
  if (events.length > 0) {
    const lines = events
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((e) => `- **${e.name}** — ${e.description || e.body.slice(0, 80)}`);
    profile.sections["关注议题"] = lines.join("\n");
  }

  // 段 4：从 learner.positivePatterns + negativePatterns 聚合
  const prefLines: string[] = [];
  if (learner.positivePatterns.length > 0) {
    prefLines.push("**用户喜欢的：**");
    for (const p of learner.positivePatterns.slice(-10)) {
      prefLines.push(`- ${p}`);
    }
  }
  if (learner.negativePatterns.length > 0) {
    prefLines.push("");
    prefLines.push("**用户不喜欢的：**");
    for (const p of learner.negativePatterns.slice(-10)) {
      prefLines.push(`- ${p}`);
    }
  }
  if (prefLines.length > 0) {
    profile.sections["已知偏好与禁忌"] = prefLines.join("\n");
  }

  // 段 5：从 memory/emotion/*.md 聚合 trigger + manifestation
  const emotions = memories.filter((m) => m.subtype === "emotion");
  if (emotions.length > 0) {
    const lines = emotions
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((e) => {
        const trigger = e.fields.trigger;
        const manifest = e.fields.manifestation;
        const parts = [`**${e.name}**`];
        if (trigger) parts.push(`触发：${trigger}`);
        if (manifest) parts.push(`表现：${manifest}`);
        return `- ${parts.join("；")}`;
      });
    profile.sections["长期情绪基线"] = lines.join("\n");
  }

  // 段 6：从 timeline
  if (timelineSummary) {
    profile.sections["近期变化"] = timelineSummary;
  }
}

// =====================================================================
// 渲染（注入到 system prompt）
// =====================================================================

/**
 * 把 profile 渲染成紧凑 markdown 文本（用于 system prompt 注入）。
 *
 * v0.21：附加"用户认知画像"段（profile.ocean）
 * 明确说明这是"理解用户是什么样的人"，不影响"对话风格"。
 */
export function renderProfileForPrompt(profile: Profile): string {
  const lines: string[] = [];
  lines.push("## 用户画像（Profile）");
  lines.push("");
  lines.push("> 用户长期画像，多数据源整合视图（v0.21+）。**这是历史快照，不是当前状态。**");
  lines.push("> 用户当下的情绪/态度以本轮 side-query 识别结果为准，不要被画像里的旧印象绑架。");
  lines.push("");

  let hasContent = false;
  for (const name of PROFILE_SECTIONS) {
    const body = profile.sections[name]?.trim();
    if (!body || body === "（暂无）" || body.startsWith("（暂无")) continue;

    lines.push(`### ${name}`);
    lines.push(body);
    lines.push("");
    hasContent = true;
  }

  if (!hasContent) {
    lines.push("（暂无内容——首次使用，等用户透露更多信息后会自动填充）");
    lines.push("");
  }

  // v0.21 新增：用户认知画像
  if (profile.ocean) {
    const o = profile.ocean;
    lines.push("### 用户认知画像（动态推算的大五人格）");
    lines.push("");
    lines.push("> LLM 用以**理解用户是什么样的人**，**不影响对话风格**（风格由 session persona 控制）。");
    lines.push(`> 推算依据：${o.basis || "（暂无）"}`);
    lines.push("");
    lines.push(`- Openness: ${o.openness.toFixed(2)}（${oceanHint("openness", o.openness)}）`);
    lines.push(`- Conscientiousness: ${o.conscientiousness.toFixed(2)}（${oceanHint("conscientiousness", o.conscientiousness)}）`);
    lines.push(`- Extraversion: ${o.extraversion.toFixed(2)}（${oceanHint("extraversion", o.extraversion)}）`);
    lines.push(`- Agreeableness: ${o.agreeableness.toFixed(2)}（${oceanHint("agreeableness", o.agreeableness)}）`);
    lines.push(`- Neuroticism: ${o.neuroticism.toFixed(2)}（${oceanHint("neuroticism", o.neuroticism)}）`);
    lines.push("");
  }

  return lines.join("\n");
}

// =====================================================================
// 隐式识别 + 融合更新（v0.21：只更新段 1/2/6）
// =====================================================================

/**
 * v0.21：PROFILE_EXTRACT_PROMPT 只让 LLM 写段 1/2/6。
 * 段 3/4/5 由 summarizeForProfile 摘要。
 */
const PROFILE_EXTRACT_PROMPT = `你是用户画像更新助手。下面是一段对话历史。

**v0.21：只更新三段**（其他段由系统摘要，不需你写）：

{
  "基本信息": "结构化字段，用「字段：值」格式。多行用 \\n 分隔。例：'职业：前端工程师\\n所在地：上海'",
  "沟通风格": "新增/变化的偏好，例如 '喜欢简洁回复（≤3句）' 或 '讨厌被总结教训'",
  "近期变化": "最近 N 天的新趋势，例如 '最近一周睡眠变差'"
}

要求：
1. **严格只输出这三段**，不要输出"关注议题"、"已知偏好"、"长期情绪基线"
2. **基本信息必须用「字段：值」格式**，不要写叙述句
3. **只输出有把握的**——没有明确信号就输出空字符串
4. **保留用户原话片段**（≤ 30 字）作为证据
5. 用第三人称叙述
6. 严格 JSON 输出，不要 Markdown 代码块

特别注意（confidence 高）：
- 用户说"我喜欢 X" / "我讨厌 Y" / "别 Z" → 沟通风格
- 用户说"叫我 XX" / "我叫 XX" / "我名字是 XX" → 基本信息（昵称）
- 用户聊到具体职业、地点、年龄段 → 基本信息
- 用户纠正你 / 否定你 → 沟通风格
- 用户提到近期生活变化 → 近期变化

对话如下：

{conversation}`;

export type ProfileUpdate = {
  基本信息?: string;
  沟通风格?: string;
  关注议题?: string[];
  已知偏好与禁忌?: string[];
  长期情绪基线?: string;
  近期变化?: string;
};

function buildConversationText(
  messages: { role: string; content: string }[],
): string {
  return messages
    .slice(-20)
    .map((m, i) => `${i + 1}. [${m.role}] ${m.content}`)
    .join("\n\n");
}

export async function extractProfileUpdate(
  provider: ModelProvider,
  recentMessages: { role: string; content: string }[],
): Promise<ProfileUpdate> {
  if (recentMessages.length === 0) return {};

  const conversation = buildConversationText(recentMessages);
  const prompt = PROFILE_EXTRACT_PROMPT.replace("{conversation}", conversation);

  let raw: string;
  try {
    raw = await provider.complete({
      model: provider.model,
      params: {
        system: "你是结构化信息抽取助手，严格输出 JSON。",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 600,
        temperature: 0.2,
      },
    });
    if (process.env.EC_DEBUG_PROFILE) {
      console.log("[profile.extract] raw:", raw.slice(0, 200));
    }
  } catch {
    return {};
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as ProfileUpdate;
    return parsed;
  } catch {
    return {};
  }
}

// =====================================================================
// 融合策略（v0.21：段 3/4/5 由 syncFromSources 摘要，不在这里处理）
// =====================================================================

function parseFieldLines(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^-?\s*(\S+?)\s*[:：]\s*(.+)$/);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/** 段 1 的模板字段（顺序 = 展示顺序） */
const BASIC_TEMPLATE_KEYS = ["昵称", "性别", "年龄段", "职业", "所在地"] as const;

/**
 * 段 1 的字段别名。
 *
 * LLM / 用户说的叫法五花八门（"我叫小李" → 名字、"我在上海" → 城市），
 * 收敛到模板字段上，避免同一个人被记成两个字段。
 */
const BASIC_FIELD_ALIASES: Record<string, string> = {
  昵称: "昵称",
  名字: "昵称",
  姓名: "昵称",
  称呼: "昵称",
  性别: "性别",
  年龄段: "年龄段",
  年龄: "年龄段",
  职业: "职业",
  工作: "职业",
  职位: "职业",
  所在地: "所在地",
  城市: "所在地",
  地区: "所在地",
  住址: "所在地",
  居住地: "所在地",
};

function canonicalBasicKey(key: string): string {
  const k = key.trim();
  return BASIC_FIELD_ALIASES[k] ?? BASIC_FIELD_ALIASES[k.toLowerCase()] ?? k;
}

/**
 * 段 1 的合并策略：**保留式合并**（v0.21.1 修复）。
 *
 * 旧实现是 parseFieldLines(current) → 按模板 5 个字段 rebuild 整段。
 * 而 parseFieldLines 要求每行都有 ":" / "："，
 * 于是段 1 里那些 "- (日期) 用户……" 的自由文本观察行全被丢弃
 * —— 实测一次 merge 丢 27 行历史（这条路径有回归测试覆盖）。
 *
 * 现在改成：
 * - 已有的行**一行都不删**
 * - 新内容能对上某个模板字段（含别名）→ **就地替换那一行**
 * - 对不上 → **追加**（模板字段插到模板字段区的位置，其余追加到末尾）
 * - 新内容不是「键：值」格式 → 当作自由文本追加
 */
function mergeBasicSection(
  current: string,
  incoming: string,
): { text: string; changed: boolean } {
  const lines = current ? current.split("\n").filter((l) => l.trim()) : [];
  const incomingFields = parseFieldLines(incoming);

  // 新内容不是「键：值」格式 —— 当自由文本追加
  if (incomingFields.size === 0) {
    const add = incoming.trim();
    if (!add) return { text: current, changed: false };
    return { text: [...lines, add].join("\n"), changed: true };
  }

  const keyOf = (line: string): string | null => {
    const m = line.match(/^-?\s*(\S+?)\s*[:：]\s*(.+)$/);
    return m ? canonicalBasicKey(m[1]) : null;
  };
  const valueOf = (line: string): string => {
    const m = line.match(/^-?\s*(\S+?)\s*[:：]\s*(.+)$/);
    return m ? m[2].trim() : "";
  };

  let changed = false;
  for (const [rawKey, rawValue] of incomingFields) {
    const value = rawValue.trim();
    if (!value || value === "未知" || value === "（暂无）") continue;

    const key = canonicalBasicKey(rawKey);
    const idx = lines.findIndex((l) => keyOf(l) === key);

    if (idx >= 0) {
      // 已有同名字段 → 就地替换（不改动其它行）
      if (valueOf(lines[idx]) !== value) {
        lines[idx] = `- ${key}：${value}`;
        changed = true;
      }
      continue;
    }

    // 新字段
    const newLine = `- ${key}：${value}`;
    if ((BASIC_TEMPLATE_KEYS as readonly string[]).includes(key)) {
      // 模板字段插到模板字段区的末尾（保持模板顺序）；一个都没有就插最前面
      let insertAt = 0;
      for (let i = 0; i < lines.length; i++) {
        const k = keyOf(lines[i]);
        if (k && (BASIC_TEMPLATE_KEYS as readonly string[]).includes(k)) {
          insertAt = i + 1;
        }
      }
      lines.splice(insertAt, 0, newLine);
    } else {
      lines.push(newLine);
    }
    changed = true;
  }

  return { text: lines.join("\n"), changed };
}

/**
 * v0.21 融合策略：
 * - 段 1 基本信息：结构化字段更新
 * - 段 2 沟通风格：append + 日期 + 滚动上限 30
 * - 段 6 近期变化：append + 日期 + 滚动上限 30
 * - 段 3/4/5：syncFromSources 摘要（这里不动）
 */
export function mergeProfileUpdate(
  profile: Profile,
  update: ProfileUpdate,
  now: Date = new Date(),
): boolean {
  let changed = false;
  const dateStr = now.toISOString().slice(0, 10);

  // 段 1 基本信息 —— 保留式合并，不丢任何已有行（v0.21.1 修复）
  const basicIncoming = update["基本信息"];
  if (basicIncoming && basicIncoming.trim()) {
    const current = profile.sections["基本信息"] ?? "";
    const { text, changed: basicChanged } = mergeBasicSection(
      current,
      basicIncoming,
    );
    if (basicChanged) {
      profile.sections["基本信息"] = text;
      changed = true;
    }
  }

  // 段 2 沟通风格
  const styleIncoming = update["沟通风格"];
  if (styleIncoming && styleIncoming.trim()) {
    const current = profile.sections["沟通风格"] ?? "";
    const incoming = styleIncoming.trim();
    const isEmpty = !current.trim() || current === "（暂无）" || current.startsWith("（暂无");
    const isDup = current.replace(/\s+/g, "").includes(incoming.replace(/\s+/g, "").slice(0, 30));
    if (!isEmpty && isDup) {
      // dup
    } else {
      const lines = isEmpty ? [] : current.split("\n").filter((l) => l.trim());
      lines.push(`- (${dateStr}) ${incoming}`);
      profile.sections["沟通风格"] = lines.slice(-30).join("\n");
      changed = true;
    }
  }

  // 段 6 近期变化
  const recentIncoming = update["近期变化"];
  if (recentIncoming && recentIncoming.trim()) {
    const current = profile.sections["近期变化"] ?? "";
    const incoming = recentIncoming.trim();
    const isEmpty = !current.trim() || current === "（暂无）" || current.startsWith("（暂无");
    const isDup = current.replace(/\s+/g, "").includes(incoming.replace(/\s+/g, "").slice(0, 30));
    if (!isEmpty && isDup) {
      // dup
    } else {
      const lines = isEmpty ? [] : current.split("\n").filter((l) => l.trim());
      lines.push(`- (${dateStr}) ${incoming}`);
      profile.sections["近期变化"] = lines.slice(-30).join("\n");
      changed = true;
    }
  }

  return changed;
}

// =====================================================================
// 一站式入口
// =====================================================================

export async function maybeUpdateProfile(
  dataDir: string,
  provider: ModelProvider,
  recentMessages: { role: string; content: string }[],
  options?: {
    userId?: string;
    memoryDir?: string;
    timeline?: Timeline;
  },
): Promise<{
  updated: boolean;
  profile: Profile;
  changes?: { section: ProfileSection; value: string }[];
}> {
  try {
    const profile = await loadProfile(dataDir, { ...options, provider });
    const update = await extractProfileUpdate(provider, recentMessages);

    const sectionsBefore = new Map<ProfileSection, string>();
    for (const s of ["基本信息", "沟通风格", "近期变化"] as ProfileSection[]) {
      sectionsBefore.set(s, profile.sections[s] ?? "");
    }

    let changed = false;
    if (Object.keys(update).length > 0) {
      changed = mergeProfileUpdate(profile, update);
    }

    // sync 已由 loadProfile 触发，再触发一次确保最新 LLM 摘要
    await syncFromSources(profile, dataDir, { ...options, provider });

    await saveProfile(profile);

    const changes: { section: ProfileSection; value: string }[] = [];
    for (const s of ["基本信息", "沟通风格", "近期变化"] as ProfileSection[]) {
      const after = profile.sections[s] ?? "";
      const before = sectionsBefore.get(s) ?? "";
      if (after !== before) {
        const newLines = after
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !before.includes(l));
        if (newLines.length > 0) {
          changes.push({ section: s, value: newLines.join(" | ") });
        }
      }
    }

    return { updated: changed, profile, changes };
  } catch (e) {
    console.error(`[profile] 更新失败:`, (e as Error).message);
    const profile = await loadProfile(dataDir, options);
    return { updated: false, profile };
  }
}
