/**
 * PetControlDock - 宠物模式统一控制坞
 *
 * 参考 Open-LLM-VTuber InputSubtitle：毛玻璃浮动卡片，集成聊天记录、通话状态、
 * 麦克风/静音/声音开关/挂断与穿透/退出操作于单一组件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceCallState } from '../../../shared/voice-events'
import type { PetModelConfigDTO } from '../../../shared/pet-mode'
import {
  MicIcon,
  VolumeOnIcon,
  VolumeOffIcon,
  StopIcon,
  SendIcon,
  BellIcon,
  GearIcon,
} from './icons'
import type { PetAvatarStatus } from '../orchestrator/PetOrchestrator'
import { formatAvatarStatusLine } from '../utils/pet-status-labels'

/** 聊天记录单条消息（内存态轻量展示） */
export interface PetChatMessage {
  id: string
  role: 'user' | 'assistant'
  text: string
}

export interface PetControlDockProps {
  voiceState: VoiceCallState | 'idle'
  partialTranscript: string
  /** 聊天记录（用户+AI），输入框上方倒序展示最近若干条 */
  messages: PetChatMessage[]
  error?: string | null
  muted: boolean
  /** 声音开关：true=文字回复出声(TTS+真口型)，false=静默(伪口型) */
  voiceReplyEnabled: boolean
  /** 待机随机动作开关（仅用于状态行文案展示，开关本体已移至设置页） */
  idleMotionEnabled: boolean
  /** 当前虚拟人表情/动作状态（编排器推送） */
  avatarStatus?: PetAvatarStatus | null
  modelLoaded: boolean
  voiceError?: string | null
  /** 可切换的 Live2D 模型列表（控制坞下拉展示） */
  models: PetModelConfigDTO[]
  /** 当前模型 ID */
  currentModelId: string
  onStartVoice: () => void | Promise<void>
  onStopVoice: () => void | Promise<void>
  onToggleMute: () => void
  /** 切换声音开关 */
  onToggleVoiceReply: () => void | Promise<void>
  /** 切换当前模型（热切换） */
  onChangeModel: (modelId: string) => void | Promise<void>
  onExit: () => void | Promise<void>
  /** 发送文字消息（虚拟人会语音/字幕回应） */
  onSendText: (text: string) => void | Promise<void>
  /** AI 朗读时自动闭麦 */
  autoMuteMicWhileSpeaking: boolean
  /** 语音识别阈值（vad.threshold，0~1，越低越灵敏） */
  vadThreshold: number
  /** 负面语音阈值（vad.energyGateMultiplier，越大越严格，过滤背景噪声/回声） */
  energyGateMultiplier: number
  /** 修改语音引擎配置（合并持久化，主进程广播热更新） */
  onChangeVoiceSetting: (patch: {
    autoMuteMicWhileSpeaking?: boolean
    vad?: { threshold?: number; energyGateMultiplier?: number }
  }) => void | Promise<void>
}

const STATE_LABEL: Record<string, string> = {
  idle: '待机 — 点击麦克风开始对话',
  initializing: '正在加载语音引擎...',
  listening: '你可以说话了',
  recognizing: '正在听...',
  thinking: '等待 AI 回复...',
  speaking: '说话可打断 AI',
  ending: '通话结束中...',
  error: '发生错误',
}

/** 聊天记录最多展示条数（轻量，更早的不在坞内呈现，后台已落 DB） */
const MAX_VISIBLE_MESSAGES = 6

/** 可选中复制的文本区域样式 */
const selectableText: React.CSSProperties = {
  userSelect: 'text',
  WebkitUserSelect: 'text',
  cursor: 'text',
}

const glass: React.CSSProperties = {
  background: 'rgba(0, 0, 0, 0.72)',
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  borderRadius: 14,
  boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
  border: '1px solid rgba(255,255,255,0.12)',
  color: '#fff',
}

/**
 * 宠物模式底部统一控制坞（可拖拽、始终可点击，不参与身体穿透）。
 */
