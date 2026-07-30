// tests/smoke.ts
// 烟雾测试：验证基础结构能跑起来（不调用 LLM）。
// 用 bun test 跑：bun test tests/smoke.ts

import { describe, it, expect, beforeAll } from "bun:test";
// v0.15.0: personality.ts 兼容 shim 仍然存在，但 smoke 不再测人格加载
// import { loadPersonality } from "../src/personality.ts";
import { scanMemory, writeMemoryFile, appendIndexEntry } from "../src/memory.ts";
import { Timeline, EMOTION_LABEL } from "../src/timeline.ts";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

describe("memory store", () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ec-mem-"));
  });

  it("写入并扫描记忆文件（emotion 子目录）", async () => {
    await writeMemoryFile(
      tmpDir,
      {
        name: "test-emotion",
        description: "测试情绪模式",
        subtype: "emotion",
        body: "这是测试情绪模式\n\n**触发**：...\n**表现**：...",
        fields: {
          trigger: "...",
          manifestation: "...",
          evidence: ["1", "2"],
        },
      },
      "test-emotion.md",
    );

    const files = await scanMemory(tmpDir);
    expect(files.length).toBe(1);
    expect(files[0].filename).toBe("test-emotion");
    expect(files[0].subtype).toBe("emotion");
    expect(files[0].body).toContain("这是测试情绪模式");
  });

  it("追加 MEMORY.md 索引", async () => {
    await appendIndexEntry(tmpDir, {
      title: "test-emotion",
      subtype: "emotion",
      filename: "test-emotion",
      hook: "测试情绪模式",
    });

    const files = await scanMemory(tmpDir);
    // MEMORY.md 不算主题文件，扫描结果不应包含
    expect(files.length).toBe(1);
  });
});

describe("emotional timeline", () => {
  let tmpDir: string;
  let timeline: Timeline;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ec-tl-"));
    timeline = new Timeline(tmpDir);
    await timeline.ensure();
  });

  it("追加情绪记录", async () => {
    await timeline.append({
      emotion: "joy",
      intensity: 0.7,
      trigger: "测试触发",
      userExcerpt: "今天很开心",
    });

    const all = await timeline.readAll();
    expect(all.length).toBe(1);
    expect(all[0].emotion).toBe("joy");
    expect(all[0].intensity).toBe(0.7);
  });

  it("统计情绪", async () => {
    await timeline.append({
      emotion: "sadness",
      intensity: 0.8,
      trigger: "测试难过",
    });
    await timeline.append({
      emotion: "joy",
      intensity: 0.5,
    });

    const stats = await timeline.getStats();
    expect(stats.totalEntries).toBe(3);
    expect(stats.emotionCounts.joy).toBe(2);
    expect(stats.emotionCounts.sadness).toBe(1);
  });

  it("渲染摘要", async () => {
    const summary = await timeline.renderSummary(5);
    expect(summary).toContain("最近情绪轨迹");
    expect(summary).toContain(EMOTION_LABEL.joy);
  });
});