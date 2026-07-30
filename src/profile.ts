// src/profile.ts
// 用户画像系统（Profile）。
//
// 设计目标：
// - 单一结构化文档 PROFILE.md，包含 6 个固定段
// - 每次对话前自动加载，注入到 system prompt
// - 对话中隐式识别新信息 → 触发融合更新（不覆盖已有事实）
// - 初次使用时用默认模板初始化
// - 融合策略：基于段落语义去重 + 时间戳标注 + 冲突时以新信息为准
//
// 文件格式（v0.6 起与 personality 统一）：
//   YAML frontmatter + Markdown body
//   body 推荐用 6 段 ## 结构（详见 PROFILE_SECTIONS）
//   也支持自由格式 body——sections 留空，meta 仍然完整

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import type { ModelProvider } from "./provider.ts";
import {
  parseContextFile,
  serializeContextFile,
  PROFILE_SECTIONS as CONTEXT_PROFILE_SECTIONS,
  PROFILE_FILENAME,
  getProfilePath,
  type ProfileSection,
  type ContextFileMeta,
} from "./context-file.ts";

// =====================================================================
// 类型定义
// =====================================================================

// Re-export 供外部使用
export const PROFILE_SECTIONS = CONTEXT_PROFILE_SECTIONS;
export { PROFILE_FILENAME, getProfilePath };
export type { ProfileSection };

