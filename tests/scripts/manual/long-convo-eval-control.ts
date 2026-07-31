// tests/scripts/manual/long-convo-eval.ts
// 多轮长对话效果评估脚本（500 轮压测版）
//
// 目的：实测 EmoTalk 主对话循环在超长对话下的真实表现与稳定性
// 不修改 src/ 任何文件，所有数据隔离到临时目录
//
// 跑法（项目根目录）：
//   bun run tests/scripts/manual/long-convo-eval.ts
//
// 产出：
//   - tests/scripts/manual/long-convo-eval.log.json   原始逐轮日志
//   - tests/scripts/manual/LONG_CONVO_EVAL_REPORT.md  人读评估报告
//   - 临时目录 /tmp/emotalk-eval-<ts>/  隔离数据（跑完清理）

import {
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { loadProjectEnv } from "../../../src/bootstrap.ts";
import { createProvider, type ChatMessage } from "../../../src/provider.ts";
import { Timeline } from "../../../src/timeline.ts";
import { runTurn } from "../../../src/loop.ts";
import { loadLearner } from "../../../src/persona-learner.ts";
import { scanMemory } from "../../../src/memory.ts";

// =====================================================================
// 路径与隔离目录
// =====================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..", "..");
const HERE = __dirname;
const EVAL_TS = Date.now();
const EVAL_DIR = `/tmp/emotalk-eval-${EVAL_TS}`;
const DATA_DIR = join(EVAL_DIR, "data");
const MEMORY_DIR = join(DATA_DIR, "memory");
const PROFILE_DIR = join(DATA_DIR, "profile");
const TIMELINE_DIR = join(DATA_DIR, "timeline");
const LEARNER_DIR = join(DATA_DIR, "learned-prefs");
const LOG_JSON = join(HERE, "long-convo-eval.log.json");
const REPORT_MD = join(HERE, "LONG_CONVO_EVAL_REPORT.md");

for (const dir of [
  EVAL_DIR,
  DATA_DIR,
  MEMORY_DIR,
  join(MEMORY_DIR, "emotion"),
  join(MEMORY_DIR, "event"),
  join(MEMORY_DIR, "reference"),
  PROFILE_DIR,
  TIMELINE_DIR,
  LEARNER_DIR,
]) {
  mkdirSync(dir, { recursive: true });
}
writeFileSync(join(MEMORY_DIR, "MEMORY.md"), "", "utf-8");

// =====================================================================
// 用户消息池（≥25 条，覆盖不同主题 + 情绪起伏 + 偏好植入）
// 情绪标签用于人工核对识别准确度
// =====================================================================

type Pool = { user: string; expect?: string };

const POOL: Pool[] = [
  // --- 1-3: 工作压力爆表
  { user: "嗨，今天又有事，想跟你吐槽。", expect: "neutral" },
  { user: "我们组 leader 安排了一个本来下个月才做的项目，这周三就要。完全不合理。", expect: "anger" },
  { user: "别上来就说\"加油\"那种，没用，帮我骂两句吧。", expect: "anger" },
  // --- 4-6: 撑不住
  { user: "我本来以为撑一撑能过去，但今天真扛不住了。", expect: "sadness" },
  { user: "连着第三天熬到两点，脑子已经不转了。", expect: "sadness" },
  { user: "你别总说教我。我现在不需要大道理，陪我待一会就行。", expect: "anger" },
  // --- 7-9: 跟伴侣的架
  { user: "还有上周跟我对象吵架那事，今天讲完吧。", expect: "sadness" },
  { user: "她说我一回家就面瘫，我说她不体谅我加班。其实两个人都没错。", expect: "mixed" },
  { user: "我养了只猫叫牛奶，这两天一直吐，今天去医院说是肠胃炎。", expect: "fear" },
  // --- 10-12: 猫
  { user: "叫她名字她都没力气回应，跟平时那个蹦来蹦去的完全不一样。我有点慌。", expect: "fear" },
  { user: "医生说先观察两天，我坐在地上看着它眼睛一眨一眨的，突然想哭。", expect: "sadness" },
  { user: "晚上家里又打来电话。我妈又提三十好几该结婚了，问我对象是谁。", expect: "anger" },
  // --- 13-15: 催婚
  { user: "你有没有过那种感觉，所有压力同时压过来，连喘口气都没空。", expect: "sadness" },
  { user: "我妈开口就是\"人家谁谁谁已经抱孙子了\"，每次听到我就想把电话挂了。", expect: "anger" },
  { user: "我今天啥也没干成。牛奶的药我喂了一次她就吐了，我对象那边也没回。", expect: "sadness" },
  // --- 16-18: 周末放松
  { user: "算了今天先歇一会儿，我去泡杯咖啡。", expect: "neutral" },
  { user: "刚翻到一个帖子说成年人崩溃都在深夜。我看了眼时间，已经 23:40 了。", expect: "sadness" },
  { user: "我不喜欢这种\"你应该怎样\"的句式。我自己知道我应该怎样。", expect: "anger" },
  // --- 19-21: 偏好植入
  { user: "对了，别再叫我\"你\"，叫我老周。周是周到的周。", expect: "neutral" },
  { user: "我喜欢你直接点，长篇大论的回我看着累。", expect: "neutral" },
  { user: "对了，你回我太短了我也烦，像挤牙膏那种。", expect: "neutral" },
  // --- 22-25: 吐槽某件事 + 情绪回收
  { user: "你说为什么同事聚餐从来没人主动叫我？是不是我太闷了。", expect: "sadness" },
  { user: "其实今天有个好消息我忘了讲。我那个 leader 当着全组说\"老周那个方案很扎实\"。", expect: "joy" },
  { user: "嗯...心里有点暖，但又有种\"她不该是来安慰我的人\"的别扭。", expect: "mixed" },
  { user: "明天能好一点吗？我也不知道。先睡了。", expect: "sadness" },
  // --- 26-30: 收尾 + 偏好的强信号
  { user: "老周这就下线了。今天这些乱七八糟的，你看着办吧，记不记都行。", expect: "neutral" },
  { user: "晚安。明天见。", expect: "neutral" },
  { user: "我又回来了，睡不着。", expect: "sadness" },
  { user: "想了一下午，我觉得 leader 也没那么坏，可能他也压力大。", expect: "neutral" },
  { user: "牛奶刚才跳上床了，蹭了蹭我手。她好像在安慰我。", expect: "joy" },
];

// =====================================================================
// 把池子翻成 500 轮（20 轮循环，每轮 cycle 内做轻微改写）
// =====================================================================

function rewrite(base: string, cycle: number, idx: number): string {
  // 不同 cycle 加不同前缀 / 修饰语，让对话有连续感又不机械重复
  if (cycle === 0) return base;
  if (cycle === 1) {
    // 加 "今天又" "刚刚又" 之类
    if (idx % 3 === 0) return base.replace(/^/, "今天又");
    if (idx % 3 === 1) return base.replace(/^/, "嗯，");
    return base;
  }
  if (cycle === 2) {
    // 模拟隔天再聊
    if (idx % 4 === 0) return "隔了一天，再来跟你念叨一句。 " + base;
    if (idx % 4 === 1) return "又过了一阵。" + base;
    if (idx % 4 === 2) return base + "（再想想）";
    return base;
  }
  // cycle 3+: 复盘，保留连续感但不强化回复长度或说教偏好
  if (idx % 4 === 0) {
    return base + "（又想起这事）";
  }
  if (idx % 4 === 1) {
    return "（接着说）" + base;
  }
  if (idx % 4 === 2) {
    return "老周。" + base;
  }
  return base;
}

const SCRIPT: Pool[] = [];
const CYCLE_COUNT = 20; // 25 * 20 = 500
const POOL_FOR_100 = 25;
const TOTAL_TURNS = POOL.length * CYCLE_COUNT; // =500（脚本展开后总轮数）
// 拿前 25 条循环 20 次
for (let c = 0; c < CYCLE_COUNT; c++) {
  for (let i = 0; i < POOL_FOR_100; i++) {
    const base = POOL[i % POOL_FOR_100];
    SCRIPT.push({ user: rewrite(base.user, c, i), expect: base.expect });
  }
}
// 500 条确定

// =====================================================================
// 日志结构
// =====================================================================

type TurnLog = {
  turn: number;
  cycle: number;
  userInputShort: string;
  userInputFull: string;
  expectEmotion: string | null;
  responseText: string;
  responseLength: number;
  detectedEmotion: string | null;
  detectedIntensity: number | null;
  detectedTrigger: string | null;
  recalledMemories: string[];
  compacted: boolean;
  savedTokens: number;
  profileUpdates: string[];
  extractedNow: boolean;
  memoryExtracted: Array<{ action: string; subtype: string; filename: string }>;
  wallMs: number;
  historyLen: number;
};

const log: {
  evalDir: string;
  startedAt: string;
  finishedAt: string | null;
  provider: { name: string; model: string };
  turns: TurnLog[];
  errors: Array<{ turn: number; message: string }>;
  profileAfter: { sections: Record<string, string>; mtime: number } | null;
  learnerAfter: any | null;
  memoryAfter: { emotion: string[]; event: string[]; reference: string[] };
  timelineAfterCount: number;
  compactTriggers: Array<{ turn: number; savedTokens: number; historyLen: number }>;
  totalApiCallsApprox: number;
  totalWallMs: number;
} = {
  evalDir: EVAL_DIR,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  provider: { name: "", model: "" },
  turns: [],
  errors: [],
  profileAfter: null,
  learnerAfter: null,
  memoryAfter: { emotion: [], event: [], reference: [] },
  timelineAfterCount: 0,
  compactTriggers: [],
  totalApiCallsApprox: 0,
  totalWallMs: 0,
};

// =====================================================================
// 主流程
// =====================================================================

async function main() {
  console.log(`\n[eval] 数据隔离目录: ${EVAL_DIR}`);
  console.log(`[eval] 日志: ${LOG_JSON}`);
  console.log(`[eval] 报告: ${REPORT_MD}\n`);

  // 0. 加载 env
  loadProjectEnv({ settingsPath: join(ROOT, "settings.json"), verbose: true });

  // 1. Provider
  const provider = createProvider();
  log.provider = { name: provider.name, model: provider.model };
  console.log(`[eval] Provider: ${provider.name} / ${provider.model}\n`);

  // 2. Timeline
  const timeline = new Timeline(TIMELINE_DIR);
  await timeline.ensure();

  // 3. 主循环
  let history: ChatMessage[] = [];
  let previousAssistantReply = "";
  const startWall = Date.now();

  // REPL 同款 compact 配置（默认 triggerAt=20 / recentKept=6）
  // 500 轮必然触发多轮 compact
  const compactConfig = {
    triggerAt: 20,
    recentKept: 6,
    maxChars: 20000,
    minCompactWorth: 1500,
  };

  for (let i = 0; i < SCRIPT.length; i++) {
    const t = SCRIPT[i];
    const turnIndex = i + 1;
    const cycle = Math.floor(i / POOL_FOR_100);
    const turnStart = Date.now();
    const captured: { profile: string[]; memory: any[] } = {
      profile: [],
      memory: [],
    };

    // 临时 hook console.log，捕获 [profile] / [memory] 等事件
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      const msg = args
        .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
        .join(" ");
      if (msg.includes("[profile]")) captured.profile.push(msg);
      // 其它日志照常打印
      if (msg.startsWith("───") || msg.startsWith("─") || msg.startsWith(">") ||
          msg.startsWith("  [") || msg.startsWith("\n────")) {
        originalLog(...args);
      } else if (msg.startsWith("  ")) {
        originalLog(...args);
      } else {
        originalLog(...args);
      }
    };

    if (turnIndex === 1 || turnIndex % 10 === 0) {
      console.log(`\n──── Turn ${turnIndex} / ${SCRIPT.length} (cycle ${cycle}) ────`);
    }
    if (turnIndex % 25 === 1) {
      console.log(`> ${t.user.slice(0, 100)}`);
    }

    let result;
    try {
      result = await runTurn(
        {
          provider,
          memoryDir: MEMORY_DIR,
          timeline,
          compactConfig,
          dataDir: DATA_DIR,
          userId: "eval",
          previousAssistantReply,
          turnIndex,
          forceExtract: false,
          onMemoryExtracted: (results) => {
            for (const r of results) {
              captured.memory.push(r);
            }
          },
        },
        t.user,
        history,
        (chunk) => {
          // 完全静默（按用户要求：不输出 AI 的内容到终端以免淹没日志）
          // 但仍统计字数
          if (chunk.delta) void chunk.delta;
        },
      );
    } catch (e) {
      const err = e as Error;
      console.log = originalLog;
      console.log(`  ❌ turn ${turnIndex} failed: ${err.message}`);
      log.errors.push({ turn: turnIndex, message: err.message });
      // history 维持上一轮，避免整轮丢消息
      history.push({ role: "user", content: t.user });
      previousAssistantReply = "[ERROR]";
      continue;
    } finally {
      console.log = originalLog;
    }

    const turnMs = Date.now() - turnStart;

    // effectiveHistory 是 compact 后的旧历史（不含本轮 user/assistant）。
    // 注意：本轮未触发 compact 时 maybeCompact 返回原 history 同一引用，
    // 所以绝不能先 history.length=0 再 push(...effectiveHistory)。
    // 必须用新数组替换。
    history = [
      ...result.effectiveHistory,
      { role: "user", content: t.user },
      { role: "assistant", content: result.responseText },
    ];
    previousAssistantReply = result.responseText;

    // 限长：与 REPL 一致（≤ 40 条）
    if (history.length > 40) {
      history = history.slice(history.length - 40);
    }

    // 收集本轮日志
    log.turns.push({
      turn: turnIndex,
      cycle,
      userInputShort: t.user.slice(0, 80),
      userInputFull: t.user,
      expectEmotion: t.expect ?? null,
      responseText: result.responseText,
      responseLength: result.responseText.length,
      detectedEmotion: result.emotion?.emotion ?? null,
      detectedIntensity: result.emotion?.intensity ?? null,
      detectedTrigger: result.emotion?.trigger ?? null,
      recalledMemories: result.recalledMemories.map(
        (m) => `${m.subtype}:${m.filename}`,
      ),
      compacted: result.compacted,
      savedTokens: result.savedTokens ?? 0,
      profileUpdates: captured.profile,
      extractedNow: result.extractedNow,
      memoryExtracted: captured.memory,
      wallMs: turnMs,
      historyLen: history.length,
    });

    if (result.compacted) {
      log.compactTriggers.push({
        turn: turnIndex,
        savedTokens: result.savedTokens ?? 0,
        historyLen: history.length,
      });
    }

    // 进度行（每 5 轮打印一次，避免刷屏）
    if (turnIndex % 5 === 0 || turnIndex === 1) {
      const e = result.emotion;
      const eStr = e ? `${e.emotion}/${e.intensity.toFixed(2)}` : "-";
      const recallStr =
        result.recalledMemories.length > 0
          ? `recall=${result.recalledMemories.length}`
          : "";
      const compactStr = result.compacted
        ? `compact(-${result.savedTokens ?? 0}t)`
        : "";
      const profStr = captured.profile.length > 0 ? `profile+${captured.profile.length}` : "";
      const memStr = captured.memory.length > 0 ? `mem+${captured.memory.length}` : "";
      console.log(
        `  [T${String(turnIndex).padStart(3, "0")}/${SCRIPT.length}] ` +
        `rsp=${String(result.responseText.length).padStart(3, " ")}字 ` +
        `emo=${eStr.padEnd(14)} ` +
        `wall=${String(turnMs).padStart(5, " ")}ms ` +
        `hist=${String(history.length).padStart(2, " ")} ` +
        [recallStr, compactStr, profStr, memStr].filter(Boolean).join(" "),
      );
    }
  }

  // 4. 等 2.5s，让 fire-and-forget 的 profile/memory/feedback 任务完成
  console.log(`\n[eval] 等待 2.5s 让后台任务完成...`);
  await new Promise((r) => setTimeout(r, 2500));

  // 5. 读最终状态
  const profilePath = join(PROFILE_DIR, "PROFILE.md");
  let profileAfter: { sections: Record<string, string>; mtime: number } | null = null;
  if (existsSync(profilePath)) {
    const raw = readFileSync(profilePath, "utf-8");
    const sections: Record<string, string> = {};
    const re = /## \d+\. (.+?)\n([\s\S]*?)(?=\n## \d+\. |\n*$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      sections[m[1].trim()] = m[2].trim();
    }
    const mtime = statSync(profilePath).mtimeMs;
    profileAfter = { sections, mtime };
  }
  const learnerAfter = loadLearner(DATA_DIR, "eval");
  const memories = await scanMemory(MEMORY_DIR);
  const memoryAfter = {
    emotion: memories.filter((m) => m.subtype === "emotion").map((m) => m.filename),
    event: memories.filter((m) => m.subtype === "event").map((m) => m.filename),
    reference: memories.filter((m) => m.subtype === "reference").map((m) => m.filename),
  };
  const timelineEntries = await timeline.readAll();

  log.profileAfter = profileAfter;
  log.learnerAfter = learnerAfter;
  log.memoryAfter = memoryAfter;
  log.timelineAfterCount = timelineEntries.length;
  log.finishedAt = new Date().toISOString();
  log.totalWallMs = Date.now() - startWall;
  // 粗估：每轮 1 主对话 + 1 emotion + 1 recall + 1-2 异步(profile/feedback/extract)
  // emotion/recall 是 side-query 也是调一次；主对话 1 次 stream
  log.totalApiCallsApprox = SCRIPT.length * 4 + log.compactTriggers.length * 1;

  // 6. 写日志 JSON
  writeFileSync(LOG_JSON, JSON.stringify(log, null, 2), "utf-8");

  // 7. 写人读报告
  writeReport(log);

  // 8. 打印摘要
  printSummary(log);

  // 9. 清理临时目录
  try {
    rmSync(EVAL_DIR, { recursive: true, force: true });
    console.log(`\n[eval] 已清理临时目录: ${EVAL_DIR}`);
  } catch (e) {
    console.warn(`[eval] 清理临时目录失败: ${(e as Error).message}`);
  }

  console.log(`\n[eval] 完成。`);
  console.log(`[eval] 日志: ${LOG_JSON}`);
  console.log(`[eval] 报告: ${REPORT_MD}`);
}

