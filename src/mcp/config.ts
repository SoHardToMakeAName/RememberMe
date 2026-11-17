// src/mcp/config.ts
//
// MCP server 的路径与配置解析。
//
// 为什么单独一个文件：MCP server 进程的 cwd 由**客户端**决定
//（Claude Desktop 可能从任意目录启动），所以：
//   - 绝不能用 process.cwd()/data 找数据（web.ts 现在就有这个毛病）
//   - 数据目录必须是绝对路径，且优先落在用户目录（~/.rememberme/）
//     —— npm 安装后 node_modules 不可写、且升级会被覆盖
//
// 解析优先级：
//   1. REMEMBERME_DATA_DIR 环境变量（显式指定，最高优先级）
//   2. settings.json 里的 dataDir
//   3. ~/.rememberme/data（默认）

import { homedir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";

/** 本文件所在目录（Node 兼容写法，不用 Bun 专属的 import.meta.dir） */
const HERE = dirname(fileURLToPath(import.meta.url));

/** settings.json 的候选位置（按优先级） */
function settingsCandidates(): string[] {
  const list: string[] = [];
  // 1. 环境变量显式指定
  const fromEnv = process.env.REMEMBERME_SETTINGS;
  if (fromEnv?.trim()) list.push(resolve(fromEnv.trim()));
  // 2. 用户目录
  list.push(join(homedir(), ".rememberme", "settings.json"));
  // 3. 包目录（开发态：项目根 = src/mcp/ 的上两级）
  list.push(resolve(HERE, "..", "..", "settings.json"));
  return list;
}

/** 找到第一个存在的 settings.json；都没有就返回 null */
export function resolveSettingsPath(): string | null {
  for (const p of settingsCandidates()) {
    if (existsSync(p)) return p;
  }
  return null;
}

type SettingsFile = {
  env?: Record<string, string>;
  dataDir?: string;
};

/** 读 settings.json（读不到就返回空对象） */
export function loadSettings(): SettingsFile {
  const path = resolveSettingsPath();
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as SettingsFile;
  } catch {
    return {};
  }
}

/**
 * 解析数据根目录（绝对路径）。
 *
 * 注意：这里返回的是**数据根**（含 memory/ profile/ timeline/ sessions/ …），
 * 不是 data/ 的父目录。
 */
export function resolveDataDir(): string {
  // 1. 环境变量
  const fromEnv = process.env.REMEMBERME_DATA_DIR?.trim();
  if (fromEnv) {
    return isAbsolute(fromEnv) ? fromEnv : resolve(fromEnv);
  }

  // 2. settings.json
  const settings = loadSettings();
  if (settings.dataDir?.trim()) {
    const d = settings.dataDir.trim();
    return isAbsolute(d) ? d : resolve(d);
  }

  // 3. 默认
  return join(homedir(), ".rememberme", "data");
}

/** 派生路径 */
export const paths = {
  get data() {
    return resolveDataDir();
  },
  get memory() {
    return join(resolveDataDir(), "memory");
  },
  get profile() {
    return join(resolveDataDir(), "profile");
  },
  get timeline() {
    return join(resolveDataDir(), "timeline");
  },
  get sessions() {
    return join(resolveDataDir(), "sessions");
  },
  get learnedPrefs() {
    return join(resolveDataDir(), "learned-prefs");
  },
  get personality() {
    return join(resolveDataDir(), "personality");
  },
};
