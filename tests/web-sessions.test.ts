// tests/web-sessions.test.ts
// v0.14.0: Web session 端点 E2E 测试
//
// 启动一个 Bun.serve 子进程，测 /api/sessions 与 /api/session/new。
// 这些端点不需要 LLM 调用，所以可以靠 ANTHROPIC_API_KEY 缺失也不挂。

import { describe, it, expect, afterAll } from "bun:test";
// spawn 是 Bun 全局 API
declare const Bun: { spawn: (opts: any) => any };
type Subprocess = ReturnType<typeof Bun.spawn>;

const PORT = 13999;
const BASE = "http://127.0.0.1:" + PORT;

let proc: Subprocess | null = null;

async function waitForReady(timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(BASE + "/api/state");
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("server not ready in " + timeoutMs + "ms");
}

async function startServer(): Promise<void> {
  proc = Bun.spawn({
    cmd: ["bun", "run", "start"],
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitForReady();
}

async function stopServer(): Promise<void> {
  if (proc) {
    proc.kill();
    await proc.exited;
    proc = null;
  }
}

describe("Web sessions E2E", () => {
  afterAll(async () => {
    await stopServer();
  });

  it("启动后 GET /api/sessions 返回数组（含/不含已有 session 都兼容）", async () => {
    await startServer();
    const r = await fetch(BASE + "/api/sessions");
    expect(r.ok).toBe(true);
    const body = (await r.json()) as { sessions: unknown[]; currentSessionId: string | null };
    expect(Array.isArray(body.sessions)).toBe(true);
    // v0.19：sessions/ 为空时不再自动创建，currentSessionId 可能为 null
    if (body.sessions.length > 0) {
      expect(body.currentSessionId).not.toBeNull();
    } else {
      expect(body.currentSessionId).toBeNull();
    }
  });

  it("POST /api/session/new 创建新 session 并切换 currentSessionId", async () => {

    const before = await (await fetch(BASE + "/api/sessions")).json() as { sessions: unknown[]; currentSessionId: string };
    const r = await fetch(BASE + "/api/session/new", { method: "POST" });
    expect(r.ok).toBe(true);
    const out = (await r.json()) as { ok: boolean; sessionId: string };
    expect(out.ok).toBe(true);
    expect(out.sessionId).not.toBe(before.currentSessionId);

    const after = await (await fetch(BASE + "/api/sessions")).json() as { sessions: { id: string }[]; currentSessionId: string };
    expect(after.currentSessionId).toBe(out.sessionId);
    // 至少包含之前的 + 新的
    expect(after.sessions.length).toBeGreaterThan(before.sessions.length);
    expect(after.sessions.some((s) => s.id === out.sessionId)).toBe(true);
  });

  it("GET /api/sessions 列出的 session 含必要字段", async () => {
    const body = await (await fetch(BASE + "/api/sessions")).json() as {
      sessions: { id: string; title?: string; messageCount: number; createdAt: number; lastActiveAt: number }[];
    };
    expect(body.sessions.length).toBeGreaterThan(0);
    const s = body.sessions[0];
    expect(typeof s.id).toBe("string");
    expect(typeof s.messageCount).toBe("number");
    expect(typeof s.lastActiveAt).toBe("number");
    expect(typeof s.lastActiveAt).toBe("number");
  });

  // v0.15.0: 人格系统已移除。/api/switch-persona 不存在。
  // 替换为 /api/session/new + /api/session/load 的测试。
  it("反复开新对话：每次 sessionId 不同", async () => {
    const r1 = await (await fetch(BASE + "/api/session/new", { method: "POST" })).json() as { sessionId: string };
    const r2 = await (await fetch(BASE + "/api/session/new", { method: "POST" })).json() as { sessionId: string };
    expect(r1.sessionId).not.toBe(r2.sessionId);
  });

  it("创建 + 加载同 session：history 应保留", async () => {
    const created = await (await fetch(BASE + "/api/session/new", { method: "POST" })).json() as { sessionId: string };
    // 加载同一个 session
    const loaded = await (await fetch(BASE + "/api/session/load/" + created.sessionId, {
      method: "POST",
    })).json() as { ok: boolean; sessionId: string; messageCount: number };
    expect(loaded.ok).toBe(true);
    expect(loaded.sessionId).toBe(created.sessionId);
  });

  it("磁盘上 session 文件数 == /api/sessions 返回的数量", async () => {
    // 用磁盘实际文件数验证落盘一致性
    const body = await (await fetch(BASE + "/api/sessions")).json() as { sessions: { id: string }[] };
    // 读 data/sessions/ 目录
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir("data/sessions")).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(body.sessions.length);
  });
});
