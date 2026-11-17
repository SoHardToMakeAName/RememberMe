// src/memory.ts
// 情绪 + 事件 双主类记忆系统。
//
// 设计原则（来自用户反馈）：
// - 模拟朋友面对用户时的思维方式
// - 记那些改变理解的瞬间，不是机械日志
// - 两大主类：
//   * emotion —— 反复出现的情绪模式（必须有 ≥2 次证据）
//   * event —— 对用户有情感意义的生活事件
// - 一小类：
//   * reference —— 外部资源（医生/咨询师/家人联系方式）
// - 两类互相印证：事件解释情绪，情绪暗示事件
//
// 目录结构：
//   data/memory/
//     emotion/<slug>.md
//     event/<slug>.md
//     reference/<slug>.md
//     MEMORY.md （索引）
//
// 与其他系统的边界：
// - profile.ts：用户身份背景（不是 emotion 也不是 event）
// - timeline.ts：当下情绪快照（单轮，不是模式）
// - reflection.ts：跨源洞察（meta-analysis）

import { readFile, readdir, writeFile, mkdir, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import { estimateTokens } from "./utils.ts";

// =====================================================================
// Schema
// =====================================================================

/**
 * 两主类 + 一小类。
 */
export const MEMORY_TYPES = ["emotion", "event", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

/** 类型中文标签（显示用） */
export const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  emotion: "情绪模式",
  event: "生活事件",
  reference: "外部资源",
};

/** 类型子目录名 */
const TYPE_DIR: Record<MemoryType, string> = {
  emotion: "emotion",
  event: "event",
  reference: "reference",
};

/**
 * 情绪模式文件的 frontmatter 字段（解析后扁平化为 Record）。
 * 关键字段：trigger, manifestation, evidence[], confidence
 */
export type EmotionMemoryFields = {
  /** 触发条件（用户原话片段或模式描述） */
  trigger?: string;
  /** 表现（情绪类型 + 强度描述 + 行为反应） */
  manifestation?: string;
  /** 证据数组（≥2 条；可以是日期-描述或用户原话片段） */
  evidence?: string[];
  /** 首次观察到（YYYY-MM-DD） */
  first_observed?: string;
  /** 最近观察到（YYYY-MM-DD） */
  last_observed?: string;
  /** high | medium | low */
  confidence?: string;
  /** 如何在对话中应用 */
  how_to_apply?: string;
  /** 关联的 event slug 列表 */
  linked_events?: string[];
};

/**
 * 事件文件的 frontmatter 字段。
 */
export type EventMemoryFields = {
  /** 发生时间（YYYY-MM-DD 或相对描述） */
  occurred_at?: string;
  /** 情感影响（持续悲伤/回避/...） */
  emotional_impact?: string;
  /** high | medium | low */
  significance?: string;
  /** 预期持续时间（4-8 weeks 等） */
  duration_expectation?: string;
  /** 如何在对话中应用 */
  how_to_apply?: string;
  /** 关联的 emotion slug 列表 */
  linked_emotions?: string[];
};

/**
 * 外部资源文件的 frontmatter 字段。
 */
export type ReferenceMemoryFields = {
  /** 联系方式或资源类型 */
  resource_type?: string;
  /** 用途说明 */
  purpose?: string;
  /** 紧急程度 */
  urgency?: string;
};

export type MemoryFile = {
  /** 文件路径（绝对） */
  path: string;
  /** 文件名（不含 .md 和子目录，如 "deadline-anxiety"） */
  filename: string;
  /** 子目录（emotion/event/reference） */
  subtype: MemoryType;
  /** frontmatter name */
  name: string;
  /** frontmatter description */
  description: string;
  /** 正文（不含 frontmatter） */
  body: string;
  /** mtime ms */
  mtimeMs: number;
  /** 字节数 */
  sizeBytes: number;
  /** 原始 frontmatter 字段（供类型化访问） */
  fields: EmotionMemoryFields & EventMemoryFields & ReferenceMemoryFields;
};

export type MemoryIndexEntry = {
  /** 显示名称 */
  title: string;
  /** 子目录 */
  subtype: MemoryType;
  /** 文件名（不含子目录） */
  filename: string;
  /** 一句话钩子 */
  hook: string;
};

export type AnyMemoryCandidate = {
  type: MemoryType;
  /** 文件名 slug（kebab-case） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 记忆正文 */
  body: string;
  /** LLM 置信度 */
  confidence: number;
  /** 类型化 frontmatter 字段（emotion 必填 trigger/manifestation/evidence；event 必填 occurred_at/emotional_impact） */
  fields: EmotionMemoryFields & EventMemoryFields & ReferenceMemoryFields;
};

// MEMORY.md 索引的注入预算。
//
// 口径用 token 而不是字节：索引整份都会进 system prompt，真正的成本是 token。
// 而本项目索引以中文为主，CJK 的字节/token 比和英文差一个量级——同样一份
// 25KB 的索引，纯英文约 6k token，纯中文约 12k token。用字节做上限会在
// 中英混排下失真，token 预算才是稳定的口径。
const INDEX_TOKEN_BUDGET = 4_000;

// =====================================================================
// frontmatter 解析 / 序列化
// =====================================================================

/**
 * 解析 frontmatter（复用 personality.ts 的逻辑）。
 * 单行 `key: value` 格式。
 *
 * 对 array 字段（evidence / linked_events / linked_emotions）的特殊处理：
 * - 支持 `key: [a, b, c]` 数组字面量
 * - 支持 `key:\n  - a\n  - b` YAML 列表
 */
function parseFrontmatter(
  raw: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: raw };

  const [, yamlBlock, body] = match;
  const frontmatter: Record<string, unknown> = {};
  const lines = yamlBlock.split("\n");

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }

    const key = line.slice(0, colonIdx).trim();
    let value: unknown = line.slice(colonIdx + 1).trim();

    // 数组字面量：[a, b, c]
    if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
      try {
        value = JSON.parse(value);
      } catch {
        const v = value as string;
        value = v.slice(1, -1).split(",").map((s: string) => s.trim().replace(/^["']|["']$/g, ""));
      }
      frontmatter[key] = value;
      i++;
      continue;
    }

    // 去引号
    if (
      typeof value === "string" &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }

    // YAML 列表：key: \n  - a \n  - b
    if (value === "") {
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s+-\s+/, "").trim());
        j++;
      }
      if (items.length > 0) {
        frontmatter[key] = items;
        i = j;
        continue;
      }
    }

    frontmatter[key] = value;
    i++;
  }

  return { frontmatter, body: body.trim() };
}

