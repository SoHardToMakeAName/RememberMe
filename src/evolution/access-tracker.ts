// src/evolution/access-tracker.ts
// 访问追踪：每轮对话记录哪些 memory / profile item 被引用
// 用途：curator 据此判断"哪些条目其实没人在用"（→ stale / archived）。
// 设计：纯函数式 + 状态保存在 dataDir/access-log.jsonl（append-only）。

import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { AccessRecord } from "./lifecycle.ts";

export type AccessKind = "memory" | "profile" | "skill";

export type AccessEvent = {
  ts: number;
  kind: AccessKind;
  /** 条目的稳定 id（memory 用 filename，profile 用 section 名） */
  itemId: string;
  /** 触发来源 */
  source: AccessRecord["source"];
  /** 触发的那条用户消息（可选，用于事后追溯） */
  context?: string;
};

/**
 * 记录一次访问事件。
 * append-only JSONL，失败不抛错（不能让跟踪崩溃主对话）。
 */
export async function recordAccessEvent(
  dataDir: string,
  event: AccessEvent,
): Promise<void> {
  try {
    const path = join(dataDir, "evolution", "access-log.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // 静默失败
  }
}

/**
 * 批量记录（一次主循环里通常有多个被引用的条目）。
 */
export async function recordAccessEvents(
  dataDir: string,
  events: AccessEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    const path = join(dataDir, "evolution", "access-log.jsonl");
    await mkdir(dirname(path), { recursive: true });
    const lines = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await appendFile(path, lines, "utf-8");
  } catch {
    // 静默
  }
}

/**
 * 读取最近 N 条访问事件。
 * 倒序读取文件（最新在最后），取最近 N 条并反转。
 */
export async function readRecentAccessEvents(
  dataDir: string,
  limit: number = 1000,
): Promise<AccessEvent[]> {
  const path = join(dataDir, "evolution", "access-log.jsonl");
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    const events: AccessEvent[] = [];
    for (const line of lines) {
      try {
        events.push(JSON.parse(line) as AccessEvent);
      } catch {
        // skip corrupt
      }
    }
    return events.slice(-limit);
  } catch {
    return [];
  }
}

/**
 * 聚合：每个 item 的最后访问时间 + 累计访问次数。
 */
export function aggregateAccessStats(
  events: AccessEvent[],
): Map<string, { lastAccessedAt: number; count: number; kind: AccessKind }> {
  const map = new Map<string, { lastAccessedAt: number; count: number; kind: AccessKind }>();
  for (const e of events) {
    const existing = map.get(e.itemId);
    if (existing) {
      existing.count++;
      if (e.ts > existing.lastAccessedAt) existing.lastAccessedAt = e.ts;
    } else {
      map.set(e.itemId, { lastAccessedAt: e.ts, count: 1, kind: e.kind });
    }
  }
  return map;
}

/**
 * 把当前轮"用到的 memory 文件名"转成 AccessEvent 列表。
 * loop.ts 在 runTurn 末尾调用这个，传给 recordAccessEvents。
 */
export function buildEventsFromMemoryFiles(
  ts: number,
  memoryFilenames: string[],
  source: AccessRecord["source"] = "conversation",
): AccessEvent[] {
  return memoryFilenames.map((filename) => ({
    ts,
    kind: "memory" as const,
    itemId: filename,
    source,
  }));
}
