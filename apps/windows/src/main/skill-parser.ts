/**
 * SKILL.md Frontmatter 解析器
 *
 * 支持 YAML 格式，包括多行文本（|、>、>-、|-）
 */

import type { SkillFrontmatter } from './types/skill-metadata';

/**
 * 解析 SKILL.md 的 frontmatter
 *
 * 支持 YAML 格式：
 * ---
 * name: skill-name
 * description: |
 *   Multi-line
 *   description here
 * version: 1.0.0
 * ---
 */
export function parseFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 检查是否有 frontmatter
  if (!normalized.startsWith('---')) {
    return {};
  }

  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return {};
  }

  const frontmatterBlock = normalized.slice(4, endIndex);
  return parseLineFrontmatter(frontmatterBlock);
}

/**
 * 逐行解析 frontmatter 内容，支持多行值
 */
function parseLineFrontmatter(block: string): SkillFrontmatter {
  const frontmatter: SkillFrontmatter = {};
  const lines = block.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const match = line.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      i++;
      continue;
    }

    const key = match[1];
    const inlineValue = match[2].trim();
    if (!key) {
      i++;
      continue;
    }

    // 处理 YAML 多行指示符（|、>、>-、|-）
    if (inlineValue === '|' || inlineValue === '>' || inlineValue === '>-' || inlineValue === '|-') {
      const { value, linesConsumed } = extractMultiLineValue(lines, i);
      if (value !== undefined) {
        frontmatter[key] = value;
      }
      i += linesConsumed;
      continue;
    }

    // 处理多行值（下一行有缩进）
    if (!inlineValue && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      if (nextLine.startsWith(' ') || nextLine.startsWith('\t')) {
        const { value, linesConsumed } = extractMultiLineValue(lines, i);
        if (value !== undefined) {
          frontmatter[key] = value;
        }
        i += linesConsumed;
        continue;
      }
    }

    const value = stripQuotes(inlineValue);
    if (value !== undefined) {
      frontmatter[key] = value;
    }
    i++;
  }

  return frontmatter;
}

/**
 * 提取多行值（从下一行开始，直到遇到非缩进行）
 */
function extractMultiLineValue(
  lines: string[],
  startIndex: number,
): { value: string; linesConsumed: number } {
  const valueLines: string[] = [];
  let i = startIndex + 1;
  while (i < lines.length) {
    const line = lines[i];
    // 非空行且没有缩进，表示多行值结束
    if (line.length > 0 && !line.startsWith(' ') && !line.startsWith('\t')) {
      break;
    }
    // 移除前导缩进并添加到值列表
    valueLines.push(line);
    i++;
  }
  // 将多行值合并为单个字符串，保留换行或使用空格
  const combined = valueLines.join('\n').trim();
  return { value: combined, linesConsumed: i - startIndex };
}

/**
 * 移除字符串首尾的引号
 */
function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
