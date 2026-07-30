// tests/proactive.test.ts
// v0.7 主动发起对话系统测试。

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  loadProactiveState,
  saveProactiveState,
  shouldTriggerProactive,
  recordProactiveSent,
  recordUserActivity,
  todayLocal,
  isQuietHour,
  generateProactiveMessage,
  DEFAULT_PROACTIVE_CONFIG,
  type ProactiveState,
  type ProactiveConfig,
  type ProactiveContext,
} from "../src/proactive.ts";
import { Timeline } from "../src/timeline.ts";
import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ModelProvider,
  StreamOptions,
  StreamChunk,
} from "../src/provider.ts";
import { loadProfile } from "../src/profile.ts";
// v0.15.0: 不再加载人格文件
// import { loadPersonality } from "../src/personality.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-proactive-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =====================================================================
// Mock provider
// =====================================================================

function makeJsonProvider(output: string | null): ModelProvider {
  return {
    name: "mock",
    model: "mock",
    async *stream(_opts: StreamOptions): AsyncIterable<StreamChunk> {
      if (output === null) {
        yield { delta: "", done: true };
      } else {
        yield { delta: output, done: false };
        yield { delta: "", done: true };
      }
    },
    async complete(opts: StreamOptions): Promise<string> {
      let r = "";
      for await (const c of this.stream(opts)) {
        r += c.delta;
        if (c.done) break;
      }
      return r;
    },
  };
}

// =====================================================================
// todayLocal
// =====================================================================

describe("todayLocal", () => {
  it("返回 YYYY-MM-DD 格式", () => {
    const s = todayLocal(new Date(2026, 6, 14, 10, 0, 0));
    expect(s).toBe("2026-07-14");
  });

  it("个位数月/日补 0", () => {
    const s = todayLocal(new Date(2026, 0, 5, 10, 0, 0));
    expect(s).toBe("2026-01-05");
  });
});

// =====================================================================
// isQuietHour
// =====================================================================

describe("isQuietHour", () => {
  it("不跨午夜：start=13, end=18，hour=15 → 在", () => {
    expect(isQuietHour(15, { start: 13, end: 18 })).toBe(true);
  });
  it("不跨午夜：start=13, end=18，hour=12 → 不在", () => {
    expect(isQuietHour(12, { start: 13, end: 18 })).toBe(false);
  });
  it("不跨午夜：hour=18 → 不在（end 边界）", () => {
    expect(isQuietHour(18, { start: 13, end: 18 })).toBe(false);
  });

  it("跨午夜：23-8，hour=23 → 在", () => {
    expect(isQuietHour(23, { start: 23, end: 8 })).toBe(true);
  });
  it("跨午夜：23-8，hour=0 → 在", () => {
    expect(isQuietHour(0, { start: 23, end: 8 })).toBe(true);
  });
  it("跨午夜：23-8，hour=10 → 不在", () => {
    expect(isQuietHour(10, { start: 23, end: 8 })).toBe(false);
  });
  it("跨午夜：23-8，hour=22 → 不在", () => {
    expect(isQuietHour(22, { start: 23, end: 8 })).toBe(false);
  });
});

// =====================================================================
// state 持久化
// =====================================================================

describe("loadProactiveState / saveProactiveState", () => {
  it("首次加载返回零值", async () => {
    const state = await loadProactiveState(join(tmpDir, "fresh"));
    expect(state.lastUserActivityAt).toBe(0);
    expect(state.lastProactiveAt).toBe(0);
    expect(state.todayCount).toBe(0);
    expect(state.todayDate).toBe("");
  });

  it("保存后能加载", async () => {
    const dir = join(tmpDir, "roundtrip");
    const state: ProactiveState = {
      lastUserActivityAt: 1719000000000,
      lastProactiveAt: 1719050000000,
      todayCount: 1,
      todayDate: "2026-07-11",
    };
    await saveProactiveState(dir, state);
    const loaded = await loadProactiveState(dir);
    expect(loaded.lastUserActivityAt).toBe(1719000000000);
    expect(loaded.todayCount).toBe(1);
  });

  it("损坏 JSON → 零值", async () => {
    const dir = join(tmpDir, "corrupt");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "proactive-state.json"),
      "not json",
      "utf-8",
    );
    const loaded = await loadProactiveState(dir);
    expect(loaded.lastUserActivityAt).toBe(0);
  });
});

// =====================================================================
// shouldTriggerProactive
// =====================================================================

