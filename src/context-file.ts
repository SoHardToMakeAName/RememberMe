// src/context-file.ts
// 纯 Markdown 格式的 profile / personality 文件解析器。
//
// 格式约定（统一）：
//   # <name>                              ← H1 = name
//
//   - **类型**：personality | profile     ← 元数据列表（可选）
//   - **版本**：1.0.0
//   - **作者**：xxx
//   - **描述**：xxx
//
//   <正文：自由格式 / 或 6 段结构（profile）>   ← 元数据列表之后的所有内容
//
// 元数据列表结束标志：第一个 ## 标题 或 非列表行
//
// 互换性（保持纯 Markdown）：
//   PROFILE.md 复制到 personality/ → loadPersonality 成功
//   personality/*.md 复制到 data/profile/ → loadProfile 成功
//
// 完全去掉 YAML frontmatter（--- 分隔符），
// 对非技术用户更友好。

import { join } from "node:path";

// =====================================================================
// Profile 6 段（这里定义，profile.ts re-export）
// =====================================================================

export const PROFILE_SECTIONS = [
  "基本信息",
  "沟通风格",
  "关注议题",
  "已知偏好与禁忌",
  "长期情绪基线",
  "近期变化",
] as const;

export type ProfileSection = (typeof PROFILE_SECTIONS)[number];

// =====================================================================
// 类型
// =====================================================================

export type ContextFileKind = "personality" | "profile";

export type ContextFileMeta = {
  name: string;
  version: string;
  description: string;
  author: string;
  kind: ContextFileKind;
};

/** 解析后的文件。 */
export type ContextFile = {
  meta: ContextFileMeta;
  /** body（不含 H1 和元数据列表） */
  body: string;
  /**
   * 如果 body 含 6 段 ## 结构，则提取；否则 undefined。
   */
  structuredSections?: Record<ProfileSection, string>;
  /** 完整原始文本（用于 round-trip 序列化） */
  raw: string;
  /** 文件路径 */
  sourcePath: string;
};

// =====================================================================
// 元数据键名映射
// =====================================================================

/**
 * 元数据列表的 key → meta 字段映射（支持中英文）。
 */
const META_KEY_MAP: Record<string, keyof ContextFileMeta> = {
  类型: "kind",
  kind: "kind",
  版本: "version",
  version: "version",
  作者: "author",
  author: "author",
  描述: "description",
  description: "description",
  名称: "name",
  name: "name",
};

// =====================================================================
// 解析
// =====================================================================

/**
 * 从纯 Markdown 文件中提取 H1（name）和元数据列表。
 *
 * 返回：
 *   - name: 第一个 H1 的文本（去掉前缀 # 和首尾空白）
 *   - meta: 解析出的元数据
 *   - body: 元数据列表之后的所有内容（已 trim）
 *   - bodyStartLine: body 在 raw 中的起始行号（用于 6 段检测）
 */
