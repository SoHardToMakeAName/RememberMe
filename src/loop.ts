// src/loop.ts
// 对话主循环：用户输入 → side-query（并行） → 组装 prompt → 流式输出 → 落盘
//
// 关键设计：
// 1. 情绪识别和记忆召回**并行**（不阻塞主对话）
// 2. 响应流式输出（用户能看到第一字）
// 3. 每轮对话结束后，情绪识别结果 + 用户原话 → 写入 timeline
// 4. 进入主模型前自动 compact（）
// 5. 不在本轮写 memory（避免太频繁）；记忆写入由 REPL 控制命令触发或定时任务
// 进入主模型前加载 profile + 注入 system prompt
// 对话结束后隐式触发 profile 融合更新
// 受控触发记忆自动抽取（每 N 轮 OR 情绪高强度）

import type { ModelProvider, ChatMessage, StreamChunk } from "./provider.ts";
import type { LearnerState } from "./persona-learner.ts";
import { loadLearner, saveLearner, applyFeedback, emptyState } from "./persona-learner.ts";
import { detectFeedback } from "./feedback-detector.ts";
import {
 scanMemory,
 readMemoryIndex,
 type MemoryFile,
 type MemoryType,
} from "./memory.ts";
import type { Timeline } from "./timeline.ts";
import { detectEmotion, recallMemories, type EmotionDetection } from "./classify.ts";
import { buildSystemPrompt } from "./prompt.ts";
import {
 maybeCompact,
 estimateHistoryTokens,
 DEFAULT_COMPACT_CONFIG,
 type CompactConfig,
} from "./compact.ts";
import {
 loadProfile,
 maybeUpdateProfile,
 renderProfileForPrompt,
 type Profile,
} from "./profile.ts";
import {
 maybeAutoExtract,
 type AutoExtractConfig,
} from "./memory-extract.ts";

export type LoopDeps = {
 provider: ModelProvider;
 memoryDir: string;
 timeline: Timeline;
 /** compact 配置（可选，默认） */
 compactConfig?: CompactConfig;
 /** data 根目录（用于加载 profile + learner）。不传则跳过 profile */
 dataDir?: string;
 /** 用户 ID（用于按用户隔离 learner state） */
 userId?: string;
 /** 大五人设（按 sessionId 加载，OCEAN）。不传则不显示人设 */
 persona?: import("./bigfive.ts").BigFivePersona | null;
 /** 上一轮 AI 回复（用于本轮的反馈检测）。不传则不检测 */
 previousAssistantReply?: string;
 /** 记忆自动抽取回调（每轮都会传；内部决定是否触发） */
 onMemoryExtracted?: (results: Array<{
 subtype: MemoryType;
 filename: string;
 action: "new" | "merged" | "skipped";
 }>) => void;
 /** 强制本轮执行一次抽取（让 /memory suggest 不依赖 turn 计数） */
 forceExtract?: boolean;
 /** 当前 turn 序号（用于节流） */
 turnIndex?: number;
 /** AbortSignal（用于取消流式输出 / 后台任务） */
 signal?: AbortSignal;
};

/** 自动抽取的触发条件 */
const EXTRACT_INTERVAL_TURNS = 5;
const EXTRACT_INTENSITY_THRESHOLD = 0.7;

export type LoopResult = {
 /** 完整回复文本 */
 responseText: string;
 /** 本轮情绪识别结果 */
 emotion: EmotionDetection | null;
 /** 本轮召回的记忆文件 */
 recalledMemories: MemoryFile[];
 /** 本轮是否触发了 compact */
 compacted: boolean;
 /** 如果 compact 了，节省的估算 token 数 */
 savedTokens?: number;
 /**
 * 实际用于本轮对话的 history（compact 后的版本）。
 * REPL 必须用这个替换原 history，而不是 append user/assistant 到原 history。
 * 否则 compact 等于白做。
 */
 effectiveHistory: ChatMessage[];
 /** 本轮加载的 profile（首次为 null） */
 profile: Profile | null;
 /** 本轮是否触发了 profile 更新（异步结果，触发后下一轮会读到） */
 profileUpdated: boolean;
 /** 本轮是否触发了记忆自动抽取（同步返回，REPL 可立即显示提示） */
 extractedNow: boolean;
};

