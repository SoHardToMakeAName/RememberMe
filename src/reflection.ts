// src/reflection.ts
// 每日后台反思 agent（独立设计，不参考特定项目）。
//
// 设计目标：
// - 不是每轮都跑，而是每天（或更长间隔）跑一次
// - 收集最近 N 天的情绪时间线 + 当前 profile + 最近 memory
// - 用 LLM 把它们综合成结构化"洞察"
// - 落盘到 data/reflections/YYYY-MM-DD.md
// - 失败容错：所有错误都不抛
//
// 触发方式：
// 1. 手动：/reflect（REPL 命令）
// 2. 重启时检查：距离上次反思 ≥ 24h 且当日有对话 → 在 REPL 提示用户
// 3. （未来 v0.5+: 真正的 cron-style scheduling）

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "./provider.ts";
import type { Timeline, TimelineEntry } from "./timeline.ts";
import { loadProfile, type Profile } from "./profile.ts";
import { scanMemory, formatManifest, type MemoryFile } from "./memory.ts";

// =====================================================================
// 类型定义
// =====================================================================

/**
 * 反思文档的 4 个段落。
 */
export const REFLECTION_SECTIONS = [
  "情绪趋势",
  "触发器与模式",
  "主人格调整建议",
  "长期观察",
] as const;

export type ReflectionSection = (typeof REFLECTION_SECTIONS)[number];

export type Reflection = {
  /** 反思日期 YYYY-MM-DD */
  date: string;
  /** 4 段内容 */
  sections: Record<ReflectionSection, string>;
  /** 文件路径 */
  path: string;
  /** 生成时间 ms */
  createdAt: number;
};

/**
 * 反思状态：决定下次是否该跑。
 */
export type ReflectionState = {
  /** 上次反思时间（ms） */
  lastReflectionAt: number;
  /** 上次反思对应的数据快照日期（用于增量对比） */
  lastReflectionDate: string;
};

// =====================================================================
// 路径 & 默认配置
// =====================================================================

export const REFLECTIONS_DIRNAME = "reflections";
export const REFLECTION_STATE_FILENAME = "reflection-state.json";

export const DEFAULT_REFLECTION_CONFIG = {
  /** 默认回看 N 天的数据 */
  lookbackDays: 7,
  /** 距上次反思多久应该再跑（默认 24h） */
  suggestIntervalMs: 24 * 60 * 60 * 1000,
  /** LLM 输出 max tokens */
  maxOutputTokens: 1500,
};

/**
 * 拼出反思文件路径。
 */
export function getReflectionsDir(dataDir: string): string {
  return join(dataDir, REFLECTIONS_DIRNAME);
}

export function getReflectionFilePath(
  dataDir: string,
  dateStr: string,
): string {
  return join(getReflectionsDir(dataDir), `${dateStr}.md`);
}

export function getReflectionStatePath(dataDir: string): string {
  return join(getReflectionsDir(dataDir), REFLECTION_STATE_FILENAME);
}

// =====================================================================
// 状态持久化
// =====================================================================

/**
 * 加载反思 state。文件不存在返回零值。
 */
export async function loadReflectionState(
  dataDir: string,
): Promise<ReflectionState> {
  const path = getReflectionStatePath(dataDir);
  if (!existsSync(path)) {
    return { lastReflectionAt: 0, lastReflectionDate: "" };
  }
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ReflectionState>;
    return {
      lastReflectionAt: parsed.lastReflectionAt ?? 0,
      lastReflectionDate: parsed.lastReflectionDate ?? "",
    };
  } catch {
    return { lastReflectionAt: 0, lastReflectionDate: "" };
  }
}

/**
 * 持久化 state。原子写。
 */
export async function saveReflectionState(
  dataDir: string,
  state: ReflectionState,
): Promise<void> {
  const path = getReflectionStatePath(dataDir);
  await mkdir(getReflectionsDir(dataDir), { recursive: true });
  await writeFile(path, JSON.stringify(state, null, 2), "utf-8");
}

/**
 * 决定是否应该建议用户跑一次反思。
 *
 * 规则：
 * - 从没跑过 → true
 * - 上次跑距今 ≥ suggestIntervalMs 且当日有对话 → true
 * - 否则 false（避免刷屏）
 */
