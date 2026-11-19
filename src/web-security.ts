// src/web-security.ts
//
// 网页版的网络暴露面相关的纯函数（单独成文件，方便单测直接 import
// —— src/web.ts 一被 import 就会启动服务器，不能在测试里直接引）。
//
// ⚠️ 背景（v0.22.0 修复的真实安全问题）：
//
//   Bun.serve 不写 hostname 时**默认绑 0.0.0.0**（所有网卡）。
//   同一局域网里任何设备都能访问这个服务，而 POST /api/send 会直接
//   用用户的 API key 调 LLM —— key 不会"泄露"，但额度会被别人烧掉。
//   /api/messages、/api/sessions 还会把对话历史读走，/api/clear 能删会话。
//
//   修复后的策略：
//   1. 默认只监听 127.0.0.1（要放开用 HOST=0.0.0.0）
//   2. 一旦监听**非回环**地址，必须配 EC_WEB_TOKEN，否则**拒绝启动**
//      （fail-closed：宁可起不来，也不要默默把 key 送人）
//   3. 所有 /api/* 做同源检查，挡浏览器发起的 CSRF

/**
 * 是否是本机回环地址（只有这种地址才不需要鉴权）。
 *
 * 覆盖：127.0.0.0/8 整段、localhost、IPv6 的 ::1。
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * 常量时间比较。
 *
 * 逐字符比较会在第一个不同的字节就返回，理论上能被时序攻击推出 token 前缀。
 * 这里累加 XOR 差异，保证耗时与内容无关。
 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
