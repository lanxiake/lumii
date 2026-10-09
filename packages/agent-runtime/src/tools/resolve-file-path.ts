/**
 * Agent 文件路径解析 — 将相对路径锚定到 workspace cwd
 */

import path from "node:path";
import { normalizePath } from "../security/tool-sandbox.js";

/**
 * 路径访问模式：
 * - `write`（默认）：约束在工作空间 + 宿主注入的额外根内——**改/删/建/移**都走它，保持严格。
 * - `read`：**放宽到任意路径**（只校验非空）——读/搜（file_read / list_dir；glob/grep 本就无根限制）
 *   可以看工作空间外的文件。用户 2026-10-09 决策：搜/读放开，改/删严格。
 */
export type PathAccessMode = "read" | "write"

/**
 * 将 Agent 传入的文件路径解析为允许范围内的绝对路径。
 * 相对路径（如 outputs/foo.md）相对 cwd（workspace 根），而非 process.cwd()。
 *
 * @param extraRoots 额外允许的根目录（宿主注入，如用户在本机注册的项目目录）。
 *   省略时行为与仅 workspace 单根一致。
 * @param mode 访问模式（默认 write）。`read` 时**不设根限制**，可读任意绝对路径。
 * @throws 路径为空；或 write 模式下越出全部允许根时抛出错误
 */
export function resolveAgentFilePath(
  filePath: string,
  cwd: string,
  extraRoots?: readonly string[],
  mode: PathAccessMode = "write",
): string {
  const trimmed = filePath.trim();
  if (!trimmed) {
    throw new Error("filePath 不能为空");
  }

  const base = path.resolve(cwd);
  const resolved = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(base, trimmed);

  if (mode === "read") {
    // 读/搜放开：可读工作空间外的文件（用户显式决策）。写/改/删仍走下面的白名单。
    return resolved;
  }

  const roots = [base, ...(extraRoots ?? []).map((root) => path.resolve(root))];
  const normalized = normalizePath(resolved, roots);
  if (!normalized) {
    throw new Error(`路径不在允许范围内（工作空间或已注册项目）: ${filePath}`);
  }
  return normalized;
}
