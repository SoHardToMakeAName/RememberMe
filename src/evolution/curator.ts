// src/evolution/curator.ts
// 策展人：空闲触发的 3-pass 自我维护
// 3-pass 模式：状态转移 → 归档 → LLM 合并重复。
// 这是 LLM agent 通用模式（自维护 / auto-curation 是常见做法），本项目独立实现。
// 触发：每次启动 REPL 时检查"距上次策展"时间 + 用户活跃时间，空闲才跑。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  transitionBatch,
  type LifecycleMeta,
  type LifecycleState,
} from "./lifecycle.ts";
import { readRecentAccessEvents, aggregateAccessStats } from "./access-tracker.ts";

/** curator 状态（持久化在 dataDir/evolution/curator-state.json） */
export type CuratorState = {
  /** 上次跑 curator 的时间（ms） */
  lastRunAt: number;
  /** 累计跑了多少次 */
  runCount: number;
  /** 上次运行产生的状态变化数（仅显示用） */
  lastChanges: number;
  /** 是否暂停 */
  paused: boolean;
  /** 用户最小空闲小时数（默认 2h） */
  minIdleHours: number;
  /** 跑 curator 的最小间隔（默认 24h） */
  minIntervalHours: number;
};

export const DEFAULT_CURATOR_STATE: CuratorState = {
  lastRunAt: 0,
  runCount: 0,
  lastChanges: 0,
  paused: false,
  minIdleHours: 2,
  minIntervalHours: 24,
};

export const CURATOR_STATE_FILENAME = "curator-state.json";

function curatorStatePath(dataDir: string): string {
  return join(dataDir, "evolution", CURATOR_STATE_FILENAME);
}

export async function loadCuratorState(dataDir: string): Promise<CuratorState> {
  try {
    const raw = await readFile(curatorStatePath(dataDir), "utf-8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_CURATOR_STATE, ...parsed };
  } catch {
    return { ...DEFAULT_CURATOR_STATE };
  }
}

export async function saveCuratorState(
  dataDir: string,
  state: CuratorState,
): Promise<void> {
  try {
    await mkdir(join(dataDir, "evolution"), { recursive: true });
    await writeFile(
      curatorStatePath(dataDir),
      JSON.stringify(state, null, 2),
      "utf-8",
    );
  } catch {
    // 静默
  }
}

/** curator 单次运行的结果 */
export type CuratorRunResult = {
  pass1_marked: number;     // active → stale
  pass2_archived: number;   // stale → archived
  pass3_consolidated: number; // 合并的条目数（如果启用）
  skipped_pinned: number;
  skipped_no_change: number;
  durationMs: number;
};

/**
 * 是否应该现在跑 curator？
 * 条件：用户最后活跃 > minIdleHours 小时前 + 距上次策展 > minIntervalHours 小时前
 */
export function shouldRunCurator(
  state: CuratorState,
  lastUserActivityAt: number,
  now: number = Date.now(),
): { shouldRun: boolean; reason: string } {
  if (state.paused) {
    return { shouldRun: false, reason: "已暂停" };
  }

  const sinceLastRun = now - state.lastRunAt;
  const minIntervalMs = state.minIntervalHours * 3600 * 1000;
  if (state.lastRunAt > 0 && sinceLastRun < minIntervalMs) {
    const hoursLeft = ((minIntervalMs - sinceLastRun) / 3600000).toFixed(1);
    return { shouldRun: false, reason: `距上次策展 ${hoursLeft} 小时，间隔未到` };
  }

  const sinceActivity = now - lastUserActivityAt;
  const minIdleMs = state.minIdleHours * 3600 * 1000;
  if (lastUserActivityAt > 0 && sinceActivity < minIdleMs) {
    const minutesLeft = Math.ceil((minIdleMs - sinceActivity) / 60000);
    return { shouldRun: false, reason: `用户 ${minutesLeft} 分钟前还活跃，等空闲` };
  }

  return { shouldRun: true, reason: "可以跑" };
}

/**
 * 跑一次 curator（不含 LLM 合并——Pass 3 由调用方决定）。
 *
 * 输入：
 * - items: 待审查的条目（含 meta）
 * - dataDir: 用于读取 access-log
 * - config: 生命周期配置
 * - applyChanges: 把状态变化写回数据的回调（每个 item 一个）
 */
export async function runCurator<T extends { filename: string; meta: LifecycleMeta }>(
  items: T[],
  dataDir: string,
  options: {
    applyStateChange?: (item: T, oldState: LifecycleState, newState: LifecycleState) => void;
    config?: typeof DEFAULT_LIFECYCLE_CONFIG;
    now?: number;
  } = {},
): Promise<CuratorRunResult> {
  const start = Date.now();
  const config = options.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const now = options.now ?? Date.now();

  // 读取最近 90 天的访问记录（用 lastAccessedAt 来判断状态）
  const events = await readRecentAccessEvents(dataDir, 5000);
  const accessStats = aggregateAccessStats(events);

  // 把访问记录合并到 items 的 meta（如果 meta.lastAccessedAt 早于实际访问记录，就更新）
  // 这是为了"如果某个 memory 文件没在这次对话里被显式引用，但历史上被用过，就别误判为 stale"
  const updatedItems = items.map((item) => {
    const stat = accessStats.get(item.filename);
    if (stat && stat.lastAccessedAt > item.meta.lastAccessedAt) {
      return {
        ...item,
        meta: {
          ...item.meta,
          lastAccessedAt: stat.lastAccessedAt,
          accessCount: stat.count,
        },
      };
    }
    return item;
  });

  // Pass 1: 状态转移（active → stale / archived）
  const transition = transitionBatch(updatedItems, config, now);
  let pass1 = 0;
  let pass2 = 0;
  let skippedPinned = 0;
  let skippedNoChange = transition.skipped;

  for (const c of transition.changed) {
    if (c.oldState === "active" && c.newState === "stale") pass1++;
    if (c.oldState === "stale" && c.newState === "archived") pass2++;

    // pinned 永远不动（不变量 #3）
    if (c.item.meta.pinned) {
      skippedPinned++;
      continue;
    }

    // 调用回调（让调用方把状态写回磁盘）
    options.applyStateChange?.(c.item, c.oldState, c.newState);
  }

  // 累加 pinned 到 skipped（不变量 #3 验证）
  skippedNoChange += skippedPinned;

  return {
    pass1_marked: pass1,
    pass2_archived: pass2,
    pass3_consolidated: 0, // 由调用方单独跑
    skipped_pinned: skippedPinned,
    skipped_no_change: skippedNoChange,
    durationMs: Date.now() - start,
  };
}

/**
 * 更新 curator 状态（用 run 后）。
 */
export function recordCuratorRun(
  state: CuratorState,
  result: CuratorRunResult,
  now: number = Date.now(),
): CuratorState {
  return {
    ...state,
    lastRunAt: now,
    runCount: state.runCount + 1,
    lastChanges:
      result.pass1_marked + result.pass2_archived + result.pass3_consolidated,
  };
}

/**
 * 重新激活 archived 项（用户手动 `/reactivate <id>`）。
 * 从 caller 传入。
 */
export function shouldReactivate(
  meta: LifecycleMeta,
  now: number = Date.now(),
): boolean {
  return (
    meta.state === "archived" &&
    (now - meta.lastAccessedAt) / (1000 * 60 * 60 * 24) > 7
  );
}
