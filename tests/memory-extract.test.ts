// tests/memory-extract.test.ts
// v0.5 记忆自动抽取：emotion + event 双主类 schema 测试。

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  extractMemoryCandidates,
  saveMemoryCandidate,
  maybeAutoExtract,
  type AnyMemoryCandidate,
} from "../src/memory-extract.ts";
import {
  scanMemory,
  readMemoryFile,
  readMemoriesByType,
  writeMemoryFile,
  appendIndexEntry,
  findSimilarMemory,
  appendToMemoryFile,
  hasIndexEntry,
  findRelatedEmotions,
  findRelatedEvents,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
} from "../src/memory.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, StreamOptions, StreamChunk } from "../src/provider.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-extract-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =====================================================================
// Mock provider
// =====================================================================

function makeJsonProvider(jsonOutput: string | null): ModelProvider {
  return {
    name: "mock",
    model: "mock",
    async *stream(_opts: StreamOptions): AsyncIterable<StreamChunk> {
      if (jsonOutput === null) {
        yield { delta: "不是 JSON", done: false };
      } else {
        yield { delta: jsonOutput, done: false };
      }
      yield { delta: "", done: true };
    },
    async complete(opts: StreamOptions): Promise<string> {
      let result = "";
      for await (const c of this.stream(opts)) {
        result += c.delta;
        if (c.done) break;
      }
      return result;
    },
  };
}

// =====================================================================
// Schema 常量
// =====================================================================

describe("MEMORY_TYPES (v0.5)", () => {
  it("只含 emotion / event / reference 三类", () => {
    expect(MEMORY_TYPES).toEqual(["emotion", "event", "reference"]);
  });

  it("中文标签正确", () => {
    expect(MEMORY_TYPE_LABEL.emotion).toBe("情绪模式");
    expect(MEMORY_TYPE_LABEL.event).toBe("生活事件");
    expect(MEMORY_TYPE_LABEL.reference).toBe("外部资源");
  });
});

// =====================================================================
// extractMemoryCandidates
// =====================================================================

describe("extractMemoryCandidates", () => {
  it("空对话返回空数组", async () => {
    const provider = makeJsonProvider("[]");
    const candidates = await extractMemoryCandidates(provider, []);
    expect(candidates).toHaveLength(0);
  });

  it("有效 JSON：emotion 必填 evidence 数组（≥2 条）", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "emotion",
          name: "deadline-anxiety",
          description: "提到 deadline 焦虑升高",
          trigger: "工作 deadline",
          manifestation: "焦虑 + 失眠",
          evidence: ["对话 A: deadline", "对话 B: 又是 deadline"],
          confidence: 0.85,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "deadline 又来了" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("emotion");
    expect(candidates[0].fields.evidence).toHaveLength(2);
  });

  it("有效 JSON：event 必填 occurred_at + emotional_impact", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "cat-passed-away",
          description: "用户的猫去世",
          occurred_at: "2026-07-01",
          emotional_impact: "持续悲伤",
          significance: "high",
          confidence: 0.95,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "我的猫上周走了" },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].type).toBe("event");
    expect(candidates[0].fields.occurred_at).toBe("2026-07-01");
  });

  it("emotion 证据 < 2 条 → 拒绝", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "emotion",
          name: "low-evidence",
          description: "只有 1 条证据",
          trigger: "X",
          manifestation: "Y",
          evidence: ["only one"],
          confidence: 0.9,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("event 缺 occurred_at → 拒绝", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "no-date",
          description: "无日期事件",
          emotional_impact: "开心",
          confidence: 0.9,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("非 emotion/event 类型被过滤", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "user",
          name: "user-info",
          description: "用户昵称",
          confidence: 0.9,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("置信度 < 0.5 → 拒绝", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "low-conf",
          description: "低置信",
          occurred_at: "2026-07-01",
          emotional_impact: "...",
          confidence: 0.3,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("markdown 包裹 → 仍能解析", async () => {
    const provider = makeJsonProvider(
      "```json\n" +
        JSON.stringify([
          {
            type: "event",
            name: "wrap-test",
            description: "包裹测试",
            occurred_at: "2026-07-01",
            emotional_impact: "...",
            confidence: 0.9,
          },
        ]) +
        "\n```",
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(1);
  });

  it("无效 JSON → 空数组", async () => {
    const provider = makeJsonProvider("I cannot JSON");
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "..." },
    ]);
    expect(candidates).toHaveLength(0);
  });
});

