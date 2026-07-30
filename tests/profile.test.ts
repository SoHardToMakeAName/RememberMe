// tests/profile.test.ts
// profile 模块测试。

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  loadProfile,
  saveProfile,
  mergeProfileUpdate,
  renderProfileForPrompt,
  extractProfileUpdate,
  maybeUpdateProfile,
  getProfilePath,
  PROFILE_FILENAME,
  PROFILE_SECTIONS,
  type Profile,
  type ProfileUpdate,
} from "../src/profile.ts";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, StreamOptions, StreamChunk } from "../src/provider.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-profile-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =====================================================================
// 路径 & 文件名
// =====================================================================

describe("profile 路径", () => {
  it("getProfilePath 返回 <dataDir>/profile/PROFILE.md", () => {
    // 用 OS 无关方式：拼接后用 normalize 比较
    const result = getProfilePath(join(tmpDir, "data"));
    const expected = join(tmpDir, "data", "profile", PROFILE_FILENAME);
    expect(result).toBe(expected);
  });

  it("PROFILE_FILENAME 固定为 PROFILE.md", () => {
    expect(PROFILE_FILENAME).toBe("PROFILE.md");
  });
});

// =====================================================================
// 加载 / 初始化
// =====================================================================

describe("loadProfile", () => {
  it("首次加载自动创建默认模板", async () => {
    const dataDir = join(tmpDir, "fresh-init");
    const profile = await loadProfile(dataDir);

    expect(profile.initialized).toBe(true);
    expect(profile.path).toBe(getProfilePath(dataDir));
    expect(Object.keys(profile.sections)).toHaveLength(PROFILE_SECTIONS.length);

    // 文件已落盘
    const content = await readFile(profile.path, "utf-8");
    expect(content).toContain("# 用户画像");
    expect(content).toContain("- **类型**：profile");
    PROFILE_SECTIONS.forEach((section, i) => {
      // 序列化时带数字编号（如 "## 1. 基本信息"），解析时去掉前缀
      expect(content).toContain(`## ${i + 1}. ${section}`);
    });
  });

  it("二次加载不再 initialized", async () => {
    const dataDir = join(tmpDir, "second-load");
    await loadProfile(dataDir); // 第一次：初始化
    const profile2 = await loadProfile(dataDir); // 第二次
    expect(profile2.initialized).toBe(false);
    expect(Object.keys(profile2.sections)).toHaveLength(PROFILE_SECTIONS.length);
  });

  it("已存在自定义内容时正确解析", async () => {
    const dataDir = join(tmpDir, "custom-content");
    const customContent = `# 用户画像

- **类型**：profile
- **版本**：1.0
- **作者**：test
- **描述**：测试

> 自定义头。

## 1. 基本信息
- 昵称：小阳
- 职业：前端工程师

## 2. 沟通风格
- 喜欢简短直接

## 3. 关注议题
- 工作压力

## 4. 已知偏好与禁忌
- 不喜欢被总结

## 5. 长期情绪基线
- 平稳偏焦虑

## 6. 近期变化
- 最近 1 周睡眠变差
`;
    // 先创建目录（writeFile 不会自动创建父目录）
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dataDir, "profile"), { recursive: true });
    await writeFile(getProfilePath(dataDir), customContent, "utf-8");
    const profile = await loadProfile(dataDir);

    expect(profile.initialized).toBe(false);
    expect(profile.sections["基本信息"]).toContain("昵称：小阳");
    expect(profile.sections["沟通风格"]).toContain("简短直接");
  });
});

// =====================================================================
// 保存
// =====================================================================

describe("saveProfile", () => {
  it("保存后能再次正确加载", async () => {
    const dataDir = join(tmpDir, "save-roundtrip");
    const profile = await loadProfile(dataDir);

    profile.sections["基本信息"] = "- 昵称：测试用户\n- 职业：QA";
    await saveProfile(profile);

    const reloaded = await loadProfile(dataDir);
    expect(reloaded.sections["基本信息"]).toContain("测试用户");
    expect(reloaded.sections["基本信息"]).toContain("QA");
  });
});

// =====================================================================
// mergeProfileUpdate
// =====================================================================

