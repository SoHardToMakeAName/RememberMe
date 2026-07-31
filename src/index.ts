// src/index.ts
// REPL 入口（CLI 单会话模式 + 反馈学习）
//
// 命令：
//   /memory save <type> <name> <description>  - 保存一条记忆
//   /memory list                               - 列出所有记忆
//   /memory read <filename>                    - 读记忆详情
//   /timeline                                  - 看情绪轨迹
//   /timeline stats                            - 看情绪统计
//   /learner                                   - 看人设学习器状态
//   /learner reset                              - 重置学习器（清空反馈）
//   /stats                                     - 会话统计
//   /clear                                     - 清空会话历史
//   /help                                      - 帮助
//   /quit                                      - 退出

import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLearner, type LearnerState } from "./persona-learner.ts";
import {
  defaultPersona,
  loadPersonaForSession,
  savePersonaForSession,
  oceanHint,
  type BigFivePersona,
  type OCEAN,
} from "./bigfive.ts";
import { initPersonaFromDescription } from "./persona-init.ts";
import { loadProjectEnv, pickDefaultModel } from "./bootstrap.ts";
import { createProvider, type ModelProvider, type ChatMessage } from "./provider.ts";
import { Timeline, EMOTION_LABEL, EMOTION_EMOJI } from "./timeline.ts";
import { runTurn, forceCompact } from "./loop.ts";
import {
  scanMemory,
  readMemoryFile,
  writeMemoryFile,
  appendIndexEntry,
  MEMORY_TYPES,
  MEMORY_TYPE_LABEL,
  type MemoryType,
} from "./memory.ts";
import {
  createSession,
  loadSession,
  saveSession,
  listSessions,
  deleteSession,
  deriveTitle,
  type SessionMeta,
} from "./sessions.ts";
import {
  DEFAULT_COMPACT_CONFIG,
  estimateHistoryTokens,
  shouldCompact,
  type CompactConfig,
} from "./compact.ts";
import {
  loadProfile,
  renderProfileForPrompt,
  maybeUpdateProfile,
  type Profile,
} from "./profile.ts";
import {
  runReflection,
  listReflections,
  readReflection,
  loadReflectionState,
  shouldSuggestReflection,
  DEFAULT_REFLECTION_CONFIG,
} from "./reflection.ts";
import {
  loadProactiveState,
  saveProactiveState,
  shouldTriggerProactive,
  recordProactiveSent,
  recordUserActivity,
  prepareProactiveMessage,
  DEFAULT_PROACTIVE_CONFIG,
  type ProactiveConfig,
  type ProactiveState,
} from "./proactive.ts";
import { color, parseJsonLoose } from "./utils.ts";

// =====================================================================
// 路径解析
// =====================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, "..");

const DATA_DIR = join(ROOT_DIR, "data");
const MEMORY_DIR = join(DATA_DIR, "memory");
const TIMELINE_DIR = join(DATA_DIR, "timeline");
const PROFILE_DIR = join(DATA_DIR, "profile");

// =====================================================================
// 主函数
// =====================================================================