export function shouldSuggestReflection(
  state: ReflectionState,
  hasConversationToday: boolean,
  now: number = Date.now(),
  intervalMs: number = DEFAULT_REFLECTION_CONFIG.suggestIntervalMs,
): boolean {
  if (state.lastReflectionAt === 0) return true;
  if (hasConversationToday && now - state.lastReflectionAt >= intervalMs) {
    return true;
  }
  return false;
}

// =====================================================================
// 上下文收集
// =====================================================================

export type ReflectionContextInput = {
  /** timeline 实例（用于读情绪时间线） */
  timeline: Timeline;
  /** memory 目录 */
  memoryDir: string;
  /** profile 路径（或 null 让函数自己 load） */
  dataDir?: string;
  /** 回看天数 */
  lookbackDays?: number;
};

export type GatheredContext = {
  /** 时间线最近 N 天（已过滤） */
  timelineEntries: TimelineEntry[];
  /** 当前 profile（可为 null） */
  profile: Profile | null;
  /** memory 文件列表（按 mtime 倒序） */
  memories: MemoryFile[];
  /** 回看天数（实际使用的） */
  lookbackDays: number;
};

/**
 * 把最近的 timeline / memory / profile 汇总成一段纯文本 context，
 * 喂给 LLM 当反思的输入。
 */
export async function gatherReflectionContext(
  input: ReflectionContextInput,
): Promise<GatheredContext & { contextText: string }> {
  const lookbackDays = input.lookbackDays ?? DEFAULT_REFLECTION_CONFIG.lookbackDays;
  const cutoffMs = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;

  const allEntries = await input.timeline.readAll();
  const recentEntries = allEntries.filter((e) => e.ts >= cutoffMs);
  const memories = await scanMemory(input.memoryDir);

  let profile: Profile | null = null;
  if (input.dataDir) {
    try {
      profile = await loadProfile(input.dataDir);
    } catch {
      profile = null;
    }
  }

  // 拼成 contextText
  const lines: string[] = [];

  lines.push(`# 反思上下文（最近 ${lookbackDays} 天）\n`);

  // 1. 时间线情绪
  lines.push(`## 1. 情绪时间线（${recentEntries.length} 条）\n`);
  if (recentEntries.length === 0) {
    lines.push("（无）\n");
  } else {
    for (const e of recentEntries) {
      const date = new Date(e.ts).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
      const intensity = Math.round(e.intensity * 10);
      const trigger = e.trigger ? ` · ${e.trigger}` : "";
      const excerpt = e.userExcerpt ? ` · "${e.userExcerpt.slice(0, 60)}"` : "";
      lines.push(`- ${date} ${e.emotion} 强度 ${intensity}/10${trigger}${excerpt}`);
    }
    lines.push("");

    // 简单情绪分布
    const emotionCounts: Record<string, number> = {};
    let totalIntensity = 0;
    for (const e of recentEntries) {
      emotionCounts[e.emotion] = (emotionCounts[e.emotion] ?? 0) + 1;
      totalIntensity += e.intensity;
    }
    const avgIntensity = totalIntensity / recentEntries.length;
    lines.push(`**平均强度**：${(avgIntensity * 100).toFixed(0)}%`);
    lines.push(
      `**情绪分布**：${Object.entries(emotionCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(", ")}`,
    );
    lines.push("");
  }

  // 2. profile
  lines.push("\n## 2. 用户画像\n");
  if (!profile) {
    lines.push("（未加载到）\n");
  } else {
    for (const [name, body] of Object.entries(profile.sections)) {
      const trimmed = body.trim();
      if (!trimmed || trimmed.startsWith("（暂无")) continue;
      lines.push(`### ${name}\n${trimmed}\n`);
    }
  }

  // 3. memory
  lines.push("\n## 3. 记忆文件清单\n");
  if (memories.length === 0) {
    lines.push("（无）\n");
  } else {
    lines.push(formatManifest(memories) + "\n");
    // 把最近更新的 5 条记忆的正文也带上
    const top5 = memories.slice(0, 5);
    for (const m of top5) {
      lines.push(`### ${m.filename} [${m.subtype}]\n${m.description}\n${m.body}\n`);
    }
  }

  return {
    timelineEntries: recentEntries,
    profile,
    memories,
    lookbackDays,
    contextText: lines.join("\n"),
  };
}

