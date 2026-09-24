/**
 * PetControlDock - 宠物模式统一控制坞
 *
 * 参考 Open-LLM-VTuber InputSubtitle：毛玻璃浮动卡片，集成聊天记录、通话状态、
 * 麦克风/静音/声音开关/挂断与穿透/退出操作于单一组件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import type { VoiceCallState } from '../../../shared/voice-events'
import type { PetModelConfigDTO, PetExperienceDTO, PetTaskItemDTO, PetTaskStateDTO } from '../../../shared/pet-mode'
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
import { shortSessionLabel, type SessionRun } from '../utils/session-activity'
import { noticeActionLabel } from '../utils/pet-notice-adapter'
import { light, dark, selectableText } from './pet-dock-theme'
import { PetExperiencePanel } from './PetExperiencePanel'
import type { PetNotice } from '@mtbot/pet-core'

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
  /**
   * 气质标签（第二期 / 验收 U2）：出生抽签 + 演化出的那一句「好奇，但有点怕生」。
   *
   * 读不到时传 `null`，**不要在坞里凭空编一句**——用户看到的应当是"暂时不知道"
   * 而不是一个随机脾气。数值一律不进 UI（§3.6）。
   */
  personalityLabel?: string | null
  /**
   * 除当前会话之外**还在跑**的会话（多会话并发时用）。
   *
   * 只做展示与跳转，**不参与任何动画**——后台 cron agent 常年有活，
   * 让它影响姿态/呼吸的话宠物会永远在抖（见 `utils/session-activity.ts`）。
   */
  otherRuns?: readonly SessionRun[]
  /** 点某条会话：请主窗口切过去（主进程转发 `app-ui:goto`） */
  onFocusSession?: (sessionKey: string) => void
  /**
   * 待办通知（R6「叫得动」）：**等你出手**的事。
   *
   * 与 `otherRuns` 分工不同：那边是"还有谁在动"（纯展示），这边是"这件事不做，它就永远不动"
   * ——`action` 档的审批 5 分钟超时即 deny。所以它是控制坞里唯一**常驻**的一块。
   *
   * 传进来的是 `pendingNotices()` 的结果：未销账、`action` 在前、`ambient` 不列。
   */
  pendingNotices?: readonly PetNotice[]
  /** 点某条待办：把人送到那张卡前面（S2 只做"主窗前台 + 切会话"，高亮那张卡是 S3） */
  onFocusNotice?: (notice: PetNotice) => void
  /**
   * 控制坞「宠物流」那一区（五期 T5.6/T5.8）：进行中的条目 + 结果回执 + 未读。
   *
   * `null` / 缺省 = 整块不渲染（bridge 没起、不在宠物模式）。**与 `pendingNotices`
   * 不是一回事**：那边是"现在要不要你出手"（有 TTL、会销账），这边是"它替你看过什么"
   * （持久、带未读）。设计 §10.3.2 那张图里，"宠物"与"对话"是消息区的两条流，
   * 而待办区在状态栏——三块各占各的位置。
   */
  petTask?: PetTaskStateDTO | null
  /**
   * 「经历」Tab 的内容（七期 T7.6）：出生 / 性格变化 / 做过的事 / 日记。
   *
   * `null` / 缺省 = 读不到（bridge 没起、不在宠物模式），面板如实说"还读不到"。
   * 由 `PetModeShell` 从 `pet:experience:summary` 取来注入——坞保持**纯 props**。
   */
  experience?: PetExperienceDTO | null
  /**
   * 点「让它去做」。
   *
   * 坞**不做任何受理判断**（单飞锁 / 日闸门 / 能力边界都要读库，主进程才有）。
   * 它只把文本递上去；受理结论以气泡 + 宠物流条目的形式回来。
   *
   * **返回 false = 没受理**，坞据此**保留输入框里的原文**（见下面 onClick）。
   * 返回 `void`（比如没接线）按"受理了"处理——那是旧行为，不该因为一个返回值
   * 就把用户的字留在框里出不去。
   */
  onPetTaskRun?: (text: string) => void | boolean | Promise<void | boolean>
  /** 「转给主助手」：把它看到的东西交给真正的任务 Agent（用户主动触发，唯一通道） */
  onPetTaskHandoff?: (item: { description: string; text: string }) => void | Promise<void>
  /**
   * 正在受理中（点了按钮、还没拿到回答）。
   *
   * 用来**立刻**把按钮与输入框置灰——设计 §10.3.3 要求点下去 < 200ms 有响应，
   * 而"按钮还能再点"会让用户以为没点上，于是连点三次。
   */
  petTaskBusy?: boolean
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
  /**
   * 收起这个面板。
   *
   * **注意不是"退出宠物模式"**（2026-09-22 改）：宠物和主窗口现在是并行的，
   * 面板只是面板，关掉它不该把宠物一起收走——那是右键菜单里"关闭宠物模式"的事。
   * 这里原先接的是 `handleExit`，按一下整只宠物就没了，与"关个面板"的心理预期差太远。
   */
  onClose: () => void | Promise<void>
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

