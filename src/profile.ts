// src/profile.ts
// 用户画像系统（Profile）。
//
// v0.20 重构：消除 profile 孤岛
//
// profile 不再是独立抽取 + append-only 的文档。
// 它是**多个数据源的视图**：
//   - 段 1 基本信息：LLM 抽取（结构化覆盖式）
//   - 段 2 沟通风格：LLM 抽取（带日期的覆盖式）
//   - 段 3 关注议题：从 memory/event/*.md 聚合
//   - 段 4 已知偏好与禁忌：从 learner.positivePatterns + negativePatterns 聚合
//   - 段 5 长期情绪基线：从 memory/emotion/*.md 聚合（trigger + manifestation）
//   - 段 6 近期变化：从 timeline 最近 7 天 + 最近 memory 写入
//
// 写入策略：
//   - LLM 抽取只更新段 1/2/6
//   - 段 3/4/5 永远从数据源同步，不让 LLM 重复抽取
//   - 段 1 改成结构化覆盖（识别 "字段：值"，替换占位）
//   - 段 2 改成"最新覆盖"风格（带日期，方便看历史）

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

// =====================================================================
// 类型定义
// =====================================================================

export const PROFILE_SECTIONS = CONTEXT_PROFILE_SECTIONS;
export { PROFILE_FILENAME, getProfilePath };
export type { ProfileSection };

