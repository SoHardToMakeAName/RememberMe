// src/web.ts — EmoTalk 网页版后端（Bun.serve）
// 移除硬编码人格，改为反馈学习驱动的动态人设
// 启动: bun run start (默认) → 此文件
// REPL:  bun run repl  → src/index.ts

import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import type { ChatMessage, ModelProvider, StreamChunk, StreamOptions } from "./provider.ts";
import type { Profile } from "./profile.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { createSession, saveSession, loadSession, deleteSession, listSessions, deriveTitle, type SessionMeta } from "./sessions.ts";
import { detectEmotion, recallMemories, type EmotionDetection } from "./classify.ts";
import { maybeCompact, DEFAULT_COMPACT_CONFIG, type CompactConfig } from "./compact.ts";
import { scanMemory, readMemoryIndex } from "./memory.ts";
import { maybeUpdateProfile, loadProfile } from "./profile.ts";
import { loadLearner, saveLearner, type LearnerState } from "./persona-learner.ts";
import { loadPersonaForSession, savePersonaForSession, defaultPersona, type BigFivePersona } from "./bigfive.ts";
import { initPersonaFromDescription } from "./persona-init.ts";
import { Timeline } from "./timeline.ts";
import { loadProjectEnv, pickDefaultModel } from "./bootstrap.ts";
import { createProvider } from "./provider.ts";

const ROOT_DIR = process.cwd();
const WEB_DIR = join(ROOT_DIR, "web");
const DATA_DIR = join(ROOT_DIR, "data");
const PROFILE_DIR = join(DATA_DIR, "profile");
const MEMORY_DIR = join(DATA_DIR, "memory");
const TIMELINE_DIR = join(DATA_DIR, "timeline");
const SETTINGS_PATH = join(ROOT_DIR, "settings.json");
const DEFAULT_USER_ID = "default";
/** 默认人设文件（personality/ 目录下） */
const DEFAULT_PERSONA_FILE = "default.md";

interface AppState {
  provider: ModelProvider;
  userId: string;
  /** 大五人设（按 sessionId 加载） */
  persona: BigFivePersona | null;
  personaLearner: LearnerState;
  profile: Profile | null;
  currentSessionId: string | null;
  /** 上一轮 AI 回复（用于本轮的反馈检测） */
  previousAssistantReply: string;
  history: ChatMessage[];
  timeline: Timeline;
  compactConfig: CompactConfig;
}

async function bootstrap(): Promise<AppState> {
  loadProjectEnv({ settingsPath: SETTINGS_PATH });

  await mkdir(PROFILE_DIR, { recursive: true });
  await mkdir(MEMORY_DIR, { recursive: true });
  await mkdir(TIMELINE_DIR, { recursive: true });

  const model = pickDefaultModel();
  const provider = createProvider({ kind: "anthropic", model });
  const userId = DEFAULT_USER_ID;

  // 反馈学习器（v0.17.0 人设 body 改为按 sessionId 加载）
  const personaLearner = loadLearner(DATA_DIR, userId);

  let profile: Profile | null = null;
  const profilePath = join(PROFILE_DIR, "PROFILE.md");
  if (existsSync(profilePath)) {
    profile = await loadProfile(DATA_DIR);
  }

  const timeline = new Timeline(TIMELINE_DIR);
  await timeline.ensure();

  // 加载最近一次 session（v0.15.0 不再按 persona 过滤）
  const allSessions = listSessions(DATA_DIR);
  let firstSession = allSessions.length > 0 ? allSessions[0] : null;
  if (!firstSession) {
    // 用一个虚拟 persona 名（兼容旧 schema）
    firstSession = createSession(DATA_DIR, "default", userId, provider.model);
    saveSession(DATA_DIR, firstSession);
  }

  return {
    provider,
    userId,
    persona: loadPersonaForSession(DATA_DIR, firstSession.id),
    personaLearner,
    profile,
    currentSessionId: firstSession.id,
    previousAssistantReply: "",
    history: firstSession.history,
    timeline,
    compactConfig: DEFAULT_COMPACT_CONFIG,
  };
}

