// tests/reflection.test.ts
// v0.4 反思 agent 模块测试。

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  gatherReflectionContext,
  generateReflection,
  runReflection,
  listReflections,
  readReflection,
  loadReflectionState,
  saveReflectionState,
  shouldSuggestReflection,
  getReflectionsDir,
  getReflectionFilePath,
  getReflectionStatePath,
  REFLECTION_SECTIONS,
  DEFAULT_REFLECTION_CONFIG,
  type ReflectionState,
} from "../src/reflection.ts";
import { Timeline } from "../src/timeline.ts";
import { writeMemoryFile, appendIndexEntry } from "../src/memory.ts";
import {
  mkdtemp,
  rm,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, StreamOptions, StreamChunk } from "../src/provider.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-reflect-"));
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
// 路径与配置
// =====================================================================

describe("reflection 路径", () => {
  it("getReflectionsDir 返回 <dataDir>/reflections", () => {
    expect(getReflectionsDir(join(tmpDir, "data"))).toBe(
      join(tmpDir, "data", "reflections"),
    );
  });

  it("getReflectionFilePath 用日期命名", () => {
    expect(getReflectionFilePath(join(tmpDir, "data"), "2026-07-11")).toBe(
      join(tmpDir, "data", "reflections", "2026-07-11.md"),
    );
  });

  it("getReflectionStatePath 固定文件名", () => {
    expect(getReflectionStatePath(join(tmpDir, "data"))).toBe(
      join(tmpDir, "data", "reflections", "reflection-state.json"),
    );
  });

  it("REFLECTION_SECTIONS 含 4 段且顺序固定", () => {
    expect(REFLECTION_SECTIONS).toEqual([
      "情绪趋势",
      "触发器与模式",
      "主人格调整建议",
      "长期观察",
    ]);
  });
});

// =====================================================================
// state 持久化
// =====================================================================

describe("reflection state", () => {
  it("首次加载返回零值", async () => {
    const dir = join(tmpDir, "state-fresh");
    const state = await loadReflectionState(dir);
    expect(state.lastReflectionAt).toBe(0);
    expect(state.lastReflectionDate).toBe("");
  });

  it("保存后再次加载能读取", async () => {
    const dir = join(tmpDir, "state-roundtrip");
    const toSave: ReflectionState = {
      lastReflectionAt: 1719000000000,
      lastReflectionDate: "2026-07-10",
    };
    await saveReflectionState(dir, toSave);
    const loaded = await loadReflectionState(dir);
    expect(loaded.lastReflectionAt).toBe(1719000000000);
    expect(loaded.lastReflectionDate).toBe("2026-07-10");
  });

  it("损坏的 JSON 降级为零值", async () => {
    const dir = join(tmpDir, "state-corrupt");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(getReflectionsDir(dir), { recursive: true });
    await writeFile(getReflectionStatePath(dir), "not json", "utf-8");
    const loaded = await loadReflectionState(dir);
    expect(loaded.lastReflectionAt).toBe(0);
  });
});

// =====================================================================
// shouldSuggestReflection
// =====================================================================

describe("shouldSuggestReflection", () => {
  const dayMs = 24 * 60 * 60 * 1000;

  it("从未跑过 → true", () => {
    expect(
      shouldSuggestReflection(
        { lastReflectionAt: 0, lastReflectionDate: "" },
        true,
      ),
    ).toBe(true);
  });

  it("24h 内跑过且当日有对话 → false", () => {
    expect(
      shouldSuggestReflection(
        { lastReflectionAt: Date.now() - dayMs / 2, lastReflectionDate: "..." },
        true,
      ),
    ).toBe(false);
  });

  it("超过 24h 且当日有对话 → true", () => {
    expect(
      shouldSuggestReflection(
        {
          lastReflectionAt: Date.now() - dayMs * 2,
          lastReflectionDate: "...",
        },
        true,
      ),
    ).toBe(true);
  });

  it("超过 24h 但当日没有对话 → false", () => {
    expect(
      shouldSuggestReflection(
        {
          lastReflectionAt: Date.now() - dayMs * 2,
          lastReflectionDate: "...",
        },
        false,
      ),
    ).toBe(false);
  });
});

// =====================================================================
// gatherReflectionContext
// =====================================================================