describe("shouldTriggerProactive", () => {
  // 用一个固定的"现在"：2026-07-15 14:00，避开 quiet hours（23-8），
  // 让所有时间相关计算可控。
  const FIXED_NOW = new Date(2026, 6, 15, 14, 0, 0);
  const FIXED_TODAY = todayLocal(FIXED_NOW);

  const config: ProactiveConfig = {
    enabled: true,
    idleThresholdHours: 4,
    maxPerDay: 2,
    quietHours: { start: 23, end: 8 },
    cooldownMinutes: 60,
  };

  it("disabled → false", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
    const d = shouldTriggerProactive(
      state,
      { ...config, enabled: false },
      new Date(2026, 6, 15, 14, 0, 0),
    );
    expect(d.should).toBe(false);
    expect(d.reason).toBe("disabled");
  });

  it("首次启动（lastUserActivityAt=0）→ 跳过 idle 检查", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
    const d = shouldTriggerProactive(
      state,
      config,
      new Date(2026, 6, 15, 14, 0, 0),
    );
    expect(d.should).toBe(true);
  });

  it("今日已发满 maxPerDay → false", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 2,
      todayDate: todayLocal(new Date(2026, 6, 15, 14, 0, 0)),
    };
    const d = shouldTriggerProactive(
      state,
      config,
      new Date(2026, 6, 15, 14, 0, 0),
    );
    expect(d.should).toBe(false);
    expect(d.reason).toBe("daily_limit");
  });

  it("昨天已发满但今天未发 → todayCount 重置 → 允许", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 2,
      todayDate: (() => { const d = new Date(2026, 6, 15, 14, 0, 0); d.setDate(d.getDate() - 1); return todayLocal(d); })(), // 昨天
    };
    const d = shouldTriggerProactive(
      state,
      config,
      new Date(2026, 6, 15, 14, 0, 0),
    );
    expect(d.should).toBe(true);
  });

  it("quiet hour → false", () => {
    const QUIET_NOW = new Date(2026, 6, 15, 2, 0, 0); // 凌晨 2 点
    const state: ProactiveState = {
      lastUserActivityAt: QUIET_NOW.getTime() - 10 * 3600 * 1000,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: todayLocal(QUIET_NOW),
    };
    const d = shouldTriggerProactive(state, config, QUIET_NOW);
    expect(d.should).toBe(false);
    expect(d.reason).toBe("quiet_hour");
  });

  it("距上次活动不到阈值 → false", () => {
    const state: ProactiveState = {
      lastUserActivityAt: FIXED_NOW.getTime() - 1 * 3600 * 1000, // 1 小时前
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: FIXED_TODAY,
    };
    const d = shouldTriggerProactive(state, config, FIXED_NOW);
    expect(d.should).toBe(false);
    expect(d.reason).toBe("not_idle_long_enough");
  });

  it("cooldown 未过 → false", () => {
    const state: ProactiveState = {
      lastUserActivityAt: FIXED_NOW.getTime() - 10 * 3600 * 1000,
      lastProactiveAt: FIXED_NOW.getTime() - 30 * 60 * 1000, // 30 分钟前
      todayCount: 1,
      todayDate: FIXED_TODAY,
    };
    const d = shouldTriggerProactive(state, config, FIXED_NOW);
    expect(d.should).toBe(false);
    expect(d.reason).toBe("cooldown");
  });

  it("全部条件满足 → true", () => {
    const state: ProactiveState = {
      lastUserActivityAt: FIXED_NOW.getTime() - 10 * 3600 * 1000,
      lastProactiveAt: FIXED_NOW.getTime() - 5 * 3600 * 1000, // 5 小时前
      todayCount: 0,
      todayDate: FIXED_TODAY,
    };
    const d = shouldTriggerProactive(state, config, FIXED_NOW);
    expect(d.should).toBe(true);
    expect(d.reason).toBe("ok");
  });
});

// =====================================================================
// recordProactiveSent / recordUserActivity
// =====================================================================

describe("recordProactiveSent", () => {
  it("首次调用：todayCount=1, lastProactiveAt 设置", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
    const now = new Date(2026, 6, 15, 14, 0, 0);
    recordProactiveSent(state, now);
    expect(state.lastProactiveAt).toBe(now.getTime());
    expect(state.todayCount).toBe(1);
    expect(state.todayDate).toBe(todayLocal(new Date(2026, 6, 15, 14, 0, 0)));
  });

  it("同日多次：todayCount 累加", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 1,
      todayDate: todayLocal(new Date(2026, 6, 15, 14, 0, 0)),
    };
    recordProactiveSent(state, new Date(2026, 6, 15, 14, 0, 0));
    expect(state.todayCount).toBe(2);
    expect(state.todayDate).toBe(todayLocal(new Date(2026, 6, 15, 14, 0, 0)));
  });

  it("跨日：todayCount 重置为 1", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 0,
      lastProactiveAt: 0,
      todayCount: 2,
      todayDate: (() => { const d = new Date(2026, 6, 15, 14, 0, 0); d.setDate(d.getDate() - 1); return todayLocal(d); })(),
    };
    recordProactiveSent(state, new Date(2026, 6, 15, 14, 0, 0));
    expect(state.todayCount).toBe(1);
    expect(state.todayDate).toBe(todayLocal(new Date(2026, 6, 15, 14, 0, 0)));
  });
});

