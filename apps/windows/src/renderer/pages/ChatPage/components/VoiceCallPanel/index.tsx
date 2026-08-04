/**
 * 语音通话面板
 * 通话期间替换 ChatInput，显示通话状态和实时字幕
 */
import React from 'react'
import type { VoiceCallState } from '../../../../../shared/voice-events.js'
import { WaveformVisualizer } from './WaveformVisualizer.js'
import styles from './VoiceCallPanel.module.css'

interface VoiceCallPanelProps {
  state: VoiceCallState | 'idle'
  partialTranscript: string
  finalTranscript: string
  error?: string | null
  onHangup: () => void
  /** 实时波形分析节点（可选） */
  analyserNode?: AnalyserNode | null
}

const STATE_LABEL: Record<string, string> = {
  idle: '准备就绪',
  initializing: '正在加载语音引擎...',
  listening: '你可以说话了',
  recognizing: '正在听...',
  thinking: 'AI 思考中...',
  speaking: '说话打断 AI',
  ending: '通话结束中...',
  error: '发生错误',
}

const STATE_CLASS: Record<string, string> = {
  listening: 'state-listening',
  recognizing: 'state-recognizing',
  speaking: 'state-speaking',
  thinking: 'state-thinking',
}

export function VoiceCallPanel({
  state,
  partialTranscript,
  finalTranscript,
  error,
  onHangup,
  analyserNode,
}: VoiceCallPanelProps) {
  const stateClass = STATE_CLASS[state] ?? ''

  return (
    <div className={styles['voice-call-panel']}>
      {/* 实时波形可视化 */}
      <WaveformVisualizer state={state} analyserNode={analyserNode} />

      {/* 状态文字 */}
      <div className={`${styles['voice-state-label']} ${styles[stateClass] ?? ''}`}>
        {STATE_LABEL[state] ?? state}
      </div>

      {/* 错误信息 */}
      {state === 'error' && error && (
        <div className={styles['voice-error-message']}>{error}</div>
      )}

      {/* 实时字幕区 */}
      <div className={styles['voice-transcript']}>
        {finalTranscript && (
          <div className={styles['transcript-final']}>{finalTranscript}</div>
        )}
        {partialTranscript && (
          <div className={styles['transcript-partial']}>{partialTranscript}</div>
        )}
      </div>

      {/* 挂断按钮 */}
      <button
        type="button"
        className={styles['voice-hangup-btn']}
        onClick={onHangup}
        aria-label="挂断通话"
        title="挂断"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z" />
        </svg>
        <span>挂断</span>
      </button>
    </div>
  )
}

export default VoiceCallPanel
