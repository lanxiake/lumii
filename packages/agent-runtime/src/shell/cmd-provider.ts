/**
 * CmdProvider — Windows cmd.exe 提供者（主题4 P1，fallback）
 *
 * 当 Git Bash / PowerShell 都不可用时的最终降级。
 * cmd 默认输出 GBK（cp936），需对应解码。
 */

import type { ShellProvider } from "./shell-provider.js";

const isWindows = process.platform === "win32";

export class CmdProvider implements ShellProvider {
  readonly kind = "cmd" as const;
  readonly encoding = "cp936" as const;

  resolve(): string | null {
    // cmd.exe 仅 Windows 存在；非 Windows 返回 null
    return isWindows ? "cmd.exe" : null;
  }

  buildArgs(command: string): string[] {
    return ["/c", command];
  }
}
