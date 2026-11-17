// src/mcp/server.ts
//
// RememberMe 的 MCP server。
//
// **单一路径**（不再有双路径）：
//
//   写工具只有 record_turn 一个。
//   宿主只判断「这轮值不值得记」（条件式调用 → 实测可靠）；
//   「记成什么」由 server 负责：缓冲攒够 → server 调自己的 LLM 抽取，
//   用 RememberMe 原版的 extractMemoryCandidates()。
//
// 为什么不用 MCP 的 sampling（server 借宿主的模型）：
//   - MCP 官方在 2026-07-28 规范修订（SEP-2577）里废弃了 sampling，
//     推荐的迁移路径就是「server 直接调 LLM provider API」。
//   - 实际上几乎所有客户端都不声明 sampling 能力（实测 Claude Code 2.1.326：
//     capabilities = { elicitation, roots }，无 sampling）；只有 VS Code 是例外。
//   - 好处：**不用能力协商**，所有客户端行为一致，工具集固定 4 个。
//
// 读工具：list_memories / read_memory / read_profile

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerMemoryTools } from "./tools/memory.ts";
import { registerReadProfileTool } from "./tools/profile.ts";
import { registerRecordTurnTool } from "./tools/record-turn.ts";
import { INSTRUCTIONS } from "./instructions.ts";
import { log } from "./logger.ts";

export const SERVER_NAME = "rememberme";
export const SERVER_VERSION = "0.22.0";

/**
 * 创建 MCP server（不连接 transport —— 便于测试）。
 */
export function createServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );

  // ---- 读工具 ----
  registerMemoryTools(server);
  registerReadProfileTool(server);

  // ---- 唯一的写工具 ----
  registerRecordTurnTool(server);

  log.info(
    `MCP server 就绪：${SERVER_NAME} v${SERVER_VERSION}（4 个工具）`,
  );

  return server;
}
