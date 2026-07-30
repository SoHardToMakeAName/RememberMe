// tests/context-file.test.ts
// v0.8: 纯 Markdown 格式的 profile / personality 文件解析器测试 + 互换性。

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import {
  parseContextFile,
  serializeContextFile,
  PROFILE_SECTIONS,
  getProfilePath,
  type ContextFileMeta,
  type ContextFile,
} from "../src/context-file.ts";
import { loadProfile, saveProfile } from "../src/profile.ts";
// v0.15.0: 不再加载人格文件
// import { loadPersonality } from "../src/personality.ts";
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-ctx-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// =====================================================================
// parseContextFile —— H1 + 元数据列表
// =====================================================================

describe("parseContextFile 元数据提取", () => {
  it("H1 = name", () => {
    const raw = `# 阳光大暖男

## 我是谁

我是小阳。`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.name).toBe("阳光大暖男");
    expect(ctx.body).toContain("## 我是谁");
    expect(ctx.body).toContain("我是小阳。");
  });

  it("- **类型**：personality 映射到 kind", () => {
    const raw = `# 测试

- **类型**：personality

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.kind).toBe("personality");
  });

  it("- **类型**：profile 映射到 kind", () => {
    const raw = `# 测试

- **类型**：profile

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.kind).toBe("profile");
  });

  it("类型用英文 kind 也识别", () => {
    const raw = `# 测试

- **kind**: profile

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.kind).toBe("profile");
  });

  it("版本/作者/描述全部正确映射", () => {
    const raw = `# 测试

- **版本**：1.2.3
- **作者**：alice
- **描述**：这是描述

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.version).toBe("1.2.3");
    expect(ctx.meta.author).toBe("alice");
    expect(ctx.meta.description).toBe("这是描述");
  });

  it("支持中文冒号（：）", () => {
    const raw = `# 测试
- **版本**：1.0
- **作者**：bob

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.version).toBe("1.0");
    expect(ctx.meta.author).toBe("bob");
  });

  it("支持英文冒号（:）", () => {
    const raw = `# 测试
- **version**: 2.0
- **author**: charlie

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.version).toBe("2.0");
    expect(ctx.meta.author).toBe("charlie");
  });

  it("无 H1 → name 为空", () => {
    const raw = `body without title`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.name).toBe("");
  });

  it("无元数据列表 → 用默认值", () => {
    const raw = `# 测试人格

## 内容

body`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.name).toBe("测试人格");
    expect(ctx.meta.version).toBe("0.0.0");
    expect(ctx.meta.author).toBe("unknown");
    expect(ctx.meta.kind).toBe("personality"); // 默认
  });

  it("元数据列表以 ## 标题结束", () => {
    const raw = `# 测试

- **版本**：1.0
- **作者**：alice

## 正文开始

content here`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.version).toBe("1.0");
    expect(ctx.body).toContain("## 正文开始");
    expect(ctx.body).toContain("content here");
  });

  it("元数据列表以非列表行结束", () => {
    const raw = `# 测试

- **版本**：1.0

这是一段普通文字，结束元数据块。

- 这是普通列表项，不算元数据`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.meta.version).toBe("1.0");
    // body 应该包含元数据之后的所有内容
    expect(ctx.body).toContain("这是一段普通文字");
  });

  it("body 中的列表项不被解析为元数据", () => {
    const raw = `# 测试

- **版本**：1.0
- **作者**：alice

## 内容

- 正文中的列表
- 不会变成元数据`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    // 元数据列表只取开头的连续列表
    expect(ctx.meta.version).toBe("1.0");
    expect(ctx.meta.author).toBe("alice");
    // body 包含所有内容
    expect(ctx.body).toContain("## 内容");
    expect(ctx.body).toContain("正文中的列表");
  });
});

// =====================================================================
// parseContextFile —— 6 段结构检测
// =====================================================================

describe("parseContextFile 6 段结构检测", () => {
  it("profile 风格文件 → structuredSections 完整", () => {
    const raw = `# 用户画像

- **类型**：profile

## 1. 基本信息
- 昵称：小阳

## 2. 沟通风格
- 喜欢简短

## 3. 关注议题
（暂无）

## 4. 已知偏好与禁忌
（暂无）

## 5. 长期情绪基线
（暂无）

## 6. 近期变化
（暂无）`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.structuredSections).toBeDefined();
    expect(ctx.structuredSections!["基本信息"]).toContain("小阳");
    expect(ctx.structuredSections!["沟通风格"]).toContain("简短");
    expect(ctx.structuredSections!["关注议题"]).toContain("暂无");
  });

  it("支持 ## 段名（不带数字编号）", () => {
    const raw = `# 测试

- **类型**：profile

## 基本信息
- 昵称：阳光`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.structuredSections?.["基本信息"]).toContain("阳光");
  });

  it("personality 风格 → structuredSections undefined", () => {
    const raw = `# 小阳

- **类型**：personality

# 我是谁

我是小阳。

## 怎么说话

- 简短`;
    const ctx = parseContextFile(raw, "/tmp/x.md");
    expect(ctx.structuredSections).toBeUndefined();
  });
});

// =====================================================================
// serializeContextFile 纯 Markdown 格式
// =====================================================================