// =====================================================================
// LLM 反思生成
// =====================================================================

const REFLECT_SYSTEM_PROMPT = `你是情感陪伴对话的反思助手。下面是最近 N 天的情绪时间线、用户画像、和记忆文件清单。

**任务**：基于这些证据，生成一份结构化的"洞察文档"。这不是对话、不是回应用户，是写给主人（即真实陪伴用户的 AI）看的后台笔记。

**严格按以下 4 段输出 JSON**：

{
  "情绪趋势": "对比最近 7 天（或 N 天）的情绪变化。重点指出：(1) 主导情绪是否变了；(2) 强度趋势（升 / 降 / 平）；(3) 异常点（突然出现或消失的情绪）",
  "触发器与模式": "从时间线和记忆里识别反复出现或新出现的触发器。例如：\\n- 工作日傍晚焦虑加重\\n- 提到某个朋友时会更放松\\n- 周末睡眠问题下降",
  "主人格调整建议": "基于用户对主人回应的反馈（如有），或基于情绪模式推断，主人的回复风格如何微调。注意：这是建议，不是强制；用具体例子说明",
  "长期观察": "用户没有明说但被观察到的模式 / 潜在需求。例如：\\n- 用户抱怨工作但不主动说要换——可能在等被允许表达\\n- 用户对某些话题回避——可能跟过往创伤有关"
}

要求：
1. **基于证据** —— 每条结论都要有时间线或记忆的具体证据，没有证据就别说
2. **具体而非抽象** —— 不要说"用户情绪波动"，要说"周三晚上 22:00 焦虑强度 0.8，可能与周五 deadline 有关"
3. **宁缺毋滥** —— 没有观察到模式就明说"暂无"，不要为了凑数编故事
4. **保留观察的语气** —— 这不是最终判断，是"待验证的洞察"
5. **总长度 ≤ 800 字**
6. 严格 JSON 输出，不要 Markdown 代码块

上下文如下：

{context}`;

/**
 * 调用 LLM 生成反思。
 * 失败容错：返回空 sections。
 */
export async function generateReflection(
  provider: ModelProvider,
  contextText: string,
): Promise<Record<ReflectionSection, string>> {
  const prompt = REFLECT_SYSTEM_PROMPT.replace("{context}", contextText);

  let raw: string;
  try {
    raw = await provider.complete({
      model: provider.model,
      params: {
        system: "你是结构化洞察生成助手，严格输出 JSON 对象。",
        messages: [{ role: "user", content: prompt }],
        maxTokens: DEFAULT_REFLECTION_CONFIG.maxOutputTokens,
        temperature: 0.4, // 中低温度，要稳定但允许新发现
      },
    });
  } catch {
    return emptySections();
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return emptySections();
  }

  if (!parsed || typeof parsed !== "object") return emptySections();

  const sections = emptySections();
  for (const key of REFLECTION_SECTIONS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) {
      sections[key] = value.trim().slice(0, 1500);
    }
  }

  return sections;
}

function emptySections(): Record<ReflectionSection, string> {
  const out = {} as Record<ReflectionSection, string>;
  for (const s of REFLECTION_SECTIONS) out[s] = "";
  return out;
}

// =====================================================================
// 落盘
// =====================================================================

/**
 * 把反思 sections 序列化成 Markdown 文件。
 */
function serializeReflection(
  date: string,
  sections: Record<ReflectionSection, string>,
): string {
  const header = [
    `# 每日反思 — ${date}`,
    "",
    "> 由 LLM 基于最近 N 天的情绪时间线、用户画像、记忆文件生成的洞察。",
    "> 这是观察，不是判断。请用 markdown 列表形式阅读。",
    "",
    "---",
    "",
  ].join("\n");

  const body = REFLECTION_SECTIONS.map((name, i) => {
    const content = sections[name]?.trim() || "（暂无 — 模型未观察到显著模式）";
    return `## ${i + 1}. ${name}\n\n${content}`;
  }).join("\n\n---\n\n");

  return header + body + "\n";
}