async function runTurn(
  state: AppState,
  userMessage: string,
  onChunk: (chunk: StreamChunk) => void,
  signal: AbortSignal,
): Promise<{
  responseText: string;
  emotion: EmotionDetection | null;
  profileUpdated: boolean;
}> {
  // side-query: 情绪 + 记忆（并行）
  const memCandidates = await scanMemory(MEMORY_DIR);
  const memoryIndex = await readMemoryIndex(MEMORY_DIR);
  const emotion = await detectEmotion(state.provider, userMessage);
  const recalled = await recallMemories(state.provider, userMessage, memCandidates, 5);

  // compact
  const { history: compactedHistory, result: compactResult } = await maybeCompact(
    state.history,
    state.provider,
    state.compactConfig,
  );

  // 重新加载 learner（v0.15.0: 反馈循环可能在上轮更新了它）
  state.personaLearner = loadLearner(DATA_DIR, state.userId);

  // system prompt（v0.18.0: OCEAN 大五人设 + 反馈学习）
  // 按 sessionId 加载人设（如不存在则用默认 OCEAN）
  state.persona = loadPersonaForSession(DATA_DIR, state.currentSessionId!);
  const systemPrompt = await buildSystemPrompt({
    persona: state.persona,
    personaLearner: state.personaLearner,
    memoryIndex,
    profile: state.profile,
    emotion,
    recalledMemories: recalled,
    timeline: state.timeline,
  });

  const messages: ChatMessage[] = [
    ...compactedHistory,
    { role: "user", content: userMessage },
  ];

  let fullText = "";
  const streamOpts: StreamOptions = {
    model: state.provider.model,
    params: {
      system: systemPrompt,
      messages,
      maxTokens: 3000,
      temperature: 0.8,
      presencePenalty: 0.4,
      signal,
    },
  };

  for await (const chunk of state.provider.stream(streamOpts)) {
    fullText += chunk.delta;
    onChunk(chunk);
    if (chunk.done) break;
  }

  // 写时间线
  if (emotion) {
    await state.timeline.append({
      emotion: emotion.emotion,
      intensity: emotion.intensity,
      trigger: emotion.trigger,
      userExcerpt: userMessage.slice(0, 200),
      myResponseExcerpt: fullText.slice(0, 200),
    });
  }

  // 后台 profile 更新
  let profileUpdated = false;
  if (state.profile) {
    try {
      const recent = [
        ...messages.slice(-6),
        { role: "assistant" as const, content: fullText.slice(0, 500) },
      ];
      const result = await maybeUpdateProfile(DATA_DIR, state.provider, recent);
      if (result.updated) profileUpdated = true;
    } catch {
      // ignore
    }
  }

  // 反馈学习循环（fire-and-forget，不阻塞用户）
  // 用"上一轮 AI 回复"和"本轮用户消息"作为信号
  const prevReply = state.previousAssistantReply;
  if (prevReply && prevReply.trim().length > 0) {
    const { detectFeedback } = await import("./feedback-detector.ts");
    const { loadLearner, applyFeedback, saveLearner } = await import("./persona-learner.ts");
    detectFeedback(state.provider, prevReply, userMessage, signal)
      .then((result) => {
        try {
          const state2 = loadLearner(DATA_DIR, state.userId);
          const updated = applyFeedback(state2, result.signal, result.insights, result.example);
          saveLearner(DATA_DIR, updated);
          if (process.env.EC_DEBUG) {
            console.log(`[feedback] signal=${result.signal} insights=${JSON.stringify(result.insights)} reason="${result.reason}"`);
          }
        } catch {
          // 静默失败
        }
      })
      .catch(() => {});
  }

  return { responseText: fullText, emotion, profileUpdated };
}

