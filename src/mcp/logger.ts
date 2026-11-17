// src/mcp/logger.ts
//
// MCP server 的日志。
//
// ⚠️ 关键约束：走 stdio 传输时，**stdout 是 JSON-RPC 的专属通道**。
// 只要有一行 console.log 打到 stdout，客户端就会收到非法 JSON，直接崩。
//
// 所以：
//   1. 本模块所有日志一律走 console.error（stderr）
//   2. 入口处调用 protectStdout()，把残留的 console.log / console.info
//      劫持到 stderr —— 防止现有代码里的 console.log 漏网

const PREFIX = "[rememberme-mcp]";

export const log = {
  info: (...args: unknown[]) => console.error(PREFIX, ...args),
  warn: (...args: unknown[]) => console.error(PREFIX, "WARN", ...args),
  error: (...args: unknown[]) => console.error(PREFIX, "ERROR", ...args),
};

/**
 * 把 console.log / console.info / console.debug 劫持到 stderr。
 *
 * 幂等；只影响当前进程。
 */
export function protectStdout(): void {
  const stderr = console.error.bind(console);
  console.log = stderr;
  console.info = stderr;
  console.debug = stderr;
  console.warn = stderr;
}
