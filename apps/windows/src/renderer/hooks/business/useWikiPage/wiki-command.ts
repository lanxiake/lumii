/**
 * Wiki 命令发送助手
 *
 * 收敛 useWikiPage 中 47 处 `api?.sendCommand` 样板的运行时守卫与 agentId 注入；
 * 失败语义仍由调用方 try/catch 决定（吞错返哨兵 / 转错误对象 / 上抛）。
 */

/**
 * 单机应用固定单一 agent；主进程侧同样兜底 'assistant'
 * （wiki-commands.ts resolveAgentIdForWiki）。显式传入以消除对隐式兜底的依赖。
 */
const DEFAULT_AGENT_ID = 'assistant'

/** agentRuntime 桥不可用时抛出（消息与 openSource 原实现一致） */
const RUNTIME_UNAVAILABLE_MESSAGE = 'agentRuntime 不可用'

/**
 * 发送一条 Wiki 运行时命令并返回结果。
 * 运行时不可用时抛出 Error；命令执行失败原样上抛，由调用方决定处理方式。
 */
export async function sendWikiCommand<T>(
  command: { type: string } & Record<string, unknown>,
): Promise<T> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
  return (await api.sendCommand({ agentId: DEFAULT_AGENT_ID, ...command })) as T
}