describe("mergeProfileUpdate - 字符串段", () => {
  let profile: Profile;

  beforeAll(async () => {
    profile = await loadProfile(join(tmpDir, "merge-string"));
  });

  it("空段直接替换为新内容", () => {
    profile.sections["基本信息"] = "";
    const changed = mergeProfileUpdate(profile, {
      基本信息: "- 昵称：小阳\n- 职业：前端工程师",
    });
    expect(changed).toBe(true);
    expect(profile.sections["基本信息"]).toContain("昵称：小阳");
  });

  it("包含「未知」占位时直接替换", () => {
    profile.sections["基本信息"] = "- 昵称：未知\n- 职业：未知";
    mergeProfileUpdate(profile, {
      基本信息: "- 昵称：阳光\n- 职业：产品经理",
    });
    expect(profile.sections["基本信息"]).toContain("阳光");
    expect(profile.sections["基本信息"]).toContain("产品经理");
    expect(profile.sections["基本信息"]).not.toContain("未知");
  });

  it("已有内容时追加而非覆盖", () => {
    profile.sections["沟通风格"] = "- 喜欢简短";
    mergeProfileUpdate(profile, {
      沟通风格: "不喜欢被总结教训",
    });
    expect(profile.sections["沟通风格"]).toContain("喜欢简短");
    expect(profile.sections["沟通风格"]).toContain("不喜欢被总结");
  });

  it("相似内容去重，不重复追加", () => {
    profile.sections["沟通风格"] = "- 喜欢简短回复";
    const before = profile.sections["沟通风格"];
    mergeProfileUpdate(profile, {
      沟通风格: "喜欢简短回复", // 完全相同
    });
    expect(profile.sections["沟通风格"]).toBe(before);
  });

  it("带日期前缀", () => {
    profile.sections["长期情绪基线"] = "- 整体平稳";
    const fixedDate = new Date("2026-01-15T10:00:00Z");
    mergeProfileUpdate(
      profile,
      { 长期情绪基线: "工作日傍晚容易焦虑" },
      fixedDate,
    );
    expect(profile.sections["长期情绪基线"]).toContain("(2026-01-15)");
    expect(profile.sections["长期情绪基线"]).toContain("工作日傍晚");
  });
});

describe("mergeProfileUpdate - 列表段", () => {
  let profile: Profile;

  beforeAll(async () => {
    profile = await loadProfile(join(tmpDir, "merge-list"));
  });

  it("空列表直接添加", () => {
    profile.sections["关注议题"] = "";
    mergeProfileUpdate(profile, {
      关注议题: ["工作压力", "睡眠质量"],
    });
    expect(profile.sections["关注议题"]).toContain("工作压力");
    expect(profile.sections["关注议题"]).toContain("睡眠质量");
  });

  it("已存在条目不去重", () => {
    profile.sections["关注议题"] = "- 工作压力";
    mergeProfileUpdate(profile, {
      关注议题: ["工作压力", "人际关系"],
    });
    // 工作压力应该保留且不重复追加
    const matches = profile.sections["关注议题"].match(/工作压力/g) ?? [];
    expect(matches.length).toBe(1);
    expect(profile.sections["关注议题"]).toContain("人际关系");
  });

  it("新增条目追加到末尾", () => {
    profile.sections["已知偏好与禁忌"] = "- 不喜欢被总结";
    mergeProfileUpdate(profile, {
      已知偏好与禁忌: ["喜欢轻松的氛围", "讨厌说教"],
    });
    expect(profile.sections["已知偏好与禁忌"]).toContain("不喜欢被总结");
    expect(profile.sections["已知偏好与禁忌"]).toContain("喜欢轻松的氛围");
    expect(profile.sections["已知偏好与禁忌"]).toContain("讨厌说教");
  });

  it("空数组不触发更新", () => {
    profile.sections["关注议题"] = "- 工作压力";
    const before = profile.sections["关注议题"];
    const changed = mergeProfileUpdate(profile, {
      关注议题: [],
    });
    expect(changed).toBe(false);
    expect(profile.sections["关注议题"]).toBe(before);
  });
});

describe("mergeProfileUpdate - 综合", () => {
  it("一次更新多个段", () => {
    const profile = makeEmptyProfile();
    const changed = mergeProfileUpdate(profile, {
      基本信息: "- 昵称：小阳",
      关注议题: ["前端技术", "AI"],
      已知偏好与禁忌: ["喜欢简洁"],
    });
    expect(changed).toBe(true);
    expect(profile.sections["基本信息"]).toContain("小阳");
    expect(profile.sections["关注议题"]).toContain("前端技术");
    expect(profile.sections["已知偏好与禁忌"]).toContain("喜欢简洁");
    // 未指定的段保持空
    expect(profile.sections["沟通风格"]).toBe("");
  });

  it("空 update 不触发变更", () => {
    const profile = makeEmptyProfile();
    const changed = mergeProfileUpdate(profile, {});
    expect(changed).toBe(false);
  });
});

function makeEmptyProfile(): Profile {
  const sections = {} as Profile["sections"];
  for (const s of PROFILE_SECTIONS) sections[s] = "";
  return {
    sections,
    path: "/tmp/test.md",
    updatedAt: Date.now(),
    initialized: false,
  };
}

// =====================================================================
// renderProfileForPrompt
// =====================================================================

