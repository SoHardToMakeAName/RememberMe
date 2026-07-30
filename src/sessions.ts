// src/sessions.ts
// 按人格分别管理对话 session
//
// 核心逻辑：
// - 每个 session 是一个 (persona, history, model) 的三元组
// - 切换人格 = 找到该人格最近一次 session，加载它的 history
// - 找不到 = 开新 session
// - 一个用户可以同时有多个 session（不同 persona）

import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import type { ChatMessage } from "./provider.ts";

export type SessionMeta = {
  id: string;
  persona: string;        // 文件名，如 "default-sunny-bro.md"
  personaName: string;     // H1 名字
  model: string;
  history: ChatMessage[];
  createdAt: number;
  lastActiveAt: number;
  title?: string;          // 第一条 user message 的前 30 字
};

const SESSIONS_DIR_NAME = "sessions";
const MAX_HISTORY = 50;     // 防止 session 文件无限增长

export function getSessionsDir(dataDir: string): string {
  return join(dataDir, SESSIONS_DIR_NAME);
}

export function ensureSessionsDir(dataDir: string): void {
  const dir = getSessionsDir(dataDir);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function sessionPath(dataDir: string, id: string): string {
  return join(getSessionsDir(dataDir), `${id}.json`);
}

/**
 * 列出所有 session，按 lastActiveAt 倒序
 */
export function listSessions(dataDir: string): SessionMeta[] {
  const dir = getSessionsDir(dataDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const sessions: SessionMeta[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      const s = JSON.parse(raw) as SessionMeta;
      sessions.push(s);
    } catch {
      // 跳过损坏的文件
    }
  }
  sessions.sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  return sessions;
}

/**
 * 加载指定 session
 */
export function loadSession(dataDir: string, id: string): SessionMeta | null {
  const path = sessionPath(dataDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SessionMeta;
  } catch {
    return null;
  }
}

/**
 * 保存 session
 */
export function saveSession(dataDir: string, session: SessionMeta): void {
  ensureSessionsDir(dataDir);
  // 截断 history 防止无限增长
  if (session.history.length > MAX_HISTORY * 2) {
    session.history = session.history.slice(-MAX_HISTORY);
  }
  writeFileSync(sessionPath(dataDir, session.id), JSON.stringify(session, null, 2), "utf-8");
}

/**
 * 删除 session
 */
export function deleteSession(dataDir: string, id: string): void {
  const path = sessionPath(dataDir, id);
  if (existsSync(path)) unlinkSync(path);
}

/**
 * 找到某 persona 最近的一个 session
 * 如果没找到返回 null
 */
export function findLatestSessionForPersona(
  dataDir: string,
  persona: string,
): SessionMeta | null {
  const sessions = listSessions(dataDir).filter((s) => s.persona === persona);
  return sessions.length > 0 ? sessions[0] : null;
}

/**
 * 创建一个新 session
 */
export function createSession(
  dataDir: string,
  persona: string,
  personaName: string,
  model: string,
  history: ChatMessage[] = [],
): SessionMeta {
  const id = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();
  return {
    id,
    persona,
    personaName,
    model,
    history,
    createdAt: now,
    lastActiveAt: now,
  };
}

/**
 * 给 history 第一条 user message 取个简短标题（前 30 字）
 */
export function deriveTitle(history: ChatMessage[]): string | undefined {
  const firstUser = history.find((m) => m.role === "user");
  if (!firstUser) return undefined;
  const text = firstUser.content.trim();
  return text.length > 30 ? text.slice(0, 30) + "…" : text;
}
