// src/i18n.ts
// 最简 i18n：用 JSON 文件装 prompt 字符串，按 EC_LANG 环境变量切换 locale
//
// 用法：
//   import { t } from "./i18n.ts";
//   const prompt = t("compact.system_prompt");
//
// Locale 选择：
//   - 默认 zh-CN
//   - EC_LANG=en → en
//   - EC_LANG=zh-CN → zh-CN
//
// 历史数据（learner / profile / memory 中文）不动：LLM 本身支持多语，
// 用户用英文提问时 prompt 是英文，之前的 learner 中文 pattern LLM 仍能解析。

import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Locale = "zh-CN" | "en";

let currentLocale: Locale = detectLocale();
let bundle: Record<string, string> = loadBundle(currentLocale);

function detectLocale(): Locale {
  const env = process.env.EC_LANG?.toLowerCase();
  if (env === "en" || env === "english") return "en";
  return "zh-CN";
}

function loadBundle(locale: Locale): Record<string, string> {
  // 从 cwd/locales/{locale}.json 加载；找不到则 fallback 到空对象
  const path = join(process.cwd(), "locales", `${locale}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function setLocale(locale: Locale): void {
  currentLocale = locale;
  bundle = loadBundle(locale);
}

export function getLocale(): Locale {
  return currentLocale;
}

/**
 * 翻译：按点分键查 bundle；查不到 fallback 到 key 本身（避免运行时崩溃）
 *
 * 不支持插值（最简方案）；如未来需要再加 `params?: Record<string, string>` 参数替换
 */
export function t(key: string): string {
  const value = bundle[key];
  if (value === undefined) {
    // 开发时提示
    if (process.env.EC_DEBUG) {
      console.error(`[i18n] missing key: ${key} (locale=${currentLocale})`);
    }
    return key;
  }
  return value;
}

/**
 * 按 locale 估算 token 数（粗略）：
 * - 中文 1 字符 ≈ 1 token
 * - 英文 1 字符 ≈ 0.25 token（≈ 4 字符/token）
 * - 其他（CJK 字符）按中文算
 */
export function estimateTokensByLocale(content: string, locale?: Locale): number {
  const lang = locale ?? currentLocale;
  if (lang === "en") {
    return Math.ceil(content.length / 4);
  }
  // zh-CN（含中文字符）
  let total = 0;
  for (const ch of content) {
    // CJK 范围粗略判断
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) {
      total += 1; // 中文：1 字 ≈ 1 token
    } else {
      total += 0.25; // 英文/符号：按英文算
    }
  }
  return Math.ceil(total);
}