/**
 * 单轮对话：用户输入 → 流式回复。
 *
 * 流程：
 * 1. 自动 compact（如历史过长）
 * 2. 加载 profile（）
 * 3. 并行 side-query（情绪识别 + 记忆扫描 + 时间线读取）
 * 4. 组装 system prompt（含 profile 层）
 * 5. 流式调用主模型
 * 6. 把本轮情绪写入时间线
 * 7. 隐式触发 profile 更新（异步、不阻塞本轮响应）
 */
export async function runTurn(
 deps: LoopDeps,
 userInput: string,
 history: ChatMessage[],
 onChunk: (chunk: StreamChunk) => void,
 signal?: AbortSignal): Promise<LoopResult> {
 const compactConfig = deps.compactConfig ?? DEFAULT_COMPACT_CONFIG;

 // 2. 加载 profile（）—— 失败容错
 let profile: Profile | null = null;
 if (deps.dataDir) {
 try {
 profile = await loadProfile(deps.dataDir);
 } catch (e) {
 console.error(`[loop] profile 加载失败:`, (e as Error).message);
 profile = null;
 }
 }

 // 1. 进入主模型前自动 compact（如历史过长）
 // : 把 profile 的简洁渲染传入，让 compact 摘要与长期画像一致
 const profileSummaryForCompact = profile
 ? renderProfileForPrompt(profile).slice(0, 600)
 : undefined;
 const { history: compactedHistory, result: compactResult } = await maybeCompact(
 history,
 deps.provider,
 compactConfig,
 profileSummaryForCompact);

 // 3. 并行 side-query：情绪识别 + 记忆扫描 + 时间线读取
 // : 不再调模式分类（classifier 已被移除以避免 LLM 锁死在 5 个模式里）
 const candidatesPromise = scanMemory(deps.memoryDir);
 const emotionPromise = detectEmotion(deps.provider, userInput);
 const memoryIndexPromise = readMemoryIndex(deps.memoryDir);

 const candidates = await candidatesPromise;
 const memoryIndex = await memoryIndexPromise;

 // 记忆召回依赖候选列表，必须在它完成后串行
 const emotion = await emotionPromise;
 const recalled = await recallMemories(deps.provider, userInput, candidates, 5);

 // 4. 组装 system prompt（: 动态 persona + profile + memory + emotion + timeline）
 const personaLearner: LearnerState = deps.dataDir
 ? loadLearner(deps.dataDir, deps.userId ?? "default")
 : emptyState(deps.userId ?? "default");

 const systemPrompt = await buildSystemPrompt({
 persona: deps.persona ?? null,
 personaLearner,
 memoryIndex,
 profile,
 emotion,
 recalledMemories: recalled,
 timeline: deps.timeline,
 });

 // 5. 流式调用主模型
 const messages: ChatMessage[] = [
 ...compactedHistory,
 { role: "user", content: userInput },
 ];

 let fullText = "";
 for await (const chunk of deps.provider.stream({
 model: deps.provider.model,
 params: {
 system: systemPrompt,
 messages,
 maxTokens: 3000,
 temperature: 0.8,
 signal,
 },
 })) {
 fullText += chunk.delta;
 onChunk(chunk);
 if (chunk.done) break;
 }

 // 6. 把本轮情绪写入时间线
 if (emotion) {
 await deps.timeline.append({
 emotion: emotion.emotion,
 intensity: emotion.intensity,
 trigger: emotion.trigger,
 userExcerpt: userInput.slice(0, 200),
 myResponseExcerpt: fullText.slice(0, 200),
 relatedMemory: recalled[0]?.filename,
 });
 }

 // 隐式触发 profile 更新（异步、不阻塞本轮响应）
 // fire-and-forget：等本轮对话返回后再在后台跑 side-query
 let profileUpdated = false;
 if (deps.dataDir && compactedHistory.length > 0) {
 const recentForProfile = [
 ...messages.slice(-6),
 { role: "assistant" as const, content: fullText.slice(0, 500) },
 ];
 maybeUpdateProfile(deps.dataDir, deps.provider, recentForProfile, {
   userId: deps.userId ?? "default",
   memoryDir: deps.memoryDir,
   timeline: deps.timeline,
 })
 .then((result) => {
 if (result.updated && result.changes && result.changes.length > 0) {
 const time = new Date().toISOString().slice(11, 19);
 console.log(`[profile] 已更新（${time}）新增：`);
 for (const c of result.changes) {
 const truncated = c.value.length > 60
 ? c.value.slice(0, 60) + "…"
 : c.value;
 console.log(` · [${c.section}] ${truncated}`);
 }
 }
 })
 .catch(() => {
 // maybeUpdateProfile 内部已 catch，这里兜底
 });
 }

 // 受控触发记忆自动抽取
 // 触发条件：
 // a) forceExtract === true（/memory suggest 强制触发）
 // b) emotion.intensity ≥ 0.7（情绪强烈，可能有重要事实）
 // c) turnIndex % 5 === 0（每 5 轮兜底）
 const turn = deps.turnIndex ?? 0;
 const hitInterval = turn > 0 && turn % EXTRACT_INTERVAL_TURNS === 0;
 const hitIntensity =
 !!emotion && emotion.intensity >= EXTRACT_INTENSITY_THRESHOLD;
 const shouldExtract = deps.forceExtract || hitInterval || hitIntensity;
 let extractedNow = false;

 if (shouldExtract && compactedHistory.length > 0) {
 extractedNow = true;
 const recentForExtract = [
 ...messages.slice(-8),
 { role: "assistant" as const, content: fullText.slice(0, 500) },
 ];
 const autoExtractConfig: AutoExtractConfig = { minConfidence: 0.7 };
 // fire-and-forget：不 await
 maybeAutoExtract(
 deps.memoryDir,
 deps.provider,
 recentForExtract,
 autoExtractConfig)
 .then((results) => {
 if (results.length > 0 && deps.onMemoryExtracted) {
 const summary = results.map((r) => ({
 subtype: r.candidate.type,
 filename:
 r.action === "new"
 ? r.candidate.name
 : r.existingFile?.filename ?? r.candidate.name,
 action: r.action,
 }));
 deps.onMemoryExtracted!(summary);
 }
 })
 .catch(() => {
 // maybeAutoExtract 内部已 catch
 });
 }

 // 嵌入式主动问题（"对了..."）
 // 在主回复末尾**自然地**插入一个轻提问——不抢白、不单独发消息
 let embeddedProbe: string | undefined;
 if (process.env.EC_DEBUG) {
 console.log(`[loop] dataDir=${!!deps.dataDir} emotion=${!!emotion} userTurns=${compactedHistory.filter((m) => m.role === "user").length + 1}`);
 }
 if (deps.dataDir && emotion) {
 try {
 const { maybeEmbedProactive, DEFAULT_EMBEDDED_PROACTIVE_CONFIG } = await import(
 "./embedded-proactive.ts"
 );
 const { loadProactiveState } = await import("./proactive.ts");

 const proactiveState = await loadProactiveState(deps.dataDir);
 const idleMs = Date.now() - (proactiveState.lastUserActivityAt || 0);
 const replyAlreadyHasProbe =
 fullText.includes("对了") ||
 fullText.includes("话说") ||
 fullText.includes("顺便问");

 const decision = await maybeEmbedProactive(
 deps.provider,
 DEFAULT_EMBEDDED_PROACTIVE_CONFIG,
 {
 lastUserActivityAt: proactiveState.lastUserActivityAt,
 currentUserTurns: compactedHistory.filter((m) => m.role === "user").length + 1,
 lastEmbeddedAt: 0, // TODO: 持久化"上次嵌入时间"
 profile,
 memorySummary: recalled.map((r) => r.description).join("; "),
 recentUserMessage: userInput,
 currentReply: fullText,
 replyAlreadyHasProbe,
 },
 { signal: deps.signal });
 void idleMs; // currently unused, kept for future refinement

 if (decision.shouldEmbed && decision.question) {
 embeddedProbe = decision.question;
 if (process.env.EC_DEBUG) {
 console.log(`[embedded-proactive] 触发: ${decision.question}`);
 }
 // 不更新 lastUserActivityAt — 用户离开多久是「从 REPL 启动算的」
 // 而不是「从上一次回复算的」。这样 turn 2/3 也能判断用户"已经离开 X 小时"
 // （因为 first message 来自 5h 前）
 } else if (process.env.EC_DEBUG) {
 console.log(`[embedded-proactive] 跳过: ${decision.reason}`);
 }
 } catch (err) {
 // 嵌入式主动问题失败不影响主流程
 if (process.env.EC_DEBUG) {
 console.log(`[embedded-proactive] 异常: ${(err as Error).message}`);
 }
 }
 }

 // 把"对了"问题附在主回复末尾
 let finalText = fullText;
 if (embeddedProbe) {
 finalText = fullText + "\n\n" + embeddedProbe;
 // 输出嵌入的探针
 onChunk({ delta: "\n\n" + embeddedProbe, done: false });
 }

 // 二阶段改写（v4.0）： 已删除。反馈学习循环替代。

 // : 反馈学习循环（fire-and-forget，不阻塞用户响应）
 // 把"上一轮 AI 回复"和"本轮用户消息"喂给反馈检测器
 // 更新 learner state 到磁盘
 // 用户无感知
 if (deps.dataDir && deps.previousAssistantReply && deps.previousAssistantReply.trim().length > 0) {
 const prevReply = deps.previousAssistantReply;
 const userMsg = userInput;
 const dataDir = deps.dataDir;
 const userId = deps.userId ?? "default";
 // fire-and-forget：不 await
 detectFeedback(deps.provider, prevReply, userMsg, deps.signal)
 .then((result) => {
 try {
 const state = loadLearner(dataDir, userId);
 const updated = applyFeedback(
 state,
 result.signal,
 result.insights,
 result.example);
 saveLearner(dataDir, updated);
 if (process.env.EC_DEBUG) {
 console.log(`[feedback] signal=${result.signal} insights=${JSON.stringify(result.insights)} reason="${result.reason}"`);
 }
 } catch (err) {
 // 静默失败，不影响主流程
 }
 })
 .catch(() => {
 // 检测失败不阻塞
 });
 }

 // : 不再调模式分类（classifier 已被移除以避免 LLM 锁死在 5 个模式里）
 // : 模式分类连同 response-mode.ts 一起被移除

 return {
 responseText: finalText,
 emotion,
 recalledMemories: recalled,
 compacted: compactResult !== null,
 savedTokens: compactResult?.savedTokens,
 effectiveHistory: compactedHistory,
 profile,
 profileUpdated,
 extractedNow,
 };
}

/**
 * 强制执行一次 compact（供 /compact 命令手动触发）。
 * 返回新的 history 和节省的 token 数。
 */
export async function forceCompact(
 provider: ModelProvider,
 history: ChatMessage[],
 config: CompactConfig = DEFAULT_COMPACT_CONFIG,
 /** 可选的用户画像摘要 */
 profileSummary?: string) {
 return maybeCompact(history, provider, config, profileSummary);
}