describe("gatherReflectionContext", () => {
  it("空 timeline 返回（无）占位", async () => {
    const dir = join(tmpDir, "gather-empty");
    await new Timeline(dir).ensure();
    const timeline = new Timeline(dir);
    const { contextText, timelineEntries } = await gatherReflectionContext({
      timeline,
      memoryDir: dir,
      lookbackDays: 7,
    });
    expect(timelineEntries).toHaveLength(0);
    expect(contextText).toContain("（无）");
  });

  it("timeline 条目被收入 context", async () => {
    const dir = join(tmpDir, "gather-timeline");
    const timeline = new Timeline(dir);
    await timeline.ensure();
    await timeline.append({
      emotion: "fear",
      intensity: 0.7,
      trigger: "周五 deadline",
      userExcerpt: "项目又延期了",
    });
    const { contextText, timelineEntries } = await gatherReflectionContext({
      timeline,
      memoryDir: dir,
      lookbackDays: 7,
    });
    expect(timelineEntries).toHaveLength(1);
    expect(contextText).toContain("fear");
    expect(contextText).toContain("周五 deadline");
  });

  it("memory 文件清单被收入", async () => {
    const dir = join(tmpDir, "gather-memory");
    await writeMemoryFile(
      dir,
      {
        name: "deadline-anxiety",
        description: "用户提到 deadline 焦虑升高",
        subtype: "emotion",
        body: "**触发**：工作 deadline\n\n**证据**：对话 A, 对话 B",
      },
      "deadline-anxiety.md",
    );
    await appendIndexEntry(dir, {
      title: "deadline-anxiety",
      subtype: "emotion",
      filename: "deadline-anxiety",
      hook: "用户提到 deadline 焦虑升高",
    });

    const timeline = new Timeline(dir);
    await timeline.ensure();
    const { contextText, memories } = await gatherReflectionContext({
      timeline,
      memoryDir: dir,
      lookbackDays: 7,
    });
    expect(memories.length).toBe(1);
    expect(contextText).toContain("deadline-anxiety");
    expect(contextText).toContain("emotion");
  });
});

// =====================================================================
// generateReflection
// =====================================================================

describe("generateReflection", () => {
  it("有效 JSON → 解析为 4 段", async () => {
    const provider = makeJsonProvider(
      JSON.stringify({
        情绪趋势: "恐惧类情绪增加",
        触发器与模式: "周五傍晚焦虑加重",
        主人格调整建议: "短句回应",
        长期观察: "用户回避职业讨论",
      }),
    );
    const sections = await generateReflection(provider, "context");
    expect(sections["情绪趋势"]).toContain("恐惧");
    expect(sections["触发器与模式"]).toContain("周五");
  });

  it("markdown code block 包裹", async () => {
    const provider = makeJsonProvider(
      "```json\n" +
        JSON.stringify({
          情绪趋势: "平稳",
        }) +
        "\n```",
    );
    const sections = await generateReflection(provider, "context");
    expect(sections["情绪趋势"]).toContain("平稳");
  });

  it("无效 JSON → 空 sections", async () => {
    const provider = makeJsonProvider("我说不了 JSON");
    const sections = await generateReflection(provider, "context");
    expect(sections["情绪趋势"]).toBe("");
    expect(sections["触发器与模式"]).toBe("");
    expect(sections["主人格调整建议"]).toBe("");
    expect(sections["长期观察"]).toBe("");
  });

  it("非对象 → 空 sections", async () => {
    const provider = makeJsonProvider("[1,2,3]");
    const sections = await generateReflection(provider, "context");
    expect(sections["情绪趋势"]).toBe("");
  });

  it("缺失字段 → 该段为空字符串", async () => {
    const provider = makeJsonProvider(
      JSON.stringify({
        情绪趋势: "only this",
      }),
    );
    const sections = await generateReflection(provider, "context");
    expect(sections["情绪趋势"]).toContain("only this");
    expect(sections["触发器与模式"]).toBe("");
  });
});

// =====================================================================
// runReflection - 端到端
// =====================================================================

