// src/mcp/provider.ts
//
// MCP server 自己的 LLM provider。
//
// 为什么 server 要自己持 key：
//   - MCP 官方在 2026-07-28 规范修订（SEP-2577）里废弃了 sampling，
//     推荐的迁移路径就是「server 直接调 LLM provider API」。
//   - 实际上几乎所有客户端都不声明 sampling 能力（实测 Claude Code 2.1.326：
//     capabilities = { elicitation, roots }，无 sampling），
//     只有 VS Code 是文档+实测都对得上的少数派。
//
// 好消息：**用的是和现有 RememberMe（Web/CLI）完全同一份 settings.json**。
// 仓库版（bun run src/mcp/index.ts）→ 已经在用 RememberMe 的用户零额外配置。
// npm 版（npx）→ 包目录在 node_modules/ 里，找不到仓库那份，
//   需要 ~/.rememberme/settings.json（或 REMEMBERME_SETTINGS 指过去）。
//
// 惰性创建：没有 key 时 server 照样能启动（只读工具可用），
// 写工具会返回一条清楚的错误说明，而不是让整个 server 起不来。

import { loadProjectEnv, pickDefaultModel } from "../bootstrap.ts";
import { createProvider, type ModelProvider } from "../provider.ts";
import { resolveSettingsPath } from "./config.ts";
import { log } from "./logger.ts";

let cached: ModelProvider | null = null;
let cachedError: string | null = null;
let envLoaded = false;

/**
 * 「没有可用凭据」时给用户看的提示。
 *
 * 为什么需要单独判一次：Anthropic SDK 的构造函数**不校验 key**（传 undefined 也不报错），
 * 所以没有 key 时 createProvider() 照样返回一个 provider → providerStatus().ok === true →
 * 下面那句友好提示永远不会显示，用户实际看到的是调用时的 401。
 *
 * 提前判掉，用户就能直接知道该去哪儿配 key。
 */
const NO_CREDENTIAL_ERROR =
  "未配置 API key。请在 ~/.rememberme/settings.json 或项目 settings.json 里设置 " +
  "ANTHROPIC_API_KEY（以及可选的 ANTHROPIC_BASE_URL / ANTHROPIC_MODEL）。";

/**
 * 有没有任何可用的凭据。
 *
 * 注意 loadProjectEnv() 会无条件删掉 ANTHROPIC_AUTH_TOKEN
 * （SDK 优先读它，会绕开 settings.json 里的 ANTHROPIC_API_KEY 导致 401），
 * 所以这里只认 ANTHROPIC_API_KEY / OPENAI_API_KEY。
 */
function hasCredential(): boolean {
  return (
    !!process.env.ANTHROPIC_API_KEY?.trim() ||
    !!process.env.OPENAI_API_KEY?.trim()
  );
}

/**
 * 载入 LLM 配置（只做一次）。
 *
 * loadProjectEnv 会用 settings.json 覆盖 shell 环境变量，
 * 并且**清掉 ANTHROPIC_AUTH_TOKEN** —— 那很重要：
 * Anthropic SDK 同时读到 apiKey 和 authToken 会发两种认证头，
 * 网关认不出来就 401。
 */
function loadEnvOnce(): void {
  if (envLoaded) return;
  envLoaded = true;
  const settingsPath = resolveSettingsPath();
  if (settingsPath) {
    loadProjectEnv({ settingsPath });
  }
}

/** 拿到 provider；没有可用配置时返回 null。 */
export function getProvider(): ModelProvider | null {
  if (cached) return cached;
  if (cachedError) return null;

  // 只读模式：不调用 LLM。给不想让 server 花 API 额度的用户 / 测试用。
  if (process.env.REMEMBERME_MCP_DISABLE_LLM === "1") {
    cachedError = "已通过 REMEMBERME_MCP_DISABLE_LLM=1 禁用 LLM 调用（只读模式）";
    log.warn(cachedError);
    return null;
  }

  try {
    loadEnvOnce();

    // 没有任何凭据 → 直接判为「没配置」，别等 API 调用时甩一个 401 出来
    if (!hasCredential()) {
      cachedError = NO_CREDENTIAL_ERROR;
      log.warn(cachedError);
      return null;
    }

    const model = pickDefaultModel();
    // 与 src/index.ts 的逻辑保持一致：
    // 模型名是 claude* 或者有 Anthropic 兼容配置 → 走 anthropic provider
    const provider =
      model.startsWith("claude") ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_BASE_URL
        ? createProvider({
            kind: "anthropic",
            apiKey: process.env.ANTHROPIC_API_KEY,
            model,
          })
        : createProvider();
    cached = provider;
    log.info(`LLM provider 就绪：${provider.name} / ${provider.model}`);
    return provider;
  } catch (e) {
    cachedError = (e as Error).message;
    log.warn("没有可用的 LLM 配置：", cachedError);
    return null;
  }
}

/** provider 状态（给健康检查工具用）。 */
export function providerStatus(): {
  ok: boolean;
  model?: string;
  error?: string;
} {
  const p = getProvider();
  if (p) return { ok: true, model: p.model };
  return {
    ok: false,
    error: cachedError ?? NO_CREDENTIAL_ERROR,
  };
}

/**
 * 清掉缓存（provider / 错误 / env 已加载标记）。
 *
 * 给测试用：provider 是模块级单例，测「有 key」和「没 key」两条路径时需要复位。
 */
export function resetProviderCache(): void {
  cached = null;
  cachedError = null;
  envLoaded = false;
}