/**
 * 把 frontmatter 序列化为 YAML。
 * array 字段用 `[a, b, c]` 内联格式（更紧凑，side-query 解析也方便）。
 */
function buildFrontmatter(fields: Record<string, unknown>): string {
  const lines: string[] = ["---"];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}: [${v.map((x) => JSON.stringify(String(x))).join(", ")}]`);
    } else {
      lines.push(`${k}: ${JSON.stringify(String(v))}`);
    }
  }
  lines.push("---", "");
  return lines.join("\n");
}

// =====================================================================
// 文件路径工具
// =====================================================================

/**
 * 把文件名 slug 解析为子目录路径。
 * 接受 "emotion/deadline-anxiety" 或纯 "deadline-anxiety"。
 */
export function resolveMemoryPath(
  memoryDir: string,
  filename: string,
): { subtype: MemoryType; path: string } | null {
  // 形式 1: "emotion/foo"
  const slashIdx = filename.indexOf("/");
  if (slashIdx > 0) {
    const maybeType = filename.slice(0, slashIdx);
    if ((MEMORY_TYPES as readonly string[]).includes(maybeType)) {
      return {
        subtype: maybeType as MemoryType,
        // 必须带 .md 后缀：scanMemory() 存的是带 .md 的绝对路径，
        // 少了它 readMemoryFile() 里的 f.path === resolved.path 永远不成立
        // （带子目录前缀的查找 100% 落空 —— 这条路径有回归测试覆盖）。
        path: join(
          memoryDir,
          filename.endsWith(".md") ? filename : `${filename}.md`,
        ),
      };
    }
  }
  return null;
}

/**
 * 把 MemoryType 转为子目录前缀。
 */
export function prefixByType(
  subtype: MemoryType,
  filename: string,
): string {
  return `${TYPE_DIR[subtype]}/${filename}`;
}

// =====================================================================
// 扫描 / 读取
// =====================================================================

/**
 * 扫描记忆目录，按子目录分类返回所有 MemoryFile。
 */
export async function scanMemory(memoryDir: string): Promise<MemoryFile[]> {
  const all: MemoryFile[] = [];

  for (const subtype of MEMORY_TYPES) {
    const subdir = join(memoryDir, TYPE_DIR[subtype]);
    let entries: string[];
    try {
      entries = await readdir(subdir);
    } catch {
      continue;
    }
    for (const filename of entries) {
      if (!filename.endsWith(".md")) continue;
      const path = join(subdir, filename);
      try {
        const raw = await readFile(path, "utf-8");
        const { frontmatter, body } = parseFrontmatter(raw);
        const stats = await stat(path);
        all.push({
          path,
          filename: filename.replace(/\.md$/, ""),
          subtype,
          name: String(frontmatter.name ?? filename.replace(/\.md$/, "")),
          description: String(frontmatter.description ?? ""),
          body,
          mtimeMs: stats.mtimeMs,
          sizeBytes: stats.size,
          fields: frontmatter as EmotionMemoryFields &
            EventMemoryFields &
            ReferenceMemoryFields,
        });
      } catch {
        continue;
      }
    }
  }

  // 按 mtime 降序
  all.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return all;
}

/**
 * 按 subtype 过滤。
 */
export async function readMemoriesByType(
  memoryDir: string,
  subtype: MemoryType,
): Promise<MemoryFile[]> {
  const all = await scanMemory(memoryDir);
  return all.filter((f) => f.subtype === subtype);
}

/**
 * 读单个记忆文件。filename 可以是 "emotion/foo" 或 "foo"。
 */
export async function readMemoryFile(
  memoryDir: string,
  filename: string,
): Promise<MemoryFile | null> {
  const resolved = resolveMemoryPath(memoryDir, filename);
  if (resolved) {
    // 显式带子目录
    const all = await scanMemory(memoryDir);
    const found = all.find(
      (f) => f.subtype === resolved.subtype && f.path === resolved.path,
    );
    return found ?? null;
  }
  // 纯文件名：全局搜
  const all = await scanMemory(memoryDir);
  return all.find((f) => f.filename === filename) ?? null;
}

/**
 * 格式化 manifest（side-query 选择用）。
 *
 * 按类型分组而不是拉平成一串：召回 side-query 要判断的是"这次该看情绪模式还是
 * 生活事件"，分组后模型先选类型再选文件，比在混排列表里逐条比对更稳。
 * 类型作为组标题出现，条目行里就不用再重复类型标签了。
 */
export function formatManifest(files: MemoryFile[]): string {
  if (files.length === 0) return "（没有记忆文件）";

  const blocks: string[] = [];
  for (const subtype of MEMORY_TYPES) {
    const group = files.filter((f) => f.subtype === subtype);
    if (group.length === 0) continue;

    const rows = group.map((f) => {
      const day = new Date(f.mtimeMs).toISOString().slice(0, 10);
      const desc = f.description ? `：${f.description}` : "";
      return `    ${f.filename}（${day}）${desc}`;
    });

    blocks.push(
      `  ${subtype} / ${MEMORY_TYPE_LABEL[subtype]}（${group.length} 条）\n` +
        rows.join("\n"),
    );
  }

  return blocks.join("\n\n");
}

/**
 * 把索引裁剪到 token 预算内。
 *
 * 逐行累加、整行取舍，不做字符级切断：索引每行都是一条指向真实文件的指针，
 * 从中间切开会留下半截路径，模型会拿着它去读不存在的文件。
 */
function fitIndexToBudget(raw: string): {
  text: string;
  truncated: boolean;
  droppedEntries: number;
} {
  const lines = raw.split("\n");
  const kept: string[] = [];
  let used = 0;
  let cutFrom = -1;

  for (let i = 0; i < lines.length; i++) {
    const cost = estimateTokens(lines[i]) + 1; // +1 约当换行本身的开销
    if (used + cost > INDEX_TOKEN_BUDGET) {
      cutFrom = i;
      break;
    }
    kept.push(lines[i]);
    used += cost;
  }

  if (cutFrom < 0) return { text: raw, truncated: false, droppedEntries: 0 };

  const droppedEntries = lines
    .slice(cutFrom)
    .filter((l) => l.trimStart().startsWith("- ")).length;

  return {
    text: kept.join("\n").trimEnd(),
    truncated: true,
    droppedEntries,
  };
}

/**
 * 读 MEMORY.md 索引（裁剪到 token 预算内）。
 */
export async function readMemoryIndex(memoryDir: string): Promise<string> {
  const path = join(memoryDir, "MEMORY.md");

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return "";
  }

  const { text, truncated, droppedEntries } = fitIndexToBudget(raw);
  if (!truncated) return text;

  const tail =
    droppedEntries > 0 ? `末尾 ${droppedEntries} 条未载入` : "末尾内容未载入";
  return (
    text +
    `\n\n> ⚠️ 索引已用满 ${INDEX_TOKEN_BUDGET} token 预算，${tail}。请合并或清理旧条目。`
  );
}

// =====================================================================
// 写入
// =====================================================================

/**
 * 写一个主题文件到对应子目录。
 */
export async function writeMemoryFile(
  memoryDir: string,
  file: {
    name: string;
    description: string;
    subtype: MemoryType;
    body: string;
    fields?: Partial<
      EmotionMemoryFields & EventMemoryFields & ReferenceMemoryFields
    >;
  },
  filename: string,
): Promise<string> {
  const subdir = join(memoryDir, TYPE_DIR[file.subtype]);
  await mkdir(subdir, { recursive: true });
  const path = join(subdir, filename);
  const frontmatter = {
    name: file.name,
    description: file.description,
    type: file.subtype,
    ...(file.fields ?? {}),
  };
  const content = buildFrontmatter(frontmatter) + file.body.trim() + "\n";
  await writeFile(path, content, "utf-8");
  return path;
}

/**
 * 追加一条索引到 MEMORY.md。
 */
export async function appendIndexEntry(
  memoryDir: string,
  entry: MemoryIndexEntry,
): Promise<void> {
  const path = join(memoryDir, "MEMORY.md");
  await mkdir(memoryDir, { recursive: true });

  let current = "";
  try {
    current = await readFile(path, "utf-8");
  } catch {
    // 表头顺带说明行格式：模型自己往索引里补条目时照这个格式写。
    current =
      `# 记忆索引\n\n` +
      `按类型组织：emotion（情绪模式）/ event（生活事件）/ reference（外部资源）。\n` +
      `每行一条，竖线分隔：\`- 类型/文件名.md | 标题 | 一句话线索\`\n\n`;
  }

  // 路径放在行首：这是唯一机器要用的字段（hasIndexEntry 按它判重，
  // 模型按它读文件），标题和线索都是给人和模型看的补充。
  const line = `- ${entry.subtype}/${entry.filename}.md | ${entry.title} | ${entry.hook}`;
  const updated = current.trimEnd() + "\n" + line + "\n";

  const usedTokens = estimateTokens(updated);
  if (usedTokens > INDEX_TOKEN_BUDGET * 0.8) {
    console.warn(
      `[memory] 索引已用 ${usedTokens}/${INDEX_TOKEN_BUDGET} token，接近预算，考虑合并旧条目`,
    );
  }

  await writeFile(path, updated, "utf-8");
}

