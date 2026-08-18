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
    return { ...(msg as object), content: newContent } as AgentMessage;
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
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("")
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
    const content =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? msg.content.map((b) => (typeof b === "string" ? b : b.text ?? "")).join("")
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
      // 老的，改为去重引用
      result.push({
        ...msg,
        content: "[工具结果与更近期调用完全一致，已去重以节省空间]",
      });
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
    if (role !== "assistant" || !msg.toolCalls || i >= pruneBoundary) {
      return msg;
    }
    const newToolCalls = msg.toolCalls.map((tc) => {
      try {
        const parsed = JSON.parse(tc.function.arguments);
        const truncated = truncateValue(parsed);
        return {
          ...tc,
          function: {
            ...tc.function,
            arguments: JSON.stringify(truncated),
          },
        };
      } catch {
        return tc; // 解析失败，不动
      }
    });
    return { ...msg, toolCalls: newToolCalls };
  });
}