async function main() {
  console.log(color.cyan("🌅 EmoTalk\n"));

  // 0. 从项目根目录的 ./settings.json 加载 env
  // （不存在则忽略；用户/容器已设置的 env 变量优先）
  loadProjectEnv({ settingsPath: join(ROOT_DIR, "settings.json") });

  // 1. REPL 多 session 模式（和 web.ts 一致）
  // 反馈学习器
  const USER_ID = "default";
  // 加载最近一次 session：优先选有真实对话的（跳过空 session 残留）
  const allSessions = listSessions(DATA_DIR);
  const nonEmpty = allSessions.find((s) => s.history.length > 0);
  const loadTarget = nonEmpty ?? allSessions[0] ?? null;
  let currentSessionId: string;
  let history: ChatMessage[];
  if (loadTarget) {
    currentSessionId = loadTarget.id;
    history = loadTarget.history;
  } else {
    // 完全无 session（首次启动）：REPL 单会话模式创建空 session 作默认起点
    const blank = createSession(DATA_DIR, "default", USER_ID, pickDefaultModel());
    saveSession(DATA_DIR, blank);
    currentSessionId = blank.id;
    history = blank.history;
  }
  // 按 sessionId 加载人设（不存在则默认 OCEAN 0.5）
  let persona: BigFivePersona =
    loadPersonaForSession(DATA_DIR, currentSessionId) ?? defaultPersona(currentSessionId);
  const hasPersonaFile = loadPersonaForSession(DATA_DIR, currentSessionId) !== null;
  // banner：清晰显示当前 session + 加载状态
  const title = loadTarget?.title;
  const sessionDisplay = title
    ? `${color.bold(currentSessionId.slice(0, 18))} ${color.dim("「" + title + "」")}`
    : color.bold(currentSessionId);
  const historyNote = history.length > 0
    ? color.dim(`（已加载 ${history.length} 条历史对话）`)
    : "";
  const personaNote = !hasPersonaFile
    ? color.dim("（未设置人设，建议 /persona init <描述>）")
    : "";
  console.log(`${color.green("✓")} 当前 session: ${sessionDisplay}`);
  if (historyNote) console.log(`  ${historyNote}`);
  if (personaNote) console.log(`  ${personaNote}`);
  let personaLearner = loadLearner(DATA_DIR, USER_ID);
  const totalFeedback = personaLearner.signalCounts.positive + personaLearner.signalCounts.negative + personaLearner.signalCounts.neutral;
  if (totalFeedback === 0) {
    console.log(`${color.green("✓")} 反馈学习：${color.dim("冷启动（空白起点）")}`);
  } else {
    console.log(`${color.green("✓")} 人设学习器：已学习 ${color.bold(String(totalFeedback))} 轮反馈`);
  }

  // 2. 加载 provider
  let provider: ModelProvider;
  try {
    // 优先使用 settings.json 里的模型配置
    const model = pickDefaultModel();
    if (
      model.startsWith("claude") ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.ANTHROPIC_BASE_URL
    ) {
      provider = createProvider({
        kind: "anthropic",
        apiKey: process.env.ANTHROPIC_API_KEY,
        model,
      });
    } else {
      provider = createProvider();
    }
  } catch (e) {
    console.error(color.red(`❌ ${(e as Error).message}\n`));
    console.error(color.dim("请在 ~/.claude/settings.json 里设置 ANTHROPIC_API_KEY 或 ANTHROPIC_AUTH_TOKEN，或设置环境变量。"));
    process.exit(1);
  }
  console.log(
    `${color.green("✓")} 模型：${color.bold(provider.name)} / ${provider.model}`,
  );
  if (process.env.ANTHROPIC_BASE_URL) {
    console.log(color.dim(`  baseURL: ${process.env.ANTHROPIC_BASE_URL}`));
  }
  console.log();

  // 3. 初始化 timeline
  const timeline = new Timeline(TIMELINE_DIR);
  await timeline.ensure();
  console.log(`${color.green("✓")} 情绪时间线已就绪`);

  // 3.5 初始化 profile（首次使用自动创建默认模板）
  let profile: Profile;
  try {
    profile = await loadProfile(DATA_DIR, {
      userId: USER_ID,
      memoryDir: MEMORY_DIR,
      timeline,
    });
    if (profile.initialized) {
      console.log(`${color.green("✓")} 用户画像已初始化（首次使用，已创建默认模板）`);
    } else {
      console.log(`${color.green("✓")} 用户画像已加载（含数据源同步）`);
    }
  } catch (e) {
    console.error(color.yellow(`⚠️ profile 加载失败，将跳过: ${(e as Error).message}`));
    profile = null as unknown as Profile; // 用 sentinel，loop 里会处理 null
  }

  // 4. compact 配置（可用环境变量覆盖）
  // EC_COMPACT_TRIGGER_AT: 触发压缩的消息条数（默认 20 = 10 轮）
  // EC_COMPACT_RECENT_KEPT: 压缩时保留最近多少条（默认 6 = 3 轮）
  const compactConfig: CompactConfig = {
    triggerAt: parseInt(process.env.EC_COMPACT_TRIGGER_AT ?? "20"),
    recentKept: parseInt(process.env.EC_COMPACT_RECENT_KEPT ?? "6"),
    maxChars: parseInt(process.env.EC_COMPACT_MAX_CHARS ?? "20000"),
    minCompactWorth: 1500,
  };
  console.log(
    `${color.green("✓")} compact 配置：triggerAt=${compactConfig.triggerAt} / recentKept=${compactConfig.recentKept}`,
  );
  console.log();

  // 4. 启动 REPL
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(
    color.dim("提示：直接输入消息开始对话。输入 /help 查看命令。Ctrl+C 退出。\n"),
  );

  let lastAssistantReply = ""; // 用于反馈检测

  // === 输入队列（修复 pipe 模式下 readline 丢输入的 bug）===
  // rl.question 在 async 回调未完成时再次调用，会导致上一行的 listener
  // 没被正确移除，下一行可能丢失。改用 'line' 事件 + 串行处理队列。
  let inputQueue: string[] = [];
  let processing = false;

  const enqueueInput = (line: string) => {
    const text = line.trim();
    if (!text) {
      // 空行直接忽略（不消耗队列 slot）
      drainQueue();
      return;
    }
    inputQueue.push(text);
    drainQueue();
  };

  const drainQueue = () => {
    if (processing) return;
    const next = inputQueue.shift();
    if (!next) return;
    processing = true;
    handleTurn(next).finally(() => {
      processing = false;
      drainQueue();
    });
  };

  // 自动抽取开关与 turn 计数
  // 默认开启（用户改了也没事，可用 /memory auto 关闭，或设 EC_AUTO_EXTRACT=0 显式关）
  let autoExtractEnabled = process.env.EC_AUTO_EXTRACT !== "0";
  let turnIndex = 0;
  // 是否显示每轮的 [情绪: ...] 调试标签（默认开；/quiet 关闭）
  // 情绪/记忆/compact 调试标签——默认关闭。
  // 启用方法：export EC_QUIET=1（与"想看"语义相反，名字保持向后兼容）
  let showEmotionLabels = process.env.EC_QUIET === "1";
  // 对话模式（depth = 深度；playful = 玩伴模式）
  // conversationMode 删除（runTurn 不再读取）
  // let conversationMode: "depth" | "playful" =
  //   process.env.EC_MODE === "playful" ? "playful" : "depth";
  console.log(
    `${color.green("✓")} 记忆自动抽取：${autoExtractEnabled ? color.green("开") : color.dim("关")}（用 /memory auto toggle 切换）`,
  );

  // 反思 state
  const reflectionState = await loadReflectionState(DATA_DIR);
  if (reflectionState.lastReflectionAt > 0) {
    const ago = Date.now() - reflectionState.lastReflectionAt;
    const hoursAgo = (ago / (60 * 60 * 1000)).toFixed(1);
    console.log(
      `${color.dim(`  上次反思：${hoursAgo} 小时前（${reflectionState.lastReflectionDate}）`)}`,
    );
  } else {
    console.log(`${color.dim(`  反思：暂无，建议运行 /reflect 生成第一份`)}`);
  }
  console.log();

  // 重启时检查是否该提示用户跑反思
  // 条件：state 里 lastReflectionAt=0 或距今 ≥ 24h 且当日还没运行过
  const needSuggest = shouldSuggestReflection(
    reflectionState,
    true, // REPL 启动本身就意味着今天会有对话
  );
  if (needSuggest) {
    console.log(
      color.yellow(
        `💡 提示：距上次反思超过 24h。可以运行 ${color.cyan("/reflect")} 生成今日洞察。`,
      ),
    );
    console.log();
  }

  // 主动发起对话（默认关闭）
  // 启用方法：export EC_PROACTIVE=1
  const proactiveConfig: ProactiveConfig = {
    enabled: process.env.EC_PROACTIVE === "1",
    idleThresholdHours: parseFloat(
      process.env.EC_PROACTIVE_IDLE_HOURS ?? "4",
    ),
    maxPerDay: parseInt(process.env.EC_PROACTIVE_MAX_PER_DAY ?? "2"),
    quietHours: {
      start: parseInt(process.env.EC_PROACTIVE_QUIET_START ?? "23"),
      end: parseInt(process.env.EC_PROACTIVE_QUIET_END ?? "8"),
    },
    cooldownMinutes: parseInt(process.env.EC_PROACTIVE_COOLDOWN_MIN ?? "60"),
  };
  // 主动对话不再在 REPL 启动时发（避免"抢白"）
  // 改为在用户正常回复末尾自然注入"对了..."（loop.ts 的 proactiveEmbedded）
  console.log(
    `${color.dim("✓")} 主动对话：${proactiveConfig.enabled ? color.dim("对话中嵌入 '对了'") : color.dim("关")}（仅在空闲 > ${proactiveConfig.idleThresholdHours}h 且有上下文时触发，嵌入主回复末尾）`,
  );

  const proactiveState = await loadProactiveState(DATA_DIR);
  // 旧 state 跨过日期 → 今天还没发
  if (proactiveState.todayDate) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (proactiveState.todayDate !== todayStr) {
      console.log(color.dim(`  主动对话状态：${proactiveState.todayDate} 已发 ${proactiveState.todayCount} 次 → 今天新计数`));
      proactiveState.todayCount = 0;
    }
  }

  // 不在启动时记录用户活动——这样 lastUserActivityAt 保持原值
  // （用于测试"用户离开 X 小时"这种"嵌入对了"机制）
  // 真正的用户活动在用户发消息时由 enqueueInput 路径记录

  console.log();

  // 用 AbortController 支持中断
  let currentAbort: AbortController | null = null;

  // 保存当前 session 的工具函数（/quit、/session switch 时调）
  const saveCurrentSession = () => {
    try {
      const sess = createSession(DATA_DIR, "default", USER_ID, provider.model);
      const meta: SessionMeta = {
        ...sess,
        id: currentSessionId,
        history,
        title: deriveTitle(history),
        lastActiveAt: Date.now(),
      };
      saveSession(DATA_DIR, meta);
    } catch (e) {
      // 静默失败，不影响主流程
    }
  };
  // Ctrl+C / rl close 时也保存
  rl.on("close", () => {
    saveCurrentSession();
    console.log(color.dim("\n👋 再见！"));
    process.exit(0);
  });

  const handleTurn = async (text: string): Promise<void> => {
    // 命令处理
    if (text.startsWith("/")) {
      await handleCommand(text, {
        persona,
        personaLearner,
        timeline,
        provider,
        history,
        compactConfig,
        userId: USER_ID,
        autoExtractEnabled,
        setAutoExtractEnabled: (v: boolean) => {
          autoExtractEnabled = v;
        },
        showEmotionLabels,
        setShowEmotionLabels: (v: boolean) => {
          showEmotionLabels = v;
        },
        currentSessionId,
        setCurrentSession: (id: string, h: ChatMessage[]) => {
          currentSessionId = id;
          history.length = 0;
          history.push(...h);
        },
        setPersona: (p: BigFivePersona) => {
          persona = p;
        },
        reloadPersona: async () => {
          const p = loadPersonaForSession(DATA_DIR, currentSessionId)
            ?? defaultPersona(currentSessionId);
          persona = p;
          return p;
        },
        saveCurrentSession,
      });
      return;
    }

    // 对话
    try {
      currentAbort = new AbortController();
      process.stdout.write(color.green("\n> "));

      turnIndex++;
      // 只在"新会话"时记录活动（gap > 1h）
      // 避免每轮都更新 lastUserActivityAt 导致 idle 永远 = 0
      const SESSION_BREAK_MS = 60 * 60 * 1000;
      if (
        proactiveState.lastUserActivityAt === 0 ||
        Date.now() - proactiveState.lastUserActivityAt > SESSION_BREAK_MS
      ) {
        recordUserActivity(proactiveState);
        // fire-and-forget 保存（不阻塞对话）
        saveProactiveState(DATA_DIR, proactiveState).catch(() => {});
      }
      const result = await runTurn(
        {
          provider,
          memoryDir: MEMORY_DIR,
          timeline,
          compactConfig,
          dataDir: DATA_DIR,
          userId: USER_ID,
          persona,
          previousAssistantReply: lastAssistantReply,
          turnIndex,
          onMemoryExtracted: autoExtractEnabled
            ? (results) => {
                for (const r of results) {
                  if (r.action === "new") {
                    console.log(
                      color.green(
                        `\n  ✍️  [memory] 自动新建：${r.subtype}/${r.filename}`,
                      ),
                    );
                  } else if (r.action === "merged") {
                    console.log(
                      color.cyan(
                        `\n  ✍️  [memory] 自动补充：${r.filename}`,
                      ),
                    );
                  }
                  // skipped 不打印（避免噪声）
                }
              }
            : undefined,
        },
        text,
        history,
        (chunk) => {
          if (chunk.delta) {
            process.stdout.write(chunk.delta);
          }
        },
        currentAbort.signal,
      );

      process.stdout.write("\n");

      // 调试信息（灰色显示情绪和召回的记忆）—— /quiet 可关闭
      if (showEmotionLabels && result.emotion) {
        const e = result.emotion;
        const emoji = EMOTION_EMOJI[e.emotion];
        const label = EMOTION_LABEL[e.emotion];
        const intensity = "▓".repeat(Math.round(e.intensity * 5));
        console.log(
          color.dim(
            `  [情绪: ${emoji} ${label} ${intensity}${e.trigger ? ` | 触发: ${e.trigger}` : ""}]`,
          ),
        );
      }
      if (showEmotionLabels && result.recalledMemories.length > 0) {
        const names = result.recalledMemories
          .map((m) => `${m.subtype}:${m.filename}`)
          .join(", ");
        console.log(color.dim(`  [召回记忆: ${names}]`));
      }
      if (showEmotionLabels && result.compacted) {
        console.log(
          color.dim(
            `  [✂️ compact: 节省约 ${result.savedTokens ?? 0} tokens]`,
          ),
        );
      }

      // 更新历史：必须用 effectiveHistory（compact 后的版本）替换原 history，
      // 否则 REPL 永远只在原始 history 上 append，compact 等于白做。
      const effectiveHistory = [...result.effectiveHistory];
      history.length = 0;
      history.push(...effectiveHistory);
      history.push({ role: "user", content: text });
      history.push({ role: "assistant", content: result.responseText });

      // 记下本轮回复，下一轮作为反馈检测的输入
      lastAssistantReply = result.responseText;

      // 限制历史长度（避免 token 爆炸；MVP 简单实现：保留最近 40 条）
      if (history.length > 40) {
        history.splice(0, history.length - 40);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        console.log(color.dim("\n  [已中断]"));
      } else {
        console.error(color.red(`\n❌ ${(e as Error).message}`));
      }
    } finally {
      currentAbort = null;
    }
  };

  // 监听每一行输入（替换 rl.question 的 race condition）
  rl.on("line", (line) => enqueueInput(line));

  // 启动：先打印 prompt，让队列开始接收
  process.stdout.write(color.cyan("\n你："));
  drainQueue();
}