describe("renderProfileForPrompt", () => {
  it("空 profile 输出占位段", () => {
    const profile = makeEmptyProfile();
    const rendered = renderProfileForPrompt(profile);
    expect(rendered).toContain("用户画像");
    expect(rendered).toContain("暂无");
  });

  it("填充过的 profile 包含内容段", () => {
    const profile = makeEmptyProfile();
    profile.sections["基本信息"] = "- 昵称：小阳\n- 职业：前端";
    const rendered = renderProfileForPrompt(profile);
    expect(rendered).toContain("基本信息");
    expect(rendered).toContain("小阳");
    expect(rendered).toContain("前端");
  });

  it("包含 drift caveat 警告", () => {
    const profile = makeEmptyProfile();
    const rendered = renderProfileForPrompt(profile);
    expect(rendered).toMatch(/历史快照|drift/i);
  });

  it("跳过空的段落", () => {
    const profile = makeEmptyProfile();
    profile.sections["基本信息"] = "- 昵称：小阳";
    // 其他段保持空
    const rendered = renderProfileForPrompt(profile);
    expect(rendered).toContain("基本信息");
    expect(rendered).not.toContain("沟通风格");
  });
});

// =====================================================================
// extractProfileUpdate - mock provider
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
        if (c.delta) result += c.delta;
        if (c.done) break;
      }
      return result;
    },
  };
}

describe("extractProfileUpdate", () => {
  it("模型返回有效 JSON 时正确解析", async () => {
    const provider = makeJsonProvider(
      JSON.stringify({
        基本信息: "- 昵称：小阳",
        关注议题: ["工作压力"],
      }),
    );
    const update = await extractProfileUpdate(provider, [
      { role: "user", content: "我叫小阳，最近工作压力大" },
    ]);
    expect(update.基本信息).toContain("小阳");
    expect(update.关注议题).toContain("工作压力");
  });

  it("模型返回 markdown code block 包裹时也能解析", async () => {
    const provider = makeJsonProvider(
      "```json\n" +
        JSON.stringify({
          基本信息: "- 职业：产品经理",
        }) +
        "\n```",
    );
    const update = await extractProfileUpdate(provider, [
      { role: "user", content: "我是产品经理" },
    ]);
    expect(update.基本信息).toContain("产品经理");
  });

  it("模型返回非 JSON 时返回空对象", async () => {
    const provider = makeJsonProvider("我无法提取");
    const update = await extractProfileUpdate(provider, [
      { role: "user", content: "随便聊聊" },
    ]);
    expect(Object.keys(update)).toHaveLength(0);
  });

  it("空对话直接返回空对象", async () => {
    const provider = makeJsonProvider("{}");
    const update = await extractProfileUpdate(provider, []);
    expect(Object.keys(update)).toHaveLength(0);
  });
});

// =====================================================================
// maybeUpdateProfile - 端到端
// =====================================================================

describe("maybeUpdateProfile", () => {
  it("首次使用：更新后 profile 持久化", async () => {
    const dataDir = join(tmpDir, "maybe-update-1");
    const provider = makeJsonProvider(
      JSON.stringify({
        基本信息: "- 昵称：第一次",
      }),
    );
    const result = await maybeUpdateProfile(
      dataDir,
      provider,
      [{ role: "user", content: "我叫第一次" }],
    );
    expect(result.updated).toBe(true);
    expect(result.profile.sections["基本信息"]).toContain("第一次");

    // 再次加载验证持久化
    const reloaded = await loadProfile(dataDir);
    expect(reloaded.sections["基本信息"]).toContain("第一次");
  });

  it("二次更新：融合而非覆盖", async () => {
    const dataDir = join(tmpDir, "maybe-update-2");
    const provider1 = makeJsonProvider(
      JSON.stringify({ 基本信息: "- 昵称：小阳" }),
    );
    await maybeUpdateProfile(dataDir, provider1, [
      { role: "user", content: "我" },
    ]);

    const provider2 = makeJsonProvider(
      JSON.stringify({ 基本信息: "- 职业：前端工程师" }),
    );
    await maybeUpdateProfile(dataDir, provider2, [
      { role: "user", content: "前端" },
    ]);

    const final = await loadProfile(dataDir);
    expect(final.sections["基本信息"]).toContain("小阳");
    expect(final.sections["基本信息"]).toContain("前端工程师");
  });

  it("模型无新信息时不写盘", async () => {
    const dataDir = join(tmpDir, "maybe-update-noop");
    const provider = makeJsonProvider("{}");
    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "随便说" },
    ]);
    expect(result.updated).toBe(false);
  });
});

// =====================================================================
// v0.9 新增：自动偏好识别 + 行为提醒
// =====================================================================

