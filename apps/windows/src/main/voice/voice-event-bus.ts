/**
 * 语音事件总线
 * 用于主进程内部 AgentRuntime IPC 层与 VoiceCallService 之间的解耦通信
 * agent-runtime-ipc.ts 向此总线 emit 事件，VoiceCallService 订阅
 */
import { EventEmitter } from 'node:events'

class VoiceEventBus extends EventEmitter {
  constructor() {
    super()
    this.setMaxListeners(20)
  }
}

/** 全局单例，主进程内共享 */
export const voiceEventBus = new VoiceEventBus()