function serveStatic(path: string, contentType: string): Response {
  try {
    const content = readFileSync(path);
    return new Response(content, {
      headers: {
        "Content-Type": contentType,
        // 不让浏览器缓存 JS / CSS / HTML，否则改了 app.js 用户还得 Ctrl+Shift+R
        "Cache-Control": "no-store, must-revalidate",
        "Pragma": "no-cache",
        "Expires": "0",
      },
    });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// 1x1 透明 PNG，让浏览器停止刷 favicon 404
const FAVICON_PNG = new Uint8Array([
  0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00,0x00,0x00,0x0d,0x49,0x48,0x44,0x52,
  0x00,0x00,0x00,0x01,0x00,0x00,0x00,0x01,0x08,0x06,0x00,0x00,0x00,0x1f,0x15,0xc4,
  0x89,0x00,0x00,0x00,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0x00,0x01,0x00,0x00,
  0x05,0x00,0x01,0x0d,0x0a,0x2d,0xb4,0x00,0x00,0x00,0x00,0x49,0x45,0x4e,0x44,0xae,
  0x42,0x60,0x82,
]);

async function main() {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const state = await bootstrap();

  // 剥掉 LLM 偶尔漏出来的 markdown（**加粗** *斜体* `代码` # 标题）
  // 真人不这么聊天，必须在后端兜底
  const stripMarkdown = (text: string): string =>
    text
      .replace(/\*\*([^*]+)\*\*/g, "$1")   // **加粗** → 加粗
      .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1") // *斜体* → 斜体
      .replace(/`([^`]+)`/g, "$1")           // `代码` → 代码
      .replace(/^#{1,6}\s+/gm, "")          // # 标题 → 空
      .replace(/^[-*]\s+/gm, "");           // - 列表 / * 列表 → 空

  // SSE 编码辅助：自动把 event 名塞进 data.type，前端只 parse data 即可
  const sse = (event: string, data: Record<string, unknown>) =>
    `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;

  const server = Bun.serve({
    port,
    // LLM 流式回复经常超过 10s，Bun 默认 idleTimeout=10s 会强断
    // 拉满到 255s（max）
    idleTimeout: 255,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // 静态文件
      if (req.method === "GET") {
        if (path === "/" || path === "/index.html") {
          return serveStatic(join(WEB_DIR, "index.html"), "text/html; charset=utf-8");
        }
        if (path === "/style.css") {
          return serveStatic(join(WEB_DIR, "style.css"), "text/css; charset=utf-8");
        }
        if (path === "/app.js") {
          return serveStatic(join(WEB_DIR, "app.js"), "application/javascript; charset=utf-8");
        }
        if (path === "/favicon.ico") {
          return new Response(FAVICON_PNG, {
            headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" },
          });
        }
        if (path === "/api/state") {
          return new Response(JSON.stringify({
            model: state.provider.model,
            personaLoaded: state.persona !== null,
            currentSessionId: state.currentSessionId,
            learnerTotalFeedback: state.personaLearner.signalCounts.positive +
                                   state.personaLearner.signalCounts.negative +
                                   state.personaLearner.signalCounts.neutral,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (path === "/health") {
          return new Response(JSON.stringify({
            status: "ok",
            learnerTotalFeedback: state.personaLearner.signalCounts.positive +
                                   state.personaLearner.signalCounts.negative +
                                   state.personaLearner.signalCounts.neutral,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (path === "/api/sessions") {
          const sessions = listSessions(DATA_DIR);
          return new Response(JSON.stringify({
            sessions: sessions.map((sess) => ({
              id: sess.id,
              title: sess.title,
              messageCount: sess.history.length,
              createdAt: sess.createdAt,
              lastActiveAt: sess.lastActiveAt,
            })),
            currentSessionId: state.currentSessionId,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (path === "/api/messages") {
          return new Response(JSON.stringify({
            messages: state.history,
            sessionId: state.currentSessionId,
          }), { headers: { "Content-Type": "application/json" } });
        }
        return new Response("Not Found", { status: 404 });
      }

      // API: 发送消息（流式 SSE）
      if (req.method === "POST" && path === "/api/send") {
        let body: { message?: string } = {};
        try {
          body = await req.json();
        } catch {
          return new Response("Invalid JSON", { status: 400 });
        }
        if (!body.message || !body.message.trim()) {
          return new Response("Empty message", { status: 400 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            const ac = new AbortController();
            // 客户端断开 → 取消
            req.signal.addEventListener("abort", () => ac.abort());

            const send = (event: string, data: unknown) => {
              try {
                const payload = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
                controller.enqueue(encoder.encode(sse(event, payload)));
              } catch {
                // 连接已断
              }
            };

            send("status", { message: "思考中…" });

            try {
              const result = await runTurn(
                state,
                body.message!.trim(),
                (chunk) => {
                  if (chunk.delta) {
                    send("text", { delta: stripMarkdown(chunk.delta) });
                  }
                },
                ac.signal,
              );

              // 追加到历史（用最终版本，不是 draft）
              state.history.push({ role: "user", content: body.message!.trim() });
              state.history.push({ role: "assistant", content: stripMarkdown(result.responseText) });
              // 记下本轮 AI 回复，下一轮用户消息来时作为反馈检测的输入
              state.previousAssistantReply = stripMarkdown(result.responseText);
              // 持久化到 session
              if (state.currentSessionId) {
                const sess = loadSession(DATA_DIR, state.currentSessionId);
                if (sess) {
                  sess.history = state.history;
                  sess.lastActiveAt = Date.now();
                  sess.model = state.provider.model;
                  // 首条 user message 自动生成标题（v0.14.0）
                  if (!sess.title) {
                    sess.title = deriveTitle(sess.history) ?? "新对话";
                  }
                  saveSession(DATA_DIR, sess);
                }
              }

              // 状态事件
              if (result.emotion) {
                const e = result.emotion;
                send("status", {
                  message: `${e.emotion} (${(e.intensity * 100).toFixed(0)}%)`,
                });
                send("meta", {
                  delta: `情绪: ${e.emotion} ${(e.intensity * 100).toFixed(0)}%${
                    e.trigger ? ` | 触发: ${e.trigger}` : ""
                  }\n`,
                });
              }
              if (result.profileUpdated) {
                send("meta", { delta: "profile 已更新\n" });
              }

              send("done", { ok: true });
            } catch (err) {
              send("error", { message: (err as Error).message });
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        });
      }
      // API: 清空 → 归档当前 + 开新（同人格）
      if (req.method === "POST" && path === "/api/clear") {
        if (state.currentSessionId) {
          const cur = loadSession(DATA_DIR, state.currentSessionId);
          if (cur) {
            cur.history = state.history;
            cur.lastActiveAt = Date.now() - 1;
            cur.title = cur.title ?? (state.history[0]?.content.slice(0, 30) || "新对话");
            saveSession(DATA_DIR, cur);
          }
        }
        const blank = createSession(
          DATA_DIR,
          "default",
          state.userId,
          state.provider.model,
        );
        saveSession(DATA_DIR, blank);
        state.currentSessionId = blank.id;
        state.history = [];
        return new Response(JSON.stringify({ ok: true, sessionId: blank.id }), {
          headers: { "Content-Type": "application/json" },
        });
      }


      // API: 加载指定 session（v0.15.0: 不再切 persona）
      if (req.method === "POST" && path.startsWith("/api/session/load/")) {
        const id = path.slice("/api/session/load/".length);
        // 先保存当前
        if (state.currentSessionId) {
          const cur = loadSession(DATA_DIR, state.currentSessionId);
          if (cur) {
            cur.history = state.history;
            cur.lastActiveAt = Date.now();
            saveSession(DATA_DIR, cur);
          }
        }
        const sess = loadSession(DATA_DIR, id);
        if (!sess) {
          return new Response(JSON.stringify({ error: "session not found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        state.currentSessionId = sess.id;
        state.history = sess.history;
        return new Response(JSON.stringify({
          ok: true, sessionId: sess.id,
          messageCount: sess.history.length,
        }), { headers: { "Content-Type": "application/json" } });
      }

      // API: 删除指定 session（v0.14.0）
      // DELETE /api/session/{id}
      // 如果删的是当前 session：自动开新（同人格）并切换
      if (req.method === "DELETE" && path.startsWith("/api/session/")) {
        const id = path.slice("/api/session/".length);
        if (!id) {
          return new Response(JSON.stringify({ error: "session id required" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        const sess = loadSession(DATA_DIR, id);
        if (!sess) {
          return new Response(JSON.stringify({ error: "session not found" }), {
            status: 404, headers: { "Content-Type": "application/json" },
          });
        }
        const wasCurrent = id === state.currentSessionId;
        deleteSession(DATA_DIR, id);

        if (wasCurrent) {
          // 删的是当前 → 开新空 session
          const blank = createSession(
            DATA_DIR,
            "default",
            state.userId,
            state.provider.model,
          );
          saveSession(DATA_DIR, blank);
          state.currentSessionId = blank.id;
          state.history = [];
          return new Response(JSON.stringify({
            ok: true,
            deletedId: id,
            newSessionId: blank.id,
            switchedToNew: true,
          }), { headers: { "Content-Type": "application/json" } });
        }

        return new Response(JSON.stringify({
          ok: true,
          deletedId: id,
          switchedToNew: false,
        }), { headers: { "Content-Type": "application/json" } });
      }

      // API: 新开空白对话（v0.18.0: 顺便检查人设是否需要 init）
      if (req.method === "POST" && path === "/api/session/new") {
        if (state.currentSessionId) {
          const cur = loadSession(DATA_DIR, state.currentSessionId);
          if (cur) {
            cur.history = state.history;
            // 归档时 lastActiveAt = now - 1，确保 blank 一定更新
            cur.lastActiveAt = Date.now() - 1;
            saveSession(DATA_DIR, cur);
          }
        }
        const blank = createSession(
          DATA_DIR,
          "default",
          state.userId,
          state.provider.model,
        );
        saveSession(DATA_DIR, blank);
        state.currentSessionId = blank.id;
        state.history = [];
        // 检查新人设是否需要 init
        const existingPersona = loadPersonaForSession(DATA_DIR, blank.id);
        return new Response(JSON.stringify({
          ok: true,
          sessionId: blank.id,
          needsInit: existingPersona === null,
          persona: existingPersona,
        }), { headers: { "Content-Type": "application/json" } });
      }

      // API: 为某会话 init 人设（v0.18.0: 大五人格）
      // POST /api/session/{id}/persona/init
      // body: { description: string }
      if (req.method === "POST" && path.match(/^\/api\/session\/[^/]+\/persona\/init$/)) {
        const id = path.split("/")[3];
        let body: { description?: string };
        try {
          body = await req.json();
        } catch {
          return new Response(JSON.stringify({ error: "Invalid JSON" }), {
            status: 400, headers: { "Content-Type": "application/json" },
          });
        }
        if (!body.description || !body.description.trim()) {
          // 用户不填描述 → 用默认 OCEAN（0.5）
          const def = defaultPersona(id);
          savePersonaForSession(DATA_DIR, def);
          return new Response(JSON.stringify({ ok: true, persona: def }), {
            headers: { "Content-Type": "application/json" },
          });
        }
        try {
          const persona = await initPersonaFromDescription(
            state.provider,
            { description: body.description.trim(), sessionId: id },
            DATA_DIR,
          );
          return new Response(JSON.stringify({ ok: true, persona }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (err) {
          return new Response(JSON.stringify({ error: (err as Error).message }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      // API: 切换模型
      if (req.method === "POST" && path === "/api/switch-model") {
        try {
          const body = (await req.json()) as { model?: string };
          if (!body.model) {
            return new Response(JSON.stringify({ error: "model required" }), {
              status: 400, headers: { "Content-Type": "application/json" },
            });
          }
          state.provider = createProvider({ kind: "anthropic", model: body.model });
          return new Response(JSON.stringify({ ok: true, model: body.model }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e) {
          return new Response(JSON.stringify({ error: (e as Error).message }), {
            status: 500, headers: { "Content-Type": "application/json" },
          });
        }
      }

      return new Response("Method Not Allowed", { status: 405 });
    },
  });

  console.log(`\n  EmoTalk 网页版`);
  console.log(`  → http://localhost:${server.port}\n`);
  const total = state.personaLearner.signalCounts.positive +
                state.personaLearner.signalCounts.negative +
                state.personaLearner.signalCounts.neutral;
  console.log(`  人设: ${total === 0 ? "冷启动（空白起点）" : `已学习 ${total} 轮反馈`}`);
  console.log(`  模型: ${state.provider.model}\n`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