// =====================================================================
// 命令处理
// =====================================================================

type CommandContext = {
  /** 大五人设（按 sessionId 加载，OCEAN） */
  persona: BigFivePersona;
  /** 人设学习器（取代硬编码 personality） */
  personaLearner: LearnerState;
  timeline: Timeline;
  provider: ModelProvider;
  history: ChatMessage[];
  compactConfig?: CompactConfig;
  /** 用户 ID（用于按用户隔离 learner state） */
  userId: string;
  /** 当前是否开启 auto-extract */
  autoExtractEnabled: boolean;
  /** 切换 auto-extract 开关 */
  setAutoExtractEnabled: (v: boolean) => void;
  /** 是否显示情绪分析标签（默认 true；/quiet 关闭） */
  showEmotionLabels: boolean;
  setShowEmotionLabels: (v: boolean) => void;
  /** 当前 session id（/session switch 时改） */
  currentSessionId: string;
  /** 切换 session：替换 currentSessionId 和 history 引用 */
  setCurrentSession: (id: string, history: ChatMessage[]) => void;
  /** 替换当前人设（/persona init/reset/describe 用） */
  setPersona: (p: BigFivePersona) => void;
  /** 重新从 data/personality/{currentSessionId}.json 读 persona 并替换 */
  reloadPersona: () => Promise<BigFivePersona>;
  /** 显式保存当前 session 到 data/sessions/{id}.json */
  saveCurrentSession: () => void;
};

