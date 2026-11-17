// src/mcp/tools/profile.ts
//
// 画像工具：read_profile（只读）
//
// 为什么**不**暴露 update_profile：
//   画像更新由 server 内部复用现有的 maybeUpdateProfile() 完成
//   （和 Web/CLI 完全同一条代码路径：段1/2/6 由 LLM 抽取，段3/4/5 派生重算）。
//   宿主不需要学一套「怎么写画像段」的规则 —— 工具更少、宿主负担更小。
//
// 顺带说明：段 3 关注议题 / 段 4 已知偏好与禁忌 / 段 5 长期情绪基线 是**派生段**
// （由 syncFromSources 从 memory/ + learned-prefs 重算），外部写入会被覆盖。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadProfile } from "../../profile.ts";
import { paths } from "../config.ts";
import { log } from "../logger.ts";

export function registerReadProfileTool(server: McpServer): void {
  server.registerTool(
    "read_profile",
    {
      title: "读取用户画像",
      description:
        "读取用户的长期画像（基本信息、沟通风格、关注议题、已知偏好与禁忌、长期情绪基线、近期变化）。" +
        "当用户问「我是谁 / 我的偏好 / 我是什么样的人」时调用。",
      inputSchema: {
        section: z
          .enum([
            "基本信息",
            "沟通风格",
            "关注议题",
            "已知偏好与禁忌",
            "长期情绪基线",
            "近期变化",
          ])
          .optional()
          .describe("可选。只读取指定段；不填表示读取全部 6 段。"),
      },
    },
    async (args) => {
      try {
        const profile = await loadProfile(paths.data, {
          memoryDir: paths.memory,
        });
        const sections = args.section
          ? { [args.section]: profile.sections[args.section] ?? "" }
          : profile.sections;
        const text = Object.entries(sections)
          .map(([k, v]) => `## ${k}\n${v || "（暂无）"}`)
          .join("\n\n");
        return {
          content: [{ type: "text", text }],
          structuredContent: { sections },
        };
      } catch (e) {
        log.error("read_profile 失败:", (e as Error).message);
        return {
          content: [
            { type: "text", text: `读取画像失败：${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );
}
