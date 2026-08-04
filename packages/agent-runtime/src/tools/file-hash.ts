/**
 * File Content Hash — Windows mtime 抖动回退（主题1 P1-1）
 *
 * Windows 某些场景下 mtime 会亚秒抖动或被外部工具修改，导致 Read-before-Write 误拦。
 * 小文件（<100KB）计算 SHA-1 作为 contentHash，在 mtime 校验失败时回退比对内容哈希。
 */

import { createHash } from "node:crypto";

/** 小文件阈值：100KB（低于此阈值才计算 contentHash） */
const SMALL_FILE_THRESHOLD = 100 * 1024;

/**
 * 计算文件内容 SHA-1（仅小文件）
 *
 * @param content - 文件内容（Buffer 或 string）
 * @returns SHA-1 hex 字符串，若超过阈值返回 undefined
 */
export function computeFileHash(content: Buffer | string): string | undefined {
  const buf = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  if (buf.length > SMALL_FILE_THRESHOLD) {
    return undefined;
  }
  return createHash("sha1").update(buf).digest("hex");
}