// =====================================================================
// findSimilarMemory
// =====================================================================

describe("findSimilarMemory", () => {
  it("同 subtype + 完全相同 name → 命中", async () => {
    const dir = join(tmpDir, "sim-exact");
    await writeMemoryFile(
      dir,
      {
        name: "deadline-anxiety",
        description: "用户提到 deadline 焦虑升高",
        subtype: "emotion",
        body: "原内容",
      },
      "deadline-anxiety.md",
    );
    const similar = await findSimilarMemory(dir, {
      subtype: "emotion",
      name: "deadline-anxiety",
      description: "不同 desc",
    });
    expect(similar?.filename).toBe("deadline-anxiety");
  });

  it("不同 subtype 不会命中", async () => {
    const dir = join(tmpDir, "sim-diff-type");
    await writeMemoryFile(
      dir,
      {
        name: "same-name",
        description: "...",
        subtype: "emotion",
        body: "...",
      },
      "same-name.md",
    );
    const similar = await findSimilarMemory(dir, {
      subtype: "event",
      name: "same-name",
      description: "...",
    });
    expect(similar).toBeNull();
  });
});

// =====================================================================
// appendToMemoryFile
// =====================================================================

describe("appendToMemoryFile", () => {
  it("追加内容并带日期分隔", async () => {
    const dir = join(tmpDir, "append-basic");
    await writeMemoryFile(
      dir,
      {
        name: "test",
        description: "...",
        subtype: "emotion",
        body: "原内容",
      },
      "test.md",
    );
    const r = await appendToMemoryFile(
      dir,
      "emotion",
      "test",
      "新补充",
      "2026-07-11",
    );
    expect(r.appended).toBe(true);
    expect(r.content).toContain("原内容");
    expect(r.content).toContain("新补充");
    expect(r.content).toContain("自动补充");
  });

  it("重复内容跳过", async () => {
    const dir = join(tmpDir, "append-dedup");
    await writeMemoryFile(
      dir,
      {
        name: "test",
        description: "...",
        subtype: "emotion",
        body: "原内容",
      },
      "test.md",
    );
    const r = await appendToMemoryFile(dir, "emotion", "test", "原内容");
    expect(r.appended).toBe(false);
  });
});

// =====================================================================
// saveMemoryCandidate
// =====================================================================

