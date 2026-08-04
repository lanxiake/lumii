/**
 * PetBus - 宠物层统一事件总线
 *
 * 设计依据：03-接口与协议设计 §3
 *
 * pet-event-adapter 把 voice:event / agent-runtime:event 转换为 PetBusEvent，
 * PetOrchestrator 消费这些事件驱动动画。MVP 不做表情，故无 agent:emotion。
 */

import type { VoiceCallState } from '../../../shared/voice-events'

/** 语音状态事件 */
export interface PetBusVoiceState {
  readonly kind: 'voice:state'
  state: VoiceCallState
  /** 是否为打断触发（state=listening 且 interrupted） */
  interrupted: boolean
  callId: string
}

/** 通话结束 */
export interface PetBusCallEnded {
  readonly kind: 'voice:ended'
  callId: string
}

/** Agent 流式文本（MVP 仅用于字幕/调试，可选消费） */
export interface PetBusAgentText {
  readonly kind: 'agent:text'
  sessionKey: string
  delta: string
  isComplete: boolean
}

/** 用户点击宠物（命中区域） */
export interface PetBusUserTap {
  readonly kind: 'user:tap'
  hitArea: string
}

export type PetBusEvent =
  | PetBusVoiceState
  | PetBusCallEnded
  | PetBusAgentText
  | PetBusUserTap

/** PetBus 订阅回调 */
export type PetBusHandler = (event: PetBusEvent) => void

/** 极简事件总线（渲染进程内，宠物层独享） */
export class PetBus {
  private handlers = new Set<PetBusHandler>()

  emit(event: PetBusEvent): void {
    for (const h of this.handlers) {
      try {
        h(event)
      } catch (err) {
        console.error('[PetBus] handler 异常:', err)
      }
    }
  }

  on(handler: PetBusHandler): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }

  clear(): void {
    this.handlers.clear()
  }
}
