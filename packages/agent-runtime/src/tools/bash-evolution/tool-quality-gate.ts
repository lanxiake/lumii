/**
 * ToolQualityGate — 工具草稿质量门（纯规则，不调 LLM）
 *
 * 草稿进审批前必须全部通过，任一失败即丢弃：
 * 1. 定义静态合法（name kebab-case / schema 结构 / 占位符与参数双向一致）
 * 2. 样本回放：模板能覆盖 ≥80% 的观察样本（约束 LLM 不瞎编命令结构）
 * 3. 危险命令黑名单
 * 4. 与内置/已注册工具重名
 * 5. 开放式低价值模板（近似 bash，约束面不缩小）
 */

import {
  extractPlaceholders,
  validateTemplateToolDefinition,
  type TemplateToolDefinition,
} from "../template-tool.js";
import type { CommandPattern } from "./command-miner.js";

/** 危险命令黑名单（模板小写后子串匹配） */
const DANGEROUS_PATTERNS = [
  "rm -rf",
  "rm -fr",
  "git reset --hard",
  "git push --force",
  "git push -f",
  "drop table",
  "drop database",
  "truncate table",
  "chmod -R 777",
  "chmod 777 /",
  "mkfs",
  ":(){ :|:& };:",
  "curl", // curl 直接下载执行类命令一律拒绝（含 curl | sh）
  "wget",
  "> /dev/sd",
  "dd if=",
] as const;

/** 内置工具名（不可重名覆盖） */
const RESERVED_TOOL_NAMES = new Set([
  "bash", "file_read", "file_write", "file_edit", "file_copy", "file_move",
  "file_mkdir", "file_delete", "glob", "grep", "list_dir", "skill_list",
  "skill_search", "skill_invoke", "task_complete", "todo_write", "spawn_agent",
  "send_message", "ask_user_question",
]);

/** 常见解释器：其后若几乎全是占位符，则近似开放 bash */
const INTERPRETER_SKELETON_RE =
  /^(node|nodejs|npx|python3?|pwsh|powershell|bash|sh|cmd(?:\.exe)?|deno|bun)(\s+(-NoProfile|-ExecutionPolicy\s+Bypass))*$/i;

/** 尾部可拼接任意命令的占位符名 */
const OPEN_TRAILING_PARAM_RE = /(chain|command|cmd|args|post)/i;

export interface QualityGateResult {
  passed: boolean;
  errors: string[];
}

/**
 * 判断模板是否「近似开放 bash」（工具化价值低）。
 * 返回拒绝原因；通过则返回 null。
 */
export function openTemplateRejectionReason(template: string): string | null {
  const t = template.trim();
  if (!t) return "命令模板为空";

  // 1. 以占位符开头 → 可注入任意前置命令
  if (/^\{\{/.test(t)) {
    return "模板以参数占位符开头，可注入任意前置命令";
  }

  const placeholders = extractPlaceholders(t);
  const skeleton = t.replace(/\{\{[^}]+\}\}/g, "").replace(/\s+/g, " ").trim();

  // 2. 固定骨架过短且占位符过多
  if (placeholders.length >= 2 && skeleton.length < 12) {
    return "固定命令骨架过短，参数过多，近似开放 bash";
  }

  // 3. 解释器 + 仅占位符参数
  if (INTERPRETER_SKELETON_RE.test(skeleton) && placeholders.length >= 1) {
    return "解释器后几乎全是开放参数，工具化价值低";
  }

  // 4. 尾部链式/命令类开放参数
  const trailing = t.match(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}\s*$/);
  if (trailing?.[1] && OPEN_TRAILING_PARAM_RE.test(trailing[1])) {
    return `尾部开放参数「${trailing[1]}」可拼接任意命令，工具化价值低`;
  }

  return null;
}

/** 把模板正则化：占位符 → 捕获组，用于样本回放匹配 */
function templateToRegex(template: string): RegExp {
  const escaped = template.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withGroups = escaped.replace(
    /\\\{\\\{([A-Za-z][A-Za-z0-9_]*)\\\}\\\}/g,
    "(.+)",
  );
  return new RegExp(`^${withGroups}$`);
}

/**
 * 样本回放：统计样本中能被模板完整匹配的比例。
 * 匹配同时尝试两个口径：原始样本（LLM 草拟基于原文，模板可能保留引号等结构）
 * 与规则归一化样本（挖掘粗模式口径），任一命中即算覆盖。
 */
export function sampleReplayRate(
  def: TemplateToolDefinition,
  pattern: CommandPattern,
  normalize: (command: string) => string,
): number {
  if (pattern.samples.length === 0) return 1;
  const placeholders = extractPlaceholders(def.commandTemplate);
  if (placeholders.length === 0) return 0;

  const regex = templateToRegex(def.commandTemplate);
  let matched = 0;
  for (const sample of pattern.samples) {
    if (regex.test(sample) || regex.test(normalize(sample))) matched++;
  }
  return matched / pattern.samples.length;
}

/**
 * 校验工具草稿。返回错误列表，空数组 = 通过。
 */
export function checkToolDraft(
  draft: TemplateToolDefinition,
  pattern: CommandPattern,
  opts: {
    /** 已注册工具名（追加到保留名之外） */
    registeredNames?: readonly string[];
    /** 样本归一化函数（默认使用粗模式自身——调用方应传入与挖掘一致的 normalizeCommand） */
    normalize?: (command: string) => string;
    /** 回放最低还原率（默认 0.8） */
    minReplayRate?: number;
  } = {},
): QualityGateResult {
  const errors: string[] = [];

  // 1. 静态合法性
  errors.push(...validateTemplateToolDefinition(draft));

  // 2. 危险黑名单（模板小写化后子串匹配）
  const lowered = draft.commandTemplate.toLowerCase();
  for (const bad of DANGEROUS_PATTERNS) {
    if (lowered.includes(bad)) {
      errors.push(`模板命中危险命令黑名单：${bad}`);
      break;
    }
  }

  // 3. 重名检查
  const registered = new Set([...RESERVED_TOOL_NAMES, ...(opts.registeredNames ?? [])]);
  if (registered.has(draft.name)) {
    errors.push(`工具名 "${draft.name}" 与现有工具重名`);
  }

  // 4. 开放式低价值模板
  const openReason = openTemplateRejectionReason(draft.commandTemplate);
  if (openReason) {
    errors.push(openReason);
  }

  // 5. 样本回放
  const normalize = opts.normalize ?? ((cmd: string) => cmd);
  const rate = sampleReplayRate(draft, pattern, normalize);
  const minRate = opts.minReplayRate ?? 0.8;
  if (rate < minRate) {
    errors.push(`样本回放还原率 ${Math.round(rate * 100)}% 低于阈值 ${Math.round(minRate * 100)}%`);
  }

  return { passed: errors.length === 0, errors };
}