export type Profile = {
  /** 6 段内容（key = 段落名，value = 段落正文） */
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
// 默认模板
// =====================================================================

const DEFAULT_META: ContextFileMeta = {
  name: "用户画像",
  version: "0.6",
  description: "用户长期画像，多数据源整合视图",
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
- （暂无——从 memory/event 自动聚合）

## 4. 已知偏好与禁忌
- （暂无——从反馈学习自动聚合）

## 5. 长期情绪基线
- （暂无——从 memory/emotion 自动聚合）

## 6. 近期变化
- （暂无——从 timeline 最近 7 天自动聚合）`;

// =====================================================================
// 加载 / 保存
// =====================================================================

/**
 * 加载 profile，自动从其他数据源同步段 3/4/5/6。
 *
 * @param dataDir  data 根目录
 * @param options.userId  用户 ID（用于加载 learner state）
 * @param options.memoryDir  memory 目录
 * @param options.timeline  Timeline 实例
 */
export async function loadProfile(
  dataDir: string,
  options?: {
    userId?: string;
    memoryDir?: string;
    timeline?: Timeline;
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
    path,
    updatedAt: stats.mtimeMs,
    initialized: false,
    meta: ctx.meta,
  };
  await syncFromSources(profile, dataDir, options);
  // sync 后写盘（把数据源整合结果落盘，避免每次都重新聚合）
  await saveProfile(profile);
  return profile;
}

/**
 * 把 profile 写入磁盘。
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
    "> 段 3/4/5/6 由其他数据源自动同步，段 1/2 由 LLM 抽取更新。",
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
// 同步：从其他数据源填充段 3/4/5/6
// =====================================================================

/**
 * 从其他数据源填充段 3/4/5/6：
 * - 段 3 关注议题：从 memory/event/*.md 聚合
 * - 段 4 已知偏好与禁忌：从 learner.positivePatterns + negativePatterns
 * - 段 5 长期情绪基线：从 memory/emotion/*.md 聚合
 * - 段 6 近期变化：从 timeline 最近 7 天
 *
 * 失败容错：任何数据源失败都不抛异常。
 */
export async function syncFromSources(
  profile: Profile,
  dataDir: string,
  options?: {
    userId?: string;
    memoryDir?: string;
    timeline?: Timeline;
  },
): Promise<void> {
  const memoryDir = options?.memoryDir ?? joinSafe(dataDir, "memory");
  const userId = options?.userId ?? "default";
  const learner = loadLearner(dataDir, userId);

  // 段 3：从 memory/event/*.md 聚合
  try {
    const memories = await scanMemory(memoryDir);
    const events = memories.filter((m) => m.subtype === "event");
    if (events.length > 0) {
      const lines = events
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .map((e) => `- **${e.name}** — ${e.description || e.body.slice(0, 80)}`);
      profile.sections["关注议题"] = lines.join("\n");
    }
  } catch {
    // 静默
  }

  // 段 4：从 learner.positivePatterns + negativePatterns 聚合
  try {
    const lines: string[] = [];
    if (learner.positivePatterns.length > 0) {
      lines.push("**用户喜欢的：**");
      for (const p of learner.positivePatterns.slice(-10)) {
        lines.push(`- ${p}`);
      }
    }
    if (learner.negativePatterns.length > 0) {
      lines.push("");
      lines.push("**用户不喜欢的：**");
      for (const p of learner.negativePatterns.slice(-10)) {
        lines.push(`- ${p}`);
      }
    }
    if (lines.length > 0) {
      profile.sections["已知偏好与禁忌"] = lines.join("\n");
    }
  } catch {
    // 静默
  }

  // 段 5：从 memory/emotion/*.md 聚合 trigger + manifestation
  try {
    const memories = await scanMemory(memoryDir);
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
  } catch {
    // 静默
  }

  // 段 6：从 timeline 最近 7 天
  if (options?.timeline) {
    try {
      const summary = await options.timeline.renderSummary(10);
      profile.sections["近期变化"] = summary;
    } catch {
      // 静默
    }
  }
}

function joinSafe(parent: string, child: string): string {
  // 跨平台 join
  return parent.endsWith("/") || parent.endsWith("\\")
    ? parent + child
    : parent + "/" + child;
}

// =====================================================================
// 渲染（注入到 system prompt）
// =====================================================================

/**
 * 把 profile 渲染成紧凑 markdown 文本（用于 system prompt 注入）。
 *
 * 设计原则：
 * - 跳过空段落
 * - 加漂移警告
 * - 总体保持紧凑（不超过 ~1500 字）
 */
export function renderProfileForPrompt(profile: Profile): string {
  const lines: string[] = [];
  lines.push("## 用户画像（Profile）");
  lines.push("");
  lines.push("> 用户长期画像，多数据源整合视图（v0.20+）。**这是历史快照，不是当前状态。**");
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

  return lines.join("\n");
}

// =====================================================================
// 隐式识别 + 融合更新（v0.20：只更新段 1/2/6）
// =====================================================================

/**
 * LLM 抽取的 prompt（v0.20：精简，只让 LLM 写段 1/2/6）。
 */
const PROFILE_EXTRACT_PROMPT = `你是用户画像更新助手。下面是一段对话历史。

**v0.20：只更新三段**（其他段由系统从其他数据源自动同步，不需要你写）：

{
  "基本信息": "结构化字段，用「字段：值」格式。多行用 \\n 分隔。例：'职业：前端工程师\\n所在地：上海'",
  "沟通风格": "新增/变化的偏好，例如 '喜欢简洁回复（≤3句）' 或 '讨厌被总结教训'",
  "近期变化": "最近 N 天的新趋势，例如 '最近一周睡眠变差'"
}

要求：
1. **严格只输出这三段**，不要输出"关注议题"、"已知偏好"、"长期情绪基线"（那些由系统聚合）
2. **基本信息必须用「字段：值」格式**（如 "职业：xxx"、"所在地：xxx"、"昵称：xxx"），不要写叙述句
3. **只输出有把握的**——没有明确信号就输出空字符串
4. **保留用户原话片段**（≤ 30 字）作为证据（放在条目的括号里）
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
// 融合策略（v0.20 重写）
// =====================================================================

/**
 * 解析 "字段：值" 行，返回 Map<字段, 值>。
 */
function parseFieldLines(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = line.match(/^-?\s*(\S+?)\s*[:：]\s*(.+)$/);
    if (m) map.set(m[1].trim(), m[2].trim());
  }
  return map;
}

/**
 * 把字段 Map 序列化回 markdown 行。
 */
function serializeFieldLines(map: Map<string, string>, prefix = "- "): string {
  const lines: string[] = [];
  for (const [k, v] of map) {
    lines.push(`${prefix}${k}：${v}`);
  }
  return lines.join("\n");
}

/**
 * v0.20 融合策略：
 * - 段 1 基本信息：结构化字段更新（识别 "字段：值"，新值覆盖旧值；空值不动）
 * - 段 2 沟通风格：保留 append（带日期），但有 ≤30 行的滚动上限
 * - 段 6 近期变化：保留 append（带日期）
 * - 段 3/4/5：syncFromSources 在 loadProfile 时已经写过，不再处理
 */
export function mergeProfileUpdate(
  profile: Profile,
  update: ProfileUpdate,
  now: Date = new Date(),
): boolean {
  let changed = false;
  const dateStr = now.toISOString().slice(0, 10);

  // 段 1 基本信息：结构化字段更新
  const basicIncoming = update["基本信息"];
  if (basicIncoming && basicIncoming.trim()) {
    const current = profile.sections["基本信息"] ?? "";
    const currentFields = parseFieldLines(current);
    const newFields = parseFieldLines(basicIncoming);
    let basicChanged = false;
    for (const [k, v] of newFields) {
      // 新值非"未知"/"（暂无）"才覆盖
      if (!v || v === "未知" || v === "（暂无）") continue;
      if (currentFields.get(k) !== v) {
        currentFields.set(k, v);
        basicChanged = true;
      }
    }
    if (basicChanged) {
      // 保留模板字段顺序
      const orderedLines: string[] = [];
      const templateKeys = ["昵称", "性别", "年龄段", "职业", "所在地"];
      for (const k of templateKeys) {
        const v = currentFields.get(k);
        orderedLines.push(`- ${k}：${v ?? "未知"}`);
      }
      // 其他字段
      for (const [k, v] of currentFields) {
        if (templateKeys.includes(k)) continue;
        orderedLines.push(`- ${k}：${v}`);
      }
      profile.sections["基本信息"] = orderedLines.join("\n");
      changed = true;
    }
  }

  // 段 2 沟通风格：append 风格 + 滚动上限（空段首次也带日期）
  const styleIncoming = update["沟通风格"];
  if (styleIncoming && styleIncoming.trim()) {
    const current = profile.sections["沟通风格"] ?? "";
    const incoming = styleIncoming.trim();
    const isEmpty =
      !current.trim() ||
      current === "（暂无）" ||
      current.startsWith("（暂无");

    const isDup = current.replace(/\s+/g, "").includes(incoming.replace(/\s+/g, "").slice(0, 30));
    if (!isEmpty && isDup) {
      // 重复，跳过
    } else {
      const lines = isEmpty ? [] : current.split("\n").filter((l) => l.trim());
      lines.push(`- (${dateStr}) ${incoming}`);
      const trimmed = lines.slice(-30);
      profile.sections["沟通风格"] = trimmed.join("\n");
      changed = true;
    }
  }

  // 段 6 近期变化：append 风格 + 滚动上限（空段首次也带日期）
  const recentIncoming = update["近期变化"];
  if (recentIncoming && recentIncoming.trim()) {
    const current = profile.sections["近期变化"] ?? "";
    const incoming = recentIncoming.trim();
    const isEmpty =
      !current.trim() ||
      current === "（暂无）" ||
      current.startsWith("（暂无");

    const isDup = current.replace(/\s+/g, "").includes(incoming.replace(/\s+/g, "").slice(0, 30));
    if (!isEmpty && isDup) {
      // 重复
    } else {
      const lines = isEmpty ? [] : current.split("\n").filter((l) => l.trim());
      lines.push(`- (${dateStr}) ${incoming}`);
      const trimmed = lines.slice(-30);
      profile.sections["近期变化"] = trimmed.join("\n");
      changed = true;
    }
  }

  // 段 3/4/5 由 syncFromSources 管理，不在 merge 中处理（保留类型兼容）

  return changed;
}

// =====================================================================
// 一站式入口
// =====================================================================

/**
 * 完整流程：抽取 → 融合段 1/2/6 → 从数据源同步 3/4/5/6 → 保存。
 *
 * @param dataDir data 根目录
 * @param options.memoryDir  memory 目录
 * @param options.timeline  Timeline 实例（用于段 6）
 */
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
    const profile = await loadProfile(dataDir, options);
    const update = await extractProfileUpdate(provider, recentMessages);

    // 段 1/2/6 由 LLM 抽取填充
    const sectionsBefore = new Map<ProfileSection, string>();
    for (const s of ["基本信息", "沟通风格", "近期变化"] as ProfileSection[]) {
      sectionsBefore.set(s, profile.sections[s] ?? "");
    }

    let changed = false;
    if (Object.keys(update).length > 0) {
      changed = mergeProfileUpdate(profile, update);
    }

    // 段 3/4/5/6 永远从数据源同步（每次都重写，但不计入"changed"）
    await syncFromSources(profile, dataDir, options);

    if (changed || true /* always save after sync */) {
      await saveProfile(profile);

      // 收集"实际变化"
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
    }
    return { updated: false, profile };
  } catch (e) {
    console.error(`[profile] 更新失败:`, (e as Error).message);
    const profile = await loadProfile(dataDir, options);
    return { updated: false, profile };
  }
}