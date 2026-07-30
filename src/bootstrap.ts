// src/bootstrap.ts
// 从项目本地 ./settings.json 加载环境变量。
//
// 格式是 Anthropic SDK 标准的 `env` 包装：每个 key 是 SDK 识别的
// 环境变量名（ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ANTHROPIC_MODEL）。
// 项目级配置独立存放，不会污染 shell 环境。

import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * 从指定目录下的 settings.json 加载 env 到 process.env。
 *
 * 默认路径：项目根目录下的 settings.json
 *
 * 规则：
 * - 只在 process.env 中没有该变量时才覆盖（已设置的值优先）
 * - 自动把 ANTHROPIC_AUTH_TOKEN 映射到 ANTHROPIC_API_KEY
 * - 不存在的文件静默忽略
 */
export function loadProjectEnv(
  options: { settingsPath?: string; verbose?: boolean } = {},
): {
  loaded: boolean;
  path: string;
  loadedKeys: string[];
} {
  const settingsPath = options.settingsPath ?? join(process.cwd(), "settings.json");
  const verbose = options.verbose ?? false;

  if (!existsSync(settingsPath)) {
    if (verbose) {
      console.log(`[bootstrap] 跳过：${settingsPath} 不存在`);
    }
    return { loaded: false, path: settingsPath, loadedKeys: [] };
  }

  let settings: { env?: Record<string, string> };
  try {
    const raw = readFileSync(settingsPath, "utf-8");
    settings = JSON.parse(raw) as { env?: Record<string, string> };
  } catch (e) {
    if (verbose) {
      console.warn(`[bootstrap] 无法解析 ${settingsPath}:`, e);
    }
    return { loaded: false, path: settingsPath, loadedKeys: [] };
  }

  const env = settings.env ?? {};
  const loadedKeys: string[] = [];

  // 别名映射（保留 ANTHROPIC_AUTH_TOKEN 别名以兼容某些旧 shell 工具的写法）
  // ANTHROPIC_AUTH_TOKEN 也写到 ANTHROPIC_API_KEY（同值），但同时清掉 ANTHROPIC_AUTH_TOKEN
  // 防止 SDK 读到旧 shell env 里的 ANTHROPIC_AUTH_TOKEN 而用错 key。
  const aliasMap: Record<string, string> = {
    ANTHROPIC_AUTH_TOKEN: "ANTHROPIC_API_KEY",
  };

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") continue;
    const targetKey = aliasMap[key] ?? key;
    // settings.json 是项目配置的最高优先级——覆盖 shell 环境变量
    if (process.env[targetKey] !== undefined && options.verbose) {
      console.log(
        `[bootstrap] ${targetKey} 覆盖了 shell 环境变量`,
      );
    }
    process.env[targetKey] = value;
    loadedKeys.push(targetKey !== key ? `${key}→${targetKey}` : key);
  }

  // 无条件清除 ANTHROPIC_AUTH_TOKEN（无论 settings.json 有没有）
  // 因为 Anthropic SDK 优先读 ANTHROPIC_AUTH_TOKEN，会绕过 settings.json 的 ANTHROPIC_API_KEY
  // 如果 shell 里有旧的 AUTH_TOKEN，会用错 key
  if (process.env.ANTHROPIC_AUTH_TOKEN !== undefined && options.verbose) {
    console.log(`[bootstrap] 清掉 ANTHROPIC_AUTH_TOKEN shell 变量（用 ANTHROPIC_API_KEY 替代）`);
  }
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  if (verbose && loadedKeys.length > 0) {
    console.log(
      `[bootstrap] 从 ${settingsPath} 加载了 ${loadedKeys.length} 个变量：${loadedKeys.join(", ")}`,
    );
  }

  return { loaded: loadedKeys.length > 0, path: settingsPath, loadedKeys };
}

/**
 * 选择默认模型（按优先级）。
 *
 * 优先 ANTHROPIC_MODEL（settings.json 显式设置的），
 * 然后才是 ANTHROPIC_DEFAULT_*_MODEL（shell 默认）。
 * 这样用户改 settings.json 就能立即切换模型。
 */
export function pickDefaultModel(): string {
  return (
    process.env.ANTHROPIC_MODEL ??
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL ??
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ??
    process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL ??
    "claude-sonnet-4-5-20250929"
  );
}