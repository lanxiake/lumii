/**
 * 内容寻址 ID（记忆系统升级阶段一 · P2）
 *
 * 由 TS 侧确定性生成 drawer_id，作为参数传给 MemPalace（Python）做幂等 upsert：
 * 同一 (wing, room, content) 重复归档 → 同一 ID → 不产生重复。
 *
 * 与阶段二 OpenHuman 的内容寻址 chunk ID 体系一致（sha256 截断 hex），
 * 现在一次到位，避免后续返工。
 *
 * 参考 OpenHuman `chunks/types.rs`：id = sha256(parts join "\0")，截断 hex。
 */

import { createHash } from "node:crypto";

/** 内容寻址 ID 默认截断长度（hex 字符数）。阶段一 drawer 用 16，阶段二 chunk 用 32。 */
export const DRAWER_ID_HEX_LEN = 16;

/**
 * 用 NUL 分隔的多段拼接做 sha256，截断为 hex 前缀。
 * NUL 分隔避免 ("ab","c") 与 ("a","bc") 碰撞。
 */
export function contentAddressId(parts: readonly string[], hexLen = DRAWER_ID_HEX_LEN): string {
  const hash = createHash("sha256");
  hash.update(parts.join("\0"), "utf8");
  return hash.digest("hex").slice(0, hexLen);
}

/**
 * 段原文归档进 MemPalace 的确定性 drawer_id。
 * 以 (wing, room, content) 寻址：同一段原文重复归档得稳定 ID，天然防重。
 */
export function deterministicDrawerId(wing: string, room: string, content: string): string {
  return contentAddressId([wing, room, content]);
}
