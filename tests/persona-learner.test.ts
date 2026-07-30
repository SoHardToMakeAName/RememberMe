// tests/persona-learner.test.ts
// v0.16.0: persona-learner 单元测试
//
// 覆盖：applyFeedback 累加、buildDynamicPersona 冷启动 vs 有数据、上限截断、版本迁移

import { describe, it, expect } from "bun:test";
import {
  applyFeedback,
  buildDynamicPersona,
  loadLearner,
  emptyState,
  totalFeedback,
  needsMerge,
  HARD_CAP_PATTERNS,
  HARD_CAP_EXAMPLES,
  SCHEMA_VERSION,
  type LearnerState,
} from "../src/persona-learner.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function freshLearner(userId: string): LearnerState {
  return emptyState(userId);
}

function tmpDataDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "pl-"));
  mkdirSync(join(tmp, "learned-prefs"), { recursive: true });
  return tmp;
}

describe("applyFeedback", () => {
  it("初始为空状态", () => {
    const s = freshLearner("u1");
    expect(s.userId).toBe("u1");
    expect(s.version).toBe(SCHEMA_VERSION);
    expect(s.signalCounts).toEqual({ positive: 0, negative: 0, neutral: 0 });
    expect(s.positivePatterns).toEqual([]);
    expect(s.negativePatterns).toEqual([]);
    expect(s.positiveExamples).toEqual([]);
    expect(s.negativeExamples).toEqual([]);
  });

  it("正/负/中信号计数累加", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", ["喜欢"]);
    s = applyFeedback(s, "negative", ["不喜欢"]);
    s = applyFeedback(s, "neutral", []);
    expect(s.signalCounts.positive).toBe(1);
    expect(s.signalCounts.negative).toBe(1);
    expect(s.signalCounts.neutral).toBe(1);
  });

  it("positive insights 推入 positivePatterns，negative 推入 negativePatterns", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", ["喜欢例子", "喜欢中文"]);
    s = applyFeedback(s, "negative", ["不喜欢 emoji", "嫌太长"]);
    expect(s.positivePatterns).toEqual(["喜欢例子", "喜欢中文"]);
    expect(s.negativePatterns).toEqual(["不喜欢 emoji", "嫌太长"]);
  });

  it("neutral 不写入 patterns", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "neutral", ["这条不该写进去"]);
    expect(s.positivePatterns).toEqual([]);
    expect(s.negativePatterns).toEqual([]);
  });

  it("positive example 推入 positiveExamples", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", [], {
      userMessage: "问 X",
      aiReply: "答 Y",
      whyWorked: "清楚",
    });
    expect(s.positiveExamples.length).toBe(1);
    expect(s.positiveExamples[0].userMessage).toBe("问 X");
    expect(s.positiveExamples[0].whyWorked).toBe("清楚");
  });

  it("patterns 超过硬上限会被裁剪（保留最新）", () => {
    let s = freshLearner("u1");
    // 推入 HARD_CAP_PATTERNS + 5 条
    for (let i = 0; i < HARD_CAP_PATTERNS + 5; i++) {
      s = applyFeedback(s, "positive", [`pattern-${i}`]);
    }
    expect(s.positivePatterns.length).toBe(HARD_CAP_PATTERNS);
    expect(s.positivePatterns[0]).toBe(`pattern-5`); // 最早被裁掉
    expect(s.positivePatterns[s.positivePatterns.length - 1]).toBe(`pattern-${HARD_CAP_PATTERNS + 4}`);
  });

  it("examples 超过硬上限会被裁剪", () => {
    let s = freshLearner("u1");
    for (let i = 0; i < HARD_CAP_EXAMPLES + 3; i++) {
      s = applyFeedback(s, "positive", [], {
        userMessage: `q-${i}`,
        aiReply: `a-${i}`,
        whyWorked: `r-${i}`,
      });
    }
    expect(s.positiveExamples.length).toBe(HARD_CAP_EXAMPLES);
    expect(s.positiveExamples[0].userMessage).toBe("q-3"); // 最早被裁掉
  });

  it("insight 单条超长会被截断（200 字）", () => {
    let s = freshLearner("u1");
    const long = "x".repeat(300);
    s = applyFeedback(s, "positive", [long]);
    expect(s.positivePatterns[0].length).toBe(200);
  });

  it("example userMessage/aiReply 超长会被截断（500 字）", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", [], {
      userMessage: "x".repeat(800),
      aiReply: "y".repeat(800),
      whyWorked: "z".repeat(400),
    });
    expect(s.positiveExamples[0].userMessage.length).toBe(500);
    expect(s.positiveExamples[0].aiReply.length).toBe(500);
    expect(s.positiveExamples[0].whyWorked?.length).toBe(200);
  });
});

