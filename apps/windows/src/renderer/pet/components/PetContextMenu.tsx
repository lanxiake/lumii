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
 * 菜单是**瞬时**的（点外部 / Esc / 滚轮就关），而它操作的开关是**持久**的
 * （静音、声音回复、对话面板）。所以勾选态从 props 读、不要在菜单里存副本——
 * 存了就会出现"关掉菜单再打开，勾还在旧位置"。
 *
 * ## 什么样的项才收起菜单
 *
 * 只有**要跳去别处看结果**的项才关：打开/隐藏对话（面板在菜单底下压着，不关看不见）、
 * 关闭宠物模式（整个宠物都要走了）。其余全是开关与列表——静音、朗读、通话、换宠物——
 * 菜单留在原地。理由：这些项的效果就画在菜单自己身上（勾选胶囊、顶部状态摘要），
 * 关掉等于把回执也一起关了，用户只能重新右键一次才知道自己刚才点没点上，
 * 「点了没反应」与「点错了」也就分不出来。
 */

import React, { useEffect, useRef, useState } from 'react'
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
/** 顶部状态摘要那一行的高度，只用于估高 */
const STATUS_H = 30

const COLOR = {
  bg: 'rgba(26, 28, 34, 0.97)',
  border: 'rgba(255, 255, 255, 0.12)',
  text: 'rgba(238, 240, 245, 0.94)',
  dim: 'rgba(238, 240, 245, 0.45)',
  hover: 'rgba(255, 255, 255, 0.10)',
  danger: 'rgba(248, 113, 113, 0.95)',
  /** 状态"开"：绿。开关胶囊与小圆点共用，含义统一为「该功能正在生效」 */
  on: 'rgba(74, 222, 128, 0.95)',
  /** 状态"关"：灰 */
  off: 'rgba(238, 240, 245, 0.28)',
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
    {/*
      开关态画成一个**两端都有形态**的胶囊，而不是"开时一个 ✓、关时什么都没有"。
      用户的原话是「点击各种状态后需要有个可以标识其运行状态的设计」——单个 ✓ 读不出
      「现在是关着的」还是「这一项没有状态」。绿=生效、灰=未生效，一眼可辨。
      `checked` 为 undefined 的项（纯动作，如"打开对话"）不画。
    */}
    {checked !== undefined && (
      <span
        style={{
          flexShrink: 0,
          width: 26,
          height: 14,
          borderRadius: 7,
          background: checked ? COLOR.on : 'transparent',
          border: `1px solid ${checked ? COLOR.on : COLOR.off}`,
          position: 'relative',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1,
            left: checked ? 13 : 1,
            width: 10,
            height: 10,
            borderRadius: 5,
            background: checked ? '#12141a' : COLOR.off,
          }}
        />
      </span>
    )}
  </button>
)

const Separator: React.FC = () => (
  <div style={{ height: 1, margin: `${(SEP_H - 1) / 2}px 8px`, background: COLOR.border }} />
)

/**
 * 菜单顶部的状态摘要——「当前宠物功能处于什么状态」的正面回答。
 *
 * 为什么不能只靠下面那些开关：菜单一关就什么都不剩，用户下次打开前仍然不知道
 * 宠物现在是静音还是有声。开关回答的是"这一项怎么改"，摘要回答的是"现在是什么"。
 *
 * 圆点与开关胶囊共用同一套颜色语义——**绿 = 这一项开着，灰 = 关着**，与下方各开关
 * 一一对应，不引入第二套词汇。所以标签也用开关名（`静音`）而不是状态描述（`已静音`）：
 * 「静音」配绿点＝静音开着，配灰点＝没静音，读起来没有歧义。
 */
