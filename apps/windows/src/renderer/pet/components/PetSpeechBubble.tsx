/**
 * PetSpeechBubble — 贴着宠物的一小句气泡（L4 表达层）
 *
 * 设计：docs/design/客户端UI/2026-09-21-Agent状态可见化设计.md §3.2
 *
 * ## 为什么是 DOM 而不是画进 PIXI
 *
 * 画进画布能自动跟着宠物走，但那样就得在 PIXI 里排中文（字体加载、换行、圆角
 * 都得自己来），而这一层的全部价值在**措辞**上，样式灵活性比"省一次定位"重要。
 * 位置由外面每帧喂进来（PetModeShell 从渲染器读 `getPosition()`）。
 *
 * ## 为什么它有自己的生命周期
 *
 * 实测 `waiting` 常常只存在 0 毫秒（`thinking → waiting` 与紧随的 `tool-start`
 * 打在同一毫秒）。跟着 activity 生死的话，「需要你确认一下」会一闪而过甚至看不见——
 * 而它恰恰是四层里唯一值得强打扰的那句。所以**冒出来之后停多久由它自己说了算**
 * （`durationMs` 由 pet-core 的 `announceDurationMs` 按字数给）。
 *
 * ## 克制
 *
 * 与参考项目"每 10~20 秒随机冒一句台词"相反：气泡**默认不出**，出现频率由
 * `pickAgentAnnouncement` 的三条规则卡住（默认不冒 / 同轮一次 / 同句 10 分钟）。
 * 这里的样式也配合这个态度——低饱和、不闪、不弹跳，只做一次 180ms 的淡入。
 */

import React, { useEffect, useState } from 'react'

/** 气泡相对宠物锚点的位置（锚点是脚底中心） */
export interface PetSpeechBubbleProps {
  readonly text: string
  /** 锚点的画布坐标（CSS 像素） */
  readonly x: number
  readonly y: number
  /** 宠物可视高度（画布像素 × 缩放），用来把气泡抬到头顶上方 */
  readonly petHeight: number
}

const BUBBLE_MAX_WIDTH = 200

/** 气泡尾巴的尺寸（指向宠物的那个小三角） */
const TAIL_W = 10
const TAIL_H = 6

export const PetSpeechBubble: React.FC<PetSpeechBubbleProps> = ({ text, x, y, petHeight }) => {
  // 淡入用的一次性标志：挂载时为 false，下一帧置 true。直接给 opacity:1 会"闪一下
  // 就出现"，而一个突然出现的气泡在安静的工作流里相当扎眼。
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // 抬到头顶上方：锚点是脚底，宠物高 petHeight，再留一个尾巴 + 一点空隙。
  // `translate(-50%, -100%)` 让 (x, y) 成为气泡**底边中点**，于是尾巴能对准锚点。
  const bottomY = y - petHeight - TAIL_H - 6

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: bottomY,
        transform: 'translate(-50%, -100%)',
        maxWidth: BUBBLE_MAX_WIDTH,
        padding: '6px 11px',
        borderRadius: 12,
        background: 'rgba(24, 26, 32, 0.92)',
        border: '1px solid rgba(255, 255, 255, 0.10)',
        color: 'rgba(238, 240, 245, 0.96)',
        fontSize: 12,
        lineHeight: 1.45,
        letterSpacing: 0.2,
        pointerEvents: 'none',
        // 不抢控制坞的层级：气泡只是"看一眼"的东西，不该盖住可点的 UI
        zIndex: 5,
        opacity: shown ? 1 : 0,
        transition: 'opacity 180ms ease-out',
        // 长句折行而不是撑破
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        textAlign: 'center',
      }}
    >
      {text}
      {/* 尾巴：一个旋转 45° 的小方块，只露下半截 */}
      <div
        style={{
          position: 'absolute',
          left: '50%',
          bottom: -TAIL_H / 2 - 1,
          width: TAIL_W,
          height: TAIL_W,
          marginLeft: -TAIL_W / 2,
          background: 'rgba(24, 26, 32, 0.92)',
          borderRight: '1px solid rgba(255, 255, 255, 0.10)',
          borderBottom: '1px solid rgba(255, 255, 255, 0.10)',
          transform: 'rotate(45deg)',
          borderRadius: 2,
        }}
      />
    </div>
  )
}