async function handleCommand(text: string, ctx: CommandContext) {
  const [cmd, ...args] = text.slice(1).split(/\s+/);

  switch (cmd) {
    case "help":
      printHelp();
      break;

    case "memory":
      await handleMemoryCommand(args, ctx);
      break;

    case "timeline":
      await handleTimelineCommand(args, ctx);
      break;

    case "learner":
      await handleLearnerCommand(args, ctx);
      break;

    case "stats":
      await handleStatsCommand(ctx);
      break;

    case "compact":
      await handleCompactCommand(ctx);
      break;

    case "profile":
      await handleProfileCommand(args, ctx);
      break;

    case "reflect":
      await handleReflectCommand(args, ctx);
      break;

    case "reflections":
      await handleReflectionsCommand(args, ctx);
      break;

    case "proactive":
      await handleProactiveCommand(args, ctx);
      break;

    case "clear":
      ctx.history.length = 0;
      console.log(color.dim("✓ 会话历史已清空"));
      break;

    case "quiet":
      handleQuietCommand(ctx);
      break;

    case "persona":
      await handlePersonaCommand(args, ctx);
      break;

    case "session":
      await handleSessionCommand(args, ctx);
      break;

    // /mode 命令删除（runTurn 不再区分 playful/depth）
    // case "mode":
    //   handleModeCommand(args, ctx);
      break;

    case "quit":
    case "exit":
      ctx.saveCurrentSession();
      console.log(color.dim("👋 再见！"));
      process.exit(0);
      break;

    default:
      console.log(color.yellow(`未知命令: /${cmd}。输入 /help 查看可用命令。`));
  }
}

function printHelp() {
  console.log(`
${color.bold("可用命令：")}
  /persona show                              显示当前 OCEAN 人设
  /persona init <一句话描述>                 用 LLM 生成 OCEAN（写入当前 session）
  /persona describe <文本>                   不调 LLM，直接改 preferences
  /persona reset                             重置人设为默认中性
  /session list                              列出所有 session
  /session current                           显示当前 session
  /session new [描述]                        新建 session（可选立刻 init 人设）
  /session switch <id>                       切换到指定 session
  /session save                              手动保存当前 session
  /session delete <id>                       删除 session（不能删当前）
  /memory save <type> <name> <description>   保存一条记忆
  /memory list                              列出所有记忆
  /memory read <filename>                   读记忆详情
  /memory types                             列出所有支持的类型
  /memory auto <on|off|status>            自动抽取开关
  /memory suggest                         手动触发一次抽取
  /timeline                                 看最近情绪轨迹
  /timeline stats                           看情绪统计
  /learner                                  看人设学习器状态
  /learner reset                             重置学习器（清空反馈）
  /profile                                  查看用户画像
  /profile path                             查看画像文件路径
  /profile reset                            重置画像到默认模板
  /reflect                                  生成今日洞察
  /reflect [days]                           用指定回看天数生成
  /reflections list                         列出历史反思
  /reflections read <date>                  读某条反思
  /proactive <status|trigger|reset>         主动对话状态/触发/重置
  /stats                                    会话统计
  /compact                                  手动压缩历史
  /quiet                                    切换 [情绪: ...] 调试标签
  /clear                                    清空会话历史
  /help                                     本帮助
  /quit                                     退出（自动保存当前 session）

${color.bold("支持的记忆类型：")}
${MEMORY_TYPES.map((t) => `  - ${t} (${MEMORY_TYPE_LABEL[t]})`).join("\n")}
`);
}