export const PetControlDock: React.FC<PetControlDockProps> = ({
  voiceState,
  partialTranscript,
  messages,
  error,
  muted,
  voiceReplyEnabled,
  idleMotionEnabled,
  avatarStatus,
  modelLoaded,
  voiceError,
  models,
  currentModelId,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onToggleVoiceReply,
  onChangeModel,
  onExit,
  onSendText,
  autoMuteMicWhileSpeaking,
  vadThreshold,
  energyGateMultiplier,
  onChangeVoiceSetting,
}) => {
  const dockRef = useRef<HTMLDivElement | null>(null)
  const messagesRef = useRef<HTMLDivElement | null>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const [inputText, setInputText] = useState('')
  const [showVoiceSettings, setShowVoiceSettings] = useState(false)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)

  const handleSend = useCallback(() => {
    const text = inputText.trim()
    if (!text) return
    void onSendText(text)
    setInputText('')
  }, [inputText, onSendText])

  const inCall = voiceState !== 'idle'
  const stateColor =
    voiceState === 'listening'
      ? '#4f9eff'
      : voiceState === 'recognizing'
        ? '#f0a500'
        : voiceState === 'speaking'
          ? '#52c41a'
          : voiceState === 'thinking'
            ? 'rgba(255,255,255,0.75)'
            : 'rgba(255,255,255,0.55)'

  useEffect(() => {
    const el = messagesRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, partialTranscript])

  /** 拖拽移动控制坞（仅标题栏区域触发） */
  const onDragStart = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    const el = dockRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: pos?.x ?? rect.left,
      origY: pos?.y ?? rect.top,
    }
    e.preventDefault()
  }, [dockRef, pos])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      const dx = e.clientX - dragRef.current.startX
      const dy = e.clientY - dragRef.current.startY
      setPos({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy })
    }
    const onUp = () => {
      dragRef.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  const visibleMessages = messages.slice(-MAX_VISIBLE_MESSAGES)
  const showMessageArea = visibleMessages.length > 0 || !!partialTranscript || inCall

  const positionStyle: React.CSSProperties = pos
    ? { position: 'absolute', left: pos.x, top: pos.y, transform: 'none' }
    : { position: 'absolute', bottom: 120, left: '50%', transform: 'translateX(-50%)' }

  return (
    <div
      ref={dockRef}
      onMouseEnter={() =>
        window.electronAPI?.pet?.reportHover({ componentId: 'pet-dock', isHovering: true })
      }
      onMouseLeave={() =>
        window.electronAPI?.pet?.reportHover({ componentId: 'pet-dock', isHovering: false })
      }
      style={{
        ...positionStyle,
        width: 400,
        maxWidth: 'min(400px, 92vw)',
        pointerEvents: 'auto',
        zIndex: 1000,
      }}
    >
      <div style={{ ...glass, overflow: 'hidden' }}>
        {/* 拖拽标题栏（不可选中，避免与拖拽冲突） */}
        <div
          onMouseDown={onDragStart}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '8px 12px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            cursor: 'grab',
            fontSize: 11,
            color: 'rgba(255,255,255,0.45)',
            userSelect: 'none',
          }}
        >
          <span>{modelLoaded ? '虚拟人' : '加载中...'}</span>
          <span style={{ fontSize: 10 }}>拖拽移动</span>
        </div>

        {(voiceError || error) && !inCall && (
          <div
            style={{
              padding: '8px 14px',
              fontSize: 12,
              color: '#fca5a5',
              background: 'rgba(127,29,29,0.35)',
              ...selectableText,
            }}
          >
            {voiceError || error}
          </div>
        )}

        {/* 聊天记录区（用户+AI，输入框上方轻量展示） */}
        {showMessageArea && (
          <div
            ref={messagesRef}
            style={{
              padding: '12px 16px',
              maxHeight: 180,
              overflowY: 'auto',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              ...selectableText,
            }}
          >
            {visibleMessages.map((m) => (
              <ChatBubble key={m.id} role={m.role} text={m.text} />
            ))}
            {partialTranscript && (
              <div
                style={{
                  fontSize: 13,
                  color: 'rgba(255,255,255,0.5)',
                  fontStyle: 'italic',
                  marginTop: 4,
                  ...selectableText,
                }}
              >
                {partialTranscript}
              </div>
            )}
            {visibleMessages.length === 0 && !partialTranscript && inCall && voiceState === 'listening' && (
              <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)', textAlign: 'center' }}>
                对着麦克风说话开始对话
              </div>
            )}
          </div>
        )}

        {/* 状态栏 + 语音操作 */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '10px 14px',
            background: 'rgba(0,0,0,0.35)',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 500, color: stateColor }}>
              <BellIcon size={15} />
              <span>{STATE_LABEL[voiceState] ?? voiceState}</span>
            </div>
            <div
              key={avatarStatus?.statusSeq ?? 0}
              style={{
                marginTop: 4,
                marginLeft: 23,
                fontSize: 11,
                lineHeight: 1.45,
                color: 'rgba(255,255,255,0.52)',
                ...selectableText,
              }}
            >
              {formatAvatarStatusLine(avatarStatus, { idleMotionEnabled })}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {/* 语音参数设置：展开/收起阈值与闭麦面板 */}
            <DockIconButton
              title="语音设置（闭麦/识别阈值）"
              onClick={() => setShowVoiceSettings((v) => !v)}
              active={showVoiceSettings}
              accent="#8b5cf6"
            >
              <GearIcon />
            </DockIconButton>
            {/* 声音开关：文字回复出声/静默（始终可见） */}
            <DockIconButton
              title={voiceReplyEnabled ? '声音开启（文字回复朗读）' : '声音关闭（仅字幕+口型）'}
              onClick={() => void onToggleVoiceReply()}
              active={voiceReplyEnabled}
              accent="#0ea5e9"
            >
              {voiceReplyEnabled ? <VolumeOnIcon /> : <VolumeOffIcon />}
            </DockIconButton>
            {!inCall ? (
              <DockIconButton
                title="开始语音对话"
                onClick={() => void onStartVoice()}
                active
                accent="#10b981"
              >
                <MicIcon />
              </DockIconButton>
            ) : (
              <>
                <DockIconButton
                  title={muted ? '取消静音' : '静音'}
                  onClick={onToggleMute}
                  active={muted}
                  accent="#f59e0b"
                >
                  {muted ? <VolumeOffIcon /> : <VolumeOnIcon />}
                </DockIconButton>
                <DockIconButton title="挂断" onClick={() => void onStopVoice()} accent="#ef4444">
                  <StopIcon />
                </DockIconButton>
              </>
            )}
          </div>
        </div>

        {/* 语音参数面板（齿轮展开）：闭麦开关 + 识别阈值 + 负面语音阈值 */}
        {showVoiceSettings && (
          <div
            style={{
              padding: '12px 14px',
              background: 'rgba(0,0,0,0.28)',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            {/* AI 朗读时自动闭麦 */}
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                fontSize: 12,
                color: 'rgba(255,255,255,0.82)',
                cursor: 'pointer',
              }}
            >
              <span>AI 朗读时自动闭麦</span>
              <input
                type="checkbox"
                checked={autoMuteMicWhileSpeaking}
                onChange={(e) => void onChangeVoiceSetting({ autoMuteMicWhileSpeaking: e.target.checked })}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
            </label>

            {/* 语音识别阈值（vad.threshold，越低越灵敏） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'rgba(255,255,255,0.82)' }}>
                <span>语音识别阈值（越低越灵敏）</span>
                <span style={{ color: '#a5f3fc' }}>{vadThreshold.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={vadThreshold}
                onChange={(e) => void onChangeVoiceSetting({ vad: { threshold: parseFloat(e.target.value) } })}
                style={{ width: '100%', cursor: 'pointer' }}
              />
            </div>

            {/* 负面语音阈值（vad.energyGateMultiplier，越大越严格） */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'rgba(255,255,255,0.82)' }}>
                <span>负面语音阈值（越大越严格，过滤噪声/回声）</span>
                <span style={{ color: '#a5f3fc' }}>{energyGateMultiplier.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min={1}
                max={5}
                step={0.1}
                value={energyGateMultiplier}
                onChange={(e) => void onChangeVoiceSetting({ vad: { energyGateMultiplier: parseFloat(e.target.value) } })}
                style={{ width: '100%', cursor: 'pointer' }}
              />
            </div>
          </div>
        )}

        {/* 文字输入：聚焦时临时让窗口可接收键盘，失焦恢复穿透 */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px 0' }}>
          <input
            type="text"
            value={inputText}
            placeholder="输入文字和虚拟人对话…"
            onFocus={() => void window.electronAPI?.pet?.setFocusable?.(true)}
            onBlur={() => void window.electronAPI?.pet?.setFocusable?.(false)}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                e.preventDefault()
                handleSend()
              }
            }}
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.08)',
              color: '#fff',
              fontSize: 13,
              outline: 'none',
            }}
          />
          <DockIconButton title="发送" onClick={handleSend} accent="#6366f1" active={!!inputText.trim()}>
            <SendIcon />
          </DockIconButton>
        </div>

        {/* 系统操作：模型切换 / 退出 */}
        <div style={{ display: 'flex', gap: 8, padding: '10px 14px', alignItems: 'center' }}>
          <select
            value={currentModelId}
            title="切换虚拟人模型"
            onFocus={() => void window.electronAPI?.pet?.setFocusable?.(true)}
            onBlur={() => void window.electronAPI?.pet?.setFocusable?.(false)}
            onChange={(e) => void onChangeModel(e.target.value)}
            style={{
              flex: 1,
              padding: '8px 10px',
              borderRadius: 10,
              border: '1px solid rgba(255,255,255,0.18)',
              background: 'rgba(255,255,255,0.12)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {models.length === 0 && <option value={currentModelId}>加载中…</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id} style={{ color: '#000' }}>
                {m.name}
              </option>
            ))}
          </select>
          <DockTextButton onClick={() => void onExit()} title="退出宠物模式（Ctrl+Shift+P）">
            退出
          </DockTextButton>
        </div>
      </div>
    </div>
  )
}

