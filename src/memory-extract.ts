// src/memory-extract.ts
// 从对话中抽取值得记忆的事实（情绪 + 事件 双主类）。
//
// 设计原则（来自用户反馈）：
// 1. 模拟朋友面对用户时的思维方式
// 2. 只识别两类：emotion（≥2 次证据的情绪模式）+ event（有情感意义的生活事件）
// 3. 不写数字记忆（"今天 mood 0.7"）
// 4. 不写日常活动（"今天吃了碗面"）
// 5. 两类互相印证：保存时自动 link

import {
  scanMemory,
  writeMemoryFile,
  appendIndexEntry,
  appendToMemoryFile,
  findSimilarMemory,
  formatManifest,
  findRelatedEmotions,
  findRelatedEvents,
  type MemoryFile,
  type MemoryType,
  type AnyMemoryCandidate,
  type EmotionMemoryFields,
  type EventMemoryFields,
} from "./memory.ts";
import type { ModelProvider } from "./provider.ts";

// =====================================================================
// LLM 抽取 prompt
// =====================================================================

const EXTRACT_SYSTEM_PROMPT = `你是情感陪伴对话的记忆抽取助手。下面是一段对话历史。

**核心原则**：模拟朋友面对用户时的思维方式。朋友不会机械地记录每句话，但会记住那些改变理解的瞬间。

**只识别两类值得长期记忆的内容**：

1. **情绪模式 (emotion)** —— 反复出现的情绪反应
   - 必须有 **≥2 次证据**（不同对话、不同时间）
   - 例：用户每次提到工作 deadline 都焦虑，连续 3 次对话观察到
   - **不写**：单次的"今天心情不好"
   - **不写**：纯数字（"今天 mood 0.7"）

2. **生活事件 (event)** —— 对用户有情感意义的事件
   - 例：亲人去世、拿到 offer、和家人吵架、重大健康问题
   - **不写**：日常活动（"今天吃了什么"、"今天开了个会"）
   - **不写**：工作事务（除非影响情感）

两类互相印证：事件解释情绪，情绪模式暗示未说出口的事件。

**严格按 JSON 数组输出**（没有就输出 []）：

情绪模式条目：
{
  "type": "emotion",
  "name": "kebab-case slug（如 deadline-anxiety-spike）",
  "description": "一句话模式描述",
  "trigger": "触发条件",
  "manifestation": "表现（情绪类型 + 强度描述 + 行为反应）",
  "evidence": ["证据1", "证据2", ...]   // 必须 ≥2 条
  "confidence": 0.0-1.0
}

事件条目：
{
  "type": "event",
  "name": "kebab-case slug（如 cat-passed-away）",
  "description": "一句话事件",
  "occurred_at": "YYYY-MM-DD 或 '约 3 天前' 等",
  "emotional_impact": "对用户的情感影响",
  "significance": "high | medium | low",
  "confidence": 0.0-1.0
}

要求：
1. **宁缺毋滥**：没观察到就不输出
2. **emotion 必须有 ≥2 条 evidence**，否则不输出
3. **event 要有情感意义**，日常活动不算
4. **不写数字记忆**：不输出"mood 0.7"
5. **保留用户原话片段**（≤30 字）作为 evidence
6. 严格 JSON 输出，不要 Markdown 代码块

对话如下：

{conversation}

已有记忆（用来去重）：
{manifest}`;

function buildConversationText(
  messages: { role: string; content: string }[],
  maxMessages = 12,
): string {
  return messages
    .slice(-maxMessages)
    .map((m, i) => `${i + 1}. [${m.role}] ${m.content}`)
    .join("\n\n");
}

// =====================================================================
// 抽取
// =====================================================================

/**
 * 从对话中识别候选记忆（emotion / event）。
 * 失败容错：返回空数组。
 */
export async function extractMemoryCandidates(
  provider: ModelProvider,
  recentMessages: { role: string; content: string }[],
  existingFiles: MemoryFile[] = [],
): Promise<AnyMemoryCandidate[]> {
  if (recentMessages.length === 0) return [];

  const conversation = buildConversationText(recentMessages);
  const manifest = formatManifest(existingFiles);
  const prompt = EXTRACT_SYSTEM_PROMPT
    .replace("{conversation}", conversation)
    .replace("{manifest}", manifest || "（暂无）");

  let raw: string;
  try {
    raw = await provider.complete({
      model: provider.model,
      params: {
        system: "你是结构化信息抽取助手，严格输出 JSON 数组。",
        messages: [{ role: "user", content: prompt }],
        maxTokens: 1500,
        temperature: 0.2,
      },
    });
  } catch {
    return [];
  }

  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const valid: AnyMemoryCandidate[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;

    const type = c.type as string;
    if (type !== "emotion" && type !== "event") continue;

    const name = String(c.name ?? "").trim();
    const description = String(c.description ?? "").trim();
    const confidence = Number(c.confidence ?? 0);

    if (!name || !description) continue;
    if (!Number.isFinite(confidence) || confidence < 0.5) continue;
    if (!/^[a-z0-9_-]{2,40}$/i.test(name)) continue;

    if (type === "emotion") {
      const fields: EmotionMemoryFields = {
        trigger: String(c.trigger ?? "").trim(),
        manifestation: String(c.manifestation ?? "").trim(),
        evidence: Array.isArray(c.evidence)
          ? c.evidence.map((e) => String(e).trim()).filter(Boolean)
          : [],
      };

      // 关键校验：emotion 必须有 ≥2 条 evidence
      if (fields.evidence!.length < 2) continue;
      if (!fields.trigger || !fields.manifestation) continue;

      valid.push({
        type: "emotion",
        name,
        description: description.slice(0, 120),
        body: String(c.body ?? formatEmotionBody(fields, description)).slice(0, 2000),
        confidence: Math.max(0, Math.min(1, confidence)),
        fields,
      });
    } else {
      // event
      const fields: EventMemoryFields = {
        occurred_at: String(c.occurred_at ?? "").trim(),
        emotional_impact: String(c.emotional_impact ?? "").trim(),
        significance: String(c.significance ?? "medium").trim(),
      };

      // event 必须有 occurred_at 和 emotional_impact
      if (!fields.occurred_at || !fields.emotional_impact) continue;

      valid.push({
        type: "event",
        name,
        description: description.slice(0, 120),
        body: String(c.body ?? formatEventBody(fields, description)).slice(0, 2000),
        confidence: Math.max(0, Math.min(1, confidence)),
        fields,
      });
    }
  }

  return valid;
}

