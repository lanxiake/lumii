/**
 * Shell 执行策略抽象（主题4 P1）
 */

export type {
  ShellProvider,
  ShellKind,
  ShellEncoding,
} from "./shell-provider.js";
export { BashProvider } from "./bash-provider.js";
export { PowerShellProvider } from "./powershell-provider.js";
export { CmdProvider } from "./cmd-provider.js";
export {
  resolveShell,
  type ResolvedShell,
  type ResolveShellOptions,
} from "./resolve-shell.js";
export { winToPosix, posixToWin } from "./windows-paths.js";
