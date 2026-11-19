// src/mcp/tools/record-turn.ts
//
// record_turn —— 唯一的写工具。
//
// 设计要点（来自 experiments/mcp-probe 的实测结论）：
//
//  1. 宿主只判断「这轮值不值得记」，**条件式调用**。
//     实测证明「每轮都调一个工具」对 LLM 不可靠 —— 模型漏调时意识不到自己漏了。
//
//  2. 「记成什么」由 server 决定：缓冲攒够 → server 调自己的 LLM 做抽取，
//     用的是 RememberMe 原版的 extractMemoryCandidates()（prompt、JSON 解析、
//     ≥2 证据校验全部零改动）。
//     —— 这也是 MCP 官方 SEP-2577 废弃 sampling 后推荐的迁移方向。
//
//  3. 画像更新复用现有的 maybeUpdateProfile()（和 Web/CLI 完全同一条路径），
//     所以宿主不需要额外学一套「怎么写画像段」的规则。
//
//  4. 没写出时**保留缓冲** —— 一次出现可能是某个模式的第 1 次，
//     清掉就永远等不到第 2 次了。

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  extractMemoryCandidates,
  saveMemoryCandidate,
} from "../../memory-extract.ts";
import { maybeUpdateProfile } from "../../profile.ts";
// AnyMemoryCandidate 定义在 memory.ts（memory-extract.ts 只是 import 它，没有再导出）
import { scanMemory, type AnyMemoryCandidate } from "../../memory.ts";
import { paths } from "../config.ts";
import { getProvider, providerStatus } from "../provider.ts";
import { log } from "../logger.ts";

/** 缓冲里攒够几条"值得记"的记录就抽取（够 2 条证据才能归纳成模式） */
const EXTRACT_BUFFER_THRESHOLD = 2;
/** 缓冲上限（没写出时保留，防止无限增长） */
const MAX_BUFFER = 10;

type PendingTurn = {
  userMessage: string;
  assistantReply?: string;
  emotion?: string;
  intensity?: number;
  trigger?: string;
};

