/**
 * 语音通话状态机
 */
import { EventEmitter } from 'node:events'

export type VoiceCallState =
  | 'initializing'
  | 'listening'
  | 'recognizing'
  | 'thinking'
  | 'speaking'
  | 'ending'
  | 'error'

interface StateTransition {
  from: VoiceCallState | VoiceCallState[]
  to: VoiceCallState
}

const VALID_TRANSITIONS: StateTransition[] = [
  { from: 'initializing', to: 'listening' },
  // micless（文字回复出声）起呼直接进 thinking：无 VAD/ASR，等待 TTS
  { from: 'initializing', to: 'thinking' },
  { from: 'listening', to: 'recognizing' },
  { from: 'recognizing', to: 'listening' },
  { from: 'recognizing', to: 'thinking' },
  { from: 'thinking', to: 'speaking' },
  // 回合被用户中断（没有任何 delta、TTS 队列也是空的）→ 只能直接回聆听。
  // 缺这条边时，用户点「停止生成」会让状态永久停在 thinking：
  // handleAudioChunk 只在 listening/recognizing 里跑 ASR，后续语音全被静默丢弃。
  { from: 'thinking', to: 'listening' },
  { from: 'speaking', to: 'listening' },
  { from: 'speaking', to: 'recognizing' },
  { from: 'speaking', to: 'thinking' },
  { from: 'listening', to: 'thinking' },
  {
    from: ['listening', 'recognizing', 'thinking', 'speaking', 'initializing'],
    to: 'ending',
  },
  { from: ['initializing', 'listening', 'recognizing', 'thinking', 'speaking'], to: 'error' },
]

const log = {
  info: (...args: unknown[]) => console.log('[VoiceStateMachine]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceStateMachine]', ...args),
}

export class VoiceCallStateMachine extends EventEmitter {
  private state: VoiceCallState = 'initializing'

  getState(): VoiceCallState {
    return this.state
  }

  transition(to: VoiceCallState): boolean {
    const valid = VALID_TRANSITIONS.some((t) => {
      const froms = Array.isArray(t.from) ? t.from : [t.from]
      return froms.includes(this.state) && t.to === to
    })

    if (!valid) {
      log.warn(`[transition] 非法状态转换: ${this.state} → ${to}`)
      return false
    }

    const from = this.state
    this.state = to
    log.info(`[transition] ${from} → ${to}`)
    this.emit('state', { from, to })
    return true
  }

  is(state: VoiceCallState): boolean {
    return this.state === state
  }

  isOneOf(...states: VoiceCallState[]): boolean {
    return states.includes(this.state)
  }

  reset(): void {
    this.state = 'initializing'
  }
}
