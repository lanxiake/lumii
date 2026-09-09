/**
 * ToolQualityGate — 工具草稿质量门（纯规则，不调 LLM）
 *
 * 草稿进审批前必须全部通过，任一失败即丢弃：
 * 1. 定义静态合法（name kebab-case / schema 结构 / 占位符与参数双向一致）
 * 2. 样本回放：模板能覆盖 ≥80% 的观察样本（约束 LLM 不瞎编命令结构）
 * 3. 危险命令黑名单
 * 4. 与内置/已注册工具重名
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

export interface QualityGateResult {
  passed: boolean;
  errors: string[];
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

  // 4. 样本回放
  const normalize = opts.normalize ?? ((cmd: string) => cmd);
  const rate = sampleReplayRate(draft, pattern, normalize);
  const minRate = opts.minReplayRate ?? 0.8;
  if (rate < minRate) {
    errors.push(`样本回放还原率 ${Math.round(rate * 100)}% 低于阈值 ${Math.round(minRate * 100)}%`);
  }

  return { passed: errors.length === 0, errors };
}