describe("serializeContextFile 纯 Markdown 格式", () => {
  it("基本字段全部输出", () => {
    const meta: ContextFileMeta = {
      name: "测试",
      version: "1.0",
      description: "描述",
      author: "alice",
      kind: "personality",
    };
    const out = serializeContextFile(meta, "body content");
    expect(out).toContain("# 测试");
    expect(out).toContain("- **类型**：personality");
    expect(out).toContain("- **版本**：1.0");
    expect(out).toContain("- **作者**：alice");
    expect(out).toContain("- **描述**：描述");
    expect(out).toContain("body content");
    // 关键：没有 --- YAML 分隔符
    expect(out).not.toContain("---");
  });

  it("默认 version=0.0.0 跳过", () => {
    const meta: ContextFileMeta = {
      name: "测试",
      version: "0.0.0",
      description: "",
      author: "unknown",
      kind: "personality",
    };
    const out = serializeContextFile(meta, "body");
    expect(out).not.toContain("**版本**");
    expect(out).not.toContain("**作者**");
  });

  it("空 body 不报错", () => {
    const meta: ContextFileMeta = {
      name: "x",
      version: "1.0",
      description: "",
      author: "a",
      kind: "profile",
    };
    const out = serializeContextFile(meta, "");
    expect(out).toContain("# x");
  });
});

// =====================================================================
// Round-trip
// =====================================================================

describe("serializeContextFile round-trip", () => {
  it("基本元数据 + body 往返一致", () => {
    const meta: ContextFileMeta = {
      name: "测试",
      version: "1.0",
      description: "...",
      author: "me",
      kind: "profile",
    };
    const body = "## 1. 基本信息\n- x\n\n## 2. 沟通风格\n- y";
    const out = serializeContextFile(meta, body);
    const parsed = parseContextFile(out, "/tmp/x.md");
    expect(parsed.meta.name).toBe(meta.name);
    expect(parsed.meta.version).toBe(meta.version);
    expect(parsed.meta.kind).toBe(meta.kind);
    expect(parsed.body).toContain(body);
    // 6 段结构应被检测出来
    expect(parsed.structuredSections?.["基本信息"]).toBe("- x");
    expect(parsed.structuredSections?.["沟通风格"]).toBe("- y");
  });
});

// =====================================================================
// 互换性
// =====================================================================

describe("互换性：personality 格式当 profile 用", () => {
  it("loadProfile 能加载纯 Markdown personality 格式", async () => {
    const dataDir = join(tmpDir, "swap-2-profile");
    await mkdir(join(dataDir, "profile"), { recursive: true });

    const personalityStyle = `# 阳光大暖男

- **类型**：personality
- **版本**：1.0.0
- **作者**：test
- **描述**：测试用

## 我是谁

我是小阳。

## 怎么说话

- 简短
- 温暖`;

    const profilePath = getProfilePath(dataDir);
    await writeFile(profilePath, personalityStyle, "utf-8");

    const profile = await loadProfile(dataDir);
    expect(profile.initialized).toBe(false);
    expect(profile.meta.name).toBe("阳光大暖男");
    expect(profile.meta.version).toBe("1.0.0");
    expect(profile.meta.kind).toBe("personality");
    // 因为不是 6 段结构，sections 全空（优雅降级）
    expect(profile.sections["基本信息"]).toBe("");
    expect(profile.sections["沟通风格"]).toBe("");
  });
});

describe("互换性：实际项目文件验证", () => {
  it("data/profile/PROFILE.example.md 能加载为 profile", async () => {
    const root = join(import.meta.dir, "..");
    const dataDir = join(root, "data");
    // PROFILE.example.md 实际位置是 data/profile/，需要先建一个临时 dataDir
    const tmpDataDir = join(tmpDir, "data-prod-shape");
    await mkdir(join(tmpDataDir, "profile"), { recursive: true });
    // 复制 .example 到 PROFILE.md 路径
    const { readFile, copyFile } = await import("node:fs/promises");
    const exampleContent = await readFile(
      join(dataDir, "profile", "PROFILE.example.md"),
      "utf-8",
    );
    await writeFile(getProfilePath(tmpDataDir), exampleContent, "utf-8");

    const profile = await loadProfile(tmpDataDir);
    expect(profile.initialized).toBe(false);
    expect(profile.meta.name).toBe("用户画像（Profile）— 占位示例");
    expect(profile.meta.kind).toBe("profile");
    // 6 段应被识别
    expect(profile.sections["基本信息"]).toContain("小阳");
  });
});

// =====================================================================
// PROFILE_SECTIONS 常量
// =====================================================================

describe("PROFILE_SECTIONS", () => {
  it("含 6 段且顺序固定", () => {
    expect(PROFILE_SECTIONS).toEqual([
      "基本信息",
      "沟通风格",
      "关注议题",
      "已知偏好与禁忌",
      "长期情绪基线",
      "近期变化",
    ]);
  });
});

// =====================================================================
// getProfilePath
// =====================================================================

describe("getProfilePath", () => {
  it("返回 <dataDir>/profile/PROFILE.md", () => {
    expect(getProfilePath(join(tmpDir, "data"))).toBe(
      join(tmpDir, "data", "profile", "PROFILE.md"),
    );
  });
});