// src/mcp/index.ts
//
// MCP server 入口（npm bin: rememberme-mcp）。
//
// 启动顺序：
//   1. protectStdout() —— 把 console.log 劫持到 stderr。
//      ⚠️ 必须第一件做：stdout 是 JSON-RPC 的专属通道，
//         任何一行非 JSON 的输出都会让客户端直接崩。
//   2. 确保数据目录存在
//   3. 连接 stdio transport
//
// 用法：
//   bun run src/mcp/index.ts
//   npx -y @scope/rememberme-mcp
//
// 客户端配置示例：
//   {
//     "mcpServers": {
//       "rememberme": { "command": "npx", "args": ["-y", "@scope/rememberme-mcp"] }
//     }
//   }

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.ts";
import { paths } from "./config.ts";
import { log, protectStdout } from "./logger.ts";

export { createServer, SERVER_NAME, SERVER_VERSION };

async function main(): Promise<void> {
  // ① stdout 保护 —— 必须在任何输出之前
  protectStdout();

  // ② 确保数据目录存在
  try {
    await mkdir(paths.data, { recursive: true });
    await mkdir(paths.memory, { recursive: true });
    await mkdir(paths.profile, { recursive: true });
    await mkdir(paths.timeline, { recursive: true });
  } catch (e) {
    log.error("创建数据目录失败:", (e as Error).message);
  }

  log.info(
    `${SERVER_NAME} MCP server v${SERVER_VERSION} 启动 · dataDir=${paths.data}`,
  );

  // ③ 连接 stdio
  const server = createServer();
  await server.connect(new StdioServerTransport());
  log.info("已连接 stdio transport");
}

// 直接运行时才启动（被 import 时只导出）
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((e) => {
    log.error("MCP server 启动失败:", e);
    process.exit(1);
  });
}
