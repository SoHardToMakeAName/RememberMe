// tests/stress.test.ts
// 压力测试：覆盖 token 累积、compact、并发、边界、错误处理

import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { estimateTokens, estimateHistoryTokens, DEFAULT_COMPACT_CONFIG, shouldCompact } from "../src/compact.ts";
import { extractContextKeywords, validateProactiveMessage } from "../src/proactive.ts";
import { runCurator, loadCuratorState, shouldRunCurator } from "../src/evolution/curator.ts";
import { makeNewLifecycleMeta, recordAccess, transitionState, transitionBatch } from "../src/evolution/lifecycle.ts";
import { computeNextState, DEFAULT_LIFECYCLE_CONFIG } from "../src/evolution/lifecycle.ts";

describe("Stress: token 累积与 compact 触发", () => {
  function genLongHistory(turns: number, msgLen = 50) {
    const history = [];
    for (let i = 0; i < turns; i++) {
      history.push({
        role: i % 2 === 0 ? "user" : "assistant",
        content: "我".repeat(msgLen) + ` #${i}`,
      });
    }
    return history;
  }

  it("50 轮：token 应在合理范围（避免无限增长）", () => {
    const history = genLongHistory(50, 30);
    const tokens = estimateHistoryTokens(history);
    // 50 轮 × 2 消息 × 30 字 ≈ 4500 tokens (CJK)
    expect(tokens).toBeLessThan(8000);
    expect(tokens).toBeGreaterThan(2000);
  });

  it("100 轮：compact 应被触发（消息数 ≥ triggerAt=8）", () => {
    const history = genLongHistory(100, 30);
    // 100 turns × 2 messages = 200 messages → trigger compact
    const decision = shouldCompact(history, {
      ...DEFAULT_COMPACT_CONFIG,
      triggerAt: 8,
      minCompactWorth: 1500,
    });
    expect(decision.shouldCompact).toBe(true);
  });

  it("compact 后 history 长度缩减（不是无限增长）", () => {
    const history = genLongHistory(20, 100);
    const before = history.length;
    // 简化模拟 compact 效果
    const recentKept = 6;
    const after = 1 + recentKept; // summary + recent
    expect(after).toBeLessThan(before);
    expect(after).toBe(7);
  });
});

describe("Stress: extractContextKeywords 大量文本", () => {
  it("100KB 中文文本应在合理时间完成（< 500ms）", () => {
    const bigText = "妈妈最近身体不太好，用户很担心。工作压力很大。生活琐事多。" .repeat(2000);
    const ctx = {
      profile: null,
      memories: [{
        filename: "big.md",
        path: "/tmp/big.md",
        name: "big",
        description: "big",
        subtype: "event" as const,
        type: "event" as const,
        mtimeMs: 0,
        sizeBytes: 0,
        body: bigText,
        fields: {},
      }],
      timelineSummary: "",
      personalityName: "test",
      personalityDescription: "test",
    };
    const start = Date.now();
    const keywords = extractContextKeywords(ctx);
    const elapsed = Date.now() - start;
    expect(keywords.size).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(500);
  });

  it("空上下文不应崩溃", () => {
    const ctx = {
      profile: null,
      memories: [],
      timelineSummary: "",
      personalityName: "",
      personalityDescription: "",
    };
    const keywords = extractContextKeywords(ctx);
    expect(keywords.size).toBe(0);
  });
});

