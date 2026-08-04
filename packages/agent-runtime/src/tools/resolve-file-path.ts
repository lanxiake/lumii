/**
 * Agent 文件路径解析 — 将相对路径锚定到 workspace cwd
 */

import path from "node:path";
import { normalizePath } from "../security/tool-sandbox.js";

/**
 * 将 Agent 传入的文件路径解析为工作空间内的绝对路径。
 * 相对路径（如 outputs/foo.md）相对 cwd（workspace 根），而非 process.cwd()。
 *
 * @throws 路径为空或越出工作空间边界时抛出错误
 */
export function resolveAgentFilePath(filePath: string, cwd: string): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("filePath 不能为空");
  }

  const base = path.resolve(cwd);
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(base, trimmed);

  const normalized = normalizePath(resolved, [base]);
  if (!normalized) {
    throw new Error(`路径不在工作空间内: ${filePath}`);
  }
  return normalized;
}
