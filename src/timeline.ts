// src/timeline.ts
// 情绪时间线（独立于 5 类记忆）。
//
// 设计：按时间序列记录每一次对话 / 情绪识别 / 重要事件。
// 存为 JSONL，每行一条。查询方便、可独立分析情绪漂移。

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";

export type EmotionCategory =
  | "joy" // 开心
  | "sadness" // 难过
  | "anger" // 生气
  | "fear" // 害怕 / 焦虑
  | "surprise" // 惊讶
  | "disgust" // 厌恶
  | "neutral" // 平静
  | "mixed"; // 复杂

export const EMOTION_LABEL: Record<EmotionCategory, string> = {
  joy: "开心",
  sadness: "难过",
  anger: "生气",
  fear: "焦虑",
  surprise: "惊讶",
  disgust: "厌恶",
  neutral: "平静",
  mixed: "复杂",
};

export const EMOTION_EMOJI: Record<EmotionCategory, string> = {
  joy: "😊",
  sadness: "😔",
  anger: "😤",
  fear: "😰",
  surprise: "😮",
  disgust: "😒",
  neutral: "😐",
  mixed: "🤔",
};

export type TimelineEntry = {
  /** Unix 毫秒时间戳 */
  ts: number;
  /** ISO 日期（方便阅读） */
  date: string;
  /** 情绪类别 */
  emotion: EmotionCategory;
  /** 强度 0-1 */
  intensity: number;
  /** 触发器（可选） */
  trigger?: string;
  /** 用户原文片段（可选，最多 200 字） */
  userExcerpt?: string;
  /** 我的回应（可选，最多 200 字） */
  myResponseExcerpt?: string;
  /** 关联的记忆文件名（可选） */
  relatedMemory?: string;
};

export type TimelineStats = {
  totalEntries: number;
  emotionCounts: Partial<Record<EmotionCategory, number>>;
  /** 最近 7 天的情绪类别 */
  recent7Days: Partial<Record<EmotionCategory, number>>;
  /** 当前主导情绪（最近 3 条） */
  currentDominant: EmotionCategory | null;
  /** 平均强度（最近 7 天） */
  avgIntensity7Days: number;
};

export class Timeline {
  private filePath: string;

  constructor(timelineDir: string) {
    this.filePath = join(timelineDir, "emotional_timeline.jsonl");
  }

  async ensure(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await readFile(this.filePath, "utf-8");
    } catch {
      await writeFile(this.filePath, "", "utf-8");
    }
  }

  /**
   * 追加一条时间线记录。
   */
  async append(entry: Omit<TimelineEntry, "ts" | "date">): Promise<void> {
    await this.ensure();
    const now = new Date();
    const full: TimelineEntry = {
      ...entry,
      ts: now.getTime(),
      date: now.toISOString(),
    };
    await appendFile(this.filePath, JSON.stringify(full) + "\n", "utf-8");
  }

  /**
   * 读取全部记录（按时间正序）。
   */
  async readAll(): Promise<TimelineEntry[]> {
    await this.ensure();
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf-8");
    } catch {
      return [];
    }
    const entries: TimelineEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // 跳过损坏的行
      }
    }
    return entries;
  }

  /**
   * 读取最近 N 条。
   */
  async readRecent(n: number): Promise<TimelineEntry[]> {
    const all = await this.readAll();
    return all.slice(-n);
  }

  /**
   * 计算情绪统计。
   */
  async getStats(): Promise<TimelineStats> {
    const all = await this.readAll();
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const emotionCounts: Partial<Record<EmotionCategory, number>> = {};
    const recent7Days: Partial<Record<EmotionCategory, number>> = {};
    let intensitySum = 0;
    let intensityCount = 0;

    for (const e of all) {
      emotionCounts[e.emotion] = (emotionCounts[e.emotion] ?? 0) + 1;
      if (e.ts >= sevenDaysAgo) {
        recent7Days[e.emotion] = (recent7Days[e.emotion] ?? 0) + 1;
        intensitySum += e.intensity;
        intensityCount += 1;
      }
    }

    const last3 = all.slice(-3);
    const last3Counts: Partial<Record<EmotionCategory, number>> = {};
    for (const e of last3) {
      last3Counts[e.emotion] = (last3Counts[e.emotion] ?? 0) + 1;
    }
    const currentDominant =
      (Object.entries(last3Counts).sort(
        (a, b) => (b[1] ?? 0) - (a[1] ?? 0),
      )[0]?.[0] as EmotionCategory | undefined) ?? null;

    return {
      totalEntries: all.length,
      emotionCounts,
      recent7Days,
      currentDominant,
      avgIntensity7Days: intensityCount > 0 ? intensitySum / intensityCount : 0,
    };
  }

  /**
   * 渲染成可读的 prompt 摘要（注入到 system prompt）。
   */
  async renderSummary(maxEntries: number = 5): Promise<string> {
    const recent = await this.readRecent(maxEntries);
    if (recent.length === 0) return "(尚无情绪记录)";

    const lines = recent.map((e) => {
      const date = new Date(e.ts).toLocaleString("zh-CN", {
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
      });
      const emoji = EMOTION_EMOJI[e.emotion];
      const label = EMOTION_LABEL[e.emotion];
      const intensity = "⚡".repeat(Math.max(1, Math.round(e.intensity * 5)));
      const trigger = e.trigger ? ` (${e.trigger})` : "";
      const excerpt = e.userExcerpt ? ` — "${e.userExcerpt.slice(0, 60)}…"` : "";
      return `- ${date} ${emoji} ${label} ${intensity}${trigger}${excerpt}`;
    });

    const stats = await this.getStats();
    const dominantLine = stats.currentDominant
      ? `\n\n**当前主导情绪**：${EMOTION_LABEL[stats.currentDominant]} ${EMOTION_EMOJI[stats.currentDominant]}`
      : "";

    return (
      `## 最近情绪轨迹（最多 ${maxEntries} 条）\n\n` +
      lines.join("\n") +
      dominantLine
    );
  }
}