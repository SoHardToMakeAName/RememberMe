// tests/bigfive.test.ts
// v0.18.0: 大五人格（OCEAN）模块单元测试

import { describe, it, expect } from "bun:test";
import {
  defaultPersona,
  loadPersonaForSession,
  savePersonaForSession,
  validateOCEAN,
  validatePersona,
  oceanHint,
  type BigFivePersona,
  type OCEAN,
} from "../src/bigfive.ts";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function tmpDataDir(): string {
  const tmp = mkdtempSync(join(tmpdir(), "ocean-"));
  mkdirSync(join(tmp, "personality"), { recursive: true });
  return tmp;
}

describe("validateOCEAN", () => {
  it("合法 OCEAN → true", () => {
    expect(validateOCEAN({ openness: 0.5, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 })).toBe(true);
  });
  it("缺字段 → false", () => {
    expect(validateOCEAN({ openness: 0.5 })).toBe(false);
  });
  it("数值越界 → false", () => {
    expect(validateOCEAN({ openness: -0.1, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 })).toBe(false);
    expect(validateOCEAN({ openness: 1.1, conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 })).toBe(false);
  });
  it("非数字 → false", () => {
    expect(validateOCEAN({ openness: "0.5", conscientiousness: 0.5, extraversion: 0.5, agreeableness: 0.5, neuroticism: 0.5 })).toBe(false);
  });
  it("null/undefined → false", () => {
    expect(validateOCEAN(null)).toBe(false);
    expect(validateOCEAN(undefined)).toBe(false);
  });
});

describe("defaultPersona", () => {
  it("数值全 0.5（中性）", () => {
    const p = defaultPersona("s-123");
    expect(p.ocean).toEqual({
      openness: 0.5,
      conscientiousness: 0.5,
      extraversion: 0.5,
      agreeableness: 0.5,
      neuroticism: 0.5,
    });
    expect(p.sessionId).toBe("s-123");
  });
});

describe("load/save round-trip", () => {
  it("保存 → 加载 内容一致", () => {
    const tmp = tmpDataDir();
    const p: BigFivePersona = {
      sessionId: "s-abc",
      ocean: {
        openness: 0.8,
        conscientiousness: 0.3,
        extraversion: 0.7,
        agreeableness: 0.6,
        neuroticism: 0.2,
      },
      preferences: "用户喜欢直接、不绕弯",
      createdAt: 1000,
      updatedAt: 1000,
    };
    savePersonaForSession(tmp, p);
    const loaded = loadPersonaForSession(tmp, "s-abc");
    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe("s-abc");
    expect(loaded!.ocean).toEqual(p.ocean);
    expect(loaded!.preferences).toBe("用户喜欢直接、不绕弯");
    rmSync(tmp, { recursive: true, force: true });
  });

  it("文件不存在 → null", () => {
    const tmp = tmpDataDir();
    expect(loadPersonaForSession(tmp, "nonexistent")).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("文件损坏 → null（不抛）", () => {
    const tmp = tmpDataDir();
    writeFileSync(join(tmp, "personality", "broken.json"), "{not valid json", "utf-8");
    expect(loadPersonaForSession(tmp, "broken")).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("validateOCEAN 失败时 → null", () => {
    const tmp = tmpDataDir();
    writeFileSync(
      join(tmp, "personality", "bad.json"),
      JSON.stringify({ sessionId: "x", ocean: { openness: "wrong" }, preferences: "" }),
      "utf-8",
    );
    expect(loadPersonaForSession(tmp, "bad")).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe("oceanHint", () => {
  it("低值返回低档描述", () => {
    expect(oceanHint("openness", 0.2)).toContain("低");
  });
  it("中值返回中档描述", () => {
    expect(oceanHint("openness", 0.5)).toContain("中");
  });
  it("高值返回高档描述", () => {
    expect(oceanHint("openness", 0.9)).toContain("高");
  });
  it("5 个维度都返回有效描述", () => {
    for (const dim of ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as (keyof OCEAN)[]) {
      const text = oceanHint(dim, 0.5);
      expect(text.length).toBeGreaterThan(5);
    }
  });
});