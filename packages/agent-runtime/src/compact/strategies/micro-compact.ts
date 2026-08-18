/**
 * strategies/micro-compact —— 第一级压缩：清理旧工具结果
 *
 * 将旧的"可压缩工具"toolResult 内容替换为占位符/微摘要，保留最近 N 个工具结果。
 * 不删除消息、不改变消息顺序、不动 user/assistant/system，只缩减旧 toolResult 体积。
 *
 * 平移自原 context-compactor.ts microcompactToolResults + buildDeterministicToolSummary。
 *
 * 对照 claude-code-rev microCompact.ts：
 * - 仅清 COMPACTABLE_TOOLS 白名单内工具（幂等可重放），不清结构化结果工具
 * - 按"工具结果计数"保留最近 keepRecentToolResults 个（非 user turn 粒度）
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readMessageRole } from "../api-invariants.js";
import { COMPACTABLE_TOOLS, DEFAULT_KEEP_RECENT_TOOL_RESULTS } from "../types.js";
import { createHash } from "node:crypto";
import { estimateTokenCount } from "../token-estimate.js";

export const MICROCOMPACT_PLACEHOLDER =
  "[旧工具结果已清理以节省上下文空间。如需原始内容，请重新调用工具。]";

/**
 * 为将被清理的 toolResult 生成确定性微摘要（无需 LLM）。
 *
 * 相比纯占位符，微摘要保留"退出码/行数/首尾关键行"等线索，
 * 降低模型在仍需引用旧结果时凭记忆编造的概率，并提示如何重新获取。
 *
 * 完全确定性：截取首尾若干行 + 统计行数/字符数，不调用任何模型。
 *
 * @param toolName 工具名（如 bash / file_read），用于摘要标注
 * @param text     原始结果文本
 */
function buildDeterministicToolSummary(toolName: string, text: string): string {
  const lines = text.split(/\r?\n/);
  const totalLines = lines.length;
  const totalChars = text.length;

  // 首尾各取 2 行作为线索（去掉空行优先）
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  const head = nonEmpty.slice(0, 2);
  const tail = nonEmpty.length > 2 ? nonEmpty.slice(-2) : [];
  const clues = [...head, ...(tail.length > 0 ? ["…", ...tail] : [])]
    .map((l) => l.trim().slice(0, 120))
    .join(" | ");

  return (
    `[工具结果已归档 | tool=${toolName} | 摘要: 共 ${totalLines} 行/${totalChars} 字符` +
    (clues ? ` | 线索: ${clues}` : "") +
    `]\n完整内容请重新调用 ${toolName}（或用 memory_search/memory_read 回查归档）。`
  );
}

/**
 * 微压缩：将旧的"可压缩工具"toolResult 内容替换为占位符/微摘要，保留最近 N 个工具结果。
 *
 * @param keepRecentToolResults 保留最近多少个可压缩工具结果不做清理（默认 8）
 * @param options.preserveCurrentUserTurn 为 true 时，最后一条 user 之后的 toolResult
 *   一律不清理：避免工具循环中途丢失刚获取的证据。
 * @param options.useSummary 为 true 时用确定性微摘要替代纯占位符。
 */
