/**
 * PetContextMenu — 右键宠物弹出的选项菜单
 *
 * 设计参考豆包 / 电脑管家的悬浮球：**宠物本身就是那颗球**，默认不挂任何常驻面板，
 * 选项全部收在右键里。宠物模式下屏幕应该是干净的——一只宠物在桌面上，如此而已。
 *
 * ## 为什么自绘而不是 Electron 原生菜单
 *
 * 原生菜单（`Menu.popup`）更像系统级，但它要在**主进程**里按窗口坐标弹，而宠物窗口是
 * 全屏透明 + 穿透的，坐标换算与穿透状态都得再过一遍 IPC；样式也没法跟宠物窗口的
 * 暗色毛玻璃对齐。自绘的代价只是"要自己处理点击外部关闭"，收益是样式与交互完全可控。
 *
 * ## 两份状态要小心
 *
 * 菜单是**瞬时**的（点外部/Esc/选中任一项就关），而它操作的开关是**持久**的
 * （静音、声音回复、对话面板）。所以勾选态从 props 读、不要在菜单里存副本——
 * 存了就会出现"关掉菜单再打开，勾还在旧位置"。
 */

import React, { useEffect, useRef } from 'react'
import type { VoiceCallState } from '../../../shared/voice-events'
import type { PetModelConfigDTO } from '../../../shared/pet-mode'

export interface PetContextMenuProps {
  /** 菜单左上角（画布坐标，CSS 像素） */
  readonly x: number
  readonly y: number
  readonly voiceState: VoiceCallState | 'idle'
  readonly muted: boolean
  readonly voiceReplyEnabled: boolean
  readonly models: readonly PetModelConfigDTO[]
  readonly currentModelId: string
  /** 对话面板（控制坞）当前是否展开 */
  readonly dockOpen: boolean
  readonly onStartVoice: () => void
  readonly onStopVoice: () => void
  readonly onToggleMute: () => void
  readonly onToggleVoiceReply: () => void
  readonly onChangeModel: (modelId: string) => void
  readonly onToggleDock: () => void
  readonly onExit: () => void
  readonly onClose: () => void
}

const MENU_MIN_WIDTH = 196
/** 单项高度，用于估算整体高度、避免菜单超出屏幕下沿 */
const ITEM_H = 30
const SEP_H = 7

const COLOR = {
  bg: 'rgba(26, 28, 34, 0.97)',
  border: 'rgba(255, 255, 255, 0.12)',
  text: 'rgba(238, 240, 245, 0.94)',
  dim: 'rgba(238, 240, 245, 0.45)',
  hover: 'rgba(255, 255, 255, 0.10)',
  danger: 'rgba(248, 113, 113, 0.95)',
} as const

const MenuItem: React.FC<{
  label: string
  hint?: string
  checked?: boolean
  danger?: boolean
  disabled?: boolean
  onClick: () => void
}> = ({ label, hint, checked, danger, disabled, onClick }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      width: '100%',
      height: ITEM_H,
      padding: '0 12px',
      border: 'none',
      background: 'transparent',
      color: disabled ? COLOR.dim : danger ? COLOR.danger : COLOR.text,
      fontSize: 12.5,
      textAlign: 'left',
      cursor: disabled ? 'default' : 'pointer',
      whiteSpace: 'nowrap',
    }}
    onMouseEnter={(e) => {
      if (!disabled) e.currentTarget.style.background = COLOR.hover
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = 'transparent'
    }}
  >
    <span style={{ flex: 1 }}>{label}</span>
    {hint && <span style={{ color: COLOR.dim, fontSize: 11 }}>{hint}</span>}
    {/* 勾选态用文字而不是图标：宠物窗口里没有图标字体，画 SVG 不值当 */}
    {checked && <span style={{ color: COLOR.text, fontSize: 12 }}>✓</span>}
  </button>
)

const Separator: React.FC = () => (
  <div style={{ height: 1, margin: `${(SEP_H - 1) / 2}px 8px`, background: COLOR.border }} />
)

export const PetContextMenu: React.FC<PetContextMenuProps> = ({
  x,
  y,
  voiceState,
  muted,
  voiceReplyEnabled,
  models,
  currentModelId,
  dockOpen,
  onStartVoice,
  onStopVoice,
  onToggleMute,
  onToggleVoiceReply,
  onChangeModel,
  onToggleDock,
  onExit,
  onClose,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  const inCall = voiceState !== 'idle'

  // 点外部 / Esc / 滚轮 关闭。滚轮也关：菜单下面压着的是宠物，用户滚轮多半是想缩放它。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const onWheel = () => onClose()
    // 捕获阶段：菜单要能在别人之前看到这次点击，否则宠物窗口的 mousedown 会先把它吃掉
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onWheel, { capture: true, passive: true })
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('wheel', onWheel, true)
    }
  }, [onClose])

  // 兜底夹回视口内：右键点在宠物下半身、或宠物贴着屏幕右下角时，
  // 菜单会有一半在屏幕外——而它没有滚动条，露不出来的项就是点不到。
  const rows = 6 + models.length + 2 // 估算：固定项 + 模型项 + 两条分隔
  const estH = rows * ITEM_H + 2 * SEP_H + 16
  const left = Math.min(x, window.innerWidth - MENU_MIN_WIDTH - 8)
  const top = Math.min(y, Math.max(8, window.innerHeight - estH - 8))

  const run = (fn: () => void) => () => {
    onClose()
    fn()
  }

  return (
    <div
      ref={ref}
      style={{
        position: 'absolute',
        left,
        top,
        minWidth: MENU_MIN_WIDTH,
        padding: '6px 0',
        borderRadius: 10,
        background: COLOR.bg,
        border: `1px solid ${COLOR.border}`,
        boxShadow: '0 10px 32px rgba(0, 0, 0, 0.45)',
        // 菜单必须能点：宠物窗口默认整窗穿透，这里要显式参与命中
        pointerEvents: 'auto',
        zIndex: 20,
        userSelect: 'none',
      }}
    >
      {inCall ? (
        <MenuItem label="结束语音对话" danger onClick={run(onStopVoice)} />
      ) : (
        <MenuItem label="开始语音对话" onClick={run(onStartVoice)} />
      )}
      <MenuItem label="静音" checked={muted} onClick={run(onToggleMute)} />
      <MenuItem label="语音回复" hint="朗读回复" checked={voiceReplyEnabled} onClick={run(onToggleVoiceReply)} />

      <Separator />
      <MenuItem label={dockOpen ? '隐藏对话' : '打开对话'} onClick={run(onToggleDock)} />

      <Separator />
      {/* 模型直接平铺，不做二级菜单：二级菜单在自绘里要处理悬停延时、
          边界翻转、键盘导航——而这里通常只有个位数个模型。 */}
      <div style={{ padding: '2px 12px 4px', color: COLOR.dim, fontSize: 11 }}>切换模型</div>
      {models.map((m) => (
        <MenuItem
          key={m.id}
          label={m.name || m.id}
          checked={m.id === currentModelId}
          onClick={run(() => onChangeModel(m.id))}
        />
      ))}

      <Separator />
      <MenuItem label="退出宠物模式" hint="Ctrl+Shift+P" danger onClick={run(onExit)} />
    </div>
  )
}
