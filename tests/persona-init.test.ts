// tests/persona-init.test.ts
// v0.18.0: 从用户描述生成 OCEAN JSON 单元测试

import { describe, it, expect } from "bun:test";
import { parseInitOutput } from "../src/persona-init.ts";

describe("parseInitOutput", () => {
  it("标准 JSON 直接解析", () => {
    const out = parseInitOutput(
      `{"ocean":{"openness":0.8,"conscientiousness":0.5,"extraversion":0.3,"agreeableness":0.7,"neuroticism":0.2},"preferences":"用日常话翻译哲学概念"}`,
      "s-123",
    );
    expect(out.ocean.openness).toBe(0.8);
    expect(out.ocean.extraversion).toBe(0.3);
    expect(out.ocean.agreeableness).toBe(0.7);
    expect(out.preferences).toBe("用日常话翻译哲学概念");
    expect(out.sessionId).toBe("s-123");
  });

  it("包在 markdown code fence 里也能解析", () => {
    const out = parseInitOutput(
      '```json\n{"ocean":{"openness":0.5,"conscientiousness":0.5,"extraversion":0.5,"agreeableness":0.5,"neuroticism":0.5},"preferences":"中性"}\n```',
      "s-456",
    );
    expect(out.ocean.openness).toBe(0.5);
    expect(out.preferences).toBe("中性");
  });

  it("非法 JSON → 降级为默认 OCEAN（0.5）", () => {
    const out = parseInitOutput("not json", "s-789");
    expect(out.ocean).toEqual({
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
    });
    expect(out.sessionId).toBe("s-789");
  });

  it("空字符串 → 降级为默认", () => {
    const out = parseInitOutput("", "s-000");
    expect(out.ocean.openness).toBe(0.5);
  });

  it("OCEAN 数值越界 → 钳制到 0-1", () => {
    const out = parseInitOutput(
      `{"ocean":{"openness":1.5,"conscientiousness":-0.3,"extraversion":0.5,"agreeableness":0.5,"neuroticism":0.5},"preferences":""}`,
      "s-clamp",
    );
    expect(out.ocean.openness).toBe(1);
    expect(out.ocean.conscientiousness).toBe(0);
  });

  it("OCEAN 数值保留 2 位小数", () => {
    const out = parseInitOutput(
      `{"ocean":{"openness":0.87654,"conscientiousness":0.5,"extraversion":0.5,"agreeableness":0.5,"neuroticism":0.5},"preferences":""}`,
      "s-round",
    );
    expect(out.ocean.openness).toBe(0.88);
  });

  it("preferences 缺失 → 用默认", () => {
    const out = parseInitOutput(
      `{"ocean":{"openness":0.5,"conscientiousness":0.5,"extraversion":0.5,"agreeableness":0.5,"neuroticism":0.5}}`,
      "s-nopref",
    );
    expect(out.preferences).toBeTruthy(); // 默认 preferences 文本
  });

  it("从含额外文字的输出中提取 JSON", () => {
    const out = parseInitOutput(
      `好的，根据你的描述，我生成了：{"ocean":{"openness":0.7,"conscientiousness":0.4,"extraversion":0.6,"agreeableness":0.8,"neuroticism":0.3},"preferences":"温暖好奇"}就这样。`,
      "s-mixed",
    );
    expect(out.ocean.openness).toBe(0.7);
    expect(out.preferences).toBe("温暖好奇");
  });
});