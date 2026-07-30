// tests/evolution.test.ts
// v0.12 自进化层测试

import { describe, it, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";
import {
  makeNewLifecycleMeta,
  recordAccess,
  computeNextState,
  transitionState,
  transitionBatch,
  reactivate,
  DEFAULT_LIFECYCLE_CONFIG,
  type LifecycleMeta,
} from "../src/evolution/lifecycle.ts";
import {
  recordAccessEvent,
  readRecentAccessEvents,
  aggregateAccessStats,
  buildEventsFromMemoryFiles,
} from "../src/evolution/access-tracker.ts";
import {
  loadCuratorState,
  saveCuratorState,
  shouldRunCurator,
  runCurator,
  recordCuratorRun,
  DEFAULT_CURATOR_STATE,
  type CuratorState,
} from "../src/evolution/curator.ts";

describe("lifecycle 状态机", () => {
  const now = Date.now();
  const day = 24 * 3600 * 1000;

  it("新条目是 active", () => {
    const meta = makeNewLifecycleMeta(now);
    expect(meta.state).toBe("active");
    expect(meta.accessCount).toBe(0);
    expect(meta.pinned).toBe(false);
  });

  it("active 30 天无访问 → stale", () => {
    const meta = makeNewLifecycleMeta(now);
    const future = now + 31 * day;
    expect(computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, future)).toBe("stale");
  });

  it("active 不到 30 天 → 保持 active", () => {
    const meta = makeNewLifecycleMeta(now);
    const future = now + 5 * day;
    expect(computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, future)).toBe("active");
  });

  it("stale 90 天无访问 → archived（30+60=90）", () => {
    const meta: LifecycleMeta = {
      ...makeNewLifecycleMeta(now),
      state: "stale",
      lastAccessedAt: now,
    };
    const future = now + 91 * day;
    expect(computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, future)).toBe("archived");
  });

  it("stale 不到 90 天 → 保持 stale", () => {
    const meta: LifecycleMeta = {
      ...makeNewLifecycleMeta(now),
      state: "stale",
      lastAccessedAt: now,
    };
    const future = now + 50 * day;
    expect(computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, future)).toBe("stale");
  });

  it("不变量 #3: pinned 永不动", () => {
    const meta: LifecycleMeta = {
      ...makeNewLifecycleMeta(now - 1000 * day),
      pinned: true,
    };
    expect(computeNextState(meta, DEFAULT_LIFECYCLE_CONFIG, now)).toBe("active");
  });

  it("recordAccess 更新 lastAccessedAt + count", () => {
    const meta = makeNewLifecycleMeta(now);
    const after = recordAccess(meta, { source: "conversation" }, now + 5000);
    expect(after.lastAccessedAt).toBe(now + 5000);
    expect(after.accessCount).toBe(1);
    expect(after.recentAccesses.length).toBe(1);
  });

  it("recordAccess 保留最近 5 条", () => {
    let meta = makeNewLifecycleMeta(now);
    for (let i = 0; i < 10; i++) {
      meta = recordAccess(meta, { source: "conversation" }, now + i * 1000);
    }
    expect(meta.recentAccesses.length).toBe(5);
  });

  it("reactivate archived → active", () => {
    const meta: LifecycleMeta = {
      ...makeNewLifecycleMeta(now),
      state: "archived",
    };
    const reactivated = reactivate(meta, now + 1000);
    expect(reactivated.state).toBe("active");
    expect(reactivated.lastAccessedAt).toBe(now + 1000);
  });

  it("transitionBatch 正确分类 changed / skipped", () => {
    const items = [
      {
        filename: "old.md",
        meta: {
          ...makeNewLifecycleMeta(now - 100 * day),
          state: "stale" as const,
        },
      },
      {
        filename: "fresh.md",
        meta: makeNewLifecycleMeta(now),
      },
      {
        filename: "pinned.md",
        meta: {
          ...makeNewLifecycleMeta(now - 1000 * day),
          pinned: true,
        },
      },
    ];
    const result = transitionBatch(items, DEFAULT_LIFECYCLE_CONFIG, now);
    // old.md: stale → archived (changed)
    // fresh.md: active (skipped)
    // pinned.md: active (skipped, 不动)
    expect(result.changed.length).toBe(1);
    expect(result.changed[0].oldState).toBe("stale");
    expect(result.changed[0].newState).toBe("archived");
    expect(result.skipped).toBe(2);
  });
});