// =====================================================================
// 报告生成
// =====================================================================

function writeReport(log: any) {
  const turns: TurnLog[] = log.turns;
  const okCount = turns.length - log.errors.length;
  const lengths = turns.map((t) => t.responseLength);
  const avg = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const max = Math.max(...lengths);
  const min = Math.min(...lengths);

  // === 区间统计：每 50 轮一个区间 ===
  const buckets: Array<{
    range: string;
    turns: number;
    avgLen: number;
    minLen: number;
    maxLen: number;
    compactCount: number;
    profileUpdCount: number;
    memExtractCount: number;
    emotionHist: Record<string, number>;
  }> = [];
  const BUCKET = 50;
  for (let i = 0; i < turns.length; i += BUCKET) {
    const slice = turns.slice(i, i + BUCKET);
    const l = slice.map((t) => t.responseLength);
    const bucketsLocal = {
      range: `${i + 1}-${Math.min(i + BUCKET, turns.length)}`,
      turns: slice.length,
      avgLen: l.reduce((a, b) => a + b, 0) / l.length,
      minLen: Math.min(...l),
      maxLen: Math.max(...l),
      compactCount: slice.filter((t) => t.compacted).length,
      profileUpdCount: slice.filter((t) => t.profileUpdates.length > 0).length,
      memExtractCount: slice.filter((t) => t.memoryExtracted.length > 0).length,
      emotionHist: {} as Record<string, number>,
    };
    for (const t of slice) {
      const k = t.detectedEmotion ?? "null";
      bucketsLocal.emotionHist[k] = (bucketsLocal.emotionHist[k] ?? 0) + 1;
    }
    buckets.push(bucketsLocal);
  }

  // === 情绪准确度 ===
  const emotionChecks = turns.map((t) => {
    const detected = t.detectedEmotion ?? "null";
    const expected = t.expectEmotion;
    let hit: "✓" | "~" | "✗" | "n/a" = "n/a";
    if (expected) {
      if (detected === expected) hit = "✓";
      else if (expected === "mixed" || detected === "mixed") hit = "~";
      else hit = "✗";
    }
    return { turn: t.turn, expected, detected, intensity: t.detectedIntensity?.toFixed(2) ?? "-", hit };
  });
  const emotionHits = emotionChecks.filter((c) => c.hit === "✓").length;
  const emotionPartial = emotionChecks.filter((c) => c.hit === "~").length;
  const emotionMisses = emotionChecks.filter((c) => c.hit === "✗").length;

  // === Profile 段填充 ===
  const sections = log.profileAfter?.sections ?? {};
  const SECTION_NAMES = [
    "基本信息",
    "沟通风格",
    "关注议题",
    "已知偏好与禁忌",
    "长期情绪基线",
    "近期变化",
  ];
  const sectionStatus: Record<string, { filled: boolean; snippet: string }> = {};
  for (const name of SECTION_NAMES) {
    const body = sections[name] ?? "";
    const isFilled = !!body && !body.startsWith("（暂无") && body !== "（暂无）";
    const snippet = isFilled
      ? body.split("\n").slice(0, 4).join(" / ").slice(0, 240)
      : "(空)";
    sectionStatus[name] = { filled: isFilled, snippet };
  }

  // === Learner ===
  const learner = log.learnerAfter;
  const learnerSummary = learner
    ? {
        posPatterns: learner.positivePatterns?.length ?? 0,
        negPatterns: learner.negativePatterns?.length ?? 0,
        posExamples: learner.positiveExamples?.length ?? 0,
        negExamples: learner.negativeExamples?.length ?? 0,
        signalCounts: learner.signalCounts,
        posSamples: (learner.positivePatterns ?? []).slice(-6),
        negSamples: (learner.negativePatterns ?? []).slice(-6),
        posWhySamples: (learner.positiveExamples ?? []).slice(-3).map((e: any) => e.whyWorked).filter(Boolean),
        negWhySamples: (learner.negativeExamples ?? []).slice(-3).map((e: any) => e.whyDidntWork).filter(Boolean),
      }
    : null;

  // === Compact ===
  const compactTriggers: Array<{ turn: number; savedTokens: number; historyLen: number }> = log.compactTriggers;
  const totalSaved = compactTriggers.reduce((a, b) => a + b.savedTokens, 0);

  // === Memory ===
  const mem = log.memoryAfter;

  // === 模板化检测 ===
  // 相邻回复首句前缀重复度
  const firstSentences = turns.map((t) =>
    t.responseText.split(/[。，！？\n]/)[0]?.slice(0, 12) ?? "",
  );
  let dupCount = 0;
  for (let i = 1; i < firstSentences.length; i++) {
    if (
      firstSentences[i].length >= 4 &&
      firstSentences[i - 1].startsWith(firstSentences[i].slice(0, 4))
    ) {
      dupCount++;
    }
  }

  // === 平均每轮耗时 ===
  const wallMsList = turns.map((t) => t.wallMs);
  const avgMs = wallMsList.reduce((a, b) => a + b, 0) / wallMsList.length;

  // === 写出报告 ===
  const L: string[] = [];
  L.push(`# 多轮长对话效果评估报告（500 轮）`);
  L.push(``);
  L.push(`> 生成时间：${log.finishedAt}`);
  L.push(`> 隔离目录：${log.evalDir}（跑完已清理）`);
  L.push(`> Provider：${log.provider.name} / ${log.provider.model}`);
  L.push(`> 总轮数：${turns.length}（脚本为 20 轮循环 × 25 条用户消息池）`);
  L.push(`> 完成：${okCount} 轮，失败：${log.errors.length} 轮`);
  L.push(`> 总耗时：${(log.totalWallMs / 1000).toFixed(1)}s（平均每轮 ${(avgMs / 1000).toFixed(1)}s）`);
  L.push(`> 估算 API 调用次数：约 ${log.totalApiCallsApprox} 次`);
  L.push(``);

  // 0. 摘要
  L.push(`## 0. 一句话摘要`);
  L.push(``);
  L.push(
    `- 完成率 ${okCount}/${turns.length}；回复字数均 ${avg.toFixed(0)}（min=${min} / max=${max}）。`,
  );
  L.push(
    `- 情绪识别：✓${emotionHits} / ~${emotionPartial} / ✗${emotionMisses}（共 ${emotionChecks.length} 轮）`,
  );
  L.push(
    `- Profile 段填充：${Object.values(sectionStatus).filter((s) => s.filled).length}/6`,
  );
  L.push(
    `- Learner 反馈：+${learnerSummary?.signalCounts.positive ?? 0} / -${learnerSummary?.signalCounts.negative ?? 0} / =${learnerSummary?.signalCounts.neutral ?? 0}`,
  );
  L.push(
    `- 记忆抽取：emotion=${mem.emotion.length}，event=${mem.event.length}，reference=${mem.reference.length}`,
  );
  L.push(
    `- Compact：触发 ${compactTriggers.length} 次，总共节省约 ${totalSaved} tokens`,
  );
  L.push(`- Timeline 条目：${log.timelineAfterCount} 条`);
  L.push(``);

  // 1. 响应字数分布（每 50 轮一个桶）
  L.push(`## 1. 响应字数分布（每 50 轮一个区间）`);
  L.push(``);
  L.push(`| 区间 | 轮数 | 均值 | min | max | compact | profile+ | mem+ | 主情绪 |`);
  L.push(`| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |`);
  for (const b of buckets) {
    const emoSorted = Object.entries(b.emotionHist).sort((x, y) => y[1] - x[1]);
    const emoStr = emoSorted
      .slice(0, 3)
      .map(([k, v]) => `${k}×${v}`)
      .join(" ");
    L.push(
      `| ${b.range} | ${b.turns} | ${b.avgLen.toFixed(0)} | ${b.minLen} | ${b.maxLen} | ${b.compactCount} | ${b.profileUpdCount} | ${b.memExtractCount} | ${emoStr || "-"} |`,
    );
  }
  L.push(``);
  // 趋势观察
  const first10 = buckets[0]?.avgLen ?? 0;
  const last10 = buckets[buckets.length - 1]?.avgLen ?? 0;
  const drift = last10 - first10;
  L.push(
    `**字数漂移**：前 50 轮均值 ${first10.toFixed(0)} 字 → 后 50 轮均值 ${last10.toFixed(0)} 字（${drift > 0 ? "+" : ""}${drift.toFixed(0)} 字）`,
  );
  L.push(``);

  // 2. 情绪识别
  L.push(`## 2. 情绪识别`);
  L.push(``);
  L.push(`判定规则：detected == expected → ✓；任一方为 mixed → ~；否则 ✗；无期望 → n/a`);
  L.push(``);
  L.push(`| Turn | 期望 | 实测 | 强度 | 命中 |`);
  L.push(`| ---: | --- | --- | ---: | :---: |`);
  for (const c of emotionChecks) {
    L.push(`| ${c.turn} | ${c.expected ?? "-"} | ${c.detected} | ${c.intensity} | ${c.hit} |`);
  }
  L.push(``);
  L.push(
    `命中 ${emotionHits}/${emotionChecks.length}，部分 ${emotionPartial}/${emotionChecks.length}，漏 ${emotionMisses}/${emotionChecks.length}。`,
  );
  L.push(``);

  // 3. Profile 段填充
  L.push(`## 3. Profile 段填充状态`);
  L.push(``);
  L.push(`| 段 | 是否填充 | 内容（截取） |`);
  L.push(`| --- | :---: | --- |`);
  for (const [name, s] of Object.entries(sectionStatus)) {
    const snip = s.snippet.replace(/\|/g, "\\|").slice(0, 200);
    L.push(`| ${name} | ${s.filled ? "✓" : "✗"} | ${snip} |`);
  }
  L.push(``);

  // 4. 反馈学习
  L.push(`## 4. 反馈学习（Learner state）`);
  L.push(``);
  if (learnerSummary) {
    L.push(
      `- 信号：+${learnerSummary.signalCounts.positive} / -${learnerSummary.signalCounts.negative} / =${learnerSummary.signalCounts.neutral}`,
    );
    L.push(
      `- 沉淀：positivePatterns=${learnerSummary.posPatterns}，negativePatterns=${learnerSummary.negPatterns}，positiveExamples=${learnerSummary.posExamples}，negativeExamples=${learnerSummary.negExamples}`,
    );
    L.push(``);
    if (learnerSummary.negSamples.length > 0) {
      L.push(`**用户不喜欢（最后 6 条）**：`);
      for (const p of learnerSummary.negSamples) L.push(`- ${p}`);
      L.push(``);
    }
    if (learnerSummary.posSamples.length > 0) {
      L.push(`**用户喜欢（最后 6 条）**：`);
      for (const p of learnerSummary.posSamples) L.push(`- ${p}`);
      L.push(``);
    }
    if (learnerSummary.negWhySamples.length > 0) {
      L.push(`**负反馈原因示例**：`);
      for (const p of learnerSummary.negWhySamples) L.push(`- ${p}`);
      L.push(``);
    }
    if (learnerSummary.posWhySamples.length > 0) {
      L.push(`**正反馈原因示例**：`);
      for (const p of learnerSummary.posWhySamples) L.push(`- ${p}`);
      L.push(``);
    }
  } else {
    L.push(`（无 learner state）`);
    L.push(``);
  }

  // 5. Compact
  L.push(`## 5. Compact（对话压缩）`);
  L.push(``);
  if (compactTriggers.length > 0) {
    L.push(`| 触发轮次 | 节省 tokens | 触发时 history 长度 |`);
    L.push(`| ---: | ---: | ---: |`);
    for (const c of compactTriggers) {
      L.push(`| ${c.turn} | ${c.savedTokens} | ${c.historyLen} |`);
    }
    L.push(``);
    L.push(`总触发 **${compactTriggers.length} 次**，总节省 **${totalSaved} tokens**。`);
    L.push(``);
    // 抽取 compact 前后两轮，看对话是否还连贯
    const compTurns = compactTriggers.map((c) => c.turn);
    L.push(`**Compact 后对话连贯性抽查**（取前 3 个 compact 触发点之后一轮的输入+输出）：`);
    L.push(``);
    for (const ct of compactTriggers.slice(0, 3)) {
      const after = turns.find((t) => t.turn === ct.turn + 1);
      const before = turns.find((t) => t.turn === ct.turn);
      if (after && before) {
        L.push(`- compact@T${ct.turn} → T${after.turn} 用户说：「${after.userInputShort}...」`);
        const tail = after.responseText.slice(-120).replace(/\n/g, " ");
        L.push(`  - AI 回复尾段：…${tail}`);
        L.push(`  - 是否记得上文偏好？看 detectedEmotion=${after.detectedEmotion}，recall=${after.recalledMemories.length} 条`);
      }
    }
    L.push(``);
  } else {
    L.push(`本次 500 轮对话未触发 compact（异常，应至少触发 25+ 次）。`);
    L.push(``);
  }

  // 6. 记忆抽取
  L.push(`## 6. 记忆抽取`);
  L.push(``);
  L.push(`- emotion 类：${mem.emotion.length} 条 → ${mem.emotion.join(", ") || "(空)"}`);
  L.push(`- event 类：${mem.event.length} 条 → ${mem.event.join(", ") || "(空)"}`);
  L.push(`- reference 类：${mem.reference.length} 条 → ${mem.reference.join(", ") || "(空)"}`);
  L.push(``);
  L.push(`**按轮抽取事件**：`);
  let anyMemory = false;
  for (const t of turns) {
    if (t.memoryExtracted.length > 0) {
      anyMemory = true;
      L.push(
        `- T${t.turn}: ${t.memoryExtracted.map((m) => `${m.action}/${m.subtype}/${m.filename}`).join(", ")}`,
      );
    }
  }
  if (!anyMemory) L.push(`（本轮次无 onMemoryExtracted 回调）`);
  L.push(``);

  // 7. 失败轮次
  L.push(`## 7. 失败轮次`);
  L.push(``);
  if (log.errors.length === 0) {
    L.push(`无。所有 ${turns.length} 轮都成功返回。`);
  } else {
    for (const e of log.errors) {
      L.push(`- turn ${e.turn}: ${e.message}`);
    }
  }
  L.push(``);

  // 8. 整体效果判断
  L.push(`## 8. 整体效果判断`);
  L.push(``);

  L.push(`### 8.1 回复长度收敛/发散`);
  if (Math.abs(drift) < 50) {
    L.push(`- 字数漂移小（${drift.toFixed(0)} 字），500 轮内没出现明显"越说越长/越短"的失控。`);
  } else if (drift > 50) {
    L.push(`- 字数在长对话中**变长**了（+${drift.toFixed(0)} 字），需要看是否在合理范围内。`);
  } else {
    L.push(`- 字数在长对话中**变短**了（${drift.toFixed(0)} 字），可能是模型偷懒。`);
  }
  // 极值比
  const ratio = min === 0 ? Infinity : max / min;
  if (ratio > 30) {
    L.push(`- max/min 比 = ${ratio.toFixed(1)}（>30 倍），存在极端短回复/超长回复，建议检查是否被截断。`);
  }
  L.push(``);

  L.push(`### 8.2 情绪识别是否随对话稳定`);
  const acc = (emotionHits + emotionPartial) / Math.max(1, emotionChecks.length);
  if (acc >= 0.6) {
    L.push(`- 情绪识别总命中率达 ${(acc * 100).toFixed(0)}%（${emotionHits + emotionPartial}/${emotionChecks.length}），长对话下基本稳定。`);
  } else {
    L.push(`- 情绪识别总命中率仅 ${(acc * 100).toFixed(0)}%，有改进空间（可能混合情绪难判 / prompt 不够具体）。`);
  }
  L.push(``);

  L.push(`### 8.3 Profile 填充情况`);
  const filled = Object.values(sectionStatus).filter((s) => s.filled).length;
  if (filled >= 4) {
    L.push(`- 500 轮下来 Profile 填充 ${filled}/6 段，符合预期（工作/伴侣/猫/催婚/昵称/偏好 等信号充足）。`);
  } else if (filled >= 2) {
    L.push(`- Profile 填充 ${filled}/6 段，部分段未触发（可能是 LLM 抽取未覆盖或 fire-and-forget 漏掉）。`);
  } else {
    L.push(`- Profile 填充仅 ${filled}/6 段，可能 profile 自动更新在长对话中失效。`);
  }
  L.push(``);

  L.push(`### 8.4 反馈学习是否生效`);
  if ((learnerSummary?.negPatterns ?? 0) > 0 || (learnerSummary?.posPatterns ?? 0) > 0) {
    L.push(
      `- Learner 沉淀了 ${learnerSummary!.posPatterns + learnerSummary!.negPatterns} 条偏好（+${learnerSummary!.signalCounts.positive} / -${learnerSummary!.signalCounts.negative}）。`,
    );
    L.push(
      `- 信号强度足以被检测器捕获（脚本里多次明说"别太长""别总说教""叫老周"等偏好）。`,
    );
  } else {
    L.push(`- Learner 几乎没沉淀偏好（positivePatterns/negativePatterns 都接近 0）。`);
    L.push(`- 可能原因：检测器对"明说"型反馈不够敏感，或 fire-and-forget 写入 learner state 失败。`);
  }
  L.push(``);

  L.push(`### 8.5 Compact 行为`);
  if (compactTriggers.length >= 3) {
    L.push(
      `- Compact 触发 ${compactTriggers.length} 次（${compactTriggers.map((c) => c.turn).join(", ")} 轮），符合 500 轮对话压力测试预期。`,
    );
    L.push(`- 总节省约 ${totalSaved} tokens，避免主对话 prompt 撑爆。`);
  } else if (compactTriggers.length > 0) {
    L.push(`- Compact 触发 ${compactTriggers.length} 次（偏少；按 20 条 triggerAt + 500 轮循环应触发约 25 次）。`);
  } else {
    L.push(`- Compact **未触发**，异常——500 轮对话 history 必然超过 20 条。`);
  }
  L.push(``);

  L.push(`### 8.6 模板化/重复`);
  if (dupCount >= 5) {
    L.push(`- 检测到 ${dupCount} 处首句前缀重复（>= 5 处可能存在轻度模板化）。`);
  } else {
    L.push(`- 无明显模板化倾向（首句前缀重复仅 ${dupCount} 处）。`);
  }
  L.push(``);

  L.push(`### 8.7 Bug/卡死/上下文丢失/循环`);
  if (log.errors.length === 0) {
    L.push(`- 无 API 报错、无 timeout、无卡死。`);
  } else {
    L.push(`- 有 ${log.errors.length} 轮失败（详见第 7 节）。`);
  }
  // 上下文丢失简单检测：responseText 包含"忘了""不记得"等关键字的次数
  const forgetSignals = turns
    .map((t) =>
      /我(不太|没|不)记得|我忘了|我(刚才|之前)好像(没|没有)?|想不起来/.test(t.responseText)
        ? t.turn
        : null,
    )
    .filter((x): x is number => x !== null);
  if (forgetSignals.length > 0) {
    L.push(`- AI 在 ${forgetSignals.length} 轮出现"忘了/不记得"信号（轮次：${forgetSignals.slice(0, 10).join(", ")}…）。`);
  } else {
    L.push(`- AI 在 500 轮中未出现"忘了/不记得"的上下文丢失信号。`);
  }
  // 检测循环：相邻回复几乎完全相同
  let loopCount = 0;
  for (let i = 1; i < turns.length; i++) {
    const a = turns[i].responseText.slice(0, 60);
    const b = turns[i - 1].responseText.slice(0, 60);
    if (a && a === b) loopCount++;
  }
  if (loopCount > 0) {
    L.push(`- ⚠️ 检测到 ${loopCount} 轮与上一轮首段完全相同，疑似循环输出。`);
  } else {
    L.push(`- 无循环输出（相邻回复首段不重复）。`);
  }
  L.push(``);

  L.push(`### 8.8 "懂用户"程度（综合判断）`);
  L.push(`- 偏好植入（"别回太长" "别总说教" "叫我老周" "直接点"）在 500 轮中**至少重复 20 次**。`);
  L.push(`- 若 learner 沉淀的 positive/negative patterns 里有以上关键词，则说明反馈学习真正生效。`);
  L.push(`- 若 AI 回复中后期明显变短/不再说教/使用了"老周"称呼，则说明 prompt 实际用上了 learner 沉淀。`);
  L.push(``);

  // 9. 成本
  L.push(`## 9. 成本估算`);
  L.push(``);
  const minutes = (log.totalWallMs / 60000).toFixed(1);
  L.push(`- 总耗时：**${minutes} 分钟**`);
  L.push(`- 平均每轮耗时：${(avgMs / 1000).toFixed(2)}s`);
  L.push(
    `- API 调用：约 ${log.totalApiCallsApprox} 次（每轮主对话 1 + emotion 1 + recall 1 + 1-2 异步 profile/feedback/extract；compact 本身也算 1 次）`,
  );
  const totalChars = turns.reduce((a, b) => a + b.responseLength, 0);
  const approxOutputTokens = Math.ceil(totalChars / 2);
  L.push(`- 输出 token 估算：${approxOutputTokens}（按 1 token ≈ 2 字符粗估；不含输入 system prompt）`);
  L.push(
    `- 若按 deepseek-v4-flash 的价格（输入 ≈ ¥1/M，输出 ≈ ¥2/M），整轮对话输入 + 输出估算成本约 ¥${(approxOutputTokens * 2 / 1_000_000 * 1 + SCRIPT.length * 1500 * 2 / 1_000_000 * 1).toFixed(2)}`,
  );
  L.push(``);

  // 附录
  L.push(`## 附录 A. 失败轮次 / 异常轮次明细`);
  L.push(``);
  if (log.errors.length === 0) {
    L.push(`（无）`);
  } else {
    for (const e of log.errors) {
      L.push(`- turn ${e.turn}: ${e.message}`);
    }
  }
  L.push(``);

  L.push(`## 附录 B. 抽样：每 20 轮一条 AI 回复尾段`);
  L.push(``);
  for (const t of turns) {
    if (t.turn % 20 === 0 || t.turn === 1) {
      const tail = t.responseText.slice(-160).replace(/\n/g, " ");
      L.push(
        `- **T${t.turn}** (cycle ${t.cycle}, hist=${t.historyLen}, ${t.responseLength}字) emo=${t.detectedEmotion}/${t.detectedIntensity?.toFixed(2)}: …${tail}`,
      );
    }
  }
  L.push(``);

  writeFileSync(REPORT_MD, L.join("\n"), "utf-8");
}

