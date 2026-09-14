/**
 * Agent 文件路径解析 — 将相对路径锚定到 workspace cwd
 */

import path from "node:path";
import { normalizePath } from "../security/tool-sandbox.js";

/**
 * 将 Agent 传入的文件路径解析为允许范围内的绝对路径。
 * 相对路径（如 outputs/foo.md）相对 cwd（workspace 根），而非 process.cwd()。
 *
 * @param extraRoots 额外允许的根目录（宿主注入，如用户在本机注册的项目目录）。
 *   省略时行为与仅 workspace 单根一致。
 * @throws 路径为空或越出全部允许根时抛出错误
 */
export function resolveAgentFilePath(
  filePath: string,
  cwd: string,
  extraRoots?: readonly string[],
): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("filePath 不能为空");
  }

  const base = path.resolve(cwd);
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(base, trimmed);

  const roots = [base, ...(extraRoots ?? []).map((root) => path.resolve(root))];
  const normalized = normalizePath(resolved, roots);
  if (!normalized) {
    throw new Error(`路径不在允许范围内（工作空间或已注册项目）: ${filePath}`);
  }
  return normalized;
}
