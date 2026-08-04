/**
 * 个人记忆智能整理
 *
 * 将新提取的候选记忆与历史个人记忆一并交给 LLM 去重、合并、冲突消解，
 * 输出整理后的完整 Markdown 文档（替代简单末尾追加）。
 * 支持「仅整理已有记忆、无新候选」模式。
 */

import type { ExtractedCandidate } from "./types.js";
import { buildMemoryArchitectureSection } from "./memory-architecture.js";

/** 个人记忆整理结果 */
export interface ConsolidationResult {
  readonly content: string;
  readonly merged: boolean;
}

/** 整理触发原因（日志/调试） */
export type ConsolidationTrigger =
  | "new_candidates"
  | "existing_duplicates"
  | "existing_conflicts"
  | "existing_oversized";

/**
 * 检测个人记忆是否需要主动整理（无新候选时也可触发）
 */
export function needsPersonalMemoryConsolidation(content: string): {
  readonly needed: boolean;
  readonly trigger?: ConsolidationTrigger;
} {
  const trimmed = content.trim();
  if (!trimmed) return { needed: false };

  const lines = trimmed.split("\n").filter((l) => l.trim().startsWith("-"));

  // 工具/方法冲突：generate_image.py 与 image_generate 并存
  const hasScript = /generate_image\.py/.test(trimmed);
  const hasTool = /\bimage_generate\b/.test(trimmed);
  if (hasScript && hasTool) {
    return { needed: true, trigger: "existing_conflicts" };
  }

  // 重复规则：同一规则主体出现多次（取「原因」前的核心表述）
  const rulePrefixes: string[] = [];
  for (const line of lines) {
    const m = line.match(/规则[：:]\s*(.+?)(?:\s*原因[：:]|$)/);
    if (m?.[1]) {
      const core = m[1].trim().replace(/[。.]\s*$/, "").slice(0, 32);
      if (core.length >= 6) rulePrefixes.push(core);
    }
  }
  const prefixCounts = new Map<string, number>();
  for (const p of rulePrefixes) {
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  if ([...prefixCounts.values()].some((c) => c >= 2)) {
    return { needed: true, trigger: "existing_duplicates" };
  }

  // project 快照堆积：同一项目主题重复出现多次（「项目：xxx」格式）
  const projectTitles: string[] = [];
  for (const line of lines) {
    const m = line.match(/项目[：:]\s*(.+?)(?:\s*[。.状态]|$)/);
    if (m?.[1]) {
      const core = m[1].trim().slice(0, 40);
      if (core.length >= 8) projectTitles.push(core);
    }
  }
  const projectCounts = new Map<string, number>();
  for (const title of projectTitles) {
    projectCounts.set(title, (projectCounts.get(title) ?? 0) + 1);
  }
  if ([...projectCounts.values()].some((c) => c >= 3)) {
    return { needed: true, trigger: "existing_duplicates" };
  }

  // 高度重复列表项
  if (lines.length >= 12) {
    const keys = lines.map((l) => l.trim().slice(0, 48));
    const uniqueRatio = new Set(keys).size / keys.length;
    if (uniqueRatio < 0.72) {
      return { needed: true, trigger: "existing_duplicates" };
    }
  }

  // 过长且规则条目过多
  const ruleCount = (trimmed.match(/规则[：:]/g) ?? []).length;
  if (trimmed.length > 4000 && ruleCount >= 8) {
    return { needed: true, trigger: "existing_oversized" };
  }

  return { needed: false };
}

/**
 * 构建个人记忆整理提示词
 */
export function buildMemoryConsolidationPrompt(
  existingContent: string,
  newCandidates: readonly ExtractedCandidate[],
  options?: { readonly existingOnly?: boolean },
): string {
  const existingText = existingContent.trim() || "(暂无已有个人记忆)";
  const existingOnly = options?.existingOnly ?? newCandidates.length === 0;

  const newSection = existingOnly
    ? [
        "## 新候选（待合并）",
        "(无新候选——本次任务仅整理「已有个人记忆」，合并重复、消解冲突、删除过时条目)",
      ]
    : [
        "## 新候选（待合并）",
        newCandidates.length > 0
          ? newCandidates.map((c) => `- [${c.category}] ${c.content}`).join("\n")
          : "(无新候选)",
      ];

  const taskIntro = existingOnly
    ? "你是个人记忆整理子代理。当前没有新候选，请将「已有个人记忆」整理为一份精简、无重复、无冲突的 Markdown 文档。"
    : "你是个人记忆整理子代理。将「已有个人记忆」与「新候选」合并为一份精简、无重复、无冲突的 Markdown 文档。";

  return [
    taskIntro,
    "",
    buildMemoryArchitectureSection(),
    "",
    "## 整理任务",
    "",
    "### 个人记忆 vs 工作记忆（写入边界）",
    "- **个人记忆**（本任务输出）：user（身份/偏好/习惯）+ feedback（交互风格纠正与确认）",
    "- **工作记忆**（不写入本任务）：project（进行中项目）+ reference（工具/资源）→ 由另一路径写入 SQLite",
    "- 项目进度类内容（如 K8s 系列写到第几篇）应删除或压缩，留给工作记忆；个人记忆只保留全局偏好",
    "",
    "### 去重规则",
    "1. 语义相同或高度重叠的条目合并为一条，保留最完整表述",
    "2. 同一规则重复出现多次 → 合并为一条",
    "3. 子串包含关系 → 保留更完整的那条",
    "4. **同一项目的多个进度快照** → 压缩为 1 条最新状态（或完全删除，只保留全局偏好）",
    "5. **含具体文件名/路径的临时细节**（如 `outputs/k8s-01-img1.png`）→ 删除，避免污染未来工具调用",
    "",
    "### 冲突消解规则（优先级从高到低）",
    "1. **最近用户明确陈述** > 历史记忆",
    "2. **全局偏好** > **任务级规则**（任务级须标注适用范围）",
    "3. **工具/方法冲突**：若同时存在 generate_image.py 与 image_generate → 保留 image_generate，删除脚本方案",
    "4. **场景互斥**：不同项目规则可并存，但须分节或标注范围",
    "",
    "### 输出格式",
    "输出整理后的完整 Markdown，推荐结构：",
    "## 基本信息",
    "## 交互偏好",
    "## 项目偏好（标注适用范围）",
    "- 每条用 `- ` 列表项，feedback 使用「规则 / 原因 / 应用 / 适用范围」",
    "- 删除空节、重复项、已过时条目、应归属工作记忆的项目进度细节",
    "- 总长度不超过 6000 字符",
    "- **仅输出 Markdown 正文，不要 code fence、不要解释**",
    "",
    "## 已有个人记忆",
    existingText,
    "",
    ...newSection,
  ].join("\n");
}

/**
 * 用 LLM 整理个人记忆：去重、合并、冲突消解。
 * LLM 失败时回退到简单追加（仅有新候选时）或保持原样。
 */
export async function consolidateUserMemory(params: {
  readonly existingContent: string;
  readonly newCandidates: readonly ExtractedCandidate[];
  readonly callLLM: (prompt: string) => Promise<string>;
  readonly maxLength?: number;
  /** 强制整理已有记忆（即使无新候选） */
  readonly forceConsolidate?: boolean;
}): Promise<ConsolidationResult> {
  const { existingContent, newCandidates, callLLM, maxLength = 8000, forceConsolidate } = params;

  const check = needsPersonalMemoryConsolidation(existingContent);
  const shouldConsolidate =
    forceConsolidate ||
    check.needed ||
    (newCandidates.length > 0 && !newCandidates.every((c) => existingContent.includes(c.content)));

  if (!shouldConsolidate) {
    return { content: existingContent, merged: false };
  }

  if (newCandidates.length > 0) {
    const allExist = newCandidates.every((c) => existingContent.includes(c.content));
    if (allExist && !check.needed && !forceConsolidate) {
      return { content: existingContent, merged: false };
    }
  }

  try {
    const existingOnly = newCandidates.length === 0;
    const prompt = buildMemoryConsolidationPrompt(existingContent, newCandidates, { existingOnly });
    const response = await callLLM(prompt);
    const cleaned = stripCodeFences(response).trim();

    if (!cleaned || cleaned.length < 10) {
      if (newCandidates.length === 0) return { content: existingContent, merged: false };
      return fallbackAppend(existingContent, newCandidates, maxLength);
    }

    if (cleaned.length > maxLength) {
      if (newCandidates.length === 0) return { content: existingContent, merged: false };
      return fallbackAppend(existingContent, newCandidates, maxLength);
    }

    // 整理后应有实质变化
    if (cleaned === existingContent.trim()) {
      return { content: existingContent, merged: false };
    }

    return { content: cleaned, merged: true };
  } catch {
    if (newCandidates.length === 0) return { content: existingContent, merged: false };
    return fallbackAppend(existingContent, newCandidates, maxLength);
  }
}

/**
 * 仅整理已有个人记忆（无新候选）
 */
export async function consolidateExistingPersonalMemory(params: {
  readonly existingContent: string;
  readonly callLLM: (prompt: string) => Promise<string>;
  readonly maxLength?: number;
}): Promise<ConsolidationResult & { readonly trigger?: ConsolidationTrigger }> {
  const check = needsPersonalMemoryConsolidation(params.existingContent);
  if (!check.needed) {
    return { content: params.existingContent, merged: false };
  }

  const result = await consolidateUserMemory({
    existingContent: params.existingContent,
    newCandidates: [],
    callLLM: params.callLLM,
    maxLength: params.maxLength,
    forceConsolidate: true,
  });

  return { ...result, trigger: check.trigger };
}

/**
 * 回退策略：简单去重后追加到末尾
 */
function fallbackAppend(
  existingContent: string,
  newCandidates: readonly ExtractedCandidate[],
  maxLength: number,
): ConsolidationResult {
  const newItems = newCandidates.filter((c) => !existingContent.includes(c.content));
  if (newItems.length === 0) {
    return { content: existingContent, merged: false };
  }

  const newLines = newItems.map((c) => `- ${c.content}`).join("\n");
  const updated = existingContent.trimEnd() + `\n\n${newLines}`;

  if (updated.length > maxLength) {
    return { content: existingContent, merged: false };
  }

  return { content: updated, merged: false };
}

/** 剥离 LLM 响应中可能包裹的 markdown code fence */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenceMatch = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
  return fenceMatch ? fenceMatch[1]! : trimmed;
}