describe("saveMemoryCandidate", () => {
  it("新 candidate → 新建到对应子目录 + 加索引", async () => {
    const dir = join(tmpDir, "save-new");
    const candidate: AnyMemoryCandidate = {
      type: "emotion",
      name: "first-emotion",
      description: "第一个情绪模式",
      body: "第一个情绪模式详情\n\n**触发**：...\n**表现**：...",
      confidence: 0.9,
      fields: {
        trigger: "X",
        manifestation: "Y",
        evidence: ["1", "2"],
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.action).toBe("new");
    expect(result.path).toContain("emotion");
    expect(result.path).toContain("first-emotion.md");

    // 文件确实在 emotion/ 子目录
    const file = await readMemoryFile(dir, "first-emotion");
    expect(file?.subtype).toBe("emotion");
    expect(file?.body).toContain("第一个情绪模式");

    // 索引已添加
    expect(await hasIndexEntry(dir, "emotion", "first-emotion")).toBe(true);
  });

  it("event candidate 落盘到 event/ 子目录", async () => {
    const dir = join(tmpDir, "save-event");
    const candidate: AnyMemoryCandidate = {
      type: "event",
      name: "user-got-offer",
      description: "用户拿到 offer",
      body: "...",
      confidence: 0.95,
      fields: {
        occurred_at: "2026-07-10",
        emotional_impact: "喜悦 + 释然",
        significance: "high",
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.action).toBe("new");
    expect(result.path).toContain("event");
    expect(result.path).toContain("user-got-offer.md");
  });

  it("相似 candidate → 合并而非新建", async () => {
    const dir = join(tmpDir, "save-merge");
    await writeMemoryFile(
      dir,
      {
        name: "no-summaries",
        description: "用户不喜欢结尾总结",
        subtype: "emotion",
        body: "原内容",
      },
      "no-summaries.md",
    );
    await appendIndexEntry(dir, {
      title: "no-summaries",
      subtype: "emotion",
      filename: "no-summaries",
      hook: "用户不喜欢结尾总结",
    });

    const candidate: AnyMemoryCandidate = {
      type: "emotion",
      name: "no-summaries",
      description: "补充：不喜欢中段总结",
      body: "新内容",
      confidence: 0.85,
      fields: {
        trigger: "...",
        manifestation: "...",
        evidence: ["a", "b"],
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.action).toBe("merged");
    expect(result.existingFile?.filename).toBe("no-summaries");

    const file = await readMemoryFile(dir, "no-summaries");
    expect(file?.body).toContain("原内容");
    expect(file?.body).toContain("新内容");
  });
});

// =====================================================================
// 跨印证
// =====================================================================

describe("findRelatedEmotions / findRelatedEvents", () => {
  it("保存 event 时，related_emotions 自动填充时间相关的 emotion", async () => {
    const dir = join(tmpDir, "cross-event");

    // 先建一个 emotion，时间在 2026-07-10
    await writeMemoryFile(
      dir,
      {
        name: "work-stress",
        description: "用户工作压力增加",
        subtype: "emotion",
        body: "...",
        fields: {
          trigger: "工作压力",
          manifestation: "焦虑",
          first_observed: "2026-07-05",
          last_observed: "2026-07-12",
        },
      },
      "work-stress.md",
    );

    // 保存一个时间相近的 event
    const candidate: AnyMemoryCandidate = {
      type: "event",
      name: "boss-criticism",
      description: "被领导公开批评",
      body: "...",
      confidence: 0.9,
      fields: {
        occurred_at: "2026-07-10",
        emotional_impact: "焦虑 + 自我怀疑 + 工作压力",
        significance: "high",
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.action).toBe("new");
    expect(result.linkedTo).toBeDefined();
    expect(result.linkedTo).toContain("work-stress");
  });

  it("保存 emotion 时，related_events 自动填充时间相关 event", async () => {
    const dir = join(tmpDir, "cross-emotion");

    // 先建一个 event
    await writeMemoryFile(
      dir,
      {
        name: "pet-loss",
        description: "宠物去世",
        subtype: "event",
        body: "...",
        fields: {
          occurred_at: "2026-07-05",
          emotional_impact: "悲伤 + 回避",
          significance: "high",
        },
      },
      "pet-loss.md",
    );

    // 保存一个时间范围的 emotion
    const candidate: AnyMemoryCandidate = {
      type: "emotion",
      name: "grief-process",
      description: "悲伤处理期",
      body: "...",
      confidence: 0.85,
      fields: {
        trigger: "失去亲密对象",
        manifestation: "悲伤 + 回避",
        first_observed: "2026-07-05",
        last_observed: "2026-07-12",
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.action).toBe("new");
    expect(result.linkedTo).toContain("pet-loss");
  });

  it("完全无关的 event → linkedTo 为空", async () => {
    const dir = join(tmpDir, "cross-empty");
    const candidate: AnyMemoryCandidate = {
      type: "event",
      name: "random-thing",
      description: "无关事件",
      body: "...",
      confidence: 0.9,
      fields: {
        occurred_at: "2026-07-01",
        emotional_impact: "愉悦",
        significance: "low",
      },
    };
    const result = await saveMemoryCandidate(dir, candidate);
    expect(result.linkedTo ?? []).toHaveLength(0);
  });
});

// =====================================================================
// maybeAutoExtract - 端到端
// =====================================================================

describe("maybeAutoExtract", () => {
  it("完整链路：抽取 → 落盘 → 跨子目录可读", async () => {
    const dir = join(tmpDir, "end-full");
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "user-promoted",
          description: "用户升职",
          occurred_at: "2026-07-10",
          emotional_impact: "喜悦",
          confidence: 0.9,
        },
      ]),
    );
    const results = await maybeAutoExtract(
      dir,
      provider,
      [{ role: "user", content: "我升职了" }],
      { minConfidence: 0.7 },
    );
    expect(results.length).toBe(1);
    expect(results[0].action).toBe("new");

    const files = await scanMemory(dir);
    const event = files.find((f) => f.subtype === "event");
    expect(event).toBeDefined();
    expect(event?.filename).toBe("user-promoted");
  });

  it("低 confidence → 跳过", async () => {
    const dir = join(tmpDir, "end-low-conf");
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "low",
          description: "low",
          occurred_at: "2026-07-01",
          emotional_impact: "...",
          confidence: 0.5,
        },
      ]),
    );
    const results = await maybeAutoExtract(
      dir,
      provider,
      [{ role: "user", content: "..." }],
      { minConfidence: 0.7 },
    );
    expect(results).toHaveLength(0);
  });

  it("抽取 emotion（≥2 证据）+ 抽取 event → 都落盘到正确子目录", async () => {
    const dir = join(tmpDir, "end-both");
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "emotion",
          name: "weekend-blues",
          description: "周日晚上低落",
          trigger: "周日晚上",
          manifestation: "低落",
          evidence: ["上周日", "这周日"],
          confidence: 0.8,
        },
        {
          type: "event",
          name: "deadline-missed",
          description: "错过 deadline",
          occurred_at: "2026-07-08",
          emotional_impact: "焦虑",
          significance: "high",
          confidence: 0.9,
        },
      ]),
    );
    const results = await maybeAutoExtract(
      dir,
      provider,
      [{ role: "user", content: "周日晚上又低落了" }],
      { minConfidence: 0.7 },
    );
    expect(results.length).toBe(2);

    const emotions = await readMemoriesByType(dir, "emotion");
    const events = await readMemoriesByType(dir, "event");
    expect(emotions).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(emotions[0].filename).toBe("weekend-blues");
    expect(events[0].filename).toBe("deadline-missed");
  });
});

// =====================================================================
// 反例：拒绝常见反模式
// =====================================================================

describe("反模式过滤", () => {
  it("数字记忆（mood 0.7）不应通过 schema 校验（emotion 缺 evidence）", async () => {
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "emotion",
          name: "mood-number",
          description: "今天 mood 0.7",
          trigger: "...",
          manifestation: "...",
          evidence: ["only one data point"],
          confidence: 0.9,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "今天心情 0.7" },
    ]);
    expect(candidates).toHaveLength(0);
  });

  it("日常活动（吃了碗面）不应作为 event（LLM 也不会输出）", async () => {
    // LLM 实际上不会把"今天吃了碗面"作为 event 输出，所以即使 mock 模拟了也会被情绪影响字段为空拦住
    const provider = makeJsonProvider(
      JSON.stringify([
        {
          type: "event",
          name: "ate-noodles",
          description: "今天吃了碗面",
          occurred_at: "2026-07-11",
          emotional_impact: "",
          confidence: 0.5,
        },
      ]),
    );
    const candidates = await extractMemoryCandidates(provider, [
      { role: "user", content: "今天吃了碗面" },
    ]);
    expect(candidates).toHaveLength(0); // emotional_impact 空 + conf < 0.5
  });
});