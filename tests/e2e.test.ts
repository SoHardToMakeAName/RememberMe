// tests/e2e.test.ts
// 端到端测试：用 Mock provider 验证完整对话循环。
// 不需要 API key。

import { describe, it, expect, beforeAll } from "bun:test";
import { Timeline } from "../src/timeline.ts";
import { runTurn } from "../src/loop.ts";
import type { ModelProvider, StreamOptions, StreamChunk } from "../src/provider.ts";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Mock provider：根据 system prompt 中的关键词返回不同内容。
 * 简化测试，验证 prompt 构建和 side-query 流程。
 */
class MockProvider implements ModelProvider {
  readonly name = "mock";
  readonly model = "mock-model";

  async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
    const { system, messages } = options.params;
    const lastUser = messages[messages.length - 1]?.content ?? "";

    // 模拟情绪识别 side-query
    if (system.includes("情绪识别")) {
      const text = JSON.stringify({
        emotion: lastUser.includes("累") ? "sadness" : "joy",
        intensity: lastUser.includes("累") ? 0.7 : 0.6,
        trigger: lastUser.includes("累") ? "工作压力" : "分享好消息",
        excerpt: lastUser.slice(0, 100),
      });
      yield { delta: text, done: false };
      yield { delta: "", done: true };
      return;
    }

    // 模拟记忆召回 side-query
    if (system.includes("记忆检索")) {
      yield { delta: JSON.stringify({ selected: [] }), done: false };
      yield { delta: "", done: true };
      return;
    }

    // 主对话：返回一个简短的 echo，证明 system prompt + history 都传过来了
    const systemSize = system.length;
    yield {
      delta: `[mock-echo] 收到你的消息："${lastUser.slice(0, 30)}"（system=${systemSize} chars）`,
      done: false,
    };
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

describe("E2E: full conversation loop", () => {
  let timeline: Timeline;
  let tmpDir: string;
  let provider: MockProvider;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "ec-e2e-"));
    timeline = new Timeline(tmpDir);
    await timeline.ensure();

    provider = new MockProvider();
  });

  it("完成一轮对话：stream chunks 收到、timeline 写入", async () => {
    const chunks: string[] = [];
    const result = await runTurn(
      {
        provider,
        memoryDir: tmpDir,
        timeline,
      },
      "我今天好累",
      [],
      (chunk) => {
        if (chunk.delta) chunks.push(chunk.delta);
      },
    );

    expect(result.responseText).toContain("mock-echo");
    expect(chunks.length).toBeGreaterThan(0);
    expect(result.emotion).not.toBeNull();
    expect(result.emotion!.emotion).toBe("sadness");

    // timeline 应该已经写入
    const all = await timeline.readAll();
    expect(all.length).toBe(1);
    expect(all[0].emotion).toBe("sadness");
  });

  it("第二轮：消息历史能传过去", async () => {
    const history = [
      { role: "user" as const, content: "我今天好累" },
      {
        role: "assistant" as const,
        content: "[mock-echo] 收到你的消息",
      },
    ];

    let capturedSystem = "";
    class CaptureProvider extends MockProvider {
      async *stream(options: StreamOptions): AsyncIterable<StreamChunk> {
        capturedSystem = options.params.system;
        yield* super.stream(options);
      }
    }

    const capture = new CaptureProvider();
    await runTurn(
      {
        provider: capture,
        memoryDir: tmpDir,
        timeline,
      },
      "再聊聊",
      history,
      () => {},
    );

    // v0.19：buildDynamicPersona 在无反馈时返回空字符串，不再注入"真实的人"
    expect(capturedSystem).not.toContain("真实的人");
    // system prompt 包含情绪时间线
    expect(capturedSystem).toContain("情绪轨迹");
    // system prompt 包含当前情绪识别结果
    expect(capturedSystem).toContain("用户当下情绪");
  });
});