// tests/ab-compare.test.ts
// A/B test: 直接 API 调用（A 组）vs RememberMe 完整路径（B 组）
//
// 目的：验证 RememberMe 的多层 system prompt 是不是让回复变短了。
//
// 用真实 API 跑（不走 mock）。如果没有 API key，跳过。
//
// 控制变量：
// - 同一个 provider / model / API key
// - 同一个 maxTokens (3000) / temperature (0.8) / 空 history
//
// A 组：minimal system prompt（"你是一个对话助手"）
// B 组：跑 runTurn，冷启动状态（OCEAN 全 0.5、空 learner、空 profile、空 memory）
//
// 输出：data/ab-test-result-{timestamp}.md

import { describe, it, expect, beforeAll } from "bun:test";
import { Timeline } from "../src/timeline.ts";
import { runTurn } from "../src/loop.ts";
import { createProvider, type ModelProvider, type ChatMessage } from "../src/provider.ts";
import { defaultPersona } from "../src/bigfive.ts";
import { loadProjectEnv } from "../src/bootstrap.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const PROMPTS = [
  "我今天被老板骂了，感觉很委屈",
  "我刚刚分手了",
  "你能帮我看看这段代码吗？function add(a,b){return a+b}",
  "给我讲个笑话",
  "我要不要换工作？纠结了好几个月",
  "解释一下什么是大五人格",
  "我家猫今天死了",
  "推荐三本小说给我",
  "我跟室友吵架了，怎么办",
  "今天有什么新闻？",
];

// A 组最小 system prompt
const SYSTEM_A = "你是一个对话助手。";

const MAX_TOKENS = 3000;
const TEMPERATURE = 0.8;

const shouldSkip = () => {
  if (process.env.EC_SKIP_AB_TEST === "1") return "EC_SKIP_AB_TEST=1";
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
    return "no ANTHROPIC_API_KEY / OPENAI_API_KEY";
  }
  return null;
};

describe("A/B Test: 裸 API vs RememberMe 完整路径", () => {
  let provider: ModelProvider;
  let tmpDir: string;
  let timeline: Timeline;
  let skipReason: string | null;

  beforeAll(async () => {
    // 从项目根目录的 settings.json 加载 env（不影响已存在的 shell env）
    loadProjectEnv({ settingsPath: join(ROOT, "settings.json") });
    skipReason = shouldSkip();
    if (skipReason) {
      console.log(`[ab-compare] 跳过: ${skipReason}`);
      return;
    }
    provider = createProvider();
    tmpDir = await mkdtemp(join(tmpdir(), "ec-ab-"));
    timeline = new Timeline(tmpDir);
    await timeline.ensure();
    console.log(`[ab-compare] provider=${provider.name} model=${provider.model}`);
  });

  it("跑 10 条 prompt × 2 组，生成对比报告", { timeout: 600_000 }, async () => {
    if (skipReason) {
      console.log("跳过（无 API key）");
      expect(true).toBe(true);
      return;
    }

    const results: Array<{
      prompt: string;
      aText: string;
      bText: string;
      aChars: number;
      bChars: number;
      aSentences: number;
      bSentences: number;
      aMs: number;
      bMs: number;
    }> = [];

    for (let i = 0; i < PROMPTS.length; i++) {
      const prompt = PROMPTS[i];

      // A 组：直接调 API
      const tA0 = Date.now();
      let aText = "";
      for await (const chunk of provider.stream({
        model: provider.model,
        params: {
          system: SYSTEM_A,
          messages: [{ role: "user", content: prompt } as ChatMessage],
          maxTokens: MAX_TOKENS,
          temperature: TEMPERATURE,
        },
      })) {
        aText += chunk.delta;
        if (chunk.done) break;
      }
      const tA1 = Date.now();

      // B 组：走 runTurn（冷启动：空 history + defaultPersona + 空 learner/profile/memory）
      const tB0 = Date.now();
      const bResult = await runTurn(
        {
          provider,
          memoryDir: tmpDir,
          timeline,
          dataDir: tmpDir,
          persona: defaultPersona("ab-test"),
          userId: "ab-test",
        },
        prompt,
        [],
        () => {},
      );
      const tB1 = Date.now();
      const bText = bResult.responseText;

      const aSentences = countSentences(aText);
      const bSentences = countSentences(bText);

      results.push({
        prompt,
        aText,
        bText,
        aChars: aText.length,
        bChars: bText.length,
        aSentences,
        bSentences,
        aMs: tA1 - tA0,
        bMs: tB1 - tB0,
      });

      console.log(
        `[ab-compare ${i + 1}/${PROMPTS.length}] A=${aText.length}字/${aSentences}句/${tA1 - tA0}ms  B=${bText.length}字/${bSentences}句/${tB1 - tB0}ms  "${prompt.slice(0, 20)}..."`,
      );
    }

    // 汇总统计
    const totalA = results.reduce((s, r) => s + r.aChars, 0);
    const totalB = results.reduce((s, r) => s + r.bChars, 0);
    const avgA = Math.round(totalA / results.length);
    const avgB = Math.round(totalB / results.length);
    const totalAs = results.reduce((s, r) => s + r.aSentences, 0);
    const totalBs = results.reduce((s, r) => s + r.bSentences, 0);
    const avgAs = (totalAs / results.length).toFixed(1);
    const avgBs = (totalBs / results.length).toFixed(1);

    const delta = ((totalB - totalA) / totalA * 100).toFixed(1);
    const deltaS = ((totalBs - totalAs) / totalAs * 100).toFixed(1);

    // 写报告
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const reportPath = join(ROOT, "data", `ab-test-result-${timestamp}.md`);
    await mkdir(join(ROOT, "data"), { recursive: true });

    const md = buildReport({
      model: provider.model,
      providerName: provider.name,
      results,
      totalA,
      totalB,
      avgA,
      avgB,
      totalAs,
      totalBs,
      avgAs,
      avgBs,
      delta,
      deltaS,
    });
    await writeFile(reportPath, md, "utf-8");

    console.log(`\n[ab-compare] 📊 汇总：`);
    console.log(`  字符: A=${totalA} (avg=${avgA})  B=${totalB} (avg=${avgB})  Δ=${delta}%`);
    console.log(`  句子: A=${totalAs} (avg=${avgAs})  B=${totalBs} (avg=${avgBs})  Δ=${deltaS}%`);
    console.log(`[ab-compare] 📄 报告: ${reportPath}`);

    // 断言：所有 20 次都拿到非空 response
    for (let i = 0; i < results.length; i++) {
      expect(results[i].aText.length).toBeGreaterThan(10);
      expect(results[i].bText.length).toBeGreaterThan(10);
    }
  });
});

