/**
 * PowerShellProvider — PowerShell 提供者（主题4 P1）
 *
 * 使用 -NoProfile 跳过用户 profile 加载（更快、行为可预测）。
 * 探测 pwsh.exe（PowerShell 7+）→ powershell.exe（Windows PowerShell）。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import type { ShellProvider } from "./shell-provider.js";

const isWindows = process.platform === "win32";

let cachedPwshPath: string | null | undefined;

/** 测试用：重置探测缓存 */
export function _resetPwshPathCache(): void {
  cachedPwshPath = undefined;
}

function resolvePwshPath(): string | null {
  if (cachedPwshPath !== undefined) {
    return cachedPwshPath;
  }

  if (!isWindows) {
    // 非 Windows：探测 pwsh（PowerShell Core 跨平台），无则 null
    try {
      const out = execFileSync("which", ["pwsh"], { encoding: "utf-8" }).trim();
      cachedPwshPath = out && existsSync(out) ? out : null;
    } catch {
      cachedPwshPath = null;
    }
    return cachedPwshPath;
  }

  const candidates = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\PowerShell\\7\\pwsh.exe`,
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    process.env.SystemRoot &&
      `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedPwshPath = candidate;
      return candidate;
    }
  }

  cachedPwshPath = null;
  return null;
}

export class PowerShellProvider implements ShellProvider {
  readonly kind = "powershell" as const;
  readonly encoding = "utf-8" as const;

  resolve(): string | null {
    return resolvePwshPath();
  }

  buildArgs(command: string): string[] {
    return ["-NoProfile", "-Command", command];
  }
}
