/**
 * pet-event-adapter - IPC 事件 → PetBus 适配器
 *
 * 设计依据：03-接口与协议设计 §3.2 / G-3（独立订阅，不复用 ChatPage）
 *
 * 宠物层独立订阅 voice:event（及未来 agent-runtime:event），转换为 PetBusEvent。
 * 与 ChatPage 的订阅互不干扰（事件是广播，各自更新自己的视图）。
 * dispose 时解绑全部监听，避免泄漏。
 */

import { PetBus } from './pet-bus'

const log = {
  info: (...args: unknown[]) => console.log('[pet-event-adapter]', ...args),
}

/** 绑定 voice:event 到 PetBus，返回解绑函数 */
export function bindPetEventAdapter(bus: PetBus): () => void {
  const unsubs: Array<() => void> = []

  const voiceApi = window.electronAPI?.voice
  if (voiceApi?.onEvent) {
    const unsub = voiceApi.onEvent((event: unknown) => {
      const e = event as Record<string, unknown>
      const type = e?.type as string | undefined
      switch (type) {
        case 'voice:call:state':
          bus.emit({
            kind: 'voice:state',
            state: e.state as never,
            interrupted: e.state === 'listening' && e.interrupted === true,
            callId: (e.callId as string) ?? '',
          })
          break
        case 'voice:call:ended':
          bus.emit({ kind: 'voice:ended', callId: (e.callId as string) ?? '' })
          break
        default:
          break
      }
    })
    unsubs.push(unsub)
    log.info('已订阅 voice:event')
  }

  return () => {
    unsubs.forEach((u) => u())
    log.info('已解绑全部监听')
  }
}
