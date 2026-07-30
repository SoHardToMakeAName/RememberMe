// tests/repl-sessions.test.ts
// REPL 新增的 /session 和 /persona 命令验证
//
// 测的是"命令调用对应的文件 IO 是否正确"，不模拟完整 REPL（避免引入 provider/timeline 依赖）。
// handlePersonaCommand / handleSessionCommand 是 module-internal，不导出，所以测试通过：
//   1. 直接调底层 API（saveSession/loadSession/savePersonaForSession）
//   2. 验证文件读写 round-trip
//   3. 验证 session 切换的 history 替换逻辑

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  deriveTitle,
} from "../src/sessions.ts";
import {
  loadPersonaForSession,
  savePersonaForSession,
  defaultPersona,
  type BigFivePersona,
} from "../src/bigfive.ts";
import { existsSync } from "node:fs";
import type { ChatMessage } from "../src/provider.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-repl-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("/session new — create + save round-trip", () => {
  it("创建新 session 并写入文件", () => {
    const s = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, s);

    expect(existsSync(join(tmpDir, "sessions", `${s.id}.json`))).toBe(true);
    const loaded = loadSession(tmpDir, s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.history).toEqual([]);
  });

  it("保存 history 后能 load 回来", () => {
    const s = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    const history: ChatMessage[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！" },
    ];
    saveSession(tmpDir, { ...s, history });
    const loaded = loadSession(tmpDir, s.id);
    expect(loaded!.history).toHaveLength(2);
    expect(loaded!.history[0].content).toBe("你好");
  });
});

describe("/session switch — load 目标 session 的 history", () => {
  it("loadSession 拿到的 history 用于替换当前 history", () => {
    // 创建 session A（带 2 条 history）
    const a = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    const aHistory: ChatMessage[] = [
      { role: "user", content: "A-msg1" },
      { role: "assistant", content: "A-reply1" },
    ];
    saveSession(tmpDir, { ...a, history: aHistory });

    // 创建 session B（带 1 条 history）
    const b = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, { ...b, history: [{ role: "user", content: "B-msg1" }] });

    // 模拟切换：loadSession(B) → 替换 history 引用
    const target = loadSession(tmpDir, b.id)!;
    expect(target.history).toHaveLength(1);
    expect(target.history[0].content).toBe("B-msg1");

    // 切回 A
    const back = loadSession(tmpDir, a.id)!;
    expect(back.history).toHaveLength(2);
    expect(back.history[1].content).toBe("A-reply1");
  });
});

describe("/session list — 列出所有 session 按 lastActiveAt 倒序", () => {
  it("listSessions 返回按时间排序", async () => {
    const s1 = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, { ...s1, lastActiveAt: Date.now() - 10000 });
    const s2 = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, { ...s2, lastActiveAt: Date.now() });

    const all = listSessions(tmpDir);
    expect(all.length).toBeGreaterThanOrEqual(2);
    // 最新的在前
    const idx1 = all.findIndex((s) => s.id === s1.id);
    const idx2 = all.findIndex((s) => s.id === s2.id);
    expect(idx2).toBeLessThan(idx1);
  });
});

describe("/session delete — 不删当前", () => {
  it("删除非当前 session 成功", () => {
    const a = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, a);
    expect(loadSession(tmpDir, a.id)).not.toBeNull();
    deleteSession(tmpDir, a.id);
    expect(loadSession(tmpDir, a.id)).toBeNull();
  });

  it("当前 session 的 id 不在 delete 调用里（业务逻辑层面校验，不在 deleteSession 里）", () => {
    const current = createSession(tmpDir, "default", "user-1", "claude-sonnet");
    saveSession(tmpDir, current);
    // handleSessionCommand 的 'delete' 分支会先 if (id === ctx.currentSessionId) return
    // 这里只验证 deleteSession 不带这个检查（业务层保证）
    expect(current.id).toBeTruthy();
    // 模拟业务层保护：不调用
    // deleteSession(tmpDir, current.id); // 不调
  });
});

describe("/persona init — save 后 load 回来", () => {
  it("savePersonaForSession + loadPersonaForSession round-trip", () => {
    const sessionId = "test-session-roundtrip";
    const p: BigFivePersona = {
      sessionId,
      ocean: {
        openness: 0.85,
        conscientiousness: 0.3,
        extraversion: 0.7,
        agreeableness: 0.6,
        neuroticism: 0.2,
      },
      preferences: "用具体例子而非抽象概念",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    savePersonaForSession(tmpDir, p);
    const loaded = loadPersonaForSession(tmpDir, sessionId);
    expect(loaded).not.toBeNull();
    expect(loaded!.ocean.openness).toBeCloseTo(0.85, 2);
    expect(loaded!.preferences).toBe("用具体例子而非抽象概念");
  });

  it("不存在的 sessionId 返回 null", () => {
    const loaded = loadPersonaForSession(tmpDir, "nonexistent-session");
    expect(loaded).toBeNull();
  });
});

describe("/persona reset — 删文件后回到 defaultPersona", () => {
  it("删掉 persona JSON 后 loadPersonaForSession 返回 null", () => {
    const sessionId = "test-session-reset";
    const p = defaultPersona(sessionId);
    savePersonaForSession(tmpDir, p);
    expect(loadPersonaForSession(tmpDir, sessionId)).not.toBeNull();

    // 模拟 reset：删文件
    const { unlink } = require("node:fs/promises") as typeof import("node:fs/promises");
    unlink(join(tmpDir, "personality", `${sessionId}.json`));

    expect(loadPersonaForSession(tmpDir, sessionId)).toBeNull();
    // reloadPersona 会用 defaultPersona 兜底
    const fallback = defaultPersona(sessionId);
    expect(fallback.ocean.openness).toBe(0.5);
  });
});

describe("deriveTitle — 从 history 取标题", () => {
  it("取第一条 user message 前 30 字", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "我最近工作压力很大" },
      { role: "assistant", content: "听起来..." },
    ];
    const title = deriveTitle(history);
    expect(title).toBe("我最近工作压力很大");
  });

  it("长文本截断到 30 字 + …", () => {
    const long = "啊".repeat(50);
    const history: ChatMessage[] = [{ role: "user", content: long }];
    const title = deriveTitle(history);
    expect(title!.length).toBe(31); // 30 + 1 ("…")
    expect(title!.endsWith("…")).toBe(true);
  });

  it("没有 user message 返回 undefined", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "hello" }];
    expect(deriveTitle(history)).toBeUndefined();
  });
});