const StatusRow: React.FC<{ items: readonly { label: string; on: boolean }[] }> = ({ items }) => (
  <div
    style={{
      display: 'flex',
      flexWrap: 'wrap',
      gap: '6px 10px',
      padding: '2px 12px 8px',
      marginBottom: SEP_H / 2,
      borderBottom: `1px solid ${COLOR.border}`,
    }}
  >
    {items.map((it) => (
      <span key={it.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            background: it.on ? COLOR.on : COLOR.off,
          }}
        />
        <span style={{ fontSize: 11, color: it.on ? COLOR.text : COLOR.dim }}>{it.label}</span>
      </span>
    ))}
  </div>
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
  /**
   * 二级视图。模型多的时候把它们平铺在主菜单里会拖出一长条——
   * 主菜单只留一行「更换宠物」，点进去才展开列表。
   */
  const [view, setView] = useState<'root' | 'models'>('root')

  /**
   * 菜单存在期间**让窗口保持可点**。
   *
   * 宠物窗口默认整窗穿透，主进程按"有没有 UI 组件在交互"聚合切换
   * （见 `PetWindowManager.applyMouseIgnoreState`）。菜单原先不在那份白名单里，
   * 于是指针从宠物身上移到菜单的一瞬间 `bodyHover` 就归 false、窗口恢复穿透，
   * 菜单**看得见但点不动**——`setIgnoreMouseEvents(true, { forward: true })`
   * 转发的是 mousemove，不含 mousedown/click。用户报的「点开对话没展开」
   * 「更换宠物没展开」都是这一条。
   *
   * 上报的是"菜单开着"而不是"指针压在菜单上"：后者在菜单项之间的缝隙里会闪断。
   * cleanup 里**必须**报 false——菜单是瞬时的，漏这一次窗口就再也不穿透了
   * （连带着整个桌面都点不动）。
   */
  useEffect(() => {
    const api = window.electronAPI?.pet
    api?.reportHover({ componentId: 'pet-context-menu', isHovering: true })
    return () => api?.reportHover({ componentId: 'pet-context-menu', isHovering: false })
  }, [])

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
  const rows = view === 'models' ? models.length + 2 : 9
  // 状态摘要只出现在根视图，二级视图不算它那一行
  const estH = rows * ITEM_H + 2 * SEP_H + 16 + (view === 'root' ? STATUS_H : 0)
  const left = Math.min(x, window.innerWidth - MENU_MIN_WIDTH - 8)
  const top = Math.min(y, Math.max(8, window.innerHeight - estH - 8))

  /**
   * 收起菜单再执行——只给**要跳去别处**的项用（打开对话、关闭宠物模式）。
   * 开关类项直接传回调，菜单留着让用户看见勾选态变了（见文件头）。
   */
  const runAndClose = (fn: () => void) => () => {
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
      {view === 'models' ? (
        <>
          <MenuItem label="← 返回" onClick={() => setView('root')} />
          <Separator />
          {models.map((m) => (
            <MenuItem
              key={m.id}
              label={m.name || m.id}
              checked={m.id === currentModelId}
              // 换模型不关菜单：留在列表里，勾选胶囊会跟着挪，可以连着比几个
              onClick={() => onChangeModel(m.id)}
            />
          ))}
        </>
      ) : (
        <>
          {/* 状态摘要：菜单一关就什么都不剩，这里是"现在是什么状态"的唯一出口 */}
          <StatusRow
            items={[
              { label: inCall ? '通话中' : '未通话', on: inCall },
              { label: '静音', on: muted },
              { label: '朗读', on: voiceReplyEnabled },
              { label: '对话面板', on: dockOpen },
            ]}
          />
          {inCall ? (
            <MenuItem label="结束语音对话" hint="麦克风" danger onClick={onStopVoice} />
          ) : (
            <MenuItem label="开始语音对话" hint="麦克风" onClick={onStartVoice} />
          )}
          <MenuItem label="静音" checked={muted} onClick={onToggleMute} />
          {/*
            这一项叫「文字回复朗读」而不是「语音回复」：它跟上面那项只差一个字
            （语音**对话** / 文字回复**朗读**），后果却天差地别——一个是打开麦克风
            开始通话，一个只是让文字回复出声。用户报的「点击开启语音朗读，客户端
            却打开了麦克风」就是这两行看串了。名字直接用设置页那一项的原文，
            同一件事在两个地方叫同一个名字；上面那项再补一个 dim 的「麦克风」hint，
            把"点它会开麦"写在脸上。
          */}
          <MenuItem
            label="文字回复朗读"
            checked={voiceReplyEnabled}
            onClick={onToggleVoiceReply}
          />

          <Separator />
          <MenuItem
            label={dockOpen ? '隐藏对话' : '打开对话'}
            onClick={runAndClose(onToggleDock)}
          />

          <Separator />
          {/* 模型列表收进二级：平铺在主菜单里会拖出一长条，把常用项挤到看不见 */}
          <MenuItem label="更换宠物" hint={`${models.length} 个 ▸`} onClick={() => setView('models')} />

          <Separator />
          <MenuItem label="关闭宠物模式" hint="Ctrl+Shift+P" danger onClick={runAndClose(onExit)} />
        </>
      )}
    </div>
  )
}