function printSummary(log: any) {
  const turns: TurnLog[] = log.turns;
  const ok = turns.length - log.errors.length;
  const lengths = turns.map((t) => t.responseLength);
  const avg = (lengths.reduce((a, b) => a + b, 0) / lengths.length).toFixed(0);
  const mem = log.memoryAfter;
  const lr = log.learnerAfter;

  console.log(`\n══════ 500 轮长对话评估结果摘要 ══════`);
  console.log(`Provider: ${log.provider.name} / ${log.provider.model}`);
  console.log(`完成: ${ok}/${turns.length} 轮（失败 ${log.errors.length}）`);
  console.log(`总耗时: ${(log.totalWallMs / 1000).toFixed(1)}s / 估算 API: ${log.totalApiCallsApprox} 次`);
  console.log(
    `回复字数: 均 ${avg} 字（min=${Math.min(...lengths)} / max=${Math.max(...lengths)}）`,
  );
  console.log(
    `Profile: 6 段填充 ${Object.values(log.profileAfter?.sections ?? {}).filter((v: any) => v && !v.startsWith("（暂无")).length} 段`,
  );
  console.log(
    `Learner: +${lr?.signalCounts.positive ?? 0} / -${lr?.signalCounts.negative ?? 0} / =${lr?.signalCounts.neutral ?? 0} | patterns: +${lr?.positivePatterns?.length ?? 0} / -${lr?.negativePatterns?.length ?? 0}`,
  );
  console.log(
    `Memory: emotion=${mem.emotion.length} / event=${mem.event.length} / reference=${mem.reference.length}`,
  );
  console.log(
    `Compact: 触发 ${log.compactTriggers.length} 次，总省 ${log.compactTriggers.reduce((a: number, b: any) => a + b.savedTokens, 0)} tokens`,
  );
  console.log(`Timeline: ${log.timelineAfterCount} 条`);
  console.log(`═════════════════════════════════════\n`);
}

main().catch((e) => {
  console.error(`[eval] FAIL: ${(e as Error).message}`);
  console.error((e as Error).stack);
  process.exit(1);
});