function countSentences(text: string): number {
  if (!text.trim()) return 0;
  // 按中英文句号/问号/感叹号/换行 split
  const parts = text.split(/[。！？!?\n]+/).filter((s) => s.trim().length > 0);
  return parts.length;
}

function buildReport(input: {
  model: string;
  providerName: string;
  results: Array<{
    prompt: string;
    aText: string;
    bText: string;
    aChars: number;
    bChars: number;
    aSentences: number;
    bSentences: number;
    aMs: number;
    bMs: number;
  }>;
  totalA: number;
  totalB: number;
  avgA: number;
  avgB: number;
  totalAs: number;
  totalBs: number;
  avgAs: string;
  avgBs: string;
  delta: string;
  deltaS: string;
}): string {
  const { model, providerName, results, totalA, totalB, avgA, avgB, totalAs, totalBs, avgAs, avgBs, delta, deltaS } = input;

  const sections: string[] = [];
  sections.push(`# A/B Test Report\n`);
  sections.push(`生成时间: ${new Date().toLocaleString("zh-CN")}\n`);
  sections.push(`## 配置\n`);
  sections.push(`- provider: ${providerName}`);
  sections.push(`- model: ${model}`);
  sections.push(`- maxTokens: ${MAX_TOKENS}`);
  sections.push(`- temperature: ${TEMPERATURE}`);
  sections.push(`- prompt 数: ${results.length}\n`);
  sections.push(`## 汇总\n`);
  sections.push(`| 指标 | A（裸 API） | B（RememberMe 完整） | Δ |`);
  sections.push(`|---|---|---|---|`);
  sections.push(`| 总字符 | ${totalA} | ${totalB} | ${delta}% |`);
  sections.push(`| 平均字符 | ${avgA} | ${avgB} | ${(((avgB - avgA) / avgA) * 100).toFixed(1)}% |`);
  sections.push(`| 总句子 | ${totalAs} | ${totalBs} | ${deltaS}% |`);
  sections.push(`| 平均句子 | ${avgAs} | ${avgBs} | ${(((Number(avgBs) - Number(avgAs)) / Number(avgAs)) * 100).toFixed(1)}% |\n`);
  sections.push(`## 详细对比\n`);

  results.forEach((r, i) => {
    const charDelta = ((r.bChars - r.aChars) / r.aChars * 100).toFixed(1);
    const sentDelta = r.aSentences === 0
      ? "—"
      : (((r.bSentences - r.aSentences) / r.aSentences) * 100).toFixed(1);
    sections.push(`### Prompt ${i + 1}: ${r.prompt}\n`);
    sections.push(`字符: A=${r.aChars}, B=${r.bChars} (${charDelta}%)`);
    sections.push(`句子: A=${r.aSentences}, B=${r.bSentences} (${sentDelta}%)`);
    sections.push(`耗时: A=${r.aMs}ms, B=${r.bMs}ms\n`);
    sections.push(`#### A 组\n`);
    sections.push("```");
    sections.push(r.aText.trim() || "（空）");
    sections.push("```\n");
    sections.push(`#### B 组\n`);
    sections.push("```");
    sections.push(r.bText.trim() || "（空）");
    sections.push("```\n");
  });

  return sections.join("\n");
}