describe("v0.9: maybeUpdateProfile 返回实际变化", () => {
  it("更新时返回 changes 数组（每个变更的具体内容）", async () => {
    const dataDir = join(tmpDir, "auto-update-changes");
    const provider = makeJsonProvider(
      JSON.stringify({
        沟通风格: "用户偏好短回复（≤3句）（用户说'别回太长'）",
        已知偏好与禁忌: ["别用心理咨询师腔（'我懂你'）"],
      }),
    );

    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "别回太长" },
      { role: "assistant", content: "好的" },
      { role: "user", content: "别用心理咨询师腔，我懂你这种话听着烦" },
    ]);

    expect(result.updated).toBe(true);
    expect(result.changes).toBeDefined();
    expect(result.changes!.length).toBeGreaterThan(0);
    expect(result.changes!.some((c) => c.section === "沟通风格")).toBe(true);
    expect(result.changes!.some((c) => c.section === "已知偏好与禁忌")).toBe(true);
  });

  it("空 update 时不返回 changes", async () => {
    const dataDir = join(tmpDir, "auto-update-empty");
    const provider = makeJsonProvider("{}");
    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "今天天气不错" },
    ]);
    expect(result.updated).toBe(false);
    expect(result.changes).toBeUndefined();
  });

  it("提取失败时（不是 JSON）静默返回 updated=false", async () => {
    const dataDir = join(tmpDir, "auto-update-bad-json");
    const provider = makeJsonProvider("this is not json");
    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "hi" },
    ]);
    expect(result.updated).toBe(false);
  });
});

describe("v0.9: 行为提醒自动派生（通过 renderProfileForPrompt 验证）", () => {
  function buildProfile(overrides: Partial<Record<string, string>>): Profile {
    return {
      sections: {
        基本信息: "（暂无）",
        沟通风格: "（暂无）",
        关注议题: "（暂无）",
        已知偏好与禁忌: "（暂无）",
        长期情绪基线: "（暂无）",
        近期变化: "（暂无）",
        ...overrides,
      } as Profile["sections"],
      path: "/tmp/test",
      updatedAt: 0,
      initialized: false,
    };
  }

  it("沟通偏好 = 短时，提醒里出现「短回复」", () => {
    const p = buildProfile({ 沟通风格: "用户偏好短回复（≤3句）" });
    const rendered = renderProfileForPrompt(p);
    expect(rendered).toContain("短回复");
    expect(rendered).toContain("行为提醒");
  });

  it("禁忌 = 别说教时，提醒里出现「教训 / 说教」", () => {
    const p = buildProfile({ 已知偏好与禁忌: "别教训我，别说教" });
    const rendered = renderProfileForPrompt(p);
    expect(rendered).toContain("教训");
    expect(rendered).toContain("说教");
  });

  it("禁忌 = 心理咨询师腔时，提醒拦截「我懂你」", () => {
    const p = buildProfile({ 已知偏好与禁忌: "别用心理咨询师腔" });
    const rendered = renderProfileForPrompt(p);
    expect(rendered).toContain("心理咨询师腔");
  });

  it("称呼偏好时，提醒里出现具体称呼", () => {
    const p = buildProfile({ 沟通风格: "叫我老王就行" });
    const rendered = renderProfileForPrompt(p);
    expect(rendered).toContain("老王");
  });

  it("无任何偏好时，不出现「行为提醒」段", () => {
    const p = buildProfile({});
    const rendered = renderProfileForPrompt(p);
    expect(rendered).not.toContain("行为提醒");
  });
});

describe("v0.9: 端到端流程 — 用户反馈被自动捕获并应用", () => {
  it("用户说'别回太长' → profile 更新 → 行为提醒里出现短回复", async () => {
    const dataDir = join(tmpDir, "e2e-short-pref");
    const provider = makeJsonProvider(
      JSON.stringify({
        沟通风格: "用户偏好短回复（≤3句）（用户说'你回得太长了'）",
      }),
    );

    // Step 1: 模拟用户反馈
    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "你回得太长了" },
    ]);

    expect(result.updated).toBe(true);

    // Step 2: 加载更新后的 profile，渲染成 prompt
    const profile = await loadProfile(dataDir);
    const rendered = renderProfileForPrompt(profile);

    // Step 3: 验证行为提醒里出现「短回复」
    expect(rendered).toContain("短回复");
    expect(rendered).toContain("行为提醒");
  });

  it("用户说'别提我前任' → 已知偏好与禁忌 自动更新", async () => {
    const dataDir = join(tmpDir, "e2e-taboo");
    const provider = makeJsonProvider(
      JSON.stringify({
        已知偏好与禁忌: ["别提用户的前任（用户说'别提我前任'）"],
      }),
    );

    const result = await maybeUpdateProfile(dataDir, provider, [
      { role: "user", content: "别提我前任" },
    ]);

    expect(result.updated).toBe(true);
    const profile = await loadProfile(dataDir);
    expect(profile.sections["已知偏好与禁忌"]).toContain("前任");
  });
});