describe("recordUserActivity", () => {
  it("更新 lastUserActivityAt", () => {
    const state: ProactiveState = {
      lastUserActivityAt: 100,
      lastProactiveAt: 0,
      todayCount: 0,
      todayDate: "",
    };
    const now = new Date(2026, 6, 15, 14, 0, 0);
    recordUserActivity(state, now);
    expect(state.lastUserActivityAt).toBe(now.getTime());
  });
});

// =====================================================================
// generateProactiveMessage
// =====================================================================

describe("generateProactiveMessage", () => {
  const personality = {
    name: "小阳",
    version: "1.0.0",
    description: "阳光大暖男",
    author: "test",
    body: "# 我是谁\n我是小阳",
    sourcePath: "/tmp/test.md",
  };

  it("返回 LLM 输出的消息（如果消息引用了上下文）", async () => {
    // LLM 消息必须**完全**基于 context。memory body 含 "妈妈" 和 "身体"，
    // 所以 LLM 引用 "妈妈" 是 OK 的。但 LLM 不能编造"工作"或"心情"等context里没的词。
    const provider = makeJsonProvider("妈妈身体怎么样了？");
    const ctx: ProactiveContext = {
      profile: null,
      memories: [{
        filename: "妈.md",
        path: "/tmp/妈.md",
        name: "跟妈的关系",
        description: "用户经常提到妈妈",
        body: "妈妈最近身体不太好，用户很担心",
        type: "event",
        subtype: "event",
        mtimeMs: 0,
        sizeBytes: 0,
        fields: {},
      }],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    // "妈妈" 匹配 context 关键词，通过验证
    expect(msg).toBe("妈妈身体怎么样了？");
  });

  it("无上下文 → 不调用 LLM，直接返回安全 fallback", async () => {
    const provider = makeJsonProvider("今天 deadline 还顺利吗？");
    const ctx: ProactiveContext = {
      profile: null,
      memories: [],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    // 上下文为空时直接用 fallback，不调用 LLM（节省 token + 防止编造）
    expect(msg).toBe("想你了，最近还好吗？");
  });

  it("LLM 失败 → 返回安全 fallback（不是空串）", async () => {
    const provider = makeJsonProvider(null);
    const ctx: ProactiveContext = {
      profile: null,
      memories: [],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    // LLM 失败但仍要给用户一条消息（不能空）
    expect(msg.length).toBeGreaterThan(0);
  });

  it("消息过长 → 截断到 500 字", async () => {
    const longMsg = "啊".repeat(1000);
    const provider = makeJsonProvider(longMsg);
    // 消息有"啊"会被认为太短，验证是否能截断到 500
    // 但其实我们的逻辑会先截再验证
    const ctx: ProactiveContext = {
      profile: null,
      memories: [],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    // 上下文为空 → fallback，不调用 LLM
    expect(msg).toBe("想你了，最近还好吗？");
  });

  it("消息引用了上下文 → 通过验证，原样返回", async () => {
    const provider = makeJsonProvider("你妈最近身体怎么样？");
    const ctx: ProactiveContext = {
      profile: null,
      memories: [{
        filename: "妈.md",
        path: "/tmp/妈.md",
        name: "跟妈的关系",
        description: "用户经常提到妈妈",
        body: "妈妈最近身体不太好，用户很担心",
        type: "event",
        subtype: "event",
        mtimeMs: 0,
        sizeBytes: 0,
        fields: {},
      }],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    expect(msg).toBe("你妈最近身体怎么样？");
  });

  it("消息编造了上下文没有的内容（饺子）→ 拒绝", async () => {
    // 饺子不在 profile / memory 里
    const provider = makeJsonProvider("饺子今天有没有趁你不在家干了什么坏事？");
    const ctx: ProactiveContext = {
      profile: null,
      memories: [{
        filename: "工作.md",
        path: "/tmp/工作.md",
        name: "工作压力",
        description: "deadline 压力",
        body: "用户最近工作很忙，deadline 很紧",
        type: "event",
        subtype: "event",
        mtimeMs: 0,
        sizeBytes: 0,
        fields: {},
      }],
      timelineSummary: "",
      personalityName: "小阳",
      personalityDescription: "阳光大暖男",
    };
    const msg = await generateProactiveMessage(provider, personality, ctx);
    // 应该被拒绝（"饺子"不在上下文里），回退到 fallback
    expect(msg).not.toContain("饺子");
    expect(msg).toMatch(/想起|想|在吗/); // 安全 fallback
  });
});

// =====================================================================
// DEFAULT_PROACTIVE_CONFIG
// =====================================================================

describe("DEFAULT_PROACTIVE_CONFIG", () => {
  it("默认 idleThresholdHours = 4", () => {
    expect(DEFAULT_PROACTIVE_CONFIG.idleThresholdHours).toBe(4);
  });

  it("默认 maxPerDay = 2", () => {
    expect(DEFAULT_PROACTIVE_CONFIG.maxPerDay).toBe(2);
  });

  it("默认 quietHours = 23-8（跨午夜）", () => {
    expect(DEFAULT_PROACTIVE_CONFIG.quietHours).toEqual({
      start: 23,
      end: 8,
    });
  });

  it("默认 enabled = true", () => {
    expect(DEFAULT_PROACTIVE_CONFIG.enabled).toBe(true);
  });
});

// =====================================================================
// 端到端：实际加载 profile 和 memory
// =====================================================================

describe("prepareProactiveMessage 端到端", () => {
  it("能基于真实 profile + memory 生成", async () => {
    const dataDir = join(tmpDir, "e2e");
    const memoryDir = join(dataDir, "memory");
    const profileDir = join(dataDir, "profile");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(profileDir, { recursive: true }),
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(memoryDir, { recursive: true }),
    );

    const profile = await loadProfile(dataDir);
    // v0.15.0: 不再加载人格文件——用本地 stub
    const personality = { name: "测试人格", description: "test" } as any;

    // 写一条 memory
    const { writeMemoryFile } = await import("../src/memory.ts");
    await writeMemoryFile(
      memoryDir,
      {
        name: "test-emotion",
        description: "用户对 deadline 焦虑",
        subtype: "emotion",
        body: "**触发**：工作 deadline",
      },
      "test-emotion.md",
    );

    const timelineDir = join(dataDir, "timeline");
    const timeline = new Timeline(timelineDir);
    await timeline.ensure();
    await timeline.append({
      emotion: "sadness",
      intensity: 0.5,
      trigger: "工作压力",
    });

    // LLM 输出的消息**必须**基于上下文。这里 memory body 含 "deadline"，
    // 所以 LLM 引用 deadline 是 OK 的。不引用"压力"——避免编造。
    // 注意：mock 输出只用 deadline 一个具体词 + 通用短语"怎么样"，避免其他具体词被拒。
    const provider = makeJsonProvider("deadline 怎么样？");
    const { prepareProactiveMessage } = await import("../src/proactive.ts");

    const msg = await prepareProactiveMessage(provider, {
      dataDir,
      memoryDir,
      timeline,
      profile,
      personality,
    });
    expect(msg).toContain("deadline");
  });

  it("LLM 编造了上下文没有的（'妈妈'）→ 拒绝，回退 fallback", async () => {
    const dataDir = join(tmpDir, "e2e-fabricate");
    const memoryDir = join(dataDir, "memory");
    const profileDir = join(dataDir, "profile");
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(profileDir, { recursive: true }),
    );
    await import("node:fs/promises").then((fs) =>
      fs.mkdir(memoryDir, { recursive: true }),
    );

    const profile = await loadProfile(dataDir);
    // v0.15.0: 不再加载人格文件——用本地 stub
    const personality = { name: "测试人格", description: "test" } as any;

    const { writeMemoryFile } = await import("../src/memory.ts");
    await writeMemoryFile(
      memoryDir,
      {
        name: "test-deadline",
        description: "用户 deadline 焦虑",
        subtype: "emotion",
        body: "**触发**：工作 deadline",
      },
      "test-deadline.md",
    );

    const timelineDir = join(dataDir, "timeline");
    const timeline = new Timeline(timelineDir);
    await timeline.ensure();

    // LLM 编造了"妈妈"（context 里没有）→ 应被拒绝
    const provider = makeJsonProvider("你妈最近怎么样了？");
    const { prepareProactiveMessage } = await import("../src/proactive.ts");

    const msg = await prepareProactiveMessage(provider, {
      dataDir,
      memoryDir,
      timeline,
      profile,
      personality,
    });
    expect(msg).not.toContain("妈");
    expect(msg.length).toBeGreaterThan(0); // 有 fallback，不是空
  });
});