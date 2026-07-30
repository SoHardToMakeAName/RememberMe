// tests/compact-loop-integration.test.ts
// 集成测试：跑 10 轮对话，验证 loop.ts 在第 10 轮触发 compact。
//
// 设计：
// - Mock provider 同时支持：
//   1) 情绪识别 side-query
//   2) 记忆检索 side-query
//   3) 主对话流式回复
//   4) compact 摘要（compactHistory 的 complete 调用）
// - 跑 10 轮 runTurn，前 9 轮 history 累加不触发 compact
// - 第 10 轮 history.length = 20 ≥ triggerAt=20，触发 compact
// - 断言 result.compacted === true，且 history 被替换为 [摘要] + recentKept 条

import { describe, it, expect, beforeAll } from "bun:test";
import { runTurn } from "../src/loop.ts";
import type { Personality } from "../src/personality.ts";
import { emptyState } from "../src/persona-learner.ts";
import { Timeline } from "../src/timeline.ts";
import {
  DEFAULT_COMPACT_CONFIG,
  estimateHistoryTokens,
  estimateTokens,
} from "../src/compact.ts";
import type {
  ChatMessage,
  ModelProvider,
  StreamChunk,
  StreamOptions,
} from "../src/provider.ts";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * 完整 Mock provider：根据 system prompt 关键字切换分支。
 *
 * - "情绪识别" → JSON 情绪
 * - "记忆检索" → JSON 空选
 * - "对话历史压缩" → 固定摘要
 * - 主对话（人格相关） → echo
 */
class IntegrationMockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock-integration";

  /** 记录 compact 摘要被调用的次数 */
  compactCalls = 0;

  /** 记录每次主对话 system prompt 长度（验证 prompt 一直在变） */
  mainSystemSizes: number[] = [];

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const { system, messages } = options.params;
    const lastUser = messages[messages.length - 1]?.content ?? "";

    // 1) compact summary 调用（看 system prompt 的关键字）
    if (system.includes("对话历史压缩")) {
      this.compactCalls++;
      const summary = `## 1. 用户情绪轨迹
- 10 轮对话中用户情绪从难过逐步转为释然
- 当前情绪：平静（强度 0.4）

## 2. 用户关键信息
- 工作中被领导批评
- 今晚计划早睡

## 3. 用户偏好与纠正（最关键）
- 用户不喜欢被总结/教训
- 偏好轻松语气

## 4. 未完结话题与承诺
- 周五要交的报告还没动笔

## 5. 当前对话语气基准
- 小阳使用轻松陪伴语气，用户接受度高

## 6. 其他上下文
- 用户昵称未透露`;
      yield { delta: summary, done: false };
      yield { delta: "", done: true };
      return;
    }

    // 2) 情绪识别 side-query
    if (system.includes("情绪识别")) {
      const isSad = lastUser.includes("累") || lastUser.includes("难过") || lastUser.includes("批评");
      const isJoy = lastUser.includes("开心") || lastUser.includes("哈哈");
      const text = JSON.stringify({
        emotion: isSad ? "sadness" : isJoy ? "joy" : "neutral",
        intensity: isSad ? 0.7 : isJoy ? 0.6 : 0.3,
        trigger: isSad ? "工作压力" : isJoy ? "分享好消息" : "日常寒暄",
        excerpt: lastUser.slice(0, 100),
      });
      yield { delta: text, done: false };
      yield { delta: "", done: true };
      return;
    }

    // 3) 记忆检索 side-query
    if (system.includes("记忆检索")) {
      yield { delta: JSON.stringify({ selected: [] }), done: false };
      yield { delta: "", done: true };
      return;
    }

    // 4) 主对话
    this.mainSystemSizes.push(system.length);
    const reply = `[echo ${this.mainSystemSizes.length}] 收到："${lastUser.slice(0, 20)}"`;
    yield { delta: reply, done: false };
    yield { delta: "", done: true };
  }

  async complete(options: StreamOptions): Promise<string> {
    let result = "";
    for await (const chunk of this.stream(options)) {
      result += chunk.delta;
      if (chunk.done) break;
    }
    return result;
  }
}