async function handleMemoryCommand(args: string[], ctx: CommandContext) {
  const [subcmd, ...rest] = args;

  switch (subcmd) {
    case "list": {
      const files = await scanMemory(MEMORY_DIR);
      if (files.length === 0) {
        console.log(color.dim("还没有记忆文件。"));
        return;
      }
      console.log(color.bold(`\n共 ${files.length} 条记忆：\n`));
      // 按 subtype 分组
      const groups: Record<string, typeof files> = {};
      for (const f of files) {
        if (!groups[f.subtype]) groups[f.subtype] = [];
        groups[f.subtype].push(f);
      }
      const order: Array<keyof typeof MEMORY_TYPE_LABEL> = [
        "emotion",
        "event",
        "reference",
      ];
      for (const subtype of order) {
        const items = groups[subtype];
        if (!items || items.length === 0) continue;
        console.log(
          color.bold(`  [${MEMORY_TYPE_LABEL[subtype]}] (${items.length})`),
        );
        for (const f of items) {
          const date = new Date(f.mtimeMs).toISOString().slice(0, 10);
          console.log(
            `    ${color.cyan(f.filename)} ${color.dim(date)}`,
          );
          console.log(`      ${color.dim(f.description)}`);
        }
      }
      return;
    }

    case "read": {
      const filename = rest[0];
      if (!filename) {
        console.log(color.yellow("用法: /memory read <filename>"));
        return;
      }
      const file = await readMemoryFile(MEMORY_DIR, filename);
      if (!file) {
        console.log(color.yellow(`找不到记忆文件: ${filename}`));
        return;
      }
      console.log(color.bold(`\n[${MEMORY_TYPE_LABEL[file.subtype]}] ${file.name}\n`));
      console.log(color.dim(file.description + "\n"));
      console.log(file.body);
      return;
    }

    case "types": {
      console.log(color.bold("\n支持的记忆类型（2 主类 + 1 小类）："));
      console.log(color.dim("  emotion    ——  反复出现的情绪模式（必须有 ≥2 次证据）"));
      console.log(color.dim("  event      ——  对用户有情感意义的生活事件"));
      console.log(color.dim("  reference  ——  外部资源（医生/咨询师/联系方式）"));
      return;
    }

    case "save": {
      const [type, name, ...descParts] = rest;
      const description = descParts.join(" ");
      if (!type || !name || !description) {
        console.log(
          color.yellow(
            "用法: /memory save <type> <name> <description>\n" +
              "示例: /memory save emotion deadline-anxiety 用户提到 deadline 时焦虑升高",
          ),
        );
        return;
      }
      if (!MEMORY_TYPES.includes(type as MemoryType)) {
        console.log(
          color.yellow(
            `未知类型: ${type}。支持: ${MEMORY_TYPES.join(", ")}`,
          ),
        );
        return;
      }
      await saveMemoryInteractive(type as MemoryType, name, description);
      return;
    }

    case "auto": {
      const [subcmd] = rest;
      if (subcmd === "on") {
        ctx.setAutoExtractEnabled(true);
        console.log(color.green("✓ 记忆自动抽取已开启"));
        console.log(color.dim("  触发条件：每 5 轮 或 情绪强度 ≥ 0.7"));
        return;
      }
      if (subcmd === "off") {
        ctx.setAutoExtractEnabled(false);
        console.log(color.dim("✓ 记忆自动抽取已关闭"));
        return;
      }
      if (subcmd === "status" || !subcmd) {
        console.log(
          color.bold(
            `\n记忆自动抽取：${ctx.autoExtractEnabled ? color.green("开") : color.gray("关")}`,
          ),
        );
        console.log(color.dim("  触发条件：每 5 轮兜底 或 情绪强度 ≥ 0.7"));
        console.log(color.dim("  命令：/memory auto on|off|status"));
        return;
      }
      console.log(color.yellow("用法: /memory auto <on|off|status>"));
      return;
    }

    case "suggest": {
      // 手动触发一次记忆抽取
      if (ctx.history.length === 0) {
        console.log(color.yellow("目前没有对话内容可抽取。先聊几句再试。"));
        return;
      }
      console.log(color.bold("\n🔍 正在从最近对话中抽取记忆...\n"));
      const { maybeAutoExtract } = await import("./memory-extract.ts");
      const recent = ctx.history
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content }));
      const results = await maybeAutoExtract(MEMORY_DIR, ctx.provider, recent, {
        minConfidence: 0.5, // 手动模式阈值低一点，发现更多
      });

      if (results.length === 0) {
        console.log(color.dim("  没有识别到新的值得记忆的事实。"));
        console.log(color.dim("  提示：可以明确告诉对方一些事实，便于下次记得。"));
        return;
      }

      console.log(color.green(`✓ 处理了 ${results.length} 条候选：\n`));
      for (const r of results) {
        const subtypeLabel = MEMORY_TYPE_LABEL[r.candidate.type];
        if (r.action === "new") {
          console.log(
            color.green(
              `  ✍️  新建 [${subtypeLabel}] ${r.candidate.type}/${r.candidate.name}.md — ${r.candidate.description}`,
            ),
          );
          if (r.linkedTo && r.linkedTo.length > 0) {
            console.log(
              color.dim(
                `      ↪ 跨印证关联：${r.linkedTo.join(", ")}`,
              ),
            );
          }
        } else if (r.action === "merged") {
          console.log(
            color.cyan(
              `  🔗 合并 [${subtypeLabel}] ${r.candidate.type}/${r.existingFile?.filename} — 补充：${r.candidate.description}`,
            ),
          );
        } else {
          console.log(
            color.dim(
              `  ⏭️  跳过 [${subtypeLabel}] ${r.candidate.type}/${r.candidate.name}（已存在相似内容）`,
            ),
          );
        }
      }
      return;
    }

    default:
      console.log(color.yellow("用法: /memory <list|read|types|save|auto|suggest>"));
  }
}

/**
 * 交互式保存记忆。
 */
async function saveMemoryInteractive(
  type: MemoryType,
  name: string,
  description: string,
) {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(color.bold(`\n保存记忆：${type} / ${name}\n`));
  console.log(color.dim("请输入记忆正文（trigger/manifestation/evidence 等）。多行用 \\n 分隔。"));
  console.log(color.dim("输入空行结束：\n"));

  const body = await new Promise<string>((resolve) => {
    let buffer = "";
    const onLine = (line: string) => {
      if (line.trim() === "") {
        rl.removeListener("line", onLine);
        rl.close();
        resolve(buffer);
      } else {
        buffer += (buffer ? "\n" : "") + line;
      }
    };
    rl.on("line", onLine);
  });

  if (!body.trim()) {
    console.log(color.yellow("记忆内容为空，已取消。"));
    return;
  }

  const filename = `${sanitizeFilename(name)}.md`;
  await writeMemoryFile(
    MEMORY_DIR,
    { name, description, subtype: type, body },
    filename,
  );
  await appendIndexEntry(MEMORY_DIR, {
    title: name,
    subtype: type,
    filename: filename.replace(/\.md$/, ""),
    hook: description,
  });

  console.log(color.green(`✓ 已保存：emotion/${type}/${filename}`));
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9一-龥_-]/g, "_")
    .replace(/_+/g, "_")
    .slice(0, 60);
}

async function handleTimelineCommand(args: string[], _ctx: CommandContext) {
  const [subcmd] = args;

  if (subcmd === "stats") {
    const stats = await _ctx.timeline.getStats();
    console.log(color.bold("\n📊 情绪统计\n"));
    console.log(`总记录数：${stats.totalEntries}`);
    if (stats.currentDominant) {
      const emoji = EMOTION_EMOJI[stats.currentDominant];
      const label = EMOTION_LABEL[stats.currentDominant];
      console.log(`当前主导情绪：${emoji} ${label}`);
    }
    console.log(`近 7 天平均强度：${(stats.avgIntensity7Days * 100).toFixed(0)}%`);
    if (Object.keys(stats.recent7Days).length > 0) {
      console.log(`\n近 7 天分布：`);
      for (const [emotion, count] of Object.entries(stats.recent7Days)) {
        const emoji = EMOTION_EMOJI[emotion as keyof typeof EMOTION_LABEL];
        const label = EMOTION_LABEL[emotion as keyof typeof EMOTION_LABEL];
        console.log(`  ${emoji} ${label}: ${count}`);
      }
    }
    return;
  }

  // 默认：显示最近 10 条
  const recent = await _ctx.timeline.readRecent(10);
  if (recent.length === 0) {
    console.log(color.dim("还没有情绪记录。"));
    return;
  }
  console.log(color.bold(`\n📈 最近 ${recent.length} 条情绪记录\n`));
  for (const e of recent) {
    const date = new Date(e.ts).toLocaleString("zh-CN");
    const emoji = EMOTION_EMOJI[e.emotion];
    const label = EMOTION_LABEL[e.emotion];
    const intensity = "▓".repeat(Math.max(1, Math.round(e.intensity * 5)));
    const trigger = e.trigger ? ` (${e.trigger})` : "";
    console.log(`${color.dim(date)} ${emoji} ${color.bold(label)} ${intensity}${trigger}`);
    if (e.userExcerpt) {
      console.log(color.dim(`  你: "${e.userExcerpt.slice(0, 80)}${e.userExcerpt.length > 80 ? "…" : ""}"`));
    }
    if (e.myResponseExcerpt) {
      console.log(color.dim(`  我: "${e.myResponseExcerpt.slice(0, 80)}${e.myResponseExcerpt.length > 80 ? "…" : ""}"`));
    }
  }
}