/**
 * 检查 MEMORY.md 索引里是否已有某条目。
 */
export async function hasIndexEntry(
  memoryDir: string,
  subtype: MemoryType,
  filename: string,
): Promise<boolean> {
  const index = await readMemoryIndex(memoryDir);
  return index.includes(`${subtype}/${filename}.md`);
}

// =====================================================================
// 追加 / 融合（v0.3.5 沿用）
// =====================================================================

/**
 * 简单 tokenizer：英文按空格分词；中文按字符 1-gram + 2-gram。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  if (!text) return tokens;
  for (const word of text.split(/\s+/)) {
    const w = word.replace(/[^a-z0-9一-鿿]/g, "");
    if (w.length >= 2) tokens.add(w);
  }
  for (const ch of text) {
    if (/[一-鿿]/.test(ch)) tokens.add(ch);
  }
  const chars = text.match(/[一-鿿]+/g)?.[0] ?? "";
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.add(chars.slice(i, i + 2));
  }
  return tokens;
}

/**
 * Jaccard 相似度：intersection / union。
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * 安全追加内容到已有记忆文件。
 */
export async function appendToMemoryFile(
  memoryDir: string,
  subtype: MemoryType,
  filename: string,
  addition: string,
  dateStr?: string,
): Promise<{ path: string; content: string; appended: boolean }> {
  const subdir = join(memoryDir, TYPE_DIR[subtype]);
  const path = join(subdir, `${filename}.md`);
  const raw = await readFile(path, "utf-8");
  const { frontmatter, body } = parseFrontmatter(raw);

  const normalizedAdd = addition.replace(/\s+/g, "");
  const normalizedBody = body.replace(/\s+/g, "");
  if (normalizedAdd.length >= 3 && normalizedBody.includes(normalizedAdd)) {
    return { path, content: raw, appended: false };
  }

  const stamp = dateStr ?? new Date().toISOString().slice(0, 10);
  const newBody = body.trim()
    ? `${body.trim()}\n\n---\n\n**自动补充 (${stamp})**：\n\n${addition.trim()}`
    : addition.trim();

  const content = buildFrontmatter(frontmatter) + newBody + "\n";
  await writeFile(path, content, "utf-8");
  return { path, content, appended: true };
}

