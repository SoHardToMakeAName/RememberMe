// tests/bootstrap.test.ts
// bootstrap 加载器测试。

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { loadProjectEnv, pickDefaultModel } from "../src/bootstrap.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("loadProjectEnv", () => {
  let tmpDir: string;

  // 测试前先清掉可能污染的 env 变量
  const TEST_KEYS = [
    "TEST_VAR_FOO",
    "TEST_VAR_BAZ",
    "TEST_VAR_PREEXISTING",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_MODEL",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ec-boot-"));
    savedEnv = {};
    for (const k of TEST_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    for (const k of TEST_KEYS) {
      delete process.env[k];
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    }
  });

  it("不存在的 settings.json 静默忽略", () => {
    const result = loadProjectEnv({
      settingsPath: join(tmpDir, "nope.json"),
      verbose: false,
    });
    expect(result.loaded).toBe(false);
    expect(result.loadedKeys).toEqual([]);
  });

  it("加载有效 settings.json 中的 env", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        env: {
          TEST_VAR_FOO: "bar",
          TEST_VAR_BAZ: "qux",
        },
      }),
    );

    const result = loadProjectEnv({ settingsPath: path, verbose: false });
    expect(result.loaded).toBe(true);
    expect(result.loadedKeys).toContain("TEST_VAR_FOO");
    expect(result.loadedKeys).toContain("TEST_VAR_BAZ");
    expect(process.env.TEST_VAR_FOO).toBe("bar");
    expect(process.env.TEST_VAR_BAZ).toBe("qux");

    // 清理
    delete process.env.TEST_VAR_FOO;
    delete process.env.TEST_VAR_BAZ;
  });

  it("ANTHROPIC_AUTH_TOKEN 映射到 ANTHROPIC_API_KEY", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "sk-test-xxx",
          ANTHROPIC_BASE_URL: "https://api.example.com",
          ANTHROPIC_MODEL: "test-model",
        },
      }),
    );

    const result = loadProjectEnv({ settingsPath: path, verbose: false });
    expect(result.loadedKeys).toContain("ANTHROPIC_AUTH_TOKEN→ANTHROPIC_API_KEY");
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-test-xxx");
    expect(process.env.ANTHROPIC_BASE_URL).toBe("https://api.example.com");
    expect(process.env.ANTHROPIC_MODEL).toBe("test-model");

    // 清理
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_MODEL;
  });

  it("已设置的 env 变量不被覆盖", () => {
    process.env.TEST_VAR_PREEXISTING = "outer-value";

    const path = join(tmpDir, "settings.json");
    writeFileSync(
      path,
      JSON.stringify({
        env: {
          TEST_VAR_PREEXISTING: "inner-value",
        },
      }),
    );

    loadProjectEnv({ settingsPath: path, verbose: false });
    // v0.16.0: settings.json 是项目配置最高优先级——覆盖 shell env
    expect(process.env.TEST_VAR_PREEXISTING).toBe("inner-value");

    delete process.env.TEST_VAR_PREEXISTING;
  });

  it("损坏的 JSON 静默忽略", () => {
    const path = join(tmpDir, "settings.json");
    writeFileSync(path, "{not valid json");

    const result = loadProjectEnv({ settingsPath: path, verbose: false });
    expect(result.loaded).toBe(false);
  });
});

describe("pickDefaultModel", () => {
  // 在每个测试前后清空所有相关 env（避免外部污染）
  const ENV_KEYS = [
    "ANTHROPIC_DEFAULT_OPUS_MODEL",
    "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    "ANTHROPIC_MODEL",
  ];
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      delete process.env[k];
      if (savedEnv[k] !== undefined) process.env[k] = savedEnv[k];
    }
  });

  it("按优先级选择模型", () => {
    // v0.16.0: ANTHROPIC_MODEL 优先（settings.json 显式设置）
    process.env.ANTHROPIC_MODEL = "from-ANTHROPIC_MODEL";
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "from-sonnet";
    process.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "from-opus";
    expect(pickDefaultModel()).toBe("from-ANTHROPIC_MODEL");

    // 没有 ANTHROPIC_MODEL 时才用 DEFAULT_*
    delete process.env.ANTHROPIC_MODEL;
    expect(pickDefaultModel()).toBe("from-opus");

    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    expect(pickDefaultModel()).toBe("from-sonnet");
  });

  it("默认 fallback", () => {
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_OPUS_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
    delete process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
    expect(pickDefaultModel()).toBe("claude-sonnet-4-5-20250929");
  });
});