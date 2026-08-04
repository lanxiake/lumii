/**
 * virtual-human-activation - 会话级虚拟人上下文激活态（主进程单例）
 *
 * 设计依据：08 号 ADR-14（主进程单一数据源）、06 号 §5.1
 *
 * voice-service.startCall 检测到 pet 模式时，解析 VirtualHumanPromptContext 并按
 * sessionKey 激活；BridgePromptComposer 在 buildPromptWithMemory 时按 sessionKey
 * 查询并注入表情/动作/persona 段。stopCall / 退出模式时清除，避免污染普通 Chat。
 */

import type { VirtualHumanPromptContext } from '../../shared/virtual-human'

const log = {
  info: (...args: unknown[]) => console.log('[vh]', ...args),
}

/** sessionKey → 虚拟人上下文 */
const activeContexts = new Map<string, VirtualHumanPromptContext>()

/** 激活某会话的虚拟人上下文（startCall 时） */
export function activateVirtualHumanContext(
  sessionKey: string,
  ctx: VirtualHumanPromptContext,
): void {
  if (!sessionKey) {
    return
  }
  activeContexts.set(sessionKey, ctx)
  log.info(`[activate] sessionKey=${sessionKey} modelId=${ctx.modelId}`)
}

/** 读取某会话的虚拟人上下文（composer 注入时） */
export function getVirtualHumanContext(
  sessionKey: string | undefined,
): VirtualHumanPromptContext | undefined {
  if (!sessionKey) {
    return undefined
  }
  return activeContexts.get(sessionKey)
}

/** 清除某会话的虚拟人上下文（stopCall / 退出模式时） */
export function clearVirtualHumanContext(sessionKey: string): void {
  if (activeContexts.delete(sessionKey)) {
    log.info(`[clear] sessionKey=${sessionKey}`)
  }
}