// =====================================================================
// 相似度查找
// =====================================================================

/**
 * 在已有记忆里找最相似的（同 subtype 内匹配）。
 */
export async function findSimilarMemory(
  memoryDir: string,
  candidate: {
    subtype: MemoryType;
    name: string;
    description: string;
  },
): Promise<MemoryFile | null> {
  const files = await readMemoriesByType(memoryDir, candidate.subtype);
  if (files.length === 0) return null;

  const candName = candidate.name.toLowerCase().trim();
  const candDesc = candidate.description.toLowerCase().trim();

  // 1. name 完全一致
  const exactName = files.find(
    (f) => f.name.toLowerCase().trim() === candName,
  );
  if (exactName) return exactName;

  // 2. name Jaccard ≥ 0.5
  const candNameTokens = tokenize(candName);
  let bestNameScore = 0;
  let bestNameMatch: MemoryFile | null = null;
  for (const f of files) {
    const fNameTokens = tokenize(f.name.toLowerCase());
    const score = jaccard(candNameTokens, fNameTokens);
    if (score > bestNameScore) {
      bestNameScore = score;
      bestNameMatch = f;
    }
  }
  if (bestNameMatch && bestNameScore >= 0.5) return bestNameMatch;

  // 3. description token Jaccard ≥ 0.3
  const candDescTokens = tokenize(candDesc);
  let bestDescScore = 0;
  let bestDescMatch: MemoryFile | null = null;
  for (const f of files) {
    const fDescTokens = tokenize(f.description.toLowerCase());
    const score = jaccard(candDescTokens, fDescTokens);
    if (score > bestDescScore) {
      bestDescScore = score;
      bestDescMatch = f;
    }
  }
  if (bestDescMatch && bestDescScore >= 0.3) return bestDescMatch;

  return null;
}