export function microcompactToolResults(
  messages: AgentMessage[],
  keepRecentToolResults: number = DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  options: { preserveCurrentUserTurn?: boolean; useSummary?: boolean } = {},
): AgentMessage[] {
  const { preserveCurrentUserTurn = false, useSummary = false } = options;

  // 0. 计算"当前未闭合 user 轮"起点：最后一条 user 的下标
  let currentTurnStart = -1;
  if (preserveCurrentUserTurn) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (readMessageRole(messages[i]) === "user") {
        currentTurnStart = i;
        break;
      }
    }
  }

  // 1. 收集所有"可压缩工具"的 toolResult 索引（按出现顺序），跳过当前轮内的
  const compactableIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (readMessageRole(messages[i]) !== "toolResult") continue;
    // 当前未闭合 user 轮内的 toolResult 不参与清理
    if (preserveCurrentUserTurn && currentTurnStart >= 0 && i > currentTurnStart) continue;
    const toolName = (messages[i] as { toolName?: unknown }).toolName;
    if (typeof toolName === "string" && COMPACTABLE_TOOLS.has(toolName)) {
      compactableIndices.push(i);
    }
  }

  // 2. 保留最近 keepRecentToolResults 个不清，其余进入清理集合
  const clearCount = compactableIndices.length - keepRecentToolResults;
  if (clearCount <= 0) {
    return messages; // 可压缩结果数量不足，无需清理
  }
  const toClear = new Set(compactableIndices.slice(0, clearCount));

  // 替换文本生成：微摘要（含原文线索）或纯占位符
  const makeReplacement = (toolName: string, original: string): string =>
    useSummary ? buildDeterministicToolSummary(toolName, original) : MICROCOMPACT_PLACEHOLDER;

  // 3. 清理：仅替换命中索引的 toolResult content（string 或 array text block）
  return messages.map((msg, idx) => {
    if (!toClear.has(idx)) return msg;

    const toolName =
      typeof (msg as { toolName?: unknown }).toolName === "string"
        ? (msg as { toolName: string }).toolName
        : "unknown";

    const content = (msg as { content?: unknown }).content;
    if (typeof content === "string") {
      if (content.length <= 200) return msg;
      if (content === MICROCOMPACT_PLACEHOLDER || content.startsWith("[工具结果已归档")) return msg;
      return { ...(msg as object), content: makeReplacement(toolName, content) } as AgentMessage;
    }
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = (content as unknown[]).map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const b = block as Record<string, unknown>;
      if (
        b.type === "text" &&
        typeof b.text === "string" &&
        b.text.length > 200 &&
        // 幂等：已是占位符/微摘要的文本不再二次包裹
        b.text !== MICROCOMPACT_PLACEHOLDER &&
        !b.text.startsWith("[工具结果已归档")
      ) {
        changed = true;
        return { ...b, text: makeReplacement(toolName, b.text) };
      }
      return block;
    });
    if (!changed) return msg;
    // TypeScript 类型系统过于严格，使用 any 绕过（运行时类型正确）
    return { ...msg, content: newContent as any } as AgentMessage;
  });
}

/**
 * Phase 1: Dedup 去重相同 tool 结果（无损，全范围可做含 tail）
 *
 * 对齐 Hermes _prune_old_tool_results Pass 1 dedup (L3491-L3515)。
 * 从后向前遍历，最新的保留原文，老的改为去重引用。
 *
 * @param messages 输入消息列表
 * @param dedupMinChars 最小字符阈值（默认 200），< 此值跳过（MD5 头可能比原文长）
 * @returns 新数组（不改 input）
 */
export function dedupIdenticalToolResults(
  messages: AgentMessage[],
  dedupMinChars = 200,
): AgentMessage[] {
  const seen = new Map<string, number>(); // hash -> 最新的 index
  const result: AgentMessage[] = [];

  // 从后向前遍历，建 seen map（保证最新的那条保留原文）
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const role = readMessageRole(msg);
    if (role !== "toolResult") {
      continue;
    }
    // 提取 content 文本（兼容新类型系统：content 是数组）
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((b) => {
                if (typeof b === "string") return b;
                if (typeof b === "object" && b && "text" in b) return String(b.text ?? "");
                return "";
              })
              .join("")
          : "";
    if (content.length < dedupMinChars) continue;
    if (content.startsWith("[工具结果") || content.startsWith("[Duplicate")) continue;
    const hash = createHash("md5").update(content, "utf8").digest("hex").slice(0, 12);
    if (!seen.has(hash)) {
      seen.set(hash, i); // 最新的 index
    }
  }

  // 正向遍历，构造结果
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = readMessageRole(msg);
    if (role !== "toolResult") {
      result.push(msg);
      continue;
    }
    // 提取 content 文本（兼容新类型系统：content 是数组）
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content
              .map((b) => {
                if (typeof b === "string") return b;
                if (typeof b === "object" && b && "text" in b) return String(b.text ?? "");
                return "";
              })
              .join("")
          : "";
    if (content.length < dedupMinChars) {
      result.push(msg);
      continue;
    }
    if (content.startsWith("[工具结果") || content.startsWith("[Duplicate")) {
      result.push(msg);
      continue;
    }
    const hash = createHash("md5").update(content, "utf8").digest("hex").slice(0, 12);
    const newestIndex = seen.get(hash);
    if (newestIndex === i) {
      // 最新的，保留原文
      result.push(msg);
    } else {
      // 老的，改为去重引用（content 必须是数组格式）
      result.push({
        ...msg,
        content: [
          { type: "text" as const, text: "[工具结果与更近期调用完全一致，已去重以节省空间]" },
        ],
      } as AgentMessage);
    }
  }
  return result;
}