/** 聊天气泡：用户右侧灰、AI 左侧青 */
const ChatBubble: React.FC<{ role: 'user' | 'assistant'; text: string }> = ({ role, text }) => {
  const isUser = role === 'user'
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: isUser ? 'row-reverse' : 'row',
        gap: 6,
        marginBottom: 6,
      }}
    >
      <span
        style={{
          flexShrink: 0,
          fontSize: 11,
          color: 'rgba(255,255,255,0.4)',
          lineHeight: '20px',
        }}
      >
        {isUser ? '你' : 'AI'}
      </span>
      <span
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: isUser ? 'rgba(255,255,255,0.92)' : '#a5f3fc',
          background: isUser ? 'rgba(255,255,255,0.08)' : 'rgba(34,211,238,0.08)',
          borderRadius: 8,
          padding: '3px 8px',
          maxWidth: '82%',
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          userSelect: 'text',
          WebkitUserSelect: 'text',
        }}
      >
        {text || (isUser ? '' : '…')}
      </span>
    </div>
  )
}

/** 图标按钮 */
const DockIconButton: React.FC<{
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
  accent?: string
}> = ({ children, onClick, title, active, accent = '#6366f1' }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={{
      width: 36,
      height: 36,
      borderRadius: 10,
      border: 'none',
      background: active ? accent : 'rgba(255,255,255,0.12)',
      color: '#fff',
      cursor: 'pointer',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      transition: 'background 0.15s',
    }}
  >
    {children}
  </button>
)

/** 文字按钮 */
const DockTextButton: React.FC<{
  children: React.ReactNode
  onClick: () => void
  title?: string
  active?: boolean
}> = ({ children, onClick, title, active }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    style={{
      flex: 1,
      padding: '8px 12px',
      borderRadius: 10,
      border: 'none',
      background: active ? 'rgba(245,158,11,0.85)' : 'rgba(255,255,255,0.12)',
      color: '#fff',
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
)

export default PetControlDock
