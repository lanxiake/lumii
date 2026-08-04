import React, { useState, useEffect, useRef } from 'react'
import clsx from 'clsx'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'
import styles from './MessageActions.module.css'

interface MessageActionsProps {
  messageId: string
  role: 'user' | 'assistant' | 'system'
  content: string
  isEditing: boolean
  onCopy: (content: string) => void
  onEditStart: () => void
  onEditCancel: () => void
  onEditSave: (newContent: string) => void
  onDelete: (messageId: string) => void
  onRegenerate: (messageId: string) => void
  /** 会话流式中：禁用「重新生成」按钮 */
  sessionBusy?: boolean
  /** 是否语音消息（显示回放按钮） */
  isVoice?: boolean
  /** 当前消息是否正在回放 */
  isReplaying?: boolean
  /** 触发从此消息开始的对话回放 */
  onReplay?: () => void
}

const MessageActions: React.FC<MessageActionsProps> = ({
  messageId,
  role,
  content,
  isEditing,
  onCopy,
  onEditStart,
  onEditCancel,
  onEditSave,
  onDelete,
  onRegenerate,
  sessionBusy,
  isVoice,
  isReplaying,
  onReplay,
}) => {
  const [editValue, setEditValue] = useState(content)
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false)
  /** UI：朗读进行中（显示暂停图标，点击停止）— 与合成完毕区分，直到 Web Audio 实际播完 */
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [feedback, setFeedback] = useState<'like' | 'dislike' | null>(null)

  // 用于播放 TTS preview:chunk 的 AudioContext
  const audioCtxRef = useRef<AudioContext | null>(null)
  // 调度时间戳，确保 chunk 按顺序紧密衔接
  const nextPlayTimeRef = useRef<number>(0)
  /** 为 true 时处理预览音频块；停止朗读或播完后置 false，避免订阅依赖 isSpeaking 反复挂载 */
  const acceptTtsChunksRef = useRef(false)
  /** 根据 AudioContext 队列剩余时长，在真正播放结束后收起「朗读中」状态 */
  const playbackEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  /**
   * 清除「播放结束」定时器（用户主动停止或重新开始朗读时调用）
   */
  const clearPlaybackEndTimer = () => {
    if (playbackEndTimerRef.current != null) {
      clearTimeout(playbackEndTimerRef.current)
      playbackEndTimerRef.current = null
    }
  }

  /**
   * 在收到最后一个合成块后预约 UI 结束：等解码缓冲播放完毕再熄灭朗读状态（不误用 isFinal）
   */
  const schedulePlaybackUiEnd = (ctx: AudioContext) => {
    clearPlaybackEndTimer()
    const ms = Math.max(0, (nextPlayTimeRef.current - ctx.currentTime) * 1000) + 120
    playbackEndTimerRef.current = setTimeout(() => {
      playbackEndTimerRef.current = null
      acceptTtsChunksRef.current = false
      setIsSpeaking(false)
    }, ms)
  }

  const handleCopy = () => onCopy(content)
  const handleDelete = () => setIsDeleteModalOpen(true)
  const handleConfirmDelete = () => { onDelete(messageId); setIsDeleteModalOpen(false) }
  const handleCancelDelete = () => setIsDeleteModalOpen(false)

  const handleSave = () => {
    if (editValue.trim()) onEditSave(editValue.trim())
  }
  const handleCancel = () => { setEditValue(content); onEditCancel() }

  const handleSpeak = async () => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.sendCommand) return

    if (isSpeaking) {
      acceptTtsChunksRef.current = false
      clearPlaybackEndTimer()
      await electronAPI.voice.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
      audioCtxRef.current?.close()
      audioCtxRef.current = null
      nextPlayTimeRef.current = 0
      setIsSpeaking(false)
      return
    }

    await electronAPI.voice.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
    clearPlaybackEndTimer()
    acceptTtsChunksRef.current = true

    // 初始化 AudioContext
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: 22050 })
    }
    if (audioCtxRef.current.state === 'suspended') {
      await audioCtxRef.current.resume()
    }
    nextPlayTimeRef.current = audioCtxRef.current.currentTime

    setIsSpeaking(true)
    try {
      const result = await electronAPI.voice.sendCommand({ type: 'voice:tts:preview', text: content })
      if (result?.error === 'models_not_ready') {
        acceptTtsChunksRef.current = false
        clearPlaybackEndTimer()
        setIsSpeaking(false)
        window.dispatchEvent(new CustomEvent('voice:tts:models-not-ready', { detail: result.models }))
      }
    } catch {
      acceptTtsChunksRef.current = false
      clearPlaybackEndTimer()
      setIsSpeaking(false)
    }
  }

  // 订阅 voice:tts:preview:chunk（单次订阅；是否处理由 acceptTtsChunksRef 控制）
  useEffect(() => {
    const electronAPI = (window as any).electronAPI
    if (!electronAPI?.voice?.onEvent) return

    const unsubscribe = electronAPI.voice.onEvent((event: any) => {
      if (event.type !== 'voice:tts:preview:chunk') return
      if (!acceptTtsChunksRef.current) return

      const ctx = audioCtxRef.current
      if (!ctx) return

      if (event.sampleRate === -1) {
        // Edge TTS：mp3 编码字节，需先解码
        void (async () => {
          try {
            const buffer = new Uint8Array(event.samples).buffer
            const decoded = await ctx.decodeAudioData(buffer)
            const source = ctx.createBufferSource()
            source.buffer = decoded
            source.connect(ctx.destination)
            const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime)
            source.start(startAt)
            nextPlayTimeRef.current = startAt + decoded.duration
            if (event.isFinal) schedulePlaybackUiEnd(ctx)
          } catch {
            acceptTtsChunksRef.current = false
            clearPlaybackEndTimer()
            setIsSpeaking(false)
          }
        })()
      } else {
        // 本地 VITS：PCM Float32 直接播放
        try {
          const rawSamples: Float32Array = event.samples instanceof Float32Array
            ? event.samples
            : new Float32Array(event.samples)
          // copyToChannel 在部分 TS 目标下要求 ArrayBuffer 型 Float32Array，复制一份以统一类型
          const samples = new Float32Array(rawSamples)
          const sampleRate: number = event.sampleRate > 0 ? event.sampleRate : 22050

          if (ctx.state === 'running' && samples.length > 0) {
            const buffer = ctx.createBuffer(1, samples.length, sampleRate)
            buffer.copyToChannel(samples, 0)
            const source = ctx.createBufferSource()
            source.buffer = buffer
            source.connect(ctx.destination)

            const startAt = Math.max(nextPlayTimeRef.current, ctx.currentTime)
            source.start(startAt)
            nextPlayTimeRef.current = startAt + buffer.duration
          }

          if (event.isFinal) schedulePlaybackUiEnd(ctx)
        } catch {
          acceptTtsChunksRef.current = false
          clearPlaybackEndTimer()
          setIsSpeaking(false)
        }
      }
    })

    return unsubscribe
  }, [])

  // 组件卸载时停止朗读
  useEffect(() => {
    return () => {
      acceptTtsChunksRef.current = false
      clearPlaybackEndTimer()
      const electronAPI = (window as any).electronAPI
      electronAPI?.voice?.sendCommand({ type: 'voice:tts:stop-preview' }).catch(() => {})
      audioCtxRef.current?.close()
    }
  }, [])

  if (isEditing) {
    return (
      <div className={styles['message-edit-mode']}>
        <textarea
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          className={styles['edit-textarea']}
          autoFocus
        />
        <div className={styles['edit-actions']}>
          <button className={clsx(styles['edit-btn'], styles.save)} onClick={handleSave}>保存</button>
          <button className={clsx(styles['edit-btn'], styles.cancel)} onClick={handleCancel}>取消</button>
        </div>
      </div>
    )
  }

  return (
    <div className={styles['message-actions']}>
      {/* 复制 */}
      <button className={styles['action-btn']} onClick={handleCopy} title="复制">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      </button>

      {/* 语音朗读（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], isSpeaking && styles.active)}
          onClick={handleSpeak}
          title={isSpeaking ? '停止朗读' : '朗读'}
        >
          {isSpeaking ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
              <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
              <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
            </svg>
          )}
        </button>
      )}

      {/* 点赞（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], feedback === 'like' && styles.liked)}
          onClick={() => setFeedback((p) => (p === 'like' ? null : 'like'))}
          title="有帮助"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === 'like' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z" />
            <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      )}

      {/* 点踩（仅 assistant） */}
      {role === 'assistant' && (
        <button
          className={clsx(styles['action-btn'], feedback === 'dislike' && styles.disliked)}
          onClick={() => setFeedback((p) => (p === 'dislike' ? null : 'dislike'))}
          title="没有帮助"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill={feedback === 'dislike' ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2">
            <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3H10z" />
            <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
          </svg>
        </button>
      )}

      {/* 编辑（仅 user） */}
      {role === 'user' && (
        <button className={styles['action-btn']} onClick={onEditStart} title="编辑">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </button>
      )}

      {/* 回放对话（仅语音消息） */}
      {isVoice && onReplay && (
        <button
          className={clsx(styles['action-btn'], isReplaying && styles.active)}
          onClick={onReplay}
          title={isReplaying ? '正在回放...' : '从此处回放对话'}
        >
          {isReplaying ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <polygon points="5,3 19,12 5,21" />
            </svg>
          )}
        </button>
      )}

      {/* 重新生成（user / assistant 均可）：回到对应提问，删后续重答 */}
      {(role === 'user' || role === 'assistant') && (
        <button
          className={clsx(styles['action-btn'], styles.regenerate)}
          onClick={() => onRegenerate(messageId)}
          disabled={sessionBusy}
          title={sessionBusy ? '正在回复中…' : '重新生成'}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="23 4 23 10 17 10" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      )}

      {/* 分享（复制到剪贴板） */}
      <button className={styles['action-btn']} onClick={() => onCopy(content)} title="分享">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
        </svg>
      </button>

      {/* 删除 */}
      <button className={clsx(styles['action-btn'], styles.delete)} onClick={handleDelete} title="删除">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        </svg>
      </button>

      <ConfirmModal
        open={isDeleteModalOpen}
        title="确认删除消息"
        content="确定要删除这条消息吗？此操作不可恢复。"
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={handleCancelDelete}
      />
    </div>
  )
}

export default MessageActions
export { MessageActions }