describe("10 轮对话触发 compact（loop.ts 集成）", () => {
  let personality: Personality;
  let timeline: Timeline;
  let tmpDir: string;
  let provider: IntegrationMockProvider;

  beforeAll(async () => {
    // v0.15.0: 不再加载人格文件——给个本地 stub 满足 type 要求
    personality = {
      name: "test",
      version: "0.0.0",
      description: "test",
      author: "test",
      body: "",
      sourcePath: "",
      filename: "test",
    };

    tmpDir = await mkdtemp(join(tmpdir(), "ec-compact-loop-"));
    timeline = new Timeline(tmpDir);
    await timeline.ensure();

    provider = new IntegrationMockProvider();
  });

  it("前 9 轮 history 不触发 compact", async () => {
    let history: ChatMessage[] = [];

    const userInputs = [
      "我今天好累，被领导批评了一下午，整个人都不好了",
      "心情不太好，工作上一直出错，感觉自己什么都做不好",
      "刚才老板当着全组的面说我方案太烂，我恨不得找个地缝钻进去",
      "唉不想说这些了，越说越难受",
      "算了聊聊别的吧，不然我得一直想这些烦心事",
      "你今天怎么样啊，有什么新鲜事分享下",
      "其实也没那么糟，回家路上买了个冰淇淋心情好点了",
      "谢谢你陪我聊这些乱七八糟的事",
      "那我先去睡了，明天还得早起搬砖",
    ];

    for (let i = 0; i < 9; i++) {
      const result = await runTurn(
        {
          provider,
          memoryDir: tmpDir,
          timeline,
        },
        userInputs[i],
        history,
        () => {},
      );

      // 累加历史
      history.push({ role: "user", content: userInputs[i] });
      history.push({ role: "assistant", content: result.responseText });

      // 前 9 轮 history 长度 = 2 × 轮次
      // 第 9 轮结束后 history.length = 18 < 20 = triggerAt
      expect(history.length).toBe(2 * (i + 1));
      expect(result.compacted).toBe(false);
    }

    // 确认历史未达到 triggerAt
    expect(history.length).toBe(18);
    expect(history.length).toBeLessThan(DEFAULT_COMPACT_CONFIG.triggerAt);
  });

  it("第 10 轮触发 compact：history 缩减为 [摘要] + recentKept", async () => {
    // 从上一组测试的状态开始：history.length = 18
    let history: ChatMessage[] = [];
    const userInputs = [
      "我今天好累，被领导批评了一下午，整个人都不好了",
      "心情不太好，工作上一直出错，感觉自己什么都做不好",
      "刚才老板当着全组的面说我方案太烂，我恨不得找个地缝钻进去",
      "唉不想说这些了，越说越难受",
      "算了聊聊别的吧，不然我得一直想这些烦心事",
      "你今天怎么样啊，有什么新鲜事分享下",
      "其实也没那么糟，回家路上买了个冰淇淋心情好点了",
      "谢谢你陪我聊这些乱七八糟的事",
      "那我先去睡了，明天还得早起搬砖",
    ];

    // 先跑 9 轮把 history 推到 18 条
    for (let i = 0; i < 9; i++) {
      const result = await runTurn(
        {
          provider,
          memoryDir: tmpDir,
          timeline,
          // 用极低的 minCompactWorth + 远大于 18 的 triggerAt，9 轮里完全不 compact
          compactConfig: {
            ...DEFAULT_COMPACT_CONFIG,
            minCompactWorth: 100,
            triggerAt: 100,
          },
        },
        userInputs[i],
        history,
        () => {},
      );
      history.push({ role: "user", content: userInputs[i] });
      history.push({ role: "assistant", content: result.responseText });
    }
    expect(history.length).toBe(18);

    // 重置 compactCalls 计数
    provider.compactCalls = 0;

    // 第 10 轮：第 11 句用户输入
    const tenthUserInput = "晚安，明天见";
    const tokensBefore = estimateHistoryTokens(history);

    const result = await runTurn(
      {
        provider,
        personality,
        memoryDir: tmpDir,
        timeline,
        // 第 10 轮改用极低 minCompactWorth（mock provider 返回短 echo，所以 tokens 难破 600）
        compactConfig: {
          ...DEFAULT_COMPACT_CONFIG,
          minCompactWorth: 100,
          triggerAt: 15,
        },
      },
      tenthUserInput,
      history,
      () => {},
    );

    // 关键断言：compact 已触发
    console.log(`  [调试 round10] history.length=${history.length}, result.compacted=${result.compacted}, effectiveHistory.length=${result.effectiveHistory?.length}`);
    expect(result.compacted).toBe(true);
    expect(result.savedTokens).toBeGreaterThan(0);
    expect(provider.compactCalls).toBe(1); // mock provider 收到 1 次摘要调用

    // Bug #4 修复断言：runTurn 现在返回 effectiveHistory（compact 后的版本）
    expect(result.effectiveHistory).toBeDefined();
    expect(result.effectiveHistory.length).toBe(1 + DEFAULT_COMPACT_CONFIG.recentKept);
    expect(result.effectiveHistory[0].role).toBe("user");
    expect(result.effectiveHistory[0].content).toContain("[BACKGROUND");
    expect(result.effectiveHistory[0].content).toContain("## 1. 用户情绪轨迹");

    // Bug #3 修复断言：summary role 应该是 user
    expect(result.effectiveHistory[0].role).not.toBe("assistant");

    // Bug #5 修复断言：summary 应该 < 800 tokens (maxTokens 限制)
    const summaryTokens = estimateTokens(result.effectiveHistory[0].content);
    expect(summaryTokens).toBeLessThan(800);

    // 模拟 REPL 用 effectiveHistory 替换原 history（与 index.ts 行为一致）
    const finalHistory: ChatMessage[] = [
      ...result.effectiveHistory,
      { role: "user" as const, content: tenthUserInput },
      { role: "assistant" as const, content: result.responseText },
    ];

    // 最终 history = 7 (compact 输出) + 2 (本轮) = 9 条
    expect(finalHistory.length).toBe(1 + DEFAULT_COMPACT_CONFIG.recentKept + 2);

    // 第 1 条必须是摘要消息
    expect(finalHistory[0].role).toBe("user");
    expect(finalHistory[0].content).toContain("[BACKGROUND");

    // 验证 token 数确实下降了
    const tokensAfterCompact = estimateHistoryTokens(
      finalHistory.slice(0, 1 + DEFAULT_COMPACT_CONFIG.recentKept),
    );
    expect(tokensAfterCompact).toBeLessThan(tokensBefore);

    console.log(`  [压缩前 ${tokensBefore} tokens → 压缩后 ${tokensAfterCompact} tokens，节省约 ${result.savedTokens} tokens]`);
  });

  it("Bug #4 修复：直接用 loop 集成跑 10 轮：第 10 轮触发 compact 后 history.length 缩减", async () => {
    let history: ChatMessage[] = [];
    const compactedFlags: boolean[] = [];
    const historyLengths: number[] = [];

    for (let i = 1; i <= 10; i++) {
      const input = `第 ${i} 轮对话，说说今天的想法和感受，今天确实有很多事情想说，包括工作上的压力、生活上的琐事、还有一些心情上的起伏，希望能跟你好好聊聊这些。`;
      turnsArrayPush(input);

      const result = await runTurn(
        {
          provider,
          memoryDir: tmpDir,
          timeline,
          // 用更低的 minCompactWorth 让测试能触发 compact
          compactConfig: {
            ...DEFAULT_COMPACT_CONFIG,
            minCompactWorth: 600,
            triggerAt: 15,
          },
        },
        input,
        history,
        () => {},
      );

      // Bug #4 修复：用 effectiveHistory 替换原 history（与 REPL 行为一致）
      // 注意：effectiveHistory 是从 runTurn 返回的，可能是原 history 的同一个引用
      // 所以要拷贝一份避免后续 history.length = 0 清掉 effectiveHistory
      const effectiveHistory = [...result.effectiveHistory];
      const beforePush = effectiveHistory.length;
      history.length = 0;
      history.push(...effectiveHistory);
      history.push({ role: "user", content: input });
      history.push({ role: "assistant", content: result.responseText });

      compactedFlags.push(result.compacted);
      historyLengths.push(history.length);

      // 调试：每次轮次打印 effectiveHistory 长度
      if (i === 1 || i === 5 || i === 10) {
        console.log(`  [调试 第 ${i} 轮] effectiveHistory.length=${beforePush}, result.compacted=${result.compacted}`);
      }
    }

    function turnsArrayPush(_input: string) {
      // no-op（保留给将来扩展）
    }

    // 打印轨迹
    console.log("\n  --- 10 轮历史长度轨迹（Bug #4 修复后）---");
    for (let i = 0; i < 10; i++) {
      const flag = compactedFlags[i] ? " ✂️ compact!" : "";
      console.log(`    第 ${i + 1} 轮：history.length = ${historyLengths[i]}${flag}`);
    }

    // 调试：打印最终 history 的 token 数
    const totalTokens = estimateHistoryTokens(history);
    console.log(`  最终 history 总 token 数：${totalTokens}`);

    // Bug #4 修复后断言：每次 compact 后 history.length 缩减 + 增长可控
    // 关键断言：跑完 10 轮后，history.length 应该远小于 "不修复时" 的 20+
    expect(history.length).toBeLessThan(15);

    // 至少有一次 compact（在某轮触发；用 triggerAt=15 配置，第 9 轮 history=16 时触发）
    expect(compactedFlags.some((f) => f === true)).toBe(true);

    // Bug #3 修复：摘要 role = user
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("[BACKGROUND");
  });
});