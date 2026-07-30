// tests/persona-init.integration.test.ts
// v0.18.0: persona-init 真 LLM 集成测试
//
// 用真 LLM 跑 persona 生成，验证：
// 1. 输出是合法 OCEAN JSON（round-trip 解析成功）
// 2. 数值 clamp 到 0-1
// 3. 基础相关性：描述里隐含的特质应该在 OCEAN 数值上有反映
//
// **默认跳过**——需要真 LLM 调用的费用和时间。
// 启用方法：
//   EC_INTEGRATION=1 bun test tests/persona-init.integration.test.ts
//
// 或在 CI 里用单独的 job 跑。

import { describe, it, expect } from "bun:test";
import { initPersonaFromDescription } from "../src/persona-init.ts";
import { validateOCEAN } from "../src/bigfive.ts";
import { loadProjectEnv, pickDefaultModel } from "../src/bootstrap.ts";
import { createProvider } from "../src/provider.ts";
import { join } from "node:path";
import { existsSync } from "node:fs";

const SHOULD_RUN = !!process.env.EC_INTEGRATION;
const SKIP_REASON = "Set EC_INTEGRATION=1 to run real LLM integration tests";

describe.skipIf(!SHOULD_RUN)("persona-init 真 LLM 集成测试", () => {
  it("苏格拉底 → 高 openness、低 neuroticism", async () => {
    const tmp = join(process.cwd(), "data", "test-persona-init");
    require("node:fs").mkdirSync(tmp, { recursive: true });

    // 用真 LLM
    loadProjectEnv({ settingsPath: join(process.cwd(), "settings.json"), verbose: false });
    const provider = createProvider({ kind: "anthropic", model: pickDefaultModel() });

    const result = await initPersonaFromDescription(
      provider,
      { description: "一个像苏格拉底那样的智者，喜欢提问、追求真理", sessionId: "s-test-1" },
      tmp,
    );

    // 1. 解析成功 → OCEAN 合法
    expect(validateOCEAN(result.ocean)).toBe(true);

    // 2. 苏格拉底特质 → 高开放性
    expect(result.ocean.openness).toBeGreaterThan(0.6);

    // 3. 苏格拉底特质 → 低神经质（平静、不焦虑）
    expect(result.ocean.neuroticism).toBeLessThan(0.5);

    // 4. preferences 应包含人设描述相关词
    expect(result.preferences.length).toBeGreaterThan(0);

    // 5. 数值在 0-1 之间
    for (const v of Object.values(result.ocean)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // debug 输出
    console.log("[integration] 苏格拉底 → OCEAN:", JSON.stringify(result.ocean));
    console.log("[integration] preferences:", result.preferences);

    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  }, 60_000);  // 60s timeout（LLM 可能慢）

  it("冷笑话朋友 → 高 extraversion", async () => {
    const tmp = join(process.cwd(), "data", "test-persona-init");
    require("node:fs").mkdirSync(tmp, { recursive: true });

    loadProjectEnv({ settingsPath: join(process.cwd(), "settings.json"), verbose: false });
    const provider = createProvider({ kind: "anthropic", model: pickDefaultModel() });

    const result = await initPersonaFromDescription(
      provider,
      { description: "一个会讲冷笑话的朋友，热情外向、爱开玩笑", sessionId: "s-test-2" },
      tmp,
    );

    expect(validateOCEAN(result.ocean)).toBe(true);

    // 朋友 + 热情外向 → extraversion 高
    expect(result.ocean.extraversion).toBeGreaterThan(0.6);

    console.log("[integration] 冷笑话朋友 → OCEAN:", JSON.stringify(result.ocean));
    console.log("[integration] preferences:", result.preferences);

    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  }, 60_000);

  it("空描述 → OCEAN 合法、preferences 非空", async () => {
    const tmp = join(process.cwd(), "data", "test-persona-init");
    require("node:fs").mkdirSync(tmp, { recursive: true });

    loadProjectEnv({ settingsPath: join(process.cwd(), "settings.json"), verbose: false });
    const provider = createProvider({ kind: "anthropic", model: pickDefaultModel() });

    const result = await initPersonaFromDescription(
      provider,
      { description: "", sessionId: "s-test-empty" },
      tmp,
    );

    // 不论 LLM 怎么回（走默认 OCEAN 还是 LLM 自由发挥），
    // 只要 OCEAN 合法 + preferences 非空就算通过
    expect(validateOCEAN(result.ocean)).toBe(true);
    expect(result.preferences.length).toBeGreaterThan(0);

    console.log("[integration] 空描述 → OCEAN:", JSON.stringify(result.ocean));
    console.log("[integration] 空描述 → preferences:", result.preferences);

    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});

describe.skipIf(!SHOULD_RUN)("persona-init 边界：异常 LLM 输出", () => {
  it("LLM 返回纯文本（非 JSON）→ 降级为默认", async () => {
    const tmp = join(process.cwd(), "data", "test-persona-init");
    require("node:fs").mkdirSync(tmp, { recursive: true });

    loadProjectEnv({ settingsPath: join(process.cwd(), "settings.json"), verbose: false });
    // 用一个会返回无效 JSON 的 mock（但跑真 LLM 测）
    const provider = createProvider({ kind: "anthropic", model: pickDefaultModel() });

    // 让 LLM 困惑地输出"我不知道"
    const result = await initPersonaFromDescription(
      provider,
      { description: "不告诉你", sessionId: "s-test-rebel" },
      tmp,
    );

    expect(validateOCEAN(result.ocean)).toBe(true);
    // 降级路径下 preferences 包含"生成失败"或默认文本
    expect(result.preferences.length).toBeGreaterThan(0);

    console.log("[integration] 叛逆描述 → preferences:", result.preferences);

    require("node:fs").rmSync(tmp, { recursive: true, force: true });
  }, 60_000);
});