export function registerRecordTurnTool(server: McpServer): void {
  const pending: PendingTurn[] = [];

  server.registerTool(
    "record_turn",
    {
      title: "记录这一轮值得记住的内容",
      description:
        "当这一轮有值得长期记住的内容时调用：用户明确要求记住、出现重大生活事件、" +
        "或又一次出现同类情绪反应。" +
        "你只负责判断「值不值得记」并如实转达；具体记成什么、归纳成什么模式，" +
        "由记忆系统按它自己的规则决定，你不需要自己写记忆内容。",
      inputSchema: {
        user_message: z.string().describe("用户这轮说的话（原文）"),
        assistant_reply: z
          .string()
          .optional()
          .describe("你这轮的回复（如果有）"),
        emotion: z
          .string()
          .optional()
          .describe("你这轮判断出的用户情绪类别（可选）"),
        intensity: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("情绪强度 0-1（可选）"),
        trigger: z.string().optional().describe("情绪触发原因（可选）"),
        definite: z
          .boolean()
          .optional()
          .describe(
            "true = 用户明确要求记住，或发生了明确的重大事件（立即抽取并落盘）；" +
              "false 或不填 = 只是又一次出现同类情绪（先攒着，攒够了再归纳成模式）。",
          ),
      },
    },
    async (args) => {
      try {
        pending.push({
          userMessage: args.user_message,
          assistantReply: args.assistant_reply,
          emotion: args.emotion,
          intensity: args.intensity,
          trigger: args.trigger,
        });

        const buffered = pending.length;
        // 抽取时机：
        //   definite=true（用户明确要求 / 重大事件）→ 立即抽
        //   攒够 2 次同类出现 → 抽（够 2 条证据才能归纳成模式）
        //
        // 不用「情绪强度 ≥ 0.7」单独触发：缓冲里装的都是宿主已判定为「值得记」的
        // 轮次，只有一条时抽了必然凑不够证据、白白消耗一次 LLM 调用，还会把它冲掉。
        const shouldExtract =
          args.definite === true || buffered >= EXTRACT_BUFFER_THRESHOLD;

        if (!shouldExtract) {
          // 画像更新：复用现有实现，fire-and-forget（和 Web/CLI 同一条路径）
          void updateProfileInBackground();

          return {
            content: [
              {
                type: "text",
                text: `已记录（缓冲 ${buffered} 条，攒够 ${EXTRACT_BUFFER_THRESHOLD} 条或用户明确要求时抽取）。`,
              },
            ],
            structuredContent: {
              buffered,
              willExtract: false,
              written: [],
            },
          };
        }

        // ---- server 调自己的 LLM 做抽取 ----
        const provider = getProvider();
        if (!provider) {
          const status = providerStatus();
          return {
            content: [
              {
                type: "text",
                text:
                  `无法抽取记忆：没有可用的 LLM 配置。\n${status.error ?? ""}\n` +
                  `（缓冲已保留，配置好 key 后下一轮会重试。）`,
              },
            ],
            isError: true,
            structuredContent: { buffered, willExtract: true, written: [] },
          };
        }

        const existing = await scanMemory(paths.memory);
        const convo: { role: "user" | "assistant"; content: string }[] = [];
        for (const p of pending) {
          convo.push({ role: "user", content: p.userMessage });
          if (p.assistantReply) {
            convo.push({ role: "assistant", content: p.assistantReply });
          }
        }

        let candidates: AnyMemoryCandidate[] = [];
        try {
          candidates = await extractMemoryCandidates(provider, convo, existing);
        } catch (e) {
          // LLM 调用失败 → 不丢缓冲，下轮再试
          log.error("抽取失败:", (e as Error).message);
          return {
            content: [
              {
                type: "text",
                text: `抽取失败（${(e as Error).message}）。缓冲已保留，下轮再试。`,
              },
            ],
            isError: true,
            structuredContent: { buffered, willExtract: true, written: [] },
          };
        }

        const written: { type: string; name: string; action: string }[] = [];
        for (const c of candidates) {
          const r = await saveMemoryCandidate(paths.memory, c);
          written.push({
            type: c.type,
            name:
              r.action === "new" ? c.name : (r.existingFile?.name ?? c.name),
            action: r.action,
          });
        }

        if (written.length > 0) {
          pending.length = 0;
        } else {
          // 宁缺毋滥 → 没写出。**保留缓冲**：这一条可能是某个模式的第 1 次出现，
          // 清掉就永远等不到第 2 次了。上限兜底，防止无限增长。
          if (pending.length > MAX_BUFFER) {
            pending.splice(0, pending.length - MAX_BUFFER);
          }
        }

        void updateProfileInBackground();

        return {
          content: [
            {
              type: "text",
              text:
                written.length > 0
                  ? `已抽取并写入 ${written.length} 条记忆：${written
                      .map((w) => `${w.type}/${w.name}(${w.action})`)
                      .join(", ")}`
                  : `已回顾 ${buffered} 条记录，暂不足以归纳成模式（已保留，等下一次出现）。`,
            },
          ],
          structuredContent: { buffered, willExtract: true, written },
        };
      } catch (e) {
        log.error("record_turn 失败:", (e as Error).message);
        return {
          content: [
            { type: "text", text: `记录失败：${(e as Error).message}` },
          ],
          isError: true,
        };
      }
    },
  );

  /**
   * 画像更新 —— 复用现有的 maybeUpdateProfile()。
   *
   * 和 Web/CLI 是同一条代码路径（段1/2/6 由 LLM 抽取，段3/4/5 派生重算）。
   * fire-and-forget：不阻塞宿主这一轮。
   */
  async function updateProfileInBackground(): Promise<void> {
    const provider = getProvider();
    if (!provider) return;
    const convo = pending
      .slice(-6)
      .map((p) => ({ role: "user" as const, content: p.userMessage }));
    if (convo.length === 0) return;
    try {
      await maybeUpdateProfile(paths.data, provider, convo, {
        memoryDir: paths.memory,
      });
    } catch (e) {
      log.warn("画像更新失败:", (e as Error).message);
    }
  }
}
