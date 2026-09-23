/**
 * Token 用量估算 —— compact 子系统基础设施
 *
 * 合并自原 agent/token-estimate.ts 与 context-compactor.ts 的估算逻辑，
 * 使 token 估算成为压缩子系统的一等基础设施（不再寄居 agent 目录）。
 *
 * 口径（DeepSeek 官方换算）：
 * - 1 个英文字符 ≈ 0.3 token
 * - 1 个中文字符 ≈ 0.6 token
 *
 * 覆盖块类型：text / thinking / image / tool_use / tool_result / toolCall 等。
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * CJK 及常见东亚字符的**码点范围**判断。
 *
 * 取代原先「逐字符 `CJK_CHAR_RE.test(ch)`」的写法：那段代码对**每一个字符**
 * 跑一次带 `u` 标志的正则，而 `estimateTokenCount` 会遍历整个消息列表
 * （含 tool_result 内容与 toolCall 的 `JSON.stringify`）——上下文一大，单次估算
 * 就能到秒级，而它跑在主进程主线程上。
 *
 * 2026-09-20 实测（400 条真实 content_json / 36.3M 字符 / 逐条比对语义一致）：
 * - 旧（逐字符 + 正则 test）**654ms** → 新（码点整数比较）**118ms**（5.6×）
 * - 模拟一个回合里的 20 次反复估算：**13155ms → 2381ms**
 *
 * 触发场景是 CLI 测试（多套件同时跑时上下文堆得大）。冻结现场捕获器抓到的栈
 * 完全一致地指向这个函数，见 docs/fix/2026-09-20-主进程冻结调查与修复.md。
 *
 * ⚠️ 第三条范围的起点是 **U+8C48** 而不是 U+F900：原正则字面量写的是「豈」，
 * 它的码点就是 U+8C48。这看着像笔误（大约想写兼容表意区 U+F900–FAFF），
 * 但它**把私用区 U+E000–F8FF 也圈了进来**，而真实语料里确实出现这类字符。
 * 本次是**性能优化、不改语义**，故按原范围逐字复现；是否修正留作独立议题。
 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0x3400 && cp <= 0x4dbf) || // 扩展 A
    (cp >= 0x8c48 && cp <= 0xfaff) || // 兼容表意（含私用区，见上）
    (cp >= 0x3040 && cp <= 0x309f) || // 平假名
    (cp >= 0x30a0 && cp <= 0x30ff) || // 片假名
    (cp >= 0xac00 && cp <= 0xd7af) // 韩文
  );
}

/**
 * 估算单段文本的 token 数（按字符类型加权）
 */
export function estimateTextTokenCount(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  // 按**码点**遍历（与原 `for...of` 的语义一致）：一个代理对算一个字符
  for (let i = 0; i < text.length; i++) {
    const cp = text.codePointAt(i);
    if (cp === undefined) break;
    if (cp > 0xffff) i += 1; // 跳过低位代理
    tokens += isCjkCodePoint(cp) ? 0.6 : 0.3;
  }
  return tokens;
}

/**
 * 将 token 数向上取整为整数（计费与阈值比较用）
 */
export function ceilTokenEstimate(tokens: number): number {
  return Math.ceil(tokens);
}

/**
 * 服务商 usage 回执 → 本轮实际 prompt token 数。
 *
 * 必须把缓存命中算进来：开启 prompt cache 后，系统提示词等稳定前缀会被计入
 * cacheRead/cacheWrite，inputTokens 只剩本轮增量。只取 inputTokens 会让
 * 上下文占用读数虚低一个量级（10K+ 掉到几百）。
 */
export function providerPromptTokens(usage: {
  readonly inputTokens?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}): number {
  return (usage.inputTokens ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/**
 * 将消息体字符量转为 token 估算（覆盖各块类型）
 */
function estimateMessageBodyTokens(msg: { role?: string; content?: unknown }): number {
  const content = msg.content;
  if (typeof content === "string") {
    return estimateTextTokenCount(content);
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let tokens = 0;
  for (const block of content as unknown[]) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const b = block as Record<string, unknown>;
    const t = b["type"];
    if (t === "text" && typeof b["text"] === "string") {
      tokens += estimateTextTokenCount(b["text"]);
      continue;
    }
    if (t === "thinking" && typeof b["thinking"] === "string") {
      tokens += estimateTextTokenCount(b["thinking"]);
      continue;
    }
    if (t === "image") {
      tokens += 3;
      continue;
    }
    if (t === "tool_use") {
      tokens += estimateTextTokenCount(JSON.stringify(b["input"] ?? {}));
      continue;
    }
    if (t === "tool_result") {
      const result = b["content"];
      tokens += estimateTextTokenCount(
        typeof result === "string" ? result : JSON.stringify(result ?? ""),
      );
      continue;
    }
    if (t === "toolCall" || t === "toolUse" || t === "functionCall") {
      tokens += estimateTextTokenCount(JSON.stringify(b));
      continue;
    }
    tokens += estimateTextTokenCount(JSON.stringify(b));
  }
  return tokens;
}

/**
 * 粗略估算消息列表的 token 数
 *
 * 策略：覆盖 text / thinking / toolCall 等块；按中英文字符分别换算后向上取整。
 */
export function estimateTokenCount(messages: AgentMessage[]): number {
  let totalTokens = 0;
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    totalTokens += estimateMessageBodyTokens(m);
    if (m.role === "toolResult") {
      totalTokens += estimateTextTokenCount(
        JSON.stringify({
          toolCallId: (m as { toolCallId?: unknown }).toolCallId,
          toolName: (m as { toolName?: unknown }).toolName,
        }),
      );
    }
  }
  return ceilTokenEstimate(totalTokens);
}