// /learner 命令：显示人设学习器状态
//
// 取代旧的 /personality 命令——人设不再可手动切换，
// 人设完全由反馈学习器动态生成。

async function handleLearnerCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const sub = args[0];
  const learner = ctx.personaLearner;
  const total =
    learner.signalCounts.positive +
    learner.signalCounts.negative +
    learner.signalCounts.neutral;

  if (sub === "reset") {
    const { resetLearner } = await import("./persona-learner.ts");
    const fresh = resetLearner(DATA_DIR, ctx.userId);
    console.log(color.green("✓ 已重置人设学习器。下一轮对话开始以空白起点。"));
    ctx.personaLearner = fresh;
    return;
  }

  console.log(color.bold("\n人设学习器状态（开放版）："));
  if (total === 0) {
    console.log(color.dim("  冷启动 —— 尚未收到反馈"));
    console.log(color.dim("  给真人回几条消息后，正/负反馈会自动累积为自然语言观察"));
  } else {
    console.log(`  总反馈数: ${color.bold(String(total))}`);
    console.log(
      `  正: ${learner.signalCounts.positive} / 负: ${learner.signalCounts.negative} / 中: ${learner.signalCounts.neutral}`,
    );

    if (learner.positivePatterns.length > 0) {
      console.log(`  ${color.green("用户喜欢（自然语言观察）：")}`);
      for (const p of learner.positivePatterns.slice(-10)) {
        console.log(`    ${color.green("✓")} ${p}`);
      }
    }
    if (learner.negativePatterns.length > 0) {
      console.log(`  ${color.red("用户不喜欢：")}`);
      for (const p of learner.negativePatterns.slice(-10)) {
        console.log(`    ${color.red("✗")} ${p}`);
      }
    }
    if (learner.positiveExamples.length > 0) {
      console.log(
        `  ${color.green("正向示例（" + learner.positiveExamples.length + " 个）：")}`,
      );
      const ex = learner.positiveExamples[learner.positiveExamples.length - 1];
      console.log(`    用户：${ex.userMessage.slice(0, 80)}${ex.userMessage.length > 80 ? "..." : ""}`);
      console.log(`    你：  ${ex.aiReply.slice(0, 80)}${ex.aiReply.length > 80 ? "..." : ""}`);
      if (ex.whyWorked) console.log(`    原因：${ex.whyWorked}`);
    }
    if (learner.negativeExamples.length > 0) {
      console.log(
        `  ${color.red("负向示例（" + learner.negativeExamples.length + " 个）：")}`,
      );
      const ex = learner.negativeExamples[learner.negativeExamples.length - 1];
      console.log(`    用户：${ex.userMessage.slice(0, 80)}${ex.userMessage.length > 80 ? "..." : ""}`);
      console.log(`    你：  ${ex.aiReply.slice(0, 80)}${ex.aiReply.length > 80 ? "..." : ""}`);
      if (ex.whyDidntWork) console.log(`    原因：${ex.whyDidntWork}`);
    }
    if (learner.recentReasons.length > 0) {
      console.log(`  ${color.dim("最近反馈信号（最近 5 条）：")}`);
      for (const r of learner.recentReasons.slice(-5)) {
        console.log(`    ${color.dim(`[${r.signal}] ${r.text}`)}`);
      }
    }
  }
  console.log();
}

async function handleStatsCommand(ctx: CommandContext): Promise<void> {
  console.log(color.bold("\n📊 会话统计\n"));
  console.log(`  消息数: ${color.bold(String(ctx.history.length))}`);
  const memCount = await readdir(MEMORY_DIR).catch(() => []);
  console.log(`  记忆文件: ${color.bold(String(memCount.length))}`);
  const timelineCount = await ctx.timeline.readAll().catch(() => []);
  console.log(`  情绪时间线条目: ${color.bold(String(timelineCount.length))}`);
  console.log();
  console.log(color.dim("提示：长会话用 /compact 手动压缩历史"));
}

async function handleCompactCommand(ctx: CommandContext): Promise<void> {
  console.log(color.dim("正在压缩历史..."));
  try {
    const { history: newHistory, result } = await forceCompact(
      ctx.provider,
      ctx.history,
      DEFAULT_COMPACT_CONFIG,
    );
    if (result && result.compactedCount > 0) {
      console.log(
        color.green(
          `✓ 已压缩 ${result.compactedCount} 条消息，节省约 ${result.savedTokens} tokens`,
        ),
      );
      ctx.history.length = 0;
      ctx.history.push(...newHistory);
    } else {
      console.log(color.dim("当前历史无需压缩"));
    }
  } catch (e) {
    console.log(color.red(`compact 失败: ${(e as Error).message}`));
  }
}

async function handleProfileCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const sub = args[0];
  if (sub === "path") {
    console.log(`画像文件: ${color.cyan(join(PROFILE_DIR, "PROFILE.md"))}`);
    return;
  }
  if (sub === "reset") {
    const profilePath = join(PROFILE_DIR, "PROFILE.md");
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(profilePath);
    } catch {
      // 文件本来就不存在
    }
    // 重新加载（触发 syncFromSources 用默认模板 + memory + learner 数据源）
    // 注：timeline 需要 main() 的实例，handleProfileCommand 拿不到；
    // 用户在下一轮对话时由 maybeUpdateProfile 再写入 timeline 数据
    await loadProfile(DATA_DIR, {
      userId: "default",
      memoryDir: MEMORY_DIR,
    });
    console.log(color.green("✓ 画像已重置（默认模板 + 数据源同步）"));
    return;
  }
  // 默认：显示当前画像内容
  try {
    const profilePath = join(PROFILE_DIR, "PROFILE.md");
    const profile = await readFile(profilePath, "utf-8");
    console.log(color.bold("\n👤 用户画像：\n"));
    console.log(profile.slice(0, 1500));
    if (profile.length > 1500) console.log(color.dim("\n... (内容过长，已截断)"));
  } catch {
    console.log(color.dim("画像文件不存在"));
  }
}