// ─────────────────────────────────────────────────────────────
// 色层
//
// LIGHT / DARK / light() / dark() / selectableText 已抽到 `pet-dock-theme.ts`
// ——七期 T7.6 的「经历」面板是坞的第二个 Tab，切一下 Tab 整个面板的明暗
// 不该跳一格，所以两者必须共用同一套刻度（抄一份常量过去正是老路）。
// 设计上"坞刻意不跟主窗主题"那条不变，理由随常量一起搬到了那个文件。
// ─────────────────────────────────────────────────────────────

/** 强调色底上的前景白——固定在有色底上，不参与"层亮度"调节 */
const FG_ON_ACCENT = '#fff'

/**
 * 宠物流的色调（设计 §10.3.2：「宠物自己的流（气泡式，**蓝色调**）」）。
 *
 * 与对话流的 `#a5f3fc`（青）刻意不同色：两条流同屏，靠的是**颜色**分区，
 * 而不是一条分割线——用户扫一眼就知道哪句是它自己冒出来的、哪句是在跟他对话。
 * 蓝色也比青色冷一点，与"它去办事"这个语义配。
 */
const PET_FLOW_COLOR = '#93c5fd'

/** 回执失败时的色调。与待办区那个 `rgba(255,205,120,…)` 同色系（"这不是好消息"只用一套色） */
const PET_FLOW_FAIL_COLOR = 'rgba(255, 205, 120, 0.95)'

