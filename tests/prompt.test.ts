// tests/prompt.test.ts
// v0.18.0: prompt.ts 中 layer0_persona 合并 BigFivePersona + 反馈学习

import { describe, it, expect } from "bun:test";
import { buildSystemPrompt } from "../src/prompt.ts";
import { applyFeedback, emptyState, type LearnerState } from "../src/persona-learner.ts";
import { defaultPersona, type BigFivePersona } from "../src/bigfive.ts";

import type { Timeline } from "../src/timeline.ts";
const mockTimeline = {
  renderSummary: async () => "（无）",
} as unknown as Timeline;

function makePersona(overrides?: Partial<BigFivePersona>): BigFivePersona {
  return { ...defaultPersona("s-1"), ...overrides };
}

describe("buildSystemPrompt layer0_persona OCEAN 合并", () => {
  it("只有 persona → 输出大五维度段", async () => {
    const persona = makePersona({
      ocean: { openness: 0.9, conscientiousness: 0.5, extraversion: 0.3, agreeableness: 0.7, neuroticism: 0.2 },
      preferences: "用日常话翻译哲学概念",
    });
    const prompt = await buildSystemPrompt({
      persona,
      personaLearner: emptyState("u1"),
      memoryIndex: "",
      profile: null,
      emotion: null,
      recalledMemories: [],
      timeline: mockTimeline,
    });
    expect(prompt).toContain("【大五人格】");
    expect(prompt).toContain("Openness: 0.90");
    expect(prompt).toContain("Extraversion: 0.30");
    expect(prompt).toContain("高开放性");
    expect(prompt).toContain("【用户描述的角色偏好】");
    expect(prompt).toContain("用日常话翻译哲学概念");
  });

  it("persona 为 null → 不显示 OCEAN 段", async () => {
    const prompt = await buildSystemPrompt({
      persona: null,
      personaLearner: emptyState("u1"),
      memoryIndex: "",
      profile: null,
      emotion: null,
      recalledMemories: [],
      timeline: mockTimeline,
    });
    expect(prompt).not.toContain("【大五人格】");
    expect(prompt).toContain("真实的人"); // learner fallback
  });

  it("persona + 反馈 都有 → 包含 OCEAN 段 + 反馈段 + 优先级声明", async () => {
    const persona = makePersona({ preferences: "用具体例子" });
    let learner: LearnerState = emptyState("u1");
    learner = applyFeedback(learner, "positive", ["用户喜欢具体例子"]);

    const prompt = await buildSystemPrompt({
      persona,
      personaLearner: learner,
      memoryIndex: "",
      profile: null,
      emotion: null,
      recalledMemories: [],
      timeline: mockTimeline,
    });
    expect(prompt).toContain("【大五人格】");
    expect(prompt).toContain("Openness: 0.50");
    expect(prompt).toContain("用具体例子");
    expect(prompt).toContain("具体例子"); // learner
    expect(prompt).toContain("【优先级】");
    expect(prompt).toContain("反馈学习 > 人设");
  });

  it("persona.preferences 为空 → 省略偏好段", async () => {
    const persona = makePersona({ preferences: "" });
    const prompt = await buildSystemPrompt({
      persona,
      personaLearner: emptyState("u1"),
      memoryIndex: "",
      profile: null,
      emotion: null,
      recalledMemories: [],
      timeline: mockTimeline,
    });
    expect(prompt).toContain("【大五人格】");
    expect(prompt).not.toContain("【用户描述的角色偏好】");
  });
});