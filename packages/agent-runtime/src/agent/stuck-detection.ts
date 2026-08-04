/**
 * 卡死检测（stuck detection）——纯函数，无副作用，便于单测。
 *
 * 思想来源：OpenManus `app/agent/base.py:165-181` 的 `is_stuck()`：
 * 扫描记忆中的 assistant 消息，统计与最后一条内容相同者，达到阈值即判定"卡死"。
 *
 * mtbot 原有 detectLoop 仅基于工具调用指纹，漏掉"纯文本反复输出同一内容"的死循环；
 * 本模块补上该场景。
 */

/** 从一条消息中提取 assistant 文本（content 为 string 或 block 数组两种形态）。 */
export function extractAssistantText(msg: unknown): string {
  const m = msg as { role?: string; content?: unknown };
  if (m.role !== "assistant") return "";
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((b) => {
        const block = b as { type?: string; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("")
      .trim();
  }
  return "";
}

export interface DuplicateDetectOptions {
  /** 判定阈值：历史中与最后一条相同的 assistant 文本条数达到此值即卡死（默认 2，对齐 OpenManus）。 */
  readonly threshold?: number;
  /** 扫描窗口：只看最近 N 条消息（默认 16）。 */
  readonly window?: number;
  /** 最小文本长度：短于此值的内容（如"好的"）跳过，避免误判（默认 4）。 */
  readonly minLength?: number;
}

/**
 * 检测重复的 assistant 文本输出。
 *
 * @returns 命中返回描述字符串，未命中返回 null。
 *          若最后一条 assistant 是纯工具调用（无文本），返回 null（交给工具指纹检测处理）。
 */
export function detectDuplicateAssistantContent(
  messages: readonly unknown[],
  options: DuplicateDetectOptions = {},
): string | null {
  const threshold = options.threshold ?? 2;
  const window = options.window ?? 16;
  const minLength = options.minLength ?? 4;

  if (messages.length < threshold + 1) return null;

  // 找最后一条 assistant 的文本；纯工具调用（无文本）则不介入
  let lastText = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const role = (messages[i] as { role?: string }).role;
    if (role !== "assistant") continue;
    lastText = extractAssistantText(messages[i]);
    break;
  }
  if (lastText.length < minLength) return null;

  // 统计最近窗口内与之相同的 assistant 文本条数（跳过最后一条自身）
  const recent = messages.slice(-window);
  let duplicateCount = 0;
  let skippedSelf = false;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = extractAssistantText(recent[i]);
    if (!t) continue;
    if (!skippedSelf) {
      skippedSelf = true;
      continue;
    }
    if (t === lastText) duplicateCount++;
  }

  if (duplicateCount >= threshold) {
    return `assistant content repeated ${duplicateCount + 1}x`;
  }
  return null;
}

/**
 * 检测工具调用循环模式（基于工具名+参数指纹，避免同名不同参的误判）：
 * 1. 单指纹高频重复：最近 20 次中同一指纹 >= 18 次（90%）
 * 2. 短序列交替循环：最近 16 次中存在长度 2-3 的重复序列出现 6+ 次
 *
 * @param names 最近工具调用指纹队列（格式：toolName:argsDigest）
 * @returns 命中返回描述字符串，未命中返回 null
 */
export function detectToolLoop(names: readonly string[]): string | null {
  if (names.length < 14) return null;

  // 检测 1：单工具高频（窗口 20，阈值 18/20）
  const last20 = names.slice(-20);
  const counts = new Map<string, number>();
  for (const n of last20) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [name, count] of counts) {
    if (count >= 18) return `"${name}" repeated ${count}/20`;
  }

  // 检测 2：短序列交替（窗口 16，序列长度 2-3，出现 6+ 次）
  const last16 = names.slice(-16);
  for (let seqLen = 2; seqLen <= 3; seqLen++) {
    const tail = last16.slice(-seqLen);
    let matchCount = 0;
    for (let i = 0; i <= last16.length - seqLen; i++) {
      if (last16.slice(i, i + seqLen).join(",") === tail.join(",")) matchCount++;
    }
    if (matchCount >= 6) return `sequence [${tail.join(",")}] repeated ${matchCount}x`;
  }

  return null;
}