const glass: React.CSSProperties = {
  background: dark(0.72),
  backdropFilter: 'blur(10px)',
  WebkitBackdropFilter: 'blur(10px)',
  borderRadius: 14,
  boxShadow: `0 8px 32px ${dark(0.45)}`,
  border: `1px solid ${light(0.12)}`,
  color: FG_ON_ACCENT,
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
  personalityLabel,
  otherRuns,
  onFocusSession,
  pendingNotices,
  onFocusNotice,
  petTask,
  onPetTaskRun,
  onPetTaskHandoff,
  petTaskBusy,
  experience,
  modelLoaded,
  voiceError,
  models,
  currentModelId,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onToggleVoiceReply,
  onChangeModel,
  onClose,
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
  /** 展开的那条回执 id。一次只展开一条——坞只有 400px 宽，两条展开就把它撑成一张长表 */
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null)
  /**
   * 当前 Tab（七期 T7.6）。
   *
   * 默认「对话」：坞的主职仍是"跟他说话"，「经历」是偶尔翻一次的**证据页**
   * （设计 §8.4）。做成状态而不是两个面板并列，是因为两者的高度差很多
   * （对话要输入框与状态栏，经历只要一段可滚动的列表），并排会有一个永远空着。
   */
  const [tab, setTab] = useState<'chat' | 'experience'>('chat')
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
            ? `${light(0.75)}`
            : `${light(0.55)}`

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
  /**
   * 宠物流那一区显不显示。
   *
   * **进行中的条目也算内容**（`running` 非空就显示）——设计 §10.3.3 第 3 步要的就是
   * "用户点完立刻看到一条在转的条目"，那时还没有任何回执。
   */
  const petFlow = petTask
  const hasPetFlow = !!petFlow && (petFlow.running !== null || petFlow.items.length > 0)
  /** 有两条流才加"对话"小标题：只有一条流时加标题是凭空的仪式感 */
  const showFlowLabels = hasPetFlow && showMessageArea

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
            borderBottom: `1px solid ${light(0.1)}`,
            cursor: 'grab',
            fontSize: 11,
            color: `${light(0.45)}`,
            userSelect: 'none',
          }}
        >
          <span>
            {modelLoaded ? '虚拟人' : '加载中...'}
            {/* 气质标签（第二期，验收 U2）：只给一句话，不给数值——§3.6 的禁令 */}
            {personalityLabel && (
              <span style={{ marginLeft: 8, color: `${light(0.6)}` }}>· {personalityLabel}</span>
            )}
          </span>
          <span style={{ fontSize: 10 }}>拖拽移动</span>
        </div>

        {/*
          Tab 条（七期 T7.6）。**只有两个**：对话是它的日常，经历是偶尔翻一次的
          证据页（设计 §8.4）。刻意不做成图标——坞顶那一条已经够挤，
          而"经历"这个词本身就是用户会去找的。
        */}
        <div
          style={{
            display: 'flex',
            gap: 4,
            padding: '6px 10px 0',
            borderBottom: `1px solid ${light(0.08)}`,
          }}
        >
          {(
            [
              ['chat', '对话'],
              ['experience', '经历'],
            ] as const
          ).map(([key, label]) => {
            const active = tab === key
            return (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{
                  flex: 1,
                  padding: '5px 0',
                  border: 'none',
                  borderBottom: `2px solid ${active ? `${light(0.55)}` : 'transparent'}`,
                  background: 'transparent',
                  color: active ? `${light(0.85)}` : `${light(0.42)}`,
                  fontSize: 12,
                  font: 'inherit',
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
              >
                {label}
                {/* 宠物流有未读时在「对话」上点一下——它就在那个 Tab 里（五期 T5.8） */}
                {key === 'chat' && petTask && petTask.unread > 0 && (
                  <span style={{ marginLeft: 4, color: PET_FLOW_COLOR }}>·</span>
                )}
              </button>
            )
          })}
        </div>

        {tab === 'experience' ? (
          <PetExperiencePanel experience={experience ?? null} />
        ) : (
          <>
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

        {/* 聊天记录区：**两条流同屏分区**（五期 T5.6，设计 §10.3.2） */}
        {(showMessageArea || hasPetFlow) && (
          <div
            ref={messagesRef}
            style={{
              padding: '12px 16px',
              maxHeight: 220,
              overflowY: 'auto',
              borderBottom: `1px solid ${light(0.08)}`,
              ...selectableText,
            }}
          >
            {/*
              ── 宠物流（上半区，蓝色调）──
              设计 §10.3.2 的一句话解释了它为什么**不是**第二个 Tab：
              「宠物主动说话的价值在于它自己冒出来」——藏进 Tab 就等于没有。
              所以分区但同屏，让它在余光里被看到。
            */}
            {hasPetFlow && petFlow && (
              <div style={{ marginBottom: showMessageArea ? 10 : 0 }}>
                <FlowLabel
                  text="宠物"
                  tone={PET_FLOW_COLOR}
                  badge={petFlow.unread > 0 ? `${petFlow.unread} 条没看` : undefined}
                />
                {petFlow.running && (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', marginBottom: 6, fontSize: 13 }}>
                    <span aria-hidden="true" style={{ color: PET_FLOW_COLOR, animation: 'none' }}>
                      ●
                    </span>
                    <span style={{ color: `${light(0.62)}` }}>
                      正在看：{shortText(petFlow.running.description, 18)}
                    </span>
                  </div>
                )}
                {petFlow.items.map((item) => (
                  <PetTaskRow
                    key={item.id}
                    item={item}
                    expanded={expandedTaskId === item.id}
                    onToggle={() => setExpandedTaskId((prev) => (prev === item.id ? null : item.id))}
                    {...(onPetTaskHandoff ? { onHandoff: onPetTaskHandoff } : {})}
                  />
                ))}
              </div>
            )}

            {/* ── 对话流（下半区，现有那块，原样）── */}
            {showMessageArea && (
              <>
                {showFlowLabels && <FlowLabel text="对话" tone={`${light(0.45)}`} />}
                {visibleMessages.map((m) => (
                  <ChatBubble key={m.id} role={m.role} text={m.text} />
                ))}
                {partialTranscript && (
                  <div
                    style={{
                      fontSize: 13,
                      color: `${light(0.5)}`,
                      fontStyle: 'italic',
                      marginTop: 4,
                      ...selectableText,
                    }}
                  >
                    {partialTranscript}
                  </div>
                )}
                {visibleMessages.length === 0 && !partialTranscript && inCall && voiceState === 'listening' && (
                  <div style={{ fontSize: 12, color: `${light(0.35)}`, textAlign: 'center' }}>
                    对着麦克风说话开始对话
                  </div>
                )}
              </>
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
            background: `${dark(0.35)}`,
            borderBottom: `1px solid ${light(0.08)}`,
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
                color: `${light(0.52)}`,
                ...selectableText,
              }}
            >
              {formatAvatarStatusLine(avatarStatus, { idleMotionEnabled })}
            </div>
            {/*
              多会话清单：**"别人还在跑"这件事只在这里说**。
              头顶符号留给"需要你出手"（抢占），这里是"还有谁在动"。
            */}
            {otherRuns && otherRuns.length > 0 && (
              <div style={{ marginTop: 6, marginLeft: 23, fontSize: 11, lineHeight: 1.5 }}>
                <div style={{ color: `${light(0.45)}` }}>另有 {otherRuns.length} 个会话在跑</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {otherRuns.slice(0, 6).map((r) => (
                    <button
                      key={r.sessionKey}
                      type="button"
                      title={`切到 ${r.sessionKey}`}
                      onClick={() => onFocusSession?.(r.sessionKey)}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        maxWidth: 150,
                        padding: '2px 7px',
                        borderRadius: 999,
                        border: `1px solid ${
                          r.state === 'running' ? light(0.12) : 'rgba(255, 190, 90, 0.38)'
                        }`,
                        background: 'transparent',
                        color:
                          r.state === 'running'
                            ? `${light(0.55)}`
                            : 'rgba(255, 205, 120, 0.95)',
                        fontSize: 11,
                        cursor: 'pointer',
                        overflow: 'hidden',
                        whiteSpace: 'nowrap',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      <span aria-hidden="true">
                        {r.state === 'waiting' ? '?' : r.state === 'error' ? '!' : '·'}
                      </span>
                      {shortSessionLabel(r.sessionKey)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {/*
              待办区（R6「叫得动」）：**唯一常驻的一块**。
              `report` 档（任务做完了）30 秒就自清，`action` 档（卡住了）一直挂着，
              直到用户处置或审批超时——所以这里不需要自己判时限，列表内容就是答案。
            */}
            {pendingNotices && pendingNotices.length > 0 && (
              <div style={{ marginTop: 6, marginLeft: 23, fontSize: 11, lineHeight: 1.5 }}>
                <div style={{ color: 'rgba(255, 205, 120, 0.9)' }}>
                  {(() => {
                    const waiting = pendingNotices.filter((n) => n.level === 'action').length
                    return waiting > 0 ? `${waiting} 件事等你` : '刚刚发生'
                  })()}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                  {pendingNotices.slice(0, 4).map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      title={n.text}
                      onClick={() => onFocusNotice?.(n)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        width: '100%',
                        padding: '3px 8px',
                        borderRadius: 8,
                        border: `1px solid ${
                          n.level === 'action' ? 'rgba(255, 190, 90, 0.38)' : light(0.12)
                        }`,
                        background: 'transparent',
                        color:
                          n.level === 'action'
                            ? 'rgba(255, 205, 120, 0.95)'
                            : `${light(0.6)}`,
                        fontSize: 11,
                        textAlign: 'left',
                        cursor: 'pointer',
                      }}
                    >
                      <span aria-hidden="true">{n.level === 'action' ? '?' : '·'}</span>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          whiteSpace: 'nowrap',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {n.text}
                      </span>
                      <span style={{ flexShrink: 0, opacity: 0.75 }}>
                        {noticeActionLabel(n)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
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
              background: `${dark(0.28)}`,
              borderBottom: `1px solid ${light(0.08)}`,
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
                color: `${light(0.82)}`,
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
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: `${light(0.82)}` }}>
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
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: `${light(0.82)}` }}>
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
              minWidth: 0,
              padding: '8px 12px',
              borderRadius: 10,
              border: `1px solid ${light(0.18)}`,
              background: `${light(0.08)}`,
              color: FG_ON_ACCENT,
              fontSize: 13,
              outline: 'none',
            }}
          />
          {/*
            「让它去做」（五期 T5.7，设计 §10.3.3）。
            与旁边的「发送」是**两件事**：发送是把这句话说给虚拟人听（一轮对话），
            这个是**派它出门办事**（去读文件/搜索，然后回来报结果）。
            `petTaskBusy` 期间置灰——不是防连点（主进程还有单飞锁），
            而是让"点上了"这件事在按钮上看得见。

            ⚠ **清空输入框要等主进程回话**（2026-09-24 修）。原来是"先清空再递上去"，
            而被拒那条路只冒个气泡——用户敲的字就没了，想改一改都得重打。
            现在被拒时**原文留在框里**，他能直接改。
            ⚠ 这里**只**看 `petTaskBusy`（这一次点击），**不许**把"库里有活"也算进
            `disabled`：派发侧有几条 `skipped:` 不发 `pet:goal:result`，那一下
            `petTask.running` 会一直是真的，置灰就把按钮永久锁死了。
          */}
          <button
            type="button"
            title="让它替你去看看这件事，回来报结果"
            disabled={!inputText.trim() || !!petTaskBusy}
            onClick={() => {
              const text = inputText.trim()
              if (!text || petTaskBusy) return
              void Promise.resolve(onPetTaskRun?.(text)).then((accepted) => {
                // 只有被拒（明确的 false）才保留原文；没接线 / 老返回 void 按受理处理
                if (accepted !== false) setInputText('')
              })
            }}
            style={{
              flexShrink: 0,
              padding: '8px 10px',
              borderRadius: 10,
              border: 'none',
              background:
                inputText.trim() && !petTaskBusy ? 'rgba(34,211,238,0.80)' : `${light(0.12)}`,
              color: inputText.trim() && !petTaskBusy ? '#062b33' : `${light(0.45)}`,
              fontSize: 12,
              fontWeight: 600,
              cursor: inputText.trim() && !petTaskBusy ? 'pointer' : 'default',
              transition: 'background 0.15s',
            }}
          >
            {petTaskBusy ? '在看…' : '让它去做'}
          </button>
          <DockIconButton title="发送" onClick={handleSend} accent="#6366f1" active={!!inputText.trim()}>
            <SendIcon />
          </DockIconButton>
        </div>
          </>
        )}

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
              border: `1px solid ${light(0.18)}`,
              background: `${light(0.12)}`,
              color: FG_ON_ACCENT,
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
          <DockTextButton onClick={() => void onClose()} title="收起控制面板">
            收起
          </DockTextButton>
        </div>
      </div>
    </div>
  )
}

/**
 * 一条流的小标题（"宠物" / "对话"）。
 *
 * `badge` 给未读数用（"2 条没看"）——设计 §4.2.2 的硬要求：用户交代了事，回来必须
 * 有办法**一眼看出有几条没看**，而不是逐条读一遍才知道哪条是新的。
 */
const FlowLabel: React.FC<{ text: string; tone: string; badge?: string }> = ({ text, tone, badge }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
    <span style={{ fontSize: 11, fontWeight: 600, color: tone, letterSpacing: 0.5 }}>{text}</span>
    {badge && (
      <span
        style={{
          fontSize: 10,
          padding: '1px 6px',
          borderRadius: 999,
          background: 'rgba(34,211,238,0.16)',
          border: `1px solid rgba(125,211,252,0.45)`,
          color: PET_FLOW_COLOR,
        }}
      >
        {badge}
      </span>
    )}
  </div>
)

/** 按**码点**截断并补省略号（emoji 不被切成半个，与 pet-core 同一口径） */
function shortText(text: string, max: number): string {
  const chars = [...text]
  return chars.length <= max ? text : `${chars.slice(0, max).join('')}…`
}

/** 回执时刻的相对说法。**不显示绝对时间**：坞里那句话只需要"多久以前" */
function relativeTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return ''
  const mins = Math.floor((now - at) / 60_000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins} 分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/**
 * 宠物流里的一条回执（五期 T5.8）。
 *
 * 三件事是设计点过名的，缺一不可：
 * 1. **未读高亮**（§4.2.2）：气泡是瞬时的，用户去倒杯水就错过了——这条要一直亮到看过；
 * 2. **可展开完整结果**（§10.3.3）：坞里那行是摘要（`PET_PROMPT` 要求三行内），
 *    但用户有时要的是全部；
 * 3. **一键「转给主助手」**（§4.2.2）：宠物与任务 Agent 之间**唯一**的通道，
 *    且只能由用户按——所以它只在展开后出现，不是一个随手会点到的按钮。
 *
 * ⚠ 失败的措辞与配色**一并**换：文案分开而颜色照旧（"好消息绿、坏消息也绿"）
 * 会让用户扫一眼以为是成了——那正是 §7.1 说的"把没办成说得像办成了"。
 */
const PetTaskRow: React.FC<{
  item: PetTaskItemDTO
  expanded: boolean
  onToggle: () => void
  onHandoff?: (item: { description: string; text: string }) => void | Promise<void>
}> = ({ item, expanded, onToggle, onHandoff }) => {
  const fg = item.ok ? PET_FLOW_COLOR : PET_FLOW_FAIL_COLOR
  return (
    <div style={{ marginBottom: 6 }}>
      {/* 行头：整块可点（展开/收起）。**不是 `<button>`**——里面还要放"转给主助手"那个
          按钮，按钮套按钮是非法 HTML，浏览器会把内层挤出去 */}
      <div
        role="button"
        tabIndex={0}
        title={expanded ? '收起' : '展开完整结果'}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
        style={{
          cursor: 'pointer',
          borderRadius: 8,
          padding: '4px 8px',
          // 未读：描边 + 淡底。**不用更亮的字色**——字色在这个坞里已经是语义（成功/失败）
          border: `1px solid ${item.unread ? 'rgba(125,211,252,0.55)' : 'transparent'}`,
          background: item.unread ? 'rgba(34,211,238,0.10)' : 'transparent',
          fontSize: 13,
          lineHeight: 1.5,
          color: fg,
        }}
      >
        <span aria-hidden="true" style={{ marginRight: 5, color: fg }}>
          {item.ok ? '·' : '!'}
        </span>
        <span
          style={
            expanded
              ? { whiteSpace: 'pre-wrap', wordBreak: 'break-word' }
              : {
                  display: '-webkit-box',
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }
          }
        >
          {item.text}
        </span>
        <div style={{ marginTop: 2, fontSize: 10, color: `${light(0.4)}` }}>
          {relativeTime(item.at)}
          {item.unread && <span style={{ marginLeft: 6, color: PET_FLOW_COLOR }}>未读</span>}
        </div>
      </div>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 8,
            borderLeft: `2px solid ${light(0.12)}`,
          }}
        >
          {/* 用户当时问的那句话：回执单独看常常不知道在回答什么 */}
          <div style={{ fontSize: 11, color: `${light(0.5)}`, marginBottom: 6, ...selectableText }}>
            你问的：{item.description}
          </div>
          {onHandoff && (
            <button
              type="button"
              title="把它看到的交给主助手接着处理（会切到主窗并发出这条消息）"
              onClick={() => void onHandoff({ description: item.description, text: item.text })}
              style={{
                padding: '4px 10px',
                borderRadius: 8,
                border: `1px solid rgba(125,211,252,0.45)`,
                background: 'transparent',
                color: PET_FLOW_COLOR,
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              转给主助手
            </button>
          )}
        </div>
      )}
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
          color: `${light(0.4)}`,
          lineHeight: '20px',
        }}
      >
        {isUser ? '你' : 'AI'}
      </span>
      <span
        style={{
          fontSize: 13,
          lineHeight: 1.5,
          color: isUser ? `${light(0.92)}` : '#a5f3fc',
          background: isUser ? `${light(0.08)}` : 'rgba(34,211,238,0.08)',
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
      background: active ? accent : `${light(0.12)}`,
      color: FG_ON_ACCENT,
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
      background: active ? 'rgba(245,158,11,0.85)' : `${light(0.12)}`,
      color: FG_ON_ACCENT,
      fontSize: 12,
      fontWeight: 600,
      cursor: 'pointer',
    }}
  >
    {children}
  </button>
)
