/**
 * Wiki 批量分类器 - 按目录结构批量分析和分类文件
 *
 * 设计思路：
 * 1. 按源路径的父目录分组文件
 * 2. 对每个目录组，提取目录结构和文件预览
 * 3. 调用 AI 批量判断：大类、小类、user_path、tags、description
 * 4. 根据置信度决定是否自动应用
 */

import type { WikiInboxItem } from "./types.js";
import path from "node:path";

/**
 * 批量分类结果
 */
export interface BatchClassificationResult {
  /** 大类 */
  category: string;
  /** 小类 */
  subtopic: string | null;
  /** 用户路径（多级目录） */
  userPath: string[] | null;
  /** 标签 */
  tags: string[] | null;
  /** 描述 */
  description: string | null;
  /** 置信度 (0-1) */
  confidence: number;
  /** 决策依据 */
  reason: string;
}

/**
 * 目录分组
 */
export interface DirectoryGroup {
  /** 目录路径 */
  directory: string;
  /** 该目录下的文件 */
  items: WikiInboxItem[];
  /** 目录深度（相对于根目录） */
  depth: number;
}

/**
 * 按源路径的父目录对收件箱项目进行分组
 */
export function groupByDirectory(items: WikiInboxItem[], rootDir?: string): DirectoryGroup[] {
  const groups = new Map<string, WikiInboxItem[]>();

  for (const item of items) {
    if (!item.source_path) {
      // 没有路径的项目单独分组
      const key = "__no_path__";
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(item);
      continue;
    }

    // 提取父目录
    const dir = path.dirname(item.source_path);
    const normalizedDir = dir.replace(/\\/g, "/");

    if (!groups.has(normalizedDir)) {
      groups.set(normalizedDir, []);
    }
    groups.get(normalizedDir)!.push(item);
  }

  // 转换为 DirectoryGroup 数组
  const result: DirectoryGroup[] = [];
  for (const [dir, groupItems] of groups.entries()) {
    const depth = dir === "__no_path__" ? 0 : dir.split("/").length;
    result.push({
      directory: dir,
      items: groupItems,
      depth,
    });
  }

  // 按目录深度排序（先处理浅层目录）
  result.sort((a, b) => a.depth - b.depth);

  return result;
}

/**
 * 从文件路径中提取潜在的用户路径结构
 *
 * 例如：
 * - "C:/outputs/Lumii使用指南/assets/screenshot.png"
 *   → ["outputs", "Lumii使用指南", "assets"]
 */
export function extractUserPathFromFilePath(filePath: string, rootDir?: string): string[] | null {
  if (!filePath) return null;

  const normalized = filePath.replace(/\\/g, "/");
  const dir = path.dirname(normalized);

  // 如果提供了根目录，计算相对路径
  let relativePath = dir;
  if (rootDir) {
    const normalizedRoot = rootDir.replace(/\\/g, "/");
    if (dir.startsWith(normalizedRoot)) {
      relativePath = dir.substring(normalizedRoot.length).replace(/^\//, "");
    }
  }

  // 分割路径为数组
  const parts = relativePath.split("/").filter((p) => p && p !== ".");

  // 过滤掉常见的根级目录名
  const filtered = parts.filter((p) => {
    const lower = p.toLowerCase();
    return lower !== "c:" && lower !== "d:" && lower !== "users" && !lower.match(/^[a-z]:$/);
  });

  return filtered.length > 0 ? filtered : null;
}

/**
 * 从目录名和文件名中提取潜在的标签
 */
export function extractTagsFromPaths(items: WikiInboxItem[]): string[] {
  const tags = new Set<string>();

  for (const item of items) {
    // 从标题中提取关键词
    const titleWords = item.title.split(/[\s\-_\/\\]+/).filter((w) => w.length > 1);
    for (const word of titleWords) {
      tags.add(word);
    }

    // 从路径中提取目录名
    if (item.source_path) {
      const parts = item.source_path.split(/[\/\\]/).filter((p) => p && p !== ".");
      for (const part of parts) {
        // 跳过文件名本身
        if (part.includes(".")) continue;
        if (part.length > 1) {
          tags.add(part);
        }
      }
    }
  }

  // 限制标签数量，取最常见的
  return Array.from(tags).slice(0, 10);
}

/**
 * 生成目录结构的文本表示（用于 AI 提示）
 */
export function buildDirectoryTreeText(items: WikiInboxItem[], baseDir?: string): string {
  const lines: string[] = [];

  lines.push(`目录结构（共 ${items.length} 个文件）：`);
  lines.push("");

  for (const item of items.slice(0, 20)) {
    // 最多显示 20 个
    if (item.source_path) {
      const relativePath = baseDir
        ? path.relative(baseDir, item.source_path).replace(/\\/g, "/")
        : item.source_path;
      lines.push(`- ${relativePath}`);
    } else {
      lines.push(`- ${item.title}`);
    }
  }

  if (items.length > 20) {
    lines.push(`... 还有 ${items.length - 20} 个文件`);
  }

  return lines.join("\n");
}

/**
 * 生成内容预览（用于 AI 提示）
 */
export function buildContentPreview(items: WikiInboxItem[], maxItems: number = 5): string {
  const lines: string[] = [];

  lines.push(`内容预览（前 ${Math.min(maxItems, items.length)} 个文件）：`);
  lines.push("");

  for (const item of items.slice(0, maxItems)) {
    lines.push(`## ${item.title}`);
    if (item.content_preview) {
      const preview = item.content_preview.substring(0, 200);
      lines.push(preview);
      if (item.content_preview.length > 200) {
        lines.push("...");
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * 构建批量分类的 AI 提示词
 */
export function buildBatchClassificationPrompt(group: DirectoryGroup, topicTree: string): string {
  const directoryTree = buildDirectoryTreeText(group.items);
  const contentPreview = buildContentPreview(group.items);

  return `
你是一个文件分类助手。请根据以下信息，为这批文件确定合适的分类。

## 可用的分类体系

${topicTree}

## 要分析的文件

**目录**: ${group.directory === "__no_path__" ? "无路径" : group.directory}

${directoryTree}

${contentPreview}

## 分类任务

请分析这批文件的特点，并给出：

1. **大类** (category): 从可用分类体系中选择最合适的顶层分类
2. **小类** (subtopic): 选择对应的子分类
3. **用户路径** (userPath): 基于原始目录结构，提取有意义的层级路径（数组形式）
4. **标签** (tags): 3-5个描述内容性质的关键词
5. **描述** (description): 一句话描述这批文件的主题和用途
6. **置信度** (confidence): 0-1之间，表示你对这个分类的把握程度

## 输出格式

请以 JSON 格式输出：

\`\`\`json
{
  "category": "工作",
  "subtopic": "开发",
  "userPath": ["outputs", "项目文档"],
  "tags": ["文档", "API", "技术"],
  "description": "项目技术文档和API说明",
  "confidence": 0.9,
  "reason": "根据目录结构和文件内容，明确属于开发相关的技术文档"
}
\`\`\`

**重要提示**：
- 优先基于目录结构判断
- userPath 应该保留原始目录的语义结构
- tags 应该描述内容类型和主题，不是简单复制目录名
- confidence < 0.8 表示需要人工审查
`;
}
