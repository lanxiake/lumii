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
 * ## 它**不**停住宠物（与气泡的又一处分工）
 *
 * 用户 2026-09-23：「状态展示不需要停止宠物当前动作，文字气泡需要停止」。
 * 判据是"要不要读"：符号扫一眼就够，为它把宠物钉住是打扰；气泡是一句话，
 * 被拖着平移就读不了。所以这里**不**碰 `PetWanderDriver.suspend` ——
 * 别看到气泡那边加了就跟进。
 *
 * ## 为什么用 DOM 而不是画进 PIXI
 *
 * 与气泡同理，且这里的价值全在"位置稳定"：符号跟着宠物走，但不该每帧重排。
 * 位置由调用方在**状态变化时**取一次（跟气泡一样的取舍，见 PetModeShell 的注释）——
 * 宠物走得慢，符号挂几秒，不值得为它把整个 shell 每帧重渲染。
 */
import React, { useEffect, useRef, useState } from 'react'
import type { PetGlyphTone } from '../utils/pet-status-glyph'
import { placePetOverlay, OVERLAY_GAP } from '../utils/pet-overlay-position'

export interface PetStatusGlyphProps {
  /** 显示的字符（单字符，见 pickStatusGlyph） */
  readonly char: string
  readonly tone: PetGlyphTone
  /** 中文说明，进 title / aria-label（符号对读屏器没有语义） */
  readonly label: string
  /**
   * 这条状态来自别的会话（多会话抢占时）。
   *
   * 表现是徽章右上角再叠一小块——**"还有一个"的视觉隐喻**（像一摞卡片）。
   * 不用文字：徽章太小，塞不下"另"，而缩写（"别"）没人看得懂。
   */
  readonly source?: 'other'
  /** 锚点的画布坐标（CSS 像素，脚底中心） */
  readonly x: number
  readonly y: number
  /** 宠物可视高度（画布像素 × 缩放） */
  readonly petHeight: number
  /**
   * 每帧取一次锚点。给了它就**跟着宠物走**。
   *
   * 与 `PetSpeechBubble.getAnchor` 同一套理由：每帧 setState 会让整个 `PetModeShell`
   * 重渲染，而这个位置只有这一个节点用——直接写 `style.left/top` 划算得多。
   * （首版和气泡一样是"出现那一刻取一次"，用户实测反馈「不会跟着宠物移动」。）
   */
  readonly getAnchor?: () => {
    x: number
    y: number
    petHeight: number
    /** 内容实测上伸量，姿势换了身高差很多时比 `petHeight` 准 */
    contentTop?: number
  } | null
}

/** 徽章边长 */
/**
 * 徽章直径。22 → 32：用户实测反馈「标识这些太小了，不够醒目」——
 * 它要在一屏桌面上被**余光扫到**，22px 在 1080p 下基本等于"看不见"。
 */
const SIZE = 32

/** 三种语义色。低饱和——待机特效不该抢注意力，抢眼的是点击烟花那一类 */
const TONE_COLOR: Record<PetGlyphTone, { fg: string; border: string }> = {
  info: { fg: 'rgba(238, 240, 245, 0.94)', border: 'rgba(255, 255, 255, 0.14)' },
  alert: { fg: 'rgba(255, 205, 120, 0.98)', border: 'rgba(255, 190, 90, 0.38)' },
  sleep: { fg: 'rgba(190, 214, 255, 0.92)', border: 'rgba(150, 185, 255, 0.30)' },
}

export const PetStatusGlyph: React.FC<PetStatusGlyphProps> = ({
  char,
  tone,
  label,
  source,
  x,
  y,
  petHeight,
  getAnchor,
}) => {
  const ref = useRef<HTMLDivElement>(null)
  // 淡入：挂载时为 0，下一帧置 1。直接给 1 会"闪一下就有"，在一只安静的宠物头顶很扎眼
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  /** 跟着宠物走：每帧重算位置、直接写 DOM（理由见 `getAnchor` 的注释） */
  useEffect(() => {
    if (!getAnchor) return
    let raf = 0
    const tick = (): void => {
      const anchor = getAnchor()
      const el = ref.current
      if (anchor && el) {
        // 走与气泡同一套定位：贴顶时翻到脚下、贴边时夹进视口。
        // 不做镜像——徽章是圆的、角标在右上角，翻过来只是把"还有一个"的角标换个角落。
        const p = placePetOverlay(anchor, { width: SIZE, height: SIZE }, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
        el.style.left = `${p.left}px`
        el.style.top = `${p.top}px`
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getAnchor])

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
        left: x - SIZE / 2,
        // 首帧的近似位置（抬到头顶上方）；下一帧就被 rAF 覆盖成精确值
        top: y - petHeight - OVERLAY_GAP - SIZE,
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
        fontSize: 19,
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
      {/* 来源角标：一小块叠在右上角，"还有一个"的意思（见 source 的注释） */}
      {source === 'other' && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: -3,
            right: -3,
            width: 12,
            height: 12,
            borderRadius: 3,
            background: 'rgba(24, 26, 32, 0.92)',
            border: `1px solid ${color.border}`,
          }}
        />
      )}
    </div>
  )
}