/**
 * 解析反思文件（容错）。
 */
function parseReflection(raw: string): Record<ReflectionSection, string> {
  const sections = emptySections();
  const lines = raw.split("\n");
  const sectionStarts: { name: string; lineIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) {
      const rawName = m[1].trim();
      const stripped = rawName.replace(/^\d+\.\s*/, "");
      sectionStarts.push({ name: stripped, lineIdx: i });
    }
  }

  for (let i = 0; i < sectionStarts.length; i++) {
    const { name, lineIdx } = sectionStarts[i];
    const nextLineIdx =
      i + 1 < sectionStarts.length ? sectionStarts[i + 1].lineIdx : lines.length;
    const body = lines.slice(lineIdx + 1, nextLineIdx).join("\n").trim();
    if ((REFLECTION_SECTIONS as readonly string[]).includes(name)) {
      sections[name as ReflectionSection] = body;
    }
  }

  return sections;
}

// =====================================================================
// 列表 / 读取
// =====================================================================

/**
 * 列出所有反思（按日期倒序）。
 */
export async function listReflections(
  dataDir: string,
): Promise<Reflection[]> {
  const dir = getReflectionsDir(dataDir);
  if (!existsSync(dir)) return [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const reflections: Reflection[] = [];
  for (const filename of entries) {
    if (!filename.endsWith(".md") || filename === REFLECTION_STATE_FILENAME) {
      continue;
    }
    const path = join(dir, filename);
    try {
      const raw = await readFile(path, "utf-8");
      const sections = parseReflection(raw);
      const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
      const date = filename.replace(/\.md$/, "");
      reflections.push({
        date,
        sections,
        path,
        createdAt: stats.mtimeMs,
      });
    } catch {
      // 跳过损坏的文件
    }
  }

  reflections.sort((a, b) => b.date.localeCompare(a.date));
  return reflections;
}

/**
 * 读取单条反思。
 */
export async function readReflection(
  dataDir: string,
  date: string,
): Promise<Reflection | null> {
  const path = getReflectionFilePath(dataDir, date);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const sections = parseReflection(raw);
    const stats = await import("node:fs/promises").then((fs) => fs.stat(path));
    return { date, sections, path, createdAt: stats.mtimeMs };
  } catch {
    return null;
  }
}

// =====================================================================
// 一站式入口
// =====================================================================

export type RunReflectionOptions = {
  /** 回看天数 */
  lookbackDays?: number;
  /** 用什么日期作为文件名（默认今天） */
  dateStr?: string;
  /** 是否更新 state（默认 true） */
  persistState?: boolean;
};

/**
 * 完整链路：收集 context → 生成反思 → 落盘 → 更新 state。
 * 失败容错：所有错误都不抛，返回 null。
 */
export async function runReflection(
  dataDir: string,
  timeline: Timeline,
  memoryDir: string,
  provider: ModelProvider,
  options: RunReflectionOptions = {},
): Promise<Reflection | null> {
  try {
    const lookbackDays =
      options.lookbackDays ?? DEFAULT_REFLECTION_CONFIG.lookbackDays;
    const dateStr =
      options.dateStr ?? new Date().toISOString().slice(0, 10);

    const { contextText } = await gatherReflectionContext({
      timeline,
      memoryDir,
      dataDir,
      lookbackDays,
    });

    const sections = await generateReflection(provider, contextText);

    // 写盘
    const dir = getReflectionsDir(dataDir);
    await mkdir(dir, { recursive: true });
    const path = getReflectionFilePath(dataDir, dateStr);
    const content = serializeReflection(dateStr, sections);
    await writeFile(path, content, "utf-8");

    const reflection: Reflection = {
      date: dateStr,
      sections,
      path,
      createdAt: Date.now(),
    };

    if (options.persistState !== false) {
      await saveReflectionState(dataDir, {
        lastReflectionAt: reflection.createdAt,
        lastReflectionDate: dateStr,
      });
    }

    return reflection;
  } catch (e) {
    console.error(`[reflection] 失败:`, (e as Error).message);
    return null;
  }
}