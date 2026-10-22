/**
 * Agent 事件流的**核心侧出口**（进程内广播）。
 *
 * 谁在用：Agent Runtime 把流式事件推给语音服务（实时朗读）。但它不是语音专属——
 * 任何订阅者都可以听，所以这条通道归核心，订阅方归插件。
 *
 * 之前这条总线定义在语音插件里，核心反向 import 插件实现（守卫 ⑪ 的边界）；
 * 移到核心后，插件只订阅、不拥有通道。
 */
type AgentEventListener = (event: unknown) => void

const listeners = new Set<AgentEventListener>()

/** 广播一条 Agent 事件；订阅者抛错不影响其它订阅者与推送方 */
export function emitAgentEvent(event: unknown): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch (error) {
      console.warn('[agent-event] 订阅者回调异常', error)
    }
  }
}

/** 订阅；返回取消函数 */
export function onAgentEvent(listener: AgentEventListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