async function handleReflectCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const days = parseInt(args[0] ?? "7", 10);
  console.log(color.dim(`正在生成最近 ${days} 天的洞察...`));
  try {
    const { runReflection } = await import("./reflection.ts");
    const insight = await runReflection(DATA_DIR, ctx.timeline, MEMORY_DIR, ctx.provider, { lookbackDays: days });
    if (insight) {
      console.log(color.green("\n📝 今日洞察：\n"));
      console.log(insight);
    } else {
      console.log(color.dim("没有足够的数据生成洞察"));
    }
  } catch (e) {
    console.log(color.red(`反思失败: ${(e as Error).message}`));
  }
}

async function handleReflectionsCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const sub = args[0];
  if (sub === "list") {
    const { listReflections } = await import("./reflection.ts");
    const files = await listReflections(DATA_DIR);
    if (files.length === 0) {
      console.log(color.dim("还没有反思历史"));
      return;
    }
    console.log(color.bold("\n📚 反思历史："));
    for (const f of files) {
      console.log(`  - ${f}`);
    }
    return;
  }
  if (sub === "read" && args[1]) {
    const { readReflection } = await import("./reflection.ts");
    const content = await readReflection(DATA_DIR, args[1]);
    if (content) {
      console.log(content);
    } else {
      console.log(color.yellow(`没有 ${args[1]} 的反思`));
    }
    return;
  }
  console.log(color.yellow("用法：/reflections list | /reflections read <YYYY-MM-DD>"));
}

async function handleProactiveCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const { loadProactiveState, shouldTriggerProactive, prepareProactiveMessage, recordProactiveSent, DEFAULT_PROACTIVE_CONFIG } = await import("./proactive.ts");
  const sub = args[0];
  const state = await loadProactiveState(DATA_DIR);

  if (sub === "status" || !sub) {
    const decision = shouldTriggerProactive(state, DEFAULT_PROACTIVE_CONFIG);
    console.log(color.bold("\n💡 主动对话状态：\n"));
    console.log(`  上次用户活动: ${state.lastUserActivityAt ? new Date(state.lastUserActivityAt).toLocaleString() : "暂无"}`);
    console.log(`  上次主动消息: ${state.lastProactiveAt ? new Date(state.lastProactiveAt).toLocaleString() : "暂无"}`);
    console.log(`  今日已发: ${state.todayCount}`);
    console.log(`  状态: ${decision.should ? color.green("可触发") : color.dim("暂不可（" + decision.reason + "）")}`);
    return;
  }

  if (sub === "trigger") {
    const decision = shouldTriggerProactive(state, DEFAULT_PROACTIVE_CONFIG);
    if (!decision.should) {
      console.log(color.dim(`暂不可触发: ${decision.reason}`));
      return;
    }
    try {
      const { loadProfile } = await import("./profile.ts");
      const profile = await loadProfile(DATA_DIR);
      const persona = ctx.persona;
      const msg = await prepareProactiveMessage(ctx.provider, {
        dataDir: DATA_DIR,
        memoryDir: MEMORY_DIR,
        timeline: ctx.timeline,
        profile,
        personality: {
          name: "EmoTalk",
          description: persona.preferences || "情感陪伴对话助手",
        },
      });
      console.log(color.bold("\n💡 主动消息：\n"));
      console.log(msg);
      recordProactiveSent(state);
      const { saveProactiveState } = await import("./proactive.ts");
      await saveProactiveState(DATA_DIR, state);
    } catch (e) {
      console.log(color.red(`触发失败: ${(e as Error).message}`));
    }
    return;
  }

  if (sub === "reset") {
    state.lastProactiveAt = 0;
    state.todayCount = 0;
    state.lastUserActivityAt = 0;
    const { saveProactiveState } = await import("./proactive.ts");
    await saveProactiveState(DATA_DIR, state);
    console.log(color.green("✓ 已重置主动对话状态"));
    return;
  }

  console.log(color.yellow("用法：/proactive status | /proactive trigger | /proactive reset"));
}

function handleQuietCommand(ctx: CommandContext): void {
  ctx.setShowEmotionLabels(!ctx.showEmotionLabels);
  if (ctx.showEmotionLabels) {
    console.log(color.green("✓ 已开启调试标签（情绪 / 记忆 / compact）"));
  } else {
    console.log(color.dim("✓ 已关闭调试标签 —— 对话更干净了"));
  }
}

// =====================================================================
// /persona 子命令
// =====================================================================

async function handlePersonaCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const [subcmd, ...rest] = args;

  switch (subcmd) {
    case "show":
    case undefined: {
      const p = ctx.persona;
      console.log(color.bold(`\n🌊 当前人设（session: ${ctx.currentSessionId.slice(0, 18)}…）\n`));
      const dims: (keyof OCEAN)[] = [
        "openness",
        "conscientiousness",
        "extraversion",
        "agreeableness",
        "neuroticism",
      ];
      for (const k of dims) {
        const v = p.ocean[k];
        const hint = oceanHint(k, v);
        const label = k.padEnd(20);
        console.log(`  ${label} ${color.cyan(v.toFixed(2))}  ${color.dim(hint)}`);
      }
      console.log(`\n  ${color.bold("preferences：")} ${color.dim(p.preferences)}`);
      return;
    }

    case "init": {
      const description = rest.join(" ").trim();
      if (!description) {
        console.log(color.yellow("用法：/persona init <一句话描述>"));
        console.log(color.dim("示例：/persona init 一个像苏格拉底那样的智者"));
        return;
      }
      console.log(color.dim(`\n🌊 正在基于「${description}」生成 OCEAN...`));
      try {
        const persona = await initPersonaFromDescription(
          ctx.provider,
          { description, sessionId: ctx.currentSessionId },
          DATA_DIR,
        );
        ctx.setPersona(persona);
        console.log(color.green("\n✓ 人设已设置："));
        for (const k of ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as (keyof OCEAN)[]) {
          console.log(`  ${k.padEnd(20)} ${color.cyan(persona.ocean[k].toFixed(2))}  ${color.dim(oceanHint(k, persona.ocean[k]))}`);
        }
        console.log(`\n  ${color.bold("preferences：")} ${color.dim(persona.preferences)}`);
      } catch (e) {
        console.log(color.red(`人设生成失败：${(e as Error).message}`));
      }
      return;
    }

    case "reset": {
      const personaFile = join(DATA_DIR, "personality", `${ctx.currentSessionId}.json`);
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(personaFile);
      } catch {
        // 文件本来就不存在也无所谓
      }
      const fresh = defaultPersona(ctx.currentSessionId);
      ctx.setPersona(fresh);
      console.log(color.green(`\n✓ 人设已重置为默认中性（OCEAN 全 0.5）`));
      return;
    }

    case "describe": {
      const text = rest.join(" ").trim();
      if (!text) {
        console.log(color.yellow("用法：/persona describe <自由文本偏好>"));
        console.log(color.dim("（不调 LLM，直接修改 preferences 字段）"));
        return;
      }
      const updated: BigFivePersona = {
        ...ctx.persona,
        preferences: text,
        updatedAt: Date.now(),
      };
      savePersonaForSession(DATA_DIR, updated);
      ctx.setPersona(updated);
      console.log(color.green(`\n✓ preferences 已更新（不调 LLM）`));
      console.log(color.dim(`  ${text}`));
      return;
    }

    default:
      console.log(color.yellow("用法：/persona show | init <描述> | describe <文本> | reset"));
  }
}