function formatEmotionBody(
  fields: EmotionMemoryFields,
  description: string,
): string {
  return [
    description,
    "",
    `**触发**：${fields.trigger ?? ""}`,
    `**表现**：${fields.manifestation ?? ""}`,
    `**证据**：`,
    ...((fields.evidence ?? []).map((e) => `- ${e}`)),
  ].join("\n");
}

function formatEventBody(
  fields: EventMemoryFields,
  description: string,
): string {
  return [
    description,
    "",
    `**发生时间**：${fields.occurred_at ?? ""}`,
    `**情感影响**：${fields.emotional_impact ?? ""}`,
    `**重要程度**：${fields.significance ?? "medium"}`,
  ].join("\n");
}

// =====================================================================
// 落盘（带去重 + 跨印证）
// =====================================================================

export type SaveResult = {
  candidate: AnyMemoryCandidate;
  /** "new" = 新建文件；"merged" = 追加到已有文件；"skipped" = 跳过 */
  action: "new" | "merged" | "skipped";
  existingFile?: MemoryFile;
  path?: string;
  /** 自动 link 的关联（v0.5 新增） */
  linkedTo?: string[];
};

/**
 * 把候选记忆落盘（带去重 + 跨印证）。
 */
export async function saveMemoryCandidate(
  memoryDir: string,
  candidate: AnyMemoryCandidate,
): Promise<SaveResult> {
  // 1. 找相似的（去重）
  let similar: MemoryFile | null = null;
  try {
    similar = await findSimilarMemory(memoryDir, {
      subtype: candidate.type,
      name: candidate.name,
      description: candidate.description,
    });
  } catch {
    similar = null;
  }

  if (similar) {
    // 合并到已有文件
    try {
      const addition = `**${candidate.description}**\n\n${candidate.body}`;
      const result = await appendToMemoryFile(
        memoryDir,
        candidate.type,
        similar.filename,
        addition,
      );
      return {
        candidate,
        action: result.appended ? "merged" : "skipped",
        existingFile: similar,
        path: result.path,
      };
    } catch {
      return { candidate, action: "skipped" };
    }
  }

  // 2. 跨印证：自动 link
  const linkedTo: string[] = [];
  try {
    if (candidate.type === "event") {
      const emotions = await findRelatedEmotions(
        memoryDir,
        candidate.fields,
        candidate.fields.occurred_at ?? "",
      );
      linkedTo.push(...emotions);
      candidate.fields.linked_emotions = emotions;
    } else if (candidate.type === "emotion") {
      const events = await findRelatedEvents(memoryDir, candidate.fields);
      linkedTo.push(...events);
      candidate.fields.linked_events = events;
    }
  } catch {
    // 跨印证失败不阻断保存
  }

  // 3. 新建文件
  const filename = `${candidate.name}.md`;
  try {
    const path = await writeMemoryFile(
      memoryDir,
      {
        name: candidate.name,
        description: candidate.description,
        subtype: candidate.type,
        body: candidate.body,
        fields: candidate.fields,
      },
      filename,
    );
    // 索引去重
    const alreadyIndexed = await import("./memory.ts").then((m) =>
      m.hasIndexEntry(memoryDir, candidate.type, candidate.name),
    );
    if (!alreadyIndexed) {
      await appendIndexEntry(memoryDir, {
        title: candidate.name,
        subtype: candidate.type,
        filename: candidate.name,
        hook: candidate.description,
      });
    }
    return {
      candidate,
      action: "new",
      path,
      linkedTo: linkedTo.length > 0 ? linkedTo : undefined,
    };
  } catch (e) {
    console.error(`[memory-extract] 写入失败:`, (e as Error).message);
    return { candidate, action: "skipped" };
  }
}

// =====================================================================
// 一站式入口
// =====================================================================

export type AutoExtractConfig = {
  minConfidence?: number;
};

/**
 * 完整链路：抽取 → 过滤（置信度） → 落盘（去重 + 跨印证）。
 */
export async function maybeAutoExtract(
  memoryDir: string,
  provider: ModelProvider,
  recentMessages: { role: string; content: string }[],
  config: AutoExtractConfig = {},
): Promise<SaveResult[]> {
  try {
    const existing = await scanMemory(memoryDir);
    const candidates = await extractMemoryCandidates(
      provider,
      recentMessages,
      existing,
    );

    const minConfidence = config.minConfidence ?? 0.7;
    const filtered = candidates.filter((c) => c.confidence >= minConfidence);
    if (filtered.length === 0) return [];

    const results: SaveResult[] = [];
    for (const c of filtered) {
      const r = await saveMemoryCandidate(memoryDir, c);
      results.push(r);
    }
    return results;
  } catch (e) {
    console.error(`[memory-extract] 失败:`, (e as Error).message);
    return [];
  }
}