// =====================================================================
// 跨印证（事件 ↔ 情绪）
// =====================================================================

/**
 * 给定一个 event，找可能解释它的 emotion（基于时间 + 影响相似度）。
 */
export async function findRelatedEmotions(
  memoryDir: string,
  eventFields: EventMemoryFields,
  eventDate: string,
): Promise<string[]> {
  if (!eventDate || !eventFields.emotional_impact) return [];

  const emotions = await readMemoriesByType(memoryDir, "emotion");
  const impactTokens = tokenize(eventFields.emotional_impact.toLowerCase());
  const eventTs = parseDate(eventDate);

  const matches: { name: string; score: number }[] = [];

  for (const e of emotions) {
    const triggerTokens = tokenize(
      (e.fields.trigger ?? "").toLowerCase(),
    );
    const manifestTokens = tokenize(
      (e.fields.manifestation ?? "").toLowerCase(),
    );

    // 时间对齐：emotion 的 last_observed 在 event 附近
    let timeScore = 0;
    if (eventTs && e.fields.last_observed) {
      const lastTs = parseDate(e.fields.last_observed);
      if (lastTs) {
        const days = Math.abs(eventTs - lastTs) / (24 * 60 * 60 * 1000);
        timeScore = days <= 14 ? 0.5 : days <= 30 ? 0.2 : 0;
      }
    }

    // 内容对齐：trigger 或 manifestation 与 emotional_impact 相似
    const contentScore =
      Math.max(
        jaccard(impactTokens, triggerTokens),
        jaccard(impactTokens, manifestTokens),
      ) * 0.5;

    const score = timeScore + contentScore;
    if (score >= 0.4) matches.push({ name: e.filename, score });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3).map((m) => m.name);
}

