// src/utils.ts
// 工具函数。

import { existsSync } from "node:fs";

/**
 * 检查字符串是否是 JSON 字符串。
 */
export function isJson(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全地从 stdin 读取一行（处理 Ctrl+C）。
 */
export async function readLine(
  prompt: string,
  rl: { question: (q: string, cb: (line: string) => void) => void },
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (line) => resolve(line));
  });
}

/**
 * 简易 JSON 解析（容忍 markdown code block）。
 */
export function parseJsonLoose<T = unknown>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\n/, "")
    .replace(/\n```$/, "");
  try {
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

/**
 * 等待指定毫秒。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 极简 token 估算：中文字符按 1.5 token / 字，英文按 0.3 token / 字。
 *
 * 准确度不如 tiktoken，但对预算判断够用（估算偏差只影响裁剪位置，不影响正确性）。
 * 放在 utils 而不是 compact，因为 memory.ts 的索引预算也要用它——
 * 让 memory.ts 反向依赖 compact.ts 会把压缩逻辑拖进记忆模块的依赖图。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (const ch of text) {
    // 简单判断 CJK 字符（中日韩统一表意 + 平假/片假 + 韩文音节）
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3040 && code <= 0x309f) ||
      (code >= 0x30a0 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjkChars++;
    } else {
      otherChars++;
    }
  }
  return Math.ceil(cjkChars * 1.5 + otherChars * 0.3);
}

/**
 * 彩色输出（ANSI）。
 */
export const color = {
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};