/** 用户画像的结构化表示。 */
export type Profile = {
  /** 6 段内容（key = 段落名，value = 段落正文）；如果文件不含 6 段结构，全为空字符串 */
  sections: Record<ProfileSection, string>;
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
// 默认模板（首次使用时初始化）
// =====================================================================

/**
 * 默认模板纯 Markdown 格式（v0.8 起，无 YAML frontmatter）。
 */
const DEFAULT_META: ContextFileMeta = {
  name: "用户画像",
  version: "0.5",
  description: "用户长期画像，从历史对话累积",
  author: "emotalk",
  kind: "profile",
};

const DEFAULT_BODY = `> 自动从对话中累积维护。每次对话开始前注入到 system prompt。
> 段顺序固定，不要改动；内容用 Markdown 列表/小标题组织。

## 1. 基本信息
- 昵称：未知
- 性别：未知
- 年龄段：未知
- 职业：未知
- 所在地：未知

## 2. 沟通风格
- （暂无——等用户表现出偏好后再填）

## 3. 关注议题
- （暂无——观察用户反复提到的话题）

## 4. 已知偏好与禁忌
- （暂无——等用户明确表达喜欢/不喜欢）

## 5. 长期情绪基线
- （暂无——观察用户日常情绪水平）

## 6. 近期变化
- （暂无——积累 3 天以上对话后开始填）`;

// =====================================================================
// 加载 / 保存
// =====================================================================

/**
 * 加载 profile。如果文件不存在，自动用默认模板初始化。
 *
 * 容错策略：
 * - 文件不存在 → 用默认模板初始化
 * - 文件无 frontmatter → 自动补默认 meta
 * - 文件无 6 段结构 → sections 全空字符串
 *
 * @param dataDir  data 根目录（默认是 ./data）
 * @returns 加载好的 Profile
 */
export async function loadProfile(dataDir: string): Promise<Profile> {
  const path = getProfilePath(dataDir);
  const dir = path.replace(/[/\\][^/\\]+$/, "");

  // 不存在则初始化
  if (!existsSync(path)) {
    await mkdir(dir, { recursive: true });
    const initialContent = serializeContextFile(DEFAULT_META, DEFAULT_BODY);
    await writeFile(path, initialContent, "utf-8");
    const ctx = parseContextFile(initialContent, path);
    return {
      sections: ctx.structuredSections ?? emptySections(),
      path,
      updatedAt: Date.now(),
      initialized: true,
      meta: ctx.meta,
    };
  }

  // 存在则读取
  const raw = await readFile(path, "utf-8");
  const ctx = parseContextFile(raw, path);
  const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
  return {
    sections: ctx.structuredSections ?? emptySections(),
    path,
    updatedAt: stats.mtimeMs,
    initialized: false,
    meta: ctx.meta,
  };
}

/**
 * 保存 profile 到磁盘。
 */
export async function saveProfile(profile: Profile): Promise<void> {
  const body = serializeProfileBody(profile.sections);
  const content = serializeContextFile(profile.meta, body);
  await writeFile(profile.path, content, "utf-8");
  profile.updatedAt = Date.now();
}

function serializeProfileBody(
  sections: Record<ProfileSection, string>,
): string {
  const lines: string[] = [
    "# 用户画像（Profile）",
    "",
    "> 自动从对话中累积维护。每次对话开始前注入到 system prompt。",
    "> 段顺序固定，不要改动；内容用 Markdown 列表/小标题组织。",
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

// =====================================================================
// 渲染（注入到 system prompt）
// =====================================================================

/**
 * 把 profile 渲染成一段紧凑的 Markdown 文本（用于 system prompt 注入）。
 *
 * 设计原则：
 * - 跳过空段落（避免冗余）
 * - 加漂移警告（profile 是历史快照，与当前情绪可能不一致）
 * - 总长度控制在合理范围（不超过 ~1500 字）
 */
/**
 * 从 profile 内容**自动派生**具体的行为提醒。
 * 让模型不只是"知道"用户的偏好，而是看到"具体怎么做"。
 */
export function deriveBehaviorReminders(profile: Profile): string[] {
  const reminders: string[] = [];
  const allText = Object.values(profile.sections).join("\n");

  // 沟通风格类
  if (/简洁|短|简短|别太长|短一点/i.test(allText)) {
    reminders.push("用户的偏好 = 短回复（≤ 1-3 句），除非用户主动要长");
  }
  if (/详细|长|展开|多说|讲清楚|深入/i.test(allText)) {
    reminders.push("用户的偏好 = 详细回复，多展开具体细节");
  }
  if (/慢|稳|别急|慢慢说/i.test(allText)) {
    reminders.push("用户的偏好 = 慢节奏，回复前留 1 拍");
  }
  if (/直接|别绕|别兜圈子/i.test(allText)) {
    reminders.push("用户的偏好 = 直接说，不要绕弯子或升华");
  }

  // 禁忌类
  if (/别.*教训|别.*说教|别.*总结/i.test(allText)) {
    reminders.push("⚠️ 禁止：教训 / 说教 / 总结式收尾（用户明确反感）");
  }
  if (/别.*emoji|别.*表情/i.test(allText)) {
    reminders.push("⚠️ 禁止：用 emoji / 表情符号（用户明确反感）");
  }
  if (/别.*心理咨询|别.*咨询师|别.*我懂|别.*我完全理解/i.test(allText)) {
    reminders.push("⚠️ 禁止：心理咨询师腔（'我懂你' '我完全理解'）");
  }
  if (/别.*复述|别.*确认|别.*听到你说/i.test(allText)) {
    reminders.push("⚠️ 禁止：复述确认（'我听到你说...'）");
  }

  // 节奏类
  const m = allText.match(/叫我\s*([^\s，。,.\n]+)|称呼.*?(\S{1,8})/);
  if (m && m[1]) {
    reminders.push(`称呼：用户希望被叫做 "${m[1]}"`);
  }

  return reminders;
}

export function renderProfileForPrompt(profile: Profile): string {
  const lines: string[] = [];
  lines.push("## 用户画像（Profile）");
  lines.push("");
  lines.push("> 用户长期画像，从历史对话累积而来。**这是历史快照，不是当前状态。**");
  lines.push("> 用户当下的情绪/态度以本轮 side-query 识别结果为准，不要被画像里的旧印象绑架。");
  lines.push("> **本轮回复前，请主动对照下面自动派生的执行清单，按用户的偏好方式回复。**");
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

  // v0.9 新增：自动派生的行为提醒
  const reminders = deriveBehaviorReminders(profile);
  if (reminders.length > 0) {
    lines.push("");
    lines.push("### 🎯 自动派生的行为提醒（请严格遵守）");
    lines.push("");
    for (const r of reminders) {
      lines.push(`- ${r}`);
    }
    lines.push("");
    lines.push("> ⚠️ 这些是从 profile 内容**自动推导**的，不是用户直接说的。但如果某条提醒让当下对话变怪（比如用户在很严肃地倾诉），可以临时忽略。");
  }

  return lines.join("\n");
}

// =====================================================================
// 隐式识别 + 融合更新
// =====================================================================

/**
 * 从单次对话中提取可能要更新到 profile 的信息。
 *
 * 调用 provider 一次，让模型从最近 N 轮对话里抽取：
 * - 用户新透露的基本信息（昵称、职业等）
 * - 表现出的沟通风格偏好
 * - 提到的话题
 * - 明确表达的喜欢/不喜欢
 * - 情绪模式
 * - 近期变化信号
 *
 * 返回的 JSON 严格按 6 段组织，便于后续融合。
 */
const PROFILE_EXTRACT_PROMPT = `你是用户画像更新助手。下面是一段对话历史。请从中提取**新增或变化**的用户信息。

**严格按以下 6 段输出 JSON**（没有信息就返回空字符串 "" 或空数组）：

{
  "基本信息": "新增/变化的事实，例如 '昵称：小阳' 或 '职业：前端工程师'",
  "沟通风格": "新增/变化的偏好，例如 '喜欢简洁回复（≤3句）' 或 '讨厌被总结教训'",
  "关注议题": ["新提到的反复话题1", "新话题2"],
  "已知偏好与禁忌": ["新增的喜欢/不喜欢条目"],
  "长期情绪基线": "新增的情绪模式描述，例如 '工作日傍晚容易焦虑'",
  "近期变化": "最近 N 天的新趋势，例如 '最近一周睡眠变差' 或 '情绪比上月平稳'"
}

要求：
1. **只输出有把握的**——没有明确信号就输出空
2. **保留用户原话片段**（≤ 30 字）作为证据（放在条目的括号里）
3. **不要重复已有信息**——只标记新的或变化的
4. 用第三人称叙述（"用户说..."、"用户表示..."）
5. 严格 JSON 输出，不要 Markdown 代码块

特别注意这些"明确反馈信号"（confidence 高，优先捕获）：
- 用户说"我喜欢 X" / "我讨厌 Y" / "别 Z" → 已知偏好与禁忌
- 用户说"你回得太长了/太短了" / "你说话慢点" → 沟通风格
- 用户说"叫我 XX" / "别叫我 XX" → 基本信息（称呼）
- 用户说"别用 emoji" / "别教训我" / "别说教" → 已知偏好与禁忌
- 用户纠正你的某句话 / 否定你的回应 → 已知偏好与禁忌（你踩到了雷）
- 用户多次提到同一话题 → 关注议题
- 用户聊到自己工作/生活细节 → 基本信息

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
    .slice(-20) // 只看最近 20 条
    .map((m, i) => `${i + 1}. [${m.role}] ${m.content}`)
    .join("\n\n");
}

/**
 * 调用模型从对话中抽取可能要更新的 profile 信息。
 * 如果模型返回的不是有效 JSON，返回空对象（不更新）。
 */
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
        maxTokens: 800,
        temperature: 0.2,
      },
    });
    if (process.env.EC_DEBUG_PROFILE) {
      console.log("[profile.extract] raw:", raw.slice(0, 200));
    }
  } catch {
    return {};
  }

  // 尝试解析 JSON（容忍 markdown 包裹）
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
// 融合策略
// =====================================================================

/**
 * 把抽取到的新信息融合进 profile。
 *
 * 融合策略：
 * - 字符串段（基本信息/沟通风格/长期情绪基线/近期变化）：
 *   - 如果新内容为空，跳过
 *   - 如果旧内容为空，直接用新内容
 *   - 否则：保留旧内容，在末尾追加新内容（带时间戳），不覆盖
 *   - 例外：如果旧内容是 "（暂无）" 或包含 "未知"，直接替换
 *
 * - 列表段（关注议题/已知偏好与禁忌）：
 *   - 去重（规范化后字符串相等视为重复）
 *   - 新条目追加到列表末尾
 *
 * 返回 true 表示有变化（调用方决定是否写盘）。
 */
export function mergeProfileUpdate(
  profile: Profile,
  update: ProfileUpdate,
  now: Date = new Date(),
): boolean {
  let changed = false;
  const dateStr = now.toISOString().slice(0, 10);

  // 字符串段
  const stringSections: ProfileSection[] = [
    "基本信息",
    "沟通风格",
    "长期情绪基线",
    "近期变化",
  ];

  for (const section of stringSections) {
    const incomingRaw = update[section];
    // LLM 偶尔会返回数组形式，规范化成字符串
    const incoming = Array.isArray(incomingRaw)
      ? incomingRaw.join("; ")
      : incomingRaw;
    if (!incoming || !incoming.trim()) continue;

    const current = profile.sections[section] || "";
    const isEmpty =
      !current.trim() ||
      current.includes("未知") ||
      current.trim() === "（暂无）" ||
      current.trim().startsWith("（暂无");

    if (isEmpty) {
      profile.sections[section] = incoming.trim();
      changed = true;
    } else {
      // 追加而非覆盖（带日期前缀）
      const normalizedIncoming = incoming.trim().replace(/\s+/g, "");
      const normalizedCurrent = current.replace(/\s+/g, "");
      if (normalizedCurrent.includes(normalizedIncoming.slice(0, 20))) {
        continue;
      }
      const appended = `${current}\n- (${dateStr}) ${incoming.trim()}`;
      profile.sections[section] = appended;
      changed = true;
    }
  }

  // 列表段
  const listSections: ProfileSection[] = ["关注议题", "已知偏好与禁忌"];
  for (const section of listSections) {
    const incoming = update[section];
    if (!Array.isArray(incoming) || incoming.length === 0) continue;

    const current = profile.sections[section] || "";
    const existingItems = current
      .split("\n")
      .map((line) => line.replace(/^-\s*/, "").trim())
      .filter(Boolean);

    const newItems: string[] = [];
    for (const item of incoming) {
      const trimmed = String(item).trim();
      if (!trimmed) continue;
      const normalized = trimmed.replace(/\s+/g, "");
      const isDup = existingItems.some(
        (e) => e.replace(/\s+/g, "") === normalized,
      );
      if (!isDup) newItems.push(trimmed);
    }

    if (newItems.length === 0) continue;

    const updated = [...existingItems, ...newItems].join("\n- ");
    profile.sections[section] = updated.startsWith("- ") ? updated : `- ${updated}`;
    changed = true;
  }

  return changed;
}

// =====================================================================
// 一站式入口（loop.ts 用）
// =====================================================================

/**
 * 一站式：从对话中抽取 + 融合 + 保存。
 *
 * 关键改进：自动从 update 中**挑出真正有信息量的**条目，写入 profile。
 *
 * "有信息量"的判断（粗启发式，避免 LLM 误判时污染 profile）：
 * - 包含用户原话引用（括号里）→ 高质量
 * - 包含具体数字 / 时间 / 名字 → 中质量
 * - 长度 > 5 字符 → 否则可能是空
 * - 不重复已有内容（依赖 mergeProfileUpdate 的去重）
 */
export async function maybeUpdateProfile(
  dataDir: string,
  provider: ModelProvider,
  recentMessages: { role: string; content: string }[],
): Promise<{
  updated: boolean;
  profile: Profile;
  /** 实际被写入的条目（用于 REPL 显示"自动更新了什么"） */
  changes?: { section: ProfileSection; value: string }[];
}> {
  try {
    const profile = await loadProfile(dataDir);
    const update = await extractProfileUpdate(provider, recentMessages);
    if (Object.keys(update).length === 0) {
      return { updated: false, profile };
    }

    if (process.env.EC_DEBUG_PROFILE) {
      console.log(
        `[profile.maybeUpdate] update keys: ${Object.keys(update).join(", ")}`,
      );
    }

    // 记录"实际新增的"（过滤掉空 / 重复 / 太短）
    // 注意：PROFILE_SECTIONS 是 readonly tuple，`in` 操作符行为不可靠，
    // 所以转成普通数组后再 includes 检查
    const validSections = new Set<string>(PROFILE_SECTIONS as readonly string[]);
    const sectionsAffected: ProfileSection[] = Object.keys(update).filter(
      (k): k is ProfileSection => validSections.has(k),
    );

    if (process.env.EC_DEBUG_PROFILE) {
      console.log(
        `[profile.maybeUpdate] sectionsAffected: ${sectionsAffected.join(", ")}`,
      );
    }
    const sectionsBefore = new Map<ProfileSection, string>();
    for (const s of sectionsAffected) {
      sectionsBefore.set(s, profile.sections[s] ?? "");
    }

    const changed = mergeProfileUpdate(profile, update);
    if (changed) {
      await saveProfile(profile);

      // 收集"实际变化"
      const changes: { section: ProfileSection; value: string }[] = [];
      for (const s of sectionsAffected) {
        const after = profile.sections[s] ?? "";
        const before = sectionsBefore.get(s) ?? "";
        if (process.env.EC_DEBUG_PROFILE) {
          console.log(
            `[profile.changes] section=${s} after != before? ${after !== before}; after len=${after.length}, before len=${before.length}`,
          );
        }
        if (after !== before) {
          // 提取"新追加"的部分（取最后一行）
          const newLine = after
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !before.includes(l))
            .pop();
          if (process.env.EC_DEBUG_PROFILE) {
            console.log(
              `[profile.changes] section=${s} newLine=${newLine?.slice(0, 50)}`,
            );
          }
          if (newLine) {
            changes.push({ section: s, value: newLine });
          }
        }
      }

      return { updated: true, profile, changes };
    }
    return { updated: false, profile };
  } catch (e) {
    console.error(`[profile] 更新失败:`, (e as Error).message);
    const profile = await loadProfile(dataDir);
    return { updated: false, profile };
  }
}