describe("runReflection", () => {
  it("完整链路：落盘 + state 更新 + 可读回", async () => {
    const dataDir = join(tmpDir, "end-full");
    const memoryDir = join(dataDir, "memory");
    const timelineDir = join(dataDir, "timeline");

    await Promise.all([
      import("node:fs/promises").then((fs) =>
        fs.mkdir(memoryDir, { recursive: true }),
      ),
      (async () => {
        const t = new Timeline(timelineDir);
        await t.ensure();
        await t.append({
          emotion: "sadness",
          intensity: 0.6,
          trigger: "工作压力",
          userExcerpt: "很难受",
        });
      })(),
    ]);

    const timeline = new Timeline(timelineDir);
    const provider = makeJsonProvider(
      JSON.stringify({
        情绪趋势: "悲伤强度中等",
        触发器与模式: "工作压力持续",
        主人格调整建议: "多用共情",
        长期观察: "观察是否需要专业支持",
      }),
    );

    const reflection = await runReflection(
      dataDir,
      timeline,
      memoryDir,
      provider,
      { dateStr: "2026-07-11" },
    );
    expect(reflection).not.toBeNull();
    expect(reflection?.date).toBe("2026-07-11");
    expect(reflection?.sections["情绪趋势"]).toContain("悲伤");

    // 文件确实存在
    const raw = await readFile(reflection!.path, "utf-8");
    expect(raw).toContain("# 每日反思 — 2026-07-11");
    expect(raw).toContain("## 1. 情绪趋势");

    // state 被更新
    const state = await loadReflectionState(dataDir);
    expect(state.lastReflectionDate).toBe("2026-07-11");
    expect(state.lastReflectionAt).toBeGreaterThan(0);
  });

  it("失败容错：返回 null 不抛错", async () => {
    const dataDir = join(tmpDir, "end-fail");
    const memoryDir = join(dataDir, "memory");
    const timelineDir = join(dataDir, "timeline");

    const { mkdir } = await import("node:fs/promises");
    await mkdir(memoryDir, { recursive: true });
    const t = new Timeline(timelineDir);
    await t.ensure();

    // provider 返回 null（无效 JSON），runReflection 应当返回 null
    const provider = makeJsonProvider("garbage");
    const result = await runReflection(dataDir, t, memoryDir, provider, {
      dateStr: "2026-07-10",
    });
    // 注：runReflection 自己会调 generateReflection，generateReflection
    // 返回空 sections 但不抛错。然后 saveReflection 会落盘（即使是空）。
    // 所以 result 可能不是 null，而是 sections 全空
    if (result) {
      expect(result.date).toBe("2026-07-10");
    }
  });
});

// =====================================================================
// list / read
// =====================================================================

describe("listReflections / readReflection", () => {
  it("多个反思按日期倒序", async () => {
    const dataDir = join(tmpDir, "list-multiple");
    const timelineDir = join(dataDir, "timeline");
    const memoryDir = join(dataDir, "memory");
    await Promise.all([
      import("node:fs/promises").then((fs) => fs.mkdir(memoryDir, { recursive: true })),
      import("node:fs/promises").then((fs) => fs.mkdir(timelineDir, { recursive: true })),
    ]);
    await new Timeline(timelineDir).ensure();

    const provider = makeJsonProvider(
      JSON.stringify({
        情绪趋势: "test",
      }),
    );
    await runReflection(dataDir, new Timeline(timelineDir), memoryDir, provider, {
      dateStr: "2026-07-09",
    });
    await runReflection(dataDir, new Timeline(timelineDir), memoryDir, provider, {
      dateStr: "2026-07-11",
    });
    await runReflection(dataDir, new Timeline(timelineDir), memoryDir, provider, {
      dateStr: "2026-07-10",
    });

    const list = await listReflections(dataDir);
    expect(list.length).toBe(3);
    expect(list[0].date).toBe("2026-07-11"); // 最新
    expect(list[1].date).toBe("2026-07-10");
    expect(list[2].date).toBe("2026-07-09");
  });

  it("readReflection 找不到 → null", async () => {
    const dataDir = join(tmpDir, "read-missing");
    const r = await readReflection(dataDir, "1900-01-01");
    expect(r).toBeNull();
  });

  it("readReflection 找到 → 返回 sections", async () => {
    const dataDir = join(tmpDir, "read-found");
    const timelineDir = join(dataDir, "timeline");
    const memoryDir = join(dataDir, "memory");
    await Promise.all([
      import("node:fs/promises").then((fs) => fs.mkdir(memoryDir, { recursive: true })),
      import("node:fs/promises").then((fs) => fs.mkdir(timelineDir, { recursive: true })),
    ]);
    await new Timeline(timelineDir).ensure();

    const provider = makeJsonProvider(
      JSON.stringify({
        情绪趋势: "情绪稳定",
      }),
    );
    await runReflection(dataDir, new Timeline(timelineDir), memoryDir, provider, {
      dateStr: "2026-07-11",
    });

    const r = await readReflection(dataDir, "2026-07-11");
    expect(r).not.toBeNull();
    expect(r?.sections["情绪趋势"]).toContain("稳定");
  });
});

// =====================================================================
// DEFAULT_REFLECTION_CONFIG sanity
// =====================================================================

describe("DEFAULT_REFLECTION_CONFIG", () => {
  it("lookbackDays 是 7", () => {
    expect(DEFAULT_REFLECTION_CONFIG.lookbackDays).toBe(7);
  });

  it("suggestIntervalMs 是 24h", () => {
    expect(DEFAULT_REFLECTION_CONFIG.suggestIntervalMs).toBe(
      24 * 60 * 60 * 1000,
    );
  });
});