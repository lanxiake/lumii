/**
 * ShellProvider — Shell 执行策略抽象（主题4 P1）
 *
 * 把"用哪个 shell、传什么参数、输出怎么解码"的差异从执行逻辑中剥离，
 * 让 bash / powershell / cmd 各自封装，调用方只面向接口。
 *
 * 设计：
 * - resolve()：探测可执行路径，不可用返回 null（调用方据此降级）
 * - buildArgs(command)：构造 spawn 参数（如 ['-c', command] / ['/c', command]）
 * - outputEncoding：输出解码方式（cmd 默认 GBK，其余 UTF-8）
 */

/** Shell 类型标识 */
export type ShellKind = "bash" | "powershell" | "cmd";

/** Shell 输出编码（影响 stdout/stderr 解码） */
export type ShellEncoding = "utf-8" | "cp936";

/**
 * Shell 提供者接口
 *
 * 每个实现封装一种 shell 的探测、参数构造与编码策略。
 */
export interface ShellProvider {
  /** Shell 类型 */
  readonly kind: ShellKind;
  /** 输出解码方式 */
  readonly encoding: ShellEncoding;
  /**
   * 探测 shell 可执行路径。
   * @returns 可执行绝对路径；不可用时返回 null（调用方降级到下一个 provider）
   */
  resolve(): string | null;
  /**
   * 构造 spawn 参数。
   * @param command - 用户命令字符串
   * @returns 传给 spawn 的 args 数组
   */
  buildArgs(command: string): string[];
}