describe("access-tracker", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ec-acc-"));
  });

  it("record + read 闭环", async () => {
    await recordAccessEvent(tmpDir, {
      ts: 1000,
      kind: "memory",
      itemId: "user-pref.md",
      source: "conversation",
    });
    await recordAccessEvent(tmpDir, {
      ts: 2000,
      kind: "profile",
      itemId: "沟通风格",
      source: "reflection",
    });
    const events = await readRecentAccessEvents(tmpDir);
    expect(events.length).toBe(2);
    expect(events[0].itemId).toBe("user-pref.md");
    expect(events[1].source).toBe("reflection");
  });

  it("aggregateAccessStats 正确合并多次访问", () => {
    const events = [
      { ts: 1000, kind: "memory" as const, itemId: "a.md", source: "conversation" as const },
      { ts: 2000, kind: "memory" as const, itemId: "a.md", source: "conversation" as const },
      { ts: 3000, kind: "memory" as const, itemId: "b.md", source: "conversation" as const },
    ];
    const map = aggregateAccessStats(events);
    expect(map.get("a.md")?.count).toBe(2);
    expect(map.get("a.md")?.lastAccessedAt).toBe(2000);
    expect(map.get("b.md")?.count).toBe(1);
  });

  it("buildEventsFromMemoryFiles 正确转换", () => {
    const events = buildEventsFromMemoryFiles(1000, ["a.md", "b.md"]);
    expect(events).toHaveLength(2);
    expect(events[0].kind).toBe("memory");
    expect(events[0].itemId).toBe("a.md");
    expect(events[0].ts).toBe(1000);
  });

  it("文件不存在时不报错，返回空数组", async () => {
    const events = await readRecentAccessEvents(tmpDir);
    expect(events).toEqual([]);
  });
});

describe("curator 状态与触发逻辑", () => {
  const now = Date.now();
  const hour = 3600 * 1000;
  const day = 24 * hour;

  it("首次运行（lastRunAt=0）应该跑", () => {
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE };
    const result = shouldRunCurator(state, now - 5 * hour, now);
    expect(result.shouldRun).toBe(true);
  });

  it("刚跑过 + 不到 24h 间隔 → 不跑", () => {
    const state: CuratorState = {
      ...DEFAULT_CURATOR_STATE,
      lastRunAt: now - 5 * hour,
    };
    const result = shouldRunCurator(state, now - 100 * hour, now);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toContain("间隔");
  });

  it("用户最近活跃 → 不跑（避免打扰）", () => {
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE };
    const result = shouldRunCurator(state, now - 30 * 60 * 1000, now);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toContain("活跃");
  });

  it("已暂停 → 不跑", () => {
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE, paused: true };
    const result = shouldRunCurator(state, now - 100 * hour, now);
    expect(result.shouldRun).toBe(false);
    expect(result.reason).toBe("已暂停");
  });

  it("loadCuratorState 第一次返回默认", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ec-cur-"));
    try {
      const state = await loadCuratorState(tmpDir);
      expect(state.lastRunAt).toBe(0);
      expect(state.paused).toBe(false);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("saveCuratorState + loadCuratorState 闭环", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "ec-cur-"));
    try {
      const state: CuratorState = {
        lastRunAt: 1234,
        runCount: 5,
        lastChanges: 3,
        paused: true,
        minIdleHours: 1,
        minIntervalHours: 12,
      };
      await saveCuratorState(tmpDir, state);
      const loaded = await loadCuratorState(tmpDir);
      expect(loaded.lastRunAt).toBe(1234);
      expect(loaded.runCount).toBe(5);
      expect(loaded.paused).toBe(true);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("curator.runCurator 主流程", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "ec-cur-"));
  const now = Date.now();
  const day = 24 * 3600 * 1000;

  it("Pass 1: active → stale（30+ 天无访问）", async () => {
    const items = [
      {
        filename: "old-active.md",
        meta: {
          ...makeNewLifecycleMeta(now - 40 * day),
          state: "active" as const,
        },
      },
      {
        filename: "fresh.md",
        meta: makeNewLifecycleMeta(now),
      },
    ];
    let callbackCount = 0;
    const result = await runCurator(items, tmpDir, {
      applyStateChange: (item) => {
        item.meta.state = "stale" as const;
        callbackCount++;
      },
    });
    expect(result.pass1_marked).toBe(1);
    expect(callbackCount).toBe(1);
    expect(result.skipped_no_change).toBeGreaterThanOrEqual(1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("Pass 2: stale → archived（90+ 天）", async () => {
    const items = [
      {
        filename: "very-old.md",
        meta: {
          ...makeNewLifecycleMeta(now - 100 * day),
          state: "stale" as const,
        },
      },
    ];
    const result = await runCurator(items, tmpDir, {
      applyStateChange: (item) => {
        item.meta.state = "archived" as const;
      },
    });
    expect(result.pass2_archived).toBe(1);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("不变量 #3: pinned 永不被自动转移", async () => {
    const items = [
      {
        filename: "pinned.md",
        meta: {
          ...makeNewLifecycleMeta(now - 1000 * day),
          state: "active" as const,
          pinned: true,
        },
      },
    ];
    let changed = false;
    await runCurator(items, tmpDir, {
      applyStateChange: () => {
        changed = true;
      },
    });
    expect(changed).toBe(false);
    expect(items[0].meta.state).toBe("active");
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("recordCuratorRun 更新状态", () => {
    const state: CuratorState = { ...DEFAULT_CURATOR_STATE };
    const result = {
      pass1_marked: 3,
      pass2_archived: 1,
      pass3_consolidated: 0,
      skipped_pinned: 2,
      skipped_no_change: 5,
      durationMs: 100,
    };
    const updated = recordCuratorRun(state, result, now);
    expect(updated.runCount).toBe(1);
    expect(updated.lastRunAt).toBe(now);
    expect(updated.lastChanges).toBe(4); // 3 + 1 + 0
  });
});
