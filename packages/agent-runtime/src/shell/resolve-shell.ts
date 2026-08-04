/**
 * resolveShell — Shell 选择策略（主题4 P1）
 *
 * 默认策略 "bash everywhere"：
 * - 优先 Git Bash / POSIX bash（Unix 语义，消灭转义试错）
 * - Windows 上 bash 不可用 → 降级 cmd.exe（保持现状不报错）
 * - 非 Windows bash 必然存在（/bin/bash）
 *
 * 显式指定 shell 时跳过探测，直接用调用方提供的路径（保留原有逃生口）。
 */

import { BashProvider } from "./bash-provider.js";
import { PowerShellProvider } from "./powershell-provider.js";
import { CmdProvider } from "./cmd-provider.js";
import type { ShellProvider, ShellKind } from "./shell-provider.js";

export interface ResolvedShell {
  /** 可执行路径 */
  shellPath: string;
  /** 传给 spawn 的参数 */
  args: string[];
  /** 输出解码方式 */
  encoding: "utf-8" | "cp936";
  /** 选中的 shell 类型 */
  kind: ShellKind;
  /** 是否为 cmd 降级路径（用于诊断/日志） */
  isCmdFallback: boolean;
}

export interface ResolveShellOptions {
  /** 用户命令 */
  command: string;
  /** 显式 shell 路径（提供则跳过探测，按 bash 语义构造参数） */
  explicitShell?: string;
  /** 偏好 shell 类型（默认 "bash"） */
  prefer?: ShellKind;
}

/** 按类型获取 provider 实例 */
function providerFor(kind: ShellKind): ShellProvider {
  switch (kind) {
    case "powershell":
      return new PowerShellProvider();
    case "cmd":
      return new CmdProvider();
    case "bash":
    default:
      return new BashProvider();
  }
}

/**
 * 解析最终使用的 shell。
 *
 * @returns 选定 shell 的路径、参数、编码与类型
 */
export function resolveShell(options: ResolveShellOptions): ResolvedShell {
  const { command, explicitShell, prefer = "bash" } = options;

  // 显式 shell：跳过探测，按 bash 语义（-c）构造，UTF-8 解码
  if (explicitShell) {
    return {
      shellPath: explicitShell,
      args: ["-c", command],
      encoding: "utf-8",
      kind: "bash",
      isCmdFallback: false,
    };
  }

  // 偏好 provider 探测成功 → 使用
  const preferred = providerFor(prefer);
  const preferredPath = preferred.resolve();
  if (preferredPath) {
    return {
      shellPath: preferredPath,
      args: preferred.buildArgs(command),
      encoding: preferred.encoding,
      kind: preferred.kind,
      isCmdFallback: false,
    };
  }

  // 降级链：bash 失败 → cmd（仅 Windows）
  const cmd = new CmdProvider();
  const cmdPath = cmd.resolve();
  if (cmdPath) {
    return {
      shellPath: cmdPath,
      args: cmd.buildArgs(command),
      encoding: cmd.encoding,
      kind: "cmd",
      isCmdFallback: true,
    };
  }

  // 非 Windows 且 bash 探测异常的极端兜底：直接用 /bin/bash
  return {
    shellPath: "/bin/bash",
    args: ["-c", command],
    encoding: "utf-8",
    kind: "bash",
    isCmdFallback: false,
  };
}