describe("needsMerge + totalFeedback", () => {
  it("无反馈时 total = 0", () => {
    expect(totalFeedback(freshLearner("u1"))).toBe(0);
  });

  it("patterns 超过软上限触发 needsMerge", () => {
    let s = freshLearner("u1");
    expect(needsMerge(s)).toBe(false);
    for (let i = 0; i < 16; i++) {
      s = applyFeedback(s, "positive", [`p-${i}`]);
    }
    expect(needsMerge(s)).toBe(true);
  });
});

describe("loadLearner 版本迁移", () => {
  it("文件不存在 → 返回空状态", () => {
    const tmp = tmpDataDir();
    const s = loadLearner(tmp, "u1");
    expect(s.signalCounts).toEqual({ positive: 0, negative: 0, neutral: 0 });
    rmSync(tmp, { recursive: true, force: true });
  });

  it("老版本（version=1）数据被丢弃，返回新 schema 空状态", () => {
    const tmp = tmpDataDir();
    writeFileSync(
      join(tmp, "learned-prefs", "default.json"),
      JSON.stringify({
        version: 1,
        userId: "default",
        signalCounts: { positive: 99, negative: 99, neutral: 99 },
        preferences: { preferredLength: { short: 99 } },
      }),
      "utf-8",
    );
    const s = loadLearner(tmp, "default");
    expect(s.version).toBe(SCHEMA_VERSION);
    expect(s.signalCounts.positive).toBe(0);
    expect(s.positivePatterns).toEqual([]);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("同版本数据正常加载", () => {
    const tmp = tmpDataDir();
    writeFileSync(
      join(tmp, "learned-prefs", "default.json"),
      JSON.stringify({
        version: SCHEMA_VERSION,
        userId: "default",
        signalCounts: { positive: 1, negative: 0, neutral: 0 },
        positivePatterns: ["喜欢例子"],
        negativePatterns: [],
        positiveExamples: [],
        negativeExamples: [],
        recentReasons: [],
        createdAt: 1,
        updatedAt: 1,
      }),
      "utf-8",
    );
    const s = loadLearner(tmp, "default");
    expect(s.positivePatterns).toEqual(["喜欢例子"]);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("buildDynamicPersona", () => {
  it("冷启动：极简 persona，无 patterns", () => {
    const s = freshLearner("u1");
    const text = buildDynamicPersona(s);
    expect(text).toContain("真实的人");
    expect(text).not.toContain("用户喜欢");
    expect(text).not.toContain("用户不喜欢");
  });

  it("有 patterns 时输出对应章节", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", ["喜欢具体例子", "欣赏典故"]);
    s = applyFeedback(s, "negative", ["不喜欢 emoji"]);
    const text = buildDynamicPersona(s);
    expect(text).toContain("这个用户过去喜欢的");
    expect(text).toContain("喜欢具体例子");
    expect(text).toContain("欣赏典故");
    expect(text).toContain("这个用户过去不喜欢的");
    expect(text).toContain("不喜欢 emoji");
  });

  it("有 examples 时输出示例块", () => {
    let s = freshLearner("u1");
    s = applyFeedback(s, "positive", [], {
      userMessage: "用户问了 X",
      aiReply: "我答了 Y",
      whyWorked: "命中要点",
    });
    const text = buildDynamicPersona(s);
    expect(text).toContain("过去用户明确满意的回复示例");
    expect(text).toContain("用户问了 X");
    expect(text).toContain("我答了 Y");
    expect(text).toContain("命中要点");
  });
});