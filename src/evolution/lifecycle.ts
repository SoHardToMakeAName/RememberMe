// src/evolution/lifecycle.ts
// 自进化层：生命周期状态机
// 状态机设计（active → stale → archived）是 LLM agent 自维护的通用模式。
// 本项目独立实现。
// 状态机：
//   active ──(staleAfterDays 天无访问)──> stale
//   stale ──(再 archiveAfterDays 天无访问)──> archived
//   archived ──(用户重新访问)──> active
// 5 个不变量（自维护系统的设计原则）：
//   1. 只触碰自动提取的项（用户手写的不可动）
//   2. 永远不删，只归档（可恢复）
//   3. 固定的项（pinned）永不动
//   4. 用辅助 client（不污染主 session prompt cache）
//   5. 空闲触发，不依赖 cron daemon

export type LifecycleState = "active" | "stale" | "archived";

/** 默认配置：30 天无访问 → stale，60 天后 → archived */
export const DEFAULT_LIFECYCLE_CONFIG = {
  staleAfterDays: 30,
  archiveAfterDays: 60,
};

/** 每次"访问"的元数据：谁触发的、什么上下文 */
export type AccessRecord = {
  /** 访问时间（ms） */
  ts: number;
  /** 触发来源：用户对话 / 反思 / curator 重激活 / 等 */
  source: "conversation" | "reflection" | "curator" | "manual";
  /** 可选上下文：触发的那条用户消息 */
  context?: string;
};

/**
 * 单个条目的"生命周期元数据"。
 * 存放在 memory.ts / profile.ts 的 frontmatter 里（或者单独的 .meta.json 文件）。
 */
export type LifecycleMeta = {
  /** 状态 */
  state: LifecycleState;
  /** 创建时间（ms） */
  createdAt: number;
  /** 上次访问时间（ms） */
  lastAccessedAt: number;
  /** 累计访问次数 */
  accessCount: number;
  /** 是否被用户固定（pinned 永不动） */
  pinned: boolean;
  /** 访问历史（只保留最近 5 条，避免文件膨胀） */
  recentAccesses: AccessRecord[];
};

/**
 * 创建新条目的元数据。
 */
export function makeNewLifecycleMeta(now: number = Date.now()): LifecycleMeta {
  return {
    state: "active",
    createdAt: now,
    lastAccessedAt: now,
    accessCount: 0,
    pinned: false,
    recentAccesses: [],
  };
}

/**
 * 记录一次访问。
 * 永远更新 lastAccessedAt，count +1。
 * 不变量 #3：pinned 永远不会被改状态，但 lastAccessedAt 还是会更新（要"活"的）。
 */
export function recordAccess(
  meta: LifecycleMeta,
  record: Omit<AccessRecord, "ts">,
  now: number = Date.now(),
): LifecycleMeta {
  const newRecord: AccessRecord = { ...record, ts: now };
  return {
    ...meta,
    lastAccessedAt: now,
    accessCount: meta.accessCount + 1,
    recentAccesses: [newRecord, ...meta.recentAccesses].slice(0, 5),
  };
}

/**
 * 根据当前时间和上次访问时间，判定应该转移到的状态。
 *
 * 不变量 #2：永不删除，只归档。
 * 不变量 #3：pinned 永远保持 active。
 */
export function computeNextState(
  meta: LifecycleMeta,
  config: typeof DEFAULT_LIFECYCLE_CONFIG = DEFAULT_LIFECYCLE_CONFIG,
  now: number = Date.now(),
): LifecycleState {
  if (meta.pinned) return "active";
  if (meta.state === "active") {
    const daysSinceAccess = (now - meta.lastAccessedAt) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess >= config.staleAfterDays) return "stale";
    return "active";
  }
  if (meta.state === "stale") {
    const daysSinceAccess = (now - meta.lastAccessedAt) / (1000 * 60 * 60 * 24);
    if (daysSinceAccess >= config.staleAfterDays + config.archiveAfterDays) {
      return "archived";
    }
    return "stale";
  }
  // archived：保持 archived（用户重新访问会重新激活）
  return meta.state;
}

/**
 * 应用一次状态转移。
 * 返回新 metadata（不变性更新）。
 * 转移后会自动把 lastAccessedAt 重置为 now（因为 state 转移就是一次"事件"）。
 *
 * 不变量 #3：pinned 永远不动。
 */
export function transitionState(
  meta: LifecycleMeta,
  config: typeof DEFAULT_LIFECYCLE_CONFIG = DEFAULT_LIFECYCLE_CONFIG,
  now: number = Date.now(),
): LifecycleMeta {
  const next = computeNextState(meta, config, now);
  if (next === meta.state) return meta;
  return {
    ...meta,
    state: next,
    lastAccessedAt: now, // 状态转移本身算一次"事件"
  };
}

/**
 * 重新激活 archived 项（用户明确问起了这件事）。
 * 状态回到 active，lastAccessedAt 更新。
 */
export function reactivate(
  meta: LifecycleMeta,
  now: number = Date.now(),
): LifecycleMeta {
  if (meta.pinned) return { ...meta, lastAccessedAt: now };
  if (meta.state === "active") return { ...meta, lastAccessedAt: now };
  return {
    ...meta,
    state: "active",
    lastAccessedAt: now,
  };
}

/**
 * 批量应用状态转移（curator 用）。
 * 返回 { changed: LifecycleMeta[], skipped: number }
 */
export function transitionBatch<T extends { meta: LifecycleMeta }>(
  items: T[],
  config: typeof DEFAULT_LIFECYCLE_CONFIG = DEFAULT_LIFECYCLE_CONFIG,
  now: number = Date.now(),
): {
  changed: { item: T; oldState: LifecycleState; newState: LifecycleState }[];
  skipped: number;
} {
  const changed: { item: T; oldState: LifecycleState; newState: LifecycleState }[] = [];
  let skipped = 0;
  for (const item of items) {
    const next = computeNextState(item.meta, config, now);
    if (next === item.meta.state) {
      skipped++;
    } else {
      changed.push({ item, oldState: item.meta.state, newState: next });
    }
  }
  return { changed, skipped };
}