function extractMarkdownMetadata(raw: string): {
  name: string;
  meta: ContextFileMeta;
  body: string;
} {
  const lines = raw.split("\n");

  // 默认 meta
  const meta: ContextFileMeta = {
    name: "",
    version: "0.0.0",
    description: "",
    author: "unknown",
    kind: "personality",
  };

  let i = 0;

  // 1. 跳过前导空行
  while (i < lines.length && lines[i].trim() === "") i++;

  // 2. 找第一个 H1
  let name = "";
  if (i < lines.length && /^#\s+/.test(lines[i])) {
    name = lines[i].replace(/^#\s+/, "").trim();
    meta.name = name;
    i++;
  }

  // 3. 跳到元数据列表（跳过 H1 后的空行）
  while (i < lines.length && lines[i].trim() === "") i++;

  // 4. 读取连续的元数据列表项（- **key**：value）
  //    结束条件：第一个 ## 标题 / 非列表行
  while (i < lines.length) {
    const line = lines[i];
    // 元数据项正则：- **key** [:：] value
    // 支持中文冒号（：U+FF1A）和英文冒号（:）
    const m = line.match(
      /^-\s+\*\*(.+?)\*\*\s*[:：]\s*(.*?)\s*$/,
    );
    if (m) {
      const key = m[1].trim();
      const value = m[2].trim();
      const metaKey = META_KEY_MAP[key] ?? META_KEY_MAP[key.toLowerCase()];
      if (metaKey === "kind") {
        meta.kind = value === "profile" ? "profile" : "personality";
      } else if (metaKey) {
        // Type assertion：metaKey is a keyof ContextFileMeta
        (meta as Record<string, string>)[metaKey] = value;
      }
      i++;
    } else if (line.trim() === "") {
      // 空行：跳过（但如果下一个非空行不是列表项，结束元数据块）
      const next = i + 1;
      if (
        next < lines.length &&
        lines[next].trim() !== "" &&
        !/^-\s+/.test(lines[next])
      ) {
        i++;
        break;
      }
      i++;
    } else {
      // 非列表、非空行 → 元数据块结束
      break;
    }
  }

  // 5. body = 剩余所有行
  const body = lines.slice(i).join("\n").trim();

  return { name, meta, body };
}

/**
 * 解析上下文文件（personality 或 profile），返回统一结构。
 */
export function parseContextFile(
  raw: string,
  sourcePath: string,
): ContextFile {
  const { meta, body } = extractMarkdownMetadata(raw);
  const structuredSections = tryParseStructuredSections(body);

  return {
    meta,
    body,
    structuredSections,
    raw,
    sourcePath,
  };
}

// =====================================================================
// 6 段结构检测
// =====================================================================

/**
 * 检测 body 是否含 6 段 PROFILE_SECTIONS 结构。
 */
function tryParseStructuredSections(
  body: string,
): Record<ProfileSection, string> | undefined {
  const lines = body.split("\n");
  const sectionStarts: { name: string; lineIdx: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+?)\s*$/);
    if (m) {
      const rawName = m[1].trim();
      const stripped = rawName.replace(/^\d+\.\s*/, "");
      sectionStarts.push({ name: stripped, lineIdx: i });
    }
  }

  const hasStructuredSection = sectionStarts.some((s) =>
    (PROFILE_SECTIONS as readonly string[]).includes(s.name),
  );
  if (!hasStructuredSection) return undefined;

  const sections = {} as Record<ProfileSection, string>;
  for (const s of PROFILE_SECTIONS) sections[s] = "";

  for (let i = 0; i < sectionStarts.length; i++) {
    const { name, lineIdx } = sectionStarts[i];
    const nextIdx =
      i + 1 < sectionStarts.length ? sectionStarts[i + 1].lineIdx : lines.length;
    const sectionBody = lines.slice(lineIdx + 1, nextIdx).join("\n").trim();

    if ((PROFILE_SECTIONS as readonly string[]).includes(name)) {
      sections[name as ProfileSection] = sectionBody;
    }
  }

  return sections;
}

// =====================================================================
// 序列化
// =====================================================================

/**
 * 把 meta + body 序列化成纯 Markdown 文件。
 *
 * 格式：
 *   # <name>
 *
 *   - **类型**：<kind>
 *   - **版本**：<version>
 *   - **作者**：<author>
 *   - **描述**：<description>
 *
 *   <body>
 *
 * 如果 meta.name 为空但 body 第一行是 H1，name 用 body 里的 H1。
 */
export function serializeContextFile(
  meta: ContextFileMeta,
  body: string,
): string {
  // 优先用 meta.name；如果是 profile 默认空（但 default template 给了名字）
  const name = meta.name || "未命名";

  const metaLines: string[] = [];
  if (meta.kind) {
    metaLines.push(`- **类型**：${meta.kind}`);
  }
  if (meta.version && meta.version !== "0.0.0") {
    metaLines.push(`- **版本**：${meta.version}`);
  }
  if (meta.author && meta.author !== "unknown") {
    metaLines.push(`- **作者**：${meta.author}`);
  }
  if (meta.description) {
    metaLines.push(`- **描述**：${meta.description}`);
  }

  const parts: string[] = [`# ${name}`, ""];
  if (metaLines.length > 0) {
    parts.push(metaLines.join("\n"), "");
  }
  if (body.trim()) {
    parts.push(body.trim());
  }

  return parts.join("\n") + "\n";
}

// =====================================================================
// 路径工具
// =====================================================================

export const PROFILE_FILENAME = "PROFILE.md";

/**
 * 拼出 profile 文件路径。约定：<dataDir>/profile/PROFILE.md。
 */
export function getProfilePath(dataDir: string): string {
  return join(dataDir, "profile", PROFILE_FILENAME);
}