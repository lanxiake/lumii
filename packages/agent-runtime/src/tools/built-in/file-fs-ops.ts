/**
 * 工作空间内目录/复制/移动的共享实现
 *
 * 路径一律经 resolveAgentFilePath 约束在 cwd 内。
 */

import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentFilePath } from "../resolve-file-path.js";

/** 单层列目录的条目上限，避免一次打爆上下文 */
export const LIST_DIR_MAX_ENTRIES = 200;

/**
 * 把 Agent 传入路径解析为工作空间内绝对路径
 */
export function resolveFsPath(rawPath: string, cwd: string): string {
  return resolveAgentFilePath(rawPath, cwd);
}

/**
 * 目标已存在时返回给模型看的错误文案
 */
export function destinationExistsMessage(destination: string): string {
  return `Error: destination already exists: ${destination}. Choose a new path or remove the existing file first.`;
}

/**
 * 确保目标父目录存在（便于 move/copy 到尚未创建的子目录）
 */
export async function ensureParentDir(destAbs: string): Promise<void> {
  await fs.mkdir(path.dirname(destAbs), { recursive: true });
}

/**
 * 若路径已存在则返回 true
 */
export async function pathExists(absPath: string): Promise<boolean> {
  try {
    await fs.lstat(absPath);
    return true;
  } catch {
    return false;
  }
}
