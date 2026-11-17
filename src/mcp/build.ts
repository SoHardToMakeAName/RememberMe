// src/mcp/build.ts
//
// 构建 MCP server 的分发产物（dist/mcp/index.js）。
//
// ⚠️ 为什么放在 src/ 而不是 scripts/：
//   npm 的 `prepack` 钩子要跑它（`prepack → build:mcp`），
//   所以它必须跟着仓库一起发布，否则从 fresh clone 发布出来的包没有产物。
//
// ⚠️ 为什么不用命令行 `bun build --banner "#!/usr/bin/env node"`：
//
//   Git Bash(MSYS) 会对**命令行参数**做 POSIX→Windows 路径转换，
//   把 banner 里的 `/usr/bin/env` 改写成 `C:/Program Files/Git/usr/bin/env`，
//   shebang 直接就废了。走 JS API 就完全绕开了 shell 的参数转换，
//   任何 shell（bash / cmd / PowerShell）下结果都一致。
//
// 为什么必须有 shebang：
//   npm 生成 bin shim 的逻辑（cmd-shim/lib/index.js）是——
//     "First, check if the bin is a #! of some sort.
//      If not, then assume it's something that'll be compiled,
//      or some other sort of script, and just call it directly."
//   也就是说：**没有 shebang → shim 里不会出现 node**，
//   shim 直接去执行那个 .js 文件 —— Windows 上 cmd 报「不是有效的 Win32 应用程序」，
//   POSIX 上 exec 报「exec format error」。装到用户机器上必然起不来。
//
// 用法：bun run src/mcp/build.ts

import { build } from "bun";
import { statSync } from "node:fs";
import { join } from "node:path";

/** npm bin 需要的 POSIX shebang */
const SHEBANG = "#!/usr/bin/env node";

const OUTDIR = "dist/mcp";
const ENTRY = "src/mcp/index.ts";

const result = await build({
  entrypoints: [ENTRY],
  outdir: OUTDIR,
  target: "node",
  format: "esm",
  banner: SHEBANG,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const outFile = join(OUTDIR, "index.js");
const size = statSync(outFile).size;

// 自检：shebang 必须是第一行（cmd-shim 读的是 trim 后的第一行）
const { readFileSync } = await import("node:fs");
const firstLine = readFileSync(outFile, "utf-8").split(/\r*\n/)[0];
if (firstLine !== SHEBANG) {
  console.error(`❌ shebang 不正确：第一行是 ${JSON.stringify(firstLine)}`);
  console.error(`   期望 ${JSON.stringify(SHEBANG)}`);
  console.error("   没有 shebang → npm 生成的 shim 不会调用 node → 装到用户机器上起不来。");
  process.exit(1);
}

console.log(`✅ 构建完成：${outFile}（${(size / 1024 / 1024).toFixed(2)} MB）`);
console.log(`   第一行：${firstLine}`);