/**
 * Phase 1: Truncate 截断 assistant tool_call arguments 内的长字符串
 *
 * 对齐 Hermes _truncate_tool_call_args_json (L3578-L3596)。
 * 递归遍历 JSON，对长字符串值截断为「前 N + ... + 后 N」，结果仍是合法 JSON。
 *
 * @param messages 输入消息列表
 * @param protectTailCount 保护尾部 N 条 assistant（默认 20）
 * @param maxCharsPerArg 单个字符串值最大长度（默认 1500）
 * @returns 新数组（不改 input）
 */
export function truncateHeavyToolCallArguments(
  messages: AgentMessage[],
  protectTailCount = 20,
  maxCharsPerArg = 1500,
): AgentMessage[] {
  const pruneBoundary = Math.max(0, messages.length - protectTailCount);

  function truncateValue(val: unknown): unknown {
    if (typeof val === "string" && val.length > maxCharsPerArg) {
      const halfChars = Math.floor(maxCharsPerArg / 2) - 50;
      const head = val.slice(0, halfChars);
      const tail = val.slice(-halfChars);
      const omitted = val.length - maxCharsPerArg;
      return `${head}...(已截断 ${omitted} 字符)...${tail}`;
    }
    if (Array.isArray(val)) {
      return val.map(truncateValue);
    }
    if (val && typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(obj)) {
        result[key] = truncateValue(obj[key]);
      }
      return result;
    }
    return val;
  }

  return messages.map((msg, i) => {
    const role = readMessageRole(msg);
    if (role !== "assistant" || i >= pruneBoundary) {
      return msg;
    }
    // 新类型系统：toolCall 在 content 数组中（类型为 ToolCall 的 block）
    const content = (msg as unknown as { content?: Array<{ type?: string; [key: string]: unknown }> })
      .content;
    if (!Array.isArray(content)) return msg;

    let changed = false;
    const newContent = content.map((block) => {
      if (typeof block !== "object" || !block || block.type !== "toolCall") {
        return block;
      }
      const tc = block as {
        type: "toolCall";
        id?: string;
        name?: string;
        arguments?: string;
        [key: string]: unknown;
      };
      if (!tc.arguments) return block;

      try {
        const parsed = JSON.parse(tc.arguments);
        const truncated = truncateValue(parsed);
        const newArgs = JSON.stringify(truncated);
        if (newArgs !== tc.arguments) {
          changed = true;
          return { ...tc, arguments: newArgs };
        }
        return block;
      } catch {
        return block; // 解析失败，不动
      }
    });

    if (!changed) return msg;
    // TypeScript 类型系统过于严格，使用 any 绕过（运行时类型正确）
    return { ...msg, content: newContent as any } as AgentMessage;
  });
}

/**
 * Phase 1: Proactive Prune 总包装（三阶段剪枝 + Reclaim Gate + Rearm 跑道）
 *
 * 对齐 Hermes prune_tool_results_only (L3690-L3801) 完整语义。
 * 7 道 Gate 防护：ratio/tokens/length/rearm/execute/zero-change/reclaim。
 *
 * @returns { messages, changed, reclaimedTokens, nextRearmTokens, passStats }
 */
