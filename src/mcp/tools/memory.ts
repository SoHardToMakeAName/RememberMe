// src/mcp/tools/memory.ts
//
// 记忆读取工具：list_memories / read_memory
//
// 注意 read_memory 的实现：
//   **不能**用 readMemoryFile(dir, `${type}/${name}`) —— resolveMemoryPath()
//   拼路径时漏了 .md 后缀（已在 src/memory.ts 修复，但这里直接用 scanMemory
//   + 精确匹配更稳，也不依赖那个函数的边界行为）。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { scanMemory, formatManifest, type MemoryFile } from "../../memory.ts";
import { paths } from "../config.ts";
import { log } from "../logger.ts";

export function registerMemoryTools(server: McpServer): void {
  // ---- list_memories ----
  server.registerTool(
    "list_memories",
    {
      title: "列出全部长期记忆",
      description:
        "列出用户的所有长期记忆（情绪模式 / 生活事件 / 外部资源），含名称与一句话描述。" +
        "当用户提到过去、之前、记得什么，或你需要了解用户的长期背景时调用。" +
        "返回全部条目；拿到列表后再用 read_memory 取需要的那条的完整内容。",
      inputSchema: {
        type: z
          .enum(["emotion", "event", "reference"])
          .optional()
          .describe("可选。按类型过滤；不填表示列出全部。"),
      },
    },
    async (args) => {
      try {
        const all = await scanMemory(paths.memory);
        const files: MemoryFile[] = args.type
          ? all.filter((f) => f.subtype === args.type)
          : all;

        return {
          content: [
            {
              type: "text",
              text:
                files.length === 0
                  ? "（没有匹配的记忆文件）"
                  : `找到 ${files.length} 条记忆：\n\n${formatManifest(files)}`,
            },
          ],
          structuredContent: {
            memories: files.map((f) => ({
              type: f.subtype,
              name: f.name,
              description: f.description,
              date: new Date(f.mtimeMs).toISOString().slice(0, 10),
            })),
          },
        };
      } catch (e) {
        log.error("list_memories 失败:", (e as Error).message);
        return {
          content: [
            { type: "text", text: `读取记忆失败：${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );

  // ---- read_memory ----
  server.registerTool(
    "read_memory",
    {
      title: "读取单条记忆的完整内容",
      description:
        "读取一条长期记忆的完整正文（含触发条件、表现、证据、时间、情感影响等结构化字段）。" +
        "list_memories 之后，对真正相关的条目调用本工具获取完整信息。",
      inputSchema: {
        type: z
          .enum(["emotion", "event", "reference"])
          .describe("记忆类型：emotion=情绪模式，event=生活事件，reference=外部资源。"),
        name: z.string().describe("记忆名（如 work-burnout），不含 .md 后缀。"),
      },
    },
    async (args) => {
      try {
        const all = await scanMemory(paths.memory);
        const file = all.find(
          (f) => f.subtype === args.type && f.filename === args.name,
        );
        if (!file) {
          return {
            content: [
              {
                type: "text",
                text:
                  `记忆不存在：${args.type}/${args.name}。` +
                  `可用条目：${all.map((f) => `${f.subtype}/${f.filename}`).join(", ")}`,
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: file.body }],
          structuredContent: {
            type: file.subtype,
            name: file.name,
            description: file.description,
            body: file.body,
            fields: file.fields,
          },
        };
      } catch (e) {
        log.error("read_memory 失败:", (e as Error).message);
        return {
          content: [
            { type: "text", text: `读取记忆失败：${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