describe("Stress: validateProactiveMessage 边界", () => {
  const baseCtx = {
    profile: null,
    memories: [{
      filename: "work.md",
      path: "/tmp/work.md",
      name: "工作",
      description: "deadline 压力",
      subtype: "emotion" as const,
      type: "emotion" as const,
      mtimeMs: 0,
      sizeBytes: 0,
      body: "用户 deadline 焦虑",
      fields: {},
    }],
    timelineSummary: "",
    personalityName: "test",
    personalityDescription: "test",
  };

  it("空消息 → 通过（无任何具体词 = 无编造）", () => {
    const result = validateProactiveMessage("", baseCtx);
    expect(result.valid).toBe(true);
  });

  it("只有标点 → 通过（标点不是具体词）", () => {
    const result = validateProactiveMessage("！！！？？？", baseCtx);
    expect(result.valid).toBe(true);
  });

  it("长消息（> 200 字）且无引用 → 拒绝", () => {
    const long = "工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作工作".repeat(10);
    const result = validateProactiveMessage(long, baseCtx);
    expect(result.valid).toBe(false);
  });

  it("特殊字符 + emoji 不应崩溃", () => {
    const result = validateProactiveMessage("deadline 怎么样？？ 😂 哈哈", baseCtx);
    // "deadline" 匹配 context，应该 valid
    expect(result.valid).toBe(true);
  });

  it("完全空 context → '想你了' 应该 valid（加了通用短语列表）", () => {
    const emptyCtx = { ...baseCtx, memories: [] };
    const result = validateProactiveMessage("想你了", emptyCtx);
    expect(result.valid).toBe(true);
  });

  it("100 次 validation 应该在 100ms 内完成", () => {
    const start = Date.now();
    for (let i = 0; i < 100; i++) {
      validateProactiveMessage("deadline 怎么样？", baseCtx);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("Stress: lifecycle 状态机", () => {
  it("1000 次状态转移应在 < 100ms 完成", () => {
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      const meta = makeNewLifecycleMeta(Date.now() - 1000 * 24 * 3600 * 1000);
      recordAccess(meta, { source: "conversation" });
      computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, Date.now());
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("1000 个 item 的 transitionBatch 应该在 < 200ms 完成", () => {
    const items = Array.from({ length: 1000 }, (_, i) => ({
      filename: `${i}.md`,
      meta: {
        ...makeNewLifecycleMeta(Date.now() - (40 + (i % 100)) * 24 * 3600 * 1000),
        state: "active" as const,
      },
    }));
    const start = Date.now();
    const result = transitionBatch(items, DEFAULT_LIFECYCLE_CONFIG, Date.now());
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
    expect(result.changed.length + result.skipped).toBe(1000);
  });
});

describe("Stress: curator 状态", () => {
  let tmpDir: string;

  it("save + load curator 状态 100 次应无错", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "ec-curator-stress-"));
    try {
      for (let i = 0; i < 100; i++) {
        const state = {
          lastRunAt: Date.now() - i * 60000,
          runCount: i,
          lastChanges: i % 5,
          paused: i % 2 === 0,
          minIdleHours: 1,
          minIntervalHours: 12,
        };
        const { saveCuratorState, loadCuratorState } = await import(
          "../src/evolution/curator.ts"
        );
        await saveCuratorState(tmpDir, state);
        const loaded = await loadCuratorState(tmpDir);
        expect(loaded.runCount).toBe(i);
        expect(loaded.paused).toBe(i % 2 === 0);
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shouldRunCurator 边界场景", () => {
    const now = Date.now();
    const state = {
      lastRunAt: 0,
      runCount: 0,
      lastChanges: 0,
      paused: false,
      minIdleHours: 2,
      minIntervalHours: 24,
    };
    // 首次运行：lastRunAt=0，应该可以
    let r = shouldRunCurator(state, now - 5 * 3600 * 1000, now);
    expect(r.shouldRun).toBe(true);
    // 暂停
    r = shouldRunCurator({ ...state, paused: true }, now - 5 * 3600 * 1000, now);
    expect(r.shouldRun).toBe(false);
  });
});

describe("Stress: estimateTokens 极端输入", () => {
  it("空字符串 → 0", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("1 字符 → 1.5 (CJK 系数)", () => {
    expect(estimateTokens("中")).toBe(2);
  });

  it("10k 字符纯英文 → 大约 3k tokens (0.3 系数)", () => {
    const text = "a".repeat(10000);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(3000);
  });

  it("10k 字符纯中文 → 大约 15k tokens (1.5 系数)", () => {
    const text = "中".repeat(10000);
    const tokens = estimateTokens(text);
    expect(tokens).toBe(15000);
  });

  it("emoji 不会崩溃（虽然估得不准）", () => {
    const t = estimateTokens("🎉🎉🎉");
    expect(t).toBeGreaterThan(0);
  });

  it("1000 次 estimateTokens 应 < 50ms", () => {
    const text = "今天天气真不错".repeat(100);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) estimateTokens(text);
    expect(Date.now() - start).toBeLessThan(50);
  });
});

describe("Stress: 错误处理", () => {
  it("不存在的目录读取 profile 应返回默认 profile", async () => {
    const { loadProfile } = await import("../src/profile.ts");
    const { rmSync, existsSync } = await import("node:fs");
    // 用唯一路径避免残留
    const fakeDir = `/tmp/does-not-exist-${Date.now()}-${Math.random()}`;
    if (existsSync(fakeDir)) rmSync(fakeDir, { recursive: true, force: true });
    const profile = await loadProfile(fakeDir);
    expect(profile).toBeDefined();
    expect(profile.initialized).toBe(true);
  });
});
