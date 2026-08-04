/**
 * BashProvider — Git Bash / POSIX bash 提供者（主题4 P1）
 *
 * Windows：探测 Git Bash（消灭 cp/mv/grep/中文路径转义试错），探测顺序：
 *   常见安装目录 → `where bash.exe`（剔除 System32 的 WSL 占位）。
 * 非 Windows：直接用 /bin/bash。
 *
 * 探测结果 memoize，避免每条命令重复磁盘/进程探测。
 * 从 apps/windows local-bash.ts 的 resolveGitBashPath 抽出，逻辑一致。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ShellProvider } from "./shell-provider.js";

const isWindows = process.platform === "win32";

let cachedBashPath: string | null | undefined;

/** 测试用：重置探测缓存 */
export function _resetBashPathCache(): void {
  cachedBashPath = undefined;
}

function resolveBashPath(): string | null {
  if (cachedBashPath !== undefined) {
    return cachedBashPath;
  }

  if (!isWindows) {
    cachedBashPath = "/bin/bash";
    return cachedBashPath;
  }

  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git\\bin\\bash.exe`,
    process.env["ProgramFiles(x86)"] &&
      `${process.env["ProgramFiles(x86)"]}\\Git\\bin\\bash.exe`,
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "D:\\develop\\Git\\bin\\bash.exe",
    "D:\\develop\\Git\\usr\\bin\\bash.exe",
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBashPath = candidate;
      return candidate;
    }
  }

  // 兜底：从 PATH 解析 bash.exe，排除 System32 下的 WSL 启动器（非 Git Bash）
  try {
    const out = execFileSync("where", ["bash.exe"], { encoding: "utf-8" });
    const found = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((p) => !/\\System32\\/i.test(p) && !/WindowsApps/i.test(p));
    if (found && existsSync(found)) {
      cachedBashPath = found;
      return found;
    }
  } catch {
    // where 不可用或未找到
  }

  cachedBashPath = null;
  return null;
}

export class BashProvider implements ShellProvider {
  readonly kind = "bash" as const;
  readonly encoding = "utf-8" as const;

  resolve(): string | null {
    return resolveBashPath();
  }

  buildArgs(command: string): string[] {
    return ["-c", command];
  }
}
