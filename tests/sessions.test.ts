// tests/sessions.test.ts
// v0.14.0: Session 管理模块单元测试
//
// 测 src/sessions.ts 核心功能：
// - 目录创建 / CRUD
// - 按 persona 找最近 session
// - history 截断
// - deriveTitle

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSessionsDir,
  listSessions,
  loadSession,
  saveSession,
  deleteSession,
  findLatestSessionForPersona,
  createSession,
  deriveTitle,
} from "../src/sessions.ts";
import type { ChatMessage } from "../src/provider.ts";

let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "ec-sess-"));
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ensureSessionsDir", () => {
  it("调用不抛异常", () => {
    ensureSessionsDir(tmpDir);
    ensureSessionsDir(tmpDir);
    expect(true).toBe(true);
  });
});

describe("createSession + saveSession", () => {
  it("生成 id 且字段正确", () => {
    const s = createSession(tmpDir, "test.md", "测试人格", "claude-sonnet");
    expect(s.id).toMatch(/^s-\d+-[a-z0-9]+$/);
    expect(s.persona).toBe("test.md");
    expect(s.personaName).toBe("测试人格");
    expect(s.model).toBe("claude-sonnet");
    expect(s.history).toEqual([]);
    expect(s.createdAt).toBeGreaterThan(0);
    expect(s.lastActiveAt).toBeGreaterThan(0);
  });

  it("saveSession 后 loadSession 能读回", () => {
    const s = createSession(tmpDir, "p1.md", "P1", "m1");
    saveSession(tmpDir, s);
    const loaded = loadSession(tmpDir, s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(s.id);
    expect(loaded!.persona).toBe("p1.md");
    expect(loaded!.personaName).toBe("P1");
  });
});

describe("loadSession + deleteSession", () => {
  it("loadSession 不存在的 id 返回 null", () => {
    expect(loadSession(tmpDir, "nonexistent-id")).toBeNull();
  });

  it("deleteSession 后 loadSession 返回 null", () => {
    const s = createSession(tmpDir, "del.md", "Del", "m");
    saveSession(tmpDir, s);
    expect(loadSession(tmpDir, s.id)).not.toBeNull();
    deleteSession(tmpDir, s.id);
    expect(loadSession(tmpDir, s.id)).toBeNull();
  });
});

describe("listSessions", () => {
  it("按 lastActiveAt 倒序排列", async () => {
    const a = createSession(tmpDir, "list.md", "L", "m");
    saveSession(tmpDir, a);
    await new Promise((r) => setTimeout(r, 10));
    const b = createSession(tmpDir, "list.md", "L", "m");
    saveSession(tmpDir, b);
    const all = listSessions(tmpDir).filter((s) => s.persona === "list.md");
    expect(all.length).toBe(2);
    expect(all[0].id).toBe(b.id);
    expect(all[1].id).toBe(a.id);
  });
});

describe("findLatestSessionForPersona", () => {
  it("按 persona 过滤返回最近一个", async () => {
    const x = createSession(tmpDir, "x.md", "X", "m");
    saveSession(tmpDir, x);
    await new Promise((r) => setTimeout(r, 10));
    const y = createSession(tmpDir, "y.md", "Y", "m");
    saveSession(tmpDir, y);
    const r1 = findLatestSessionForPersona(tmpDir, "x.md");
    expect(r1).not.toBeNull();
    expect(r1!.persona).toBe("x.md");
    const r2 = findLatestSessionForPersona(tmpDir, "y.md");
    expect(r2).not.toBeNull();
    expect(r2!.persona).toBe("y.md");
  });

  it("没找到返回 null", () => {
    expect(findLatestSessionForPersona(tmpDir, "nonexistent.md")).toBeNull();
  });
});

describe("deriveTitle", () => {
  it("取第一条 user message 全文（<=30 字）", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "今天心情不太好" },
      { role: "assistant", content: "怎么了？" },
    ];
    expect(deriveTitle(history)).toBe("今天心情不太好");
  });

  it("超过 30 字截断并加省略号", () => {
    const long = "今天心情不太好，因为工作上遇到了很多困难，老板也不理解我，我想找人倾诉一下";
    const history: ChatMessage[] = [{ role: "user", content: long }];
    const t = deriveTitle(history);
    expect(t).toBeDefined();
    expect(t!.length).toBe(31);
    expect(t!.endsWith("…")).toBe(true);
  });

  it("没有 user message 返回 undefined", () => {
    const history: ChatMessage[] = [{ role: "assistant", content: "你好" }];
    expect(deriveTitle(history)).toBeUndefined();
  });
});

describe("history truncation", () => {
  it("history 超过 MAX_HISTORY*2 时被截断到 MAX_HISTORY", () => {
    const s = createSession(tmpDir, "trunc.md", "T", "m");
    const big: ChatMessage[] = [];
    for (let i = 0; i < 110; i++) {
      big.push({ role: i % 2 === 0 ? "user" : "assistant", content: "m" + i });
    }
    s.history = big;
    saveSession(tmpDir, s);
    const loaded = loadSession(tmpDir, s.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.history.length).toBeLessThanOrEqual(50);
  });
});