/**
 * 给定一个 emotion，找可能的事件（基于时间范围 + trigger 相似）。
 */
export async function findRelatedEvents(
  memoryDir: string,
  emotionFields: EmotionMemoryFields,
): Promise<string[]> {
  const events = await readMemoriesByType(memoryDir, "event");
  if (events.length === 0) return [];

  const triggerTokens = tokenize((emotionFields.trigger ?? "").toLowerCase());
  const firstTs = parseDate(emotionFields.first_observed ?? "");
  const lastTs = parseDate(emotionFields.last_observed ?? "");

  const matches: { name: string; score: number }[] = [];

  for (const ev of events) {
    const evTs = parseDate(ev.fields.occurred_at ?? "");
    let timeScore = 0;
    if (evTs && (firstTs || lastTs)) {
      const start = firstTs ?? lastTs!;
      const end = lastTs ?? firstTs!;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      if (evTs >= lo - 30 * 86400000 && evTs <= hi + 14 * 86400000) {
        timeScore = 0.5;
      }
    }

    const impactTokens = tokenize(
      (ev.fields.emotional_impact ?? "").toLowerCase(),
    );
    const manifestTokens = tokenize(
      (emotionFields.manifestation ?? "").toLowerCase(),
    );
    const contentScore = jaccard(impactTokens, manifestTokens) * 0.5;

    const score = timeScore + contentScore;
    if (score >= 0.3) matches.push({ name: ev.filename, score });
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3).map((m) => m.name);
}

/**
 * 简易日期解析：YYYY-MM-DD 优先；"约 3 天前" / "上周" 等返回 null。
 */
function parseDate(s: string): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const [, y, mo, d] = m;
    return new Date(Number(y), Number(mo) - 1, Number(d)).getTime();
  }
  return null;
}