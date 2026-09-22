/**
 * PetStatusGlyph — 宠物头顶的状态符号（一个字符的小徽章）
 *
 * 设计来自用户 2026-09-22 的要求：「待机不需要左右和上下移动，待机有自己的动画，
 * 需要添加特效」。位移去掉之后，"它现在在干什么"少了可读信号——用头顶的符号补回来，
 * 而不是把宠物整体挪来挪去。
 *
 * ## 与气泡的分工
 *
 * 气泡（`PetSpeechBubble`）是**一句话**：有 TTL、要读、冒完就走。
 * 符号是**状态灯**：一眼扫到就够、跟着状态一直挂着、没有 TTL。
 * 两者会同时需要吗？会（想事的同时冒一句话）——所以**气泡在场时符号让位**
 *（调用方不渲染即可），同一个位置叠两个东西一定糊。
 *
 * ## 为什么用 DOM 而不是画进 PIXI
 *
 * 与气泡同理，且这里的价值全在"位置稳定"：符号跟着宠物走，但不该每帧重排。
 * 位置由调用方在**状态变化时**取一次（跟气泡一样的取舍，见 PetModeShell 的注释）——
 * 宠物走得慢，符号挂几秒，不值得为它把整个 shell 每帧重渲染。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { PetGlyphTone } from '../utils/pet-status-glyph'

export interface PetStatusGlyphProps {
  /** 显示的字符（单字符，见 pickStatusGlyph） */
  readonly char: string
  readonly tone: PetGlyphTone
  /** 中文说明，进 title / aria-label（符号对读屏器没有语义） */
  readonly label: string
  /** 锚点的画布坐标（CSS 像素，脚底中心） */
  readonly x: number
  readonly y: number
  /** 宠物可视高度（画布像素 × 缩放） */
  readonly petHeight: number
}

/** 徽章边长 */
const SIZE = 22
/** 离头顶的空隙（气泡在同样位置用 12，这里再抬一点，免得换气时"跳一下"） */
const GAP = 14

/** 三种语义色。低饱和——待机特效不该抢注意力，抢眼的是点击烟花那一类 */
const TONE_COLOR: Record<PetGlyphTone, { fg: string; border: string }> = {
  info: { fg: 'rgba(238, 240, 245, 0.94)', border: 'rgba(255, 255, 255, 0.14)' },
  alert: { fg: 'rgba(255, 205, 120, 0.98)', border: 'rgba(255, 190, 90, 0.38)' },
  sleep: { fg: 'rgba(190, 214, 255, 0.92)', border: 'rgba(150, 185, 255, 0.30)' },
}

export const PetStatusGlyph: React.FC<PetStatusGlyphProps> = ({ char, tone, label, x, y, petHeight }) => {
  const ref = useRef<HTMLDivElement>(null)
  // 淡入：挂载时为 0，下一帧置 1。直接给 1 会"闪一下就有"，在一只安静的宠物头顶很扎眼
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  /**
   * 极轻的"呼吸"：只改透明度，**不改位置**。
   *
   * 用 Web Animations API 而不是 CSS keyframes：宠物窗没有样式表约定，
   * 为一个两行的动画新建 `.module.css` 不划算；而且这里要的就是"挂载时起一段、
   * 卸载时自动随元素消失"，animate() 正好是这个语义。
   */
  useEffect(() => {
    const el = ref.current
    if (!el || typeof el.animate !== 'function') return
    const anim = el.animate([{ opacity: 0.72 }, { opacity: 1 }, { opacity: 0.72 }], {
      duration: 2600,
      iterations: Infinity,
      easing: 'ease-in-out',
    })
    return () => anim.cancel()
  }, [])

  const color = TONE_COLOR[tone]

  return (
    <div
      ref={ref}
      title={label}
      aria-label={label}
      role="img"
      style={{
        position: 'absolute',
        left: x,
        // 抬到头顶上方：锚点在脚底，宠物高 petHeight
        top: y - petHeight - GAP - SIZE,
        width: SIZE,
        height: SIZE,
        borderRadius: SIZE / 2,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(24, 26, 32, 0.82)',
        border: `1px solid ${color.border}`,
        color: color.fg,
        // 字号比徽章小一圈：'…' 与 'Z' 在视觉重量上差很多，统一字号会让省略号显得挤
        fontSize: 13,
        lineHeight: 1,
        fontWeight: 600,
        pointerEvents: 'none',
        // 与气泡同层：都不抢控制坞
        zIndex: 5,
        opacity: shown ? 1 : 0,
        transition: 'opacity 180ms ease-out',
        userSelect: 'none',
      }}
    >
      {char}
    </div>
  )
}

export default PetStatusGlyph