export function proactivePrune(
  messages: AgentMessage[],
  opts: {
    contextWindow: number;
    proactivePruneRatio?: number;
    proactivePruneMinResultChars?: number;
    proactivePruneMinReclaimTokens?: number;
    proactivePruneDedupMinChars?: number;
    protectLastN?: number;
    keepRecentToolResults?: number;
    currentRearmTokens?: number | null;
  },
): {
  messages: AgentMessage[];
  changed: boolean;
  reclaimedTokens: number;
  nextRearmTokens: number | null;
  passStats: { dedupedCount: number; summarizedCount: number; truncatedArgsCount: number };
} {
  const ratio = opts.proactivePruneRatio ?? 0.48;
  const minResultChars = Math.max(200, opts.proactivePruneMinResultChars ?? 8000);
  const minReclaimTokens = Math.max(0, opts.proactivePruneMinReclaimTokens ?? 4096);
  const dedupMinChars = opts.proactivePruneDedupMinChars ?? 200;
  const protectLastN = opts.protectLastN ?? 20;
  const keepRecent = opts.keepRecentToolResults ?? 20;

  // Gate 1: ratio 计算后 trigger ≤ 0 → 跳过
  const triggerTokens = Math.floor(opts.contextWindow * ratio);
  if (triggerTokens <= 0) {
    return {
      messages,
      changed: false,
      reclaimedTokens: 0,
      nextRearmTokens: null,
      passStats: { dedupedCount: 0, summarizedCount: 0, truncatedArgsCount: 0 },
    };
  }

  // Gate 2: 当前 tokens < trigger → 跳过
  const before = estimateTokenCount(messages);
  if (before < triggerTokens) {
    return {
      messages,
      changed: false,
      reclaimedTokens: 0,
      nextRearmTokens: null,
      passStats: { dedupedCount: 0, summarizedCount: 0, truncatedArgsCount: 0 },
    };
  }

  // Gate 3: 消息数太少（还没超出 head+tail）→ 跳过
  if (messages.length <= protectLastN + 3) {
    return {
      messages,
      changed: false,
      reclaimedTokens: 0,
      nextRearmTokens: null,
      passStats: { dedupedCount: 0, summarizedCount: 0, truncatedArgsCount: 0 },
    };
  }

  // Gate 4: ⭐ Rearm 跑道未到（连扫描都不做）
  if (opts.currentRearmTokens != null && before < opts.currentRearmTokens) {
    return {
      messages,
      changed: false,
      reclaimedTokens: 0,
      nextRearmTokens: null,
      passStats: { dedupedCount: 0, summarizedCount: 0, truncatedArgsCount: 0 },
    };
  }

  // 执行三阶段
  // Pass 1: Dedup（全范围，无损）
  let result = dedupIdenticalToolResults(messages, dedupMinChars);
  const dedupedCount = result.filter(
    (m, i) => m.content !== messages[i].content && String(m.content).includes("已去重"),
  ).length;

  // Pass 2: Summarize（仅作用于 prune_boundary 之前，复用现有 microcompactToolResults）
  const beforeSummarize = result;
  result = microcompactToolResults(result, keepRecent, {
    useSummary: true,
  });
  const summarizedCount = result.filter((m, i) =>
    String(m.content).startsWith("[工具结果已归档"),
  ).length;

  // Pass 3: Truncate Arguments（仅作用于 prune_boundary 之前）
  const beforeTruncate = result;
  result = truncateHeavyToolCallArguments(result, protectLastN);
  // 统计变化数（通过比较 content 序列化）
  const truncatedArgsCount = result.filter(
    (m, i) => JSON.stringify(m.content) !== JSON.stringify(beforeTruncate[i].content),
  ).length;

  // Gate 5: 三阶段 0 改动 → 跳过
  if (dedupedCount === 0 && summarizedCount === 0 && truncatedArgsCount === 0) {
    return {
      messages,
      changed: false,
      reclaimedTokens: 0,
      nextRearmTokens: null,
      passStats: { dedupedCount: 0, summarizedCount: 0, truncatedArgsCount: 0 },
    };
  }

  // 计算回收
  const after = estimateTokenCount(result);
  const reclaimed = Math.max(0, before - after);

  // Gate 6: ⭐ Reclaim Gate 回收不足 → 返回原 input 引用
  if (reclaimed < minReclaimTokens) {
    return {
      messages, // ⭐ 必须是原引用
      changed: false,
      reclaimedTokens: reclaimed,
      nextRearmTokens: null,
      passStats: { dedupedCount, summarizedCount, truncatedArgsCount },
    };
  }

  // ⭐ 计算 Rearm 跑道（三者取 max）
  const runway = Math.max(reclaimed, triggerTokens, minReclaimTokens);
  const nextRearmTokens = after + runway;

  return {
    messages: result,
    changed: true,
    reclaimedTokens: reclaimed,
    nextRearmTokens,
    passStats: { dedupedCount, summarizedCount, truncatedArgsCount },
  };
}