// =====================================================================
// 启动入口
// =====================================================================

main().catch((e) => {
  console.error(color.red(`\n❌ 启动失败: ${(e as Error).message}`));
  if ((e as Error).stack) console.error(color.dim((e as Error).stack ?? ""));
  process.exit(1);
});

// =====================================================================
// /session 子命令
// =====================================================================

async function handleSessionCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const [subcmd, ...rest] = args;

  switch (subcmd) {
    case "list":
    case undefined: {
      const sessions = listSessions(DATA_DIR);
      if (sessions.length === 0) {
        console.log(color.dim("\n（还没有任何 session）"));
        return;
      }
      console.log(color.bold(`\n📚 共 ${sessions.length} 个 session：\n`));
      for (const s of sessions) {
        const isCurrent = s.id === ctx.currentSessionId;
        const marker = isCurrent ? color.green("→ ") : "  ";
        const ago = humanizeAgo(Date.now() - s.lastActiveAt);
        const title = s.title ? `「${s.title}」` : color.dim("（无标题）");
        const histLen = s.history.length;
        console.log(
          `${marker}${color.cyan(s.id)}  ${title}  ${color.dim(`对话 ${histLen} 条 · ${ago}前`)}`,
        );
      }
      console.log(color.dim(`\n切换：/session switch <id>`));
      return;
    }

    case "current": {
      const title = deriveTitle(ctx.history);
      const p = ctx.persona;
      console.log(color.bold(`\n📍 当前 session\n`));
      console.log(`  id: ${color.cyan(ctx.currentSessionId)}`);
      console.log(`  标题: ${title ?? color.dim("（无标题）")}`);
      console.log(`  历史: ${ctx.history.length} 条`);
      console.log(`  人设: ${color.cyan(p.preferences.slice(0, 60))}${p.preferences.length > 60 ? "…" : ""}`);
      return;
    }

    case "new": {
      const description = rest.join(" ").trim();
      // 先保存当前 session
      ctx.saveCurrentSession();
      // 创建新 session
      const blank = createSession(DATA_DIR, "default", ctx.userId, ctx.provider.model);
      saveSession(DATA_DIR, blank);
      ctx.setCurrentSession(blank.id, []);
      // 重置人设为默认（或调 LLM 生成）
      if (description) {
        console.log(color.dim(`\n🌊 正在为新 session 生成人设：「${description}」`));
        try {
          const persona = await initPersonaFromDescription(
            ctx.provider,
            { description, sessionId: blank.id },
            DATA_DIR,
          );
          ctx.setPersona(persona);
          console.log(color.green(`\n✓ 新 session：${color.cyan(blank.id)}（已设置人设）`));
        } catch (e) {
          ctx.setPersona(defaultPersona(blank.id));
          console.log(color.green(`\n✓ 新 session：${color.cyan(blank.id)}（人设生成失败，已用默认）`));
          console.log(color.dim(`  ${(e as Error).message}`));
        }
      } else {
        ctx.setPersona(defaultPersona(blank.id));
        console.log(color.green(`\n✓ 新 session：${color.cyan(blank.id)}（默认人设）`));
      }
      console.log(color.dim("  开始对话吧。"));
      return;
    }

    case "switch": {
      const id = rest[0];
      if (!id) {
        console.log(color.yellow("用法：/session switch <id>"));
        return;
      }
      const target = loadSession(DATA_DIR, id);
      if (!target) {
        console.log(color.yellow(`找不到 session：${id}`));
        return;
      }
      // 保存当前
      ctx.saveCurrentSession();
      // 切换：先改 currentSessionId，再 reloadPersona
      ctx.setCurrentSession(target.id, target.history);
      await ctx.reloadPersona();
      const title = target.title ? `「${target.title}」` : "（无标题）";
      console.log(color.green(`\n✓ 已切换到：${color.cyan(target.id)}  ${title}`));
      console.log(color.dim(`  历史 ${target.history.length} 条 · 人设已 reload`));
      return;
    }

    case "save": {
      ctx.saveCurrentSession();
      console.log(color.green(`\n✓ 已保存当前 session：${color.cyan(ctx.currentSessionId)}`));
      return;
    }

    case "delete": {
      const id = rest[0];
      if (!id) {
        console.log(color.yellow("用法：/session delete <id>"));
        return;
      }
      if (id === ctx.currentSessionId) {
        console.log(color.red("\n✗ 不能删除当前正在使用的 session"));
        console.log(color.dim("  先 /session switch 到别的，再删这个"));
        return;
      }
      deleteSession(DATA_DIR, id);
      // 顺手删关联人设
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(join(DATA_DIR, "personality", `${id}.json`));
      } catch {
        // 人设文件不存在也无所谓
      }
      console.log(color.green(`\n✓ 已删除 session：${color.cyan(id)}`));
      return;
    }

    default:
      console.log(color.yellow("用法：/session list | current | new [描述] | switch <id> | save | delete <id>"));
  }
}

function humanizeAgo(ms: number): string {
  if (ms < 60_000) return "刚刚";
  if (ms < 3600_000) return `${Math.floor(ms / 60_000)}分钟`;
  if (ms < 86400_000) return `${Math.floor(ms / 3600_000)}小时`;
  return `${Math.floor(ms / 86400_000)}天`;
}
