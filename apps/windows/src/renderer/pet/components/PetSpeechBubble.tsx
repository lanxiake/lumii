/**
 * PetSpeechBubble — 贴着宠物的一小句话（L4 表达层）
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
 * （`durationMs` 由 pet-core 的 `announceDurationMs` 按字数给，4~10 秒）。
 *
 * ## 它会**停住宠物**（与头顶符号的关键差别）
 *
 * 气泡挂着的时候宠物让位不动（`PetWanderDriver.suspend('bubble')`）——否则气泡被
 * 拖着平移，一个字也读不了。头顶符号**不**停宠物：它是个状态灯，扫一眼就够，
 * 为它把宠物钉住反而是打扰。这条差别是用户 2026-09-23 明确要求的。
 *
 * ## 克制
 *
 * 与参考项目"每 10~20 秒随机冒一句台词"相反：气泡**默认不出**，出现频率由
 * `pickAgentAnnouncement` 的三条规则卡住（默认不冒 / 同轮一次 / 同句 10 分钟）。
 */

import React, { useEffect, useRef, useState } from 'react'
import { placePetOverlay } from '../utils/pet-overlay-position'

/** 气泡上的一个按钮（目前只有「去审批」/「去回答」那一类） */
interface PetSpeechBubbleAction {
  readonly label: string
  readonly onClick: () => void
}

/** 气泡相对宠物锚点的位置（锚点是脚底中心） */
export interface PetSpeechBubbleProps {
  readonly text: string
  /** 锚点的画布坐标（CSS 像素）——只是**初始值**；给了 `getAnchor` 之后由它按帧接管 */
  readonly x: number
  readonly y: number
  /** 宠物可视高度（画布像素 × 缩放），用来把气泡抬到头顶上方 */
  readonly petHeight: number
  /**
   * 每帧取一次锚点。给了它就**跟着宠物走**。
   *
   * **为什么不走 React state**：每帧 setState 会让整个 `PetModeShell`（连带 `PetCanvas`）
   * 重渲染，而这个位置只有气泡自己用。直接写 `style.left/top` 是这里唯一划算的做法。
   * （首版是"冒出来那一刻取一次位置"，用户实测反馈「不会跟着宠物移动」。）
   */
  readonly getAnchor?: () => {
    x: number
    y: number
    petHeight: number
    contentTop?: number
  } | null
  /**
   * 有它 = 这条气泡**可点**（来自通知的 `action` 档：等你审批 / 等你回答）。
   *
   * 可点意味着得把窗口从穿透态切回来。走的是 `pet-dock` 那套 **hover 上报**，
   * 而**不是** `pet-context-menu` 那种"挂着就上报"：后者会让整个窗口在气泡停留的
   * 这几秒里**吃掉全屏点击**（`setIgnoreMouseEvents(false)` 是整窗开关，不是按区域），
   * 用户这几秒里点桌面任何地方都没反应。这里只在你真的把指针压到气泡上时才吃。
   */
  readonly action?: PetSpeechBubbleAction
}

/**
 * 气泡宽度上限。
 *
 * 从 200 提到 320：两百来像素放不下「执行命令：node -e "console.log(42)"」这种
 * 真实文案，截断到只剩半句。用户实测反馈「太小了，不够醒目」——那不只是字号问题，
 * 是**信息被截没了**。
 */
const BUBBLE_MAX_WIDTH = 320

/** 尾巴的尺寸（斜切三角，指向宠物） */
const TAIL_W = 14
const TAIL_H = 9
/** 描边粗细。漫画风就是靠它立住的，2px 是"看得见但不糊住字"的下限 */
const BORDER_PX = 2

/**
 * 色层：**只在这一处定义**，本体、尾巴、按钮都从这里取。
 *
 * ## 为什么是 `--mt-*` 而不是 `--color-*` 映射层
 *
 * 映射层（`--color-text-secondary: var(--mt-fg-3)` 那一批）声明在 `:root`，而 CSS
 * 自定义属性是在**声明它的元素上**解析的 —— 只有 `documentElement` 带 `data-theme`
 * 才会重算。直接用 `--mt-*` 则挂在任意祖先都生效，宠物窗那点 `data-theme` 由
 * `utils/pet-theme.ts` 写在 `documentElement` 上（与主窗同位置）。
 *
 * ## 漫画风的三根柱子
 *
 * 1. `BUBBLE_STROKE` —— **粗描边用前景色本身**，不掺透明度：深色主题下是白描边、
 *    浅色下是深描边，两边都"勾得住"底色，这正是漫画描边的语义。
 * 2. `BUBBLE_BG` —— 底用主窗的浮层色，跟着主题走。
 * 3. 尾巴换成**斜切三角**（SVG），顶点偏向一侧，比原来那个旋转 45° 的方块更像手画的。
 *
 * 用户实测反馈驱动的一次改动：原底色是硬编码 `rgba(24, 26, 32, 0.94)`（永远近黑），
 * 而用户是**浅色主题**用户 —— 「气泡的颜色和文字颜色跟随主题变化」。
 *
 * ⚠️ 宠物层其余部分（控制坞、粒子、头顶符号）**仍然不跟主题**，见
 * `docs/plans/代码重构/客户端切片/07-主题色系/12-canvas与宠物色层收敛.md` §3.2。
 */
const BUBBLE_BG = 'color-mix(in srgb, var(--mt-bg-elevated) 96%, transparent)'
const BUBBLE_STROKE = 'var(--mt-fg-1)'
const ACTION_BG = 'color-mix(in srgb, var(--mt-fg-1) 12%, transparent)'

export const PetSpeechBubble: React.FC<PetSpeechBubbleProps> = ({
  text,
  x,
  y,
  petHeight,
  getAnchor,
  action,
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<SVGSVGElement>(null)
  /**
   * 气泡的实际尺寸。**必须量出来**才能算翻转与夹紧（见 `placePetOverlay`），
   * 但量它不能用 `getBoundingClientRect()` 每帧读 —— 那会强制样式重算。
   * 用 `ResizeObserver` 在**尺寸真的变了**的时候量一次，位置循环只读这个 ref。
   */
  const sizeRef = useRef({ width: 0, height: 0 })
  /** 尺寸已知（`opacity` 的闸：未知时不显示，免得先闪一下再跳到位） */
  const [ready, setReady] = useState(false)
  /** 气泡在宠物的上方还是下方 —— 翻到下方时尾巴画在顶边 */
  const [placement, setPlacement] = useState<'above' | 'below'>('above')

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) {
        sizeRef.current = { width: r.width, height: r.height }
      }
      // 无条件放行：真实浏览器里 `useEffect` 跑在首次布局之后，尺寸必然已有；
      // 量不到的只可能是 jsdom 这类环境——那里宁可位置近似，也不要一个永不出现的气泡。
      setReady(true)
    }
    measure()
    // jsdom 与老环境没有 ResizeObserver：measure 已经同步跑过一次，够用
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /**
   * 跟着宠物走 + 贴边翻转：每帧从锚点重算位置，**直接写 DOM**（不走 state，理由见 `getAnchor` 的注释）。
   *
   * 用 `requestAnimationFrame` 而不是渲染器的 ticker：气泡是 DOM、与 PIXI 不同源；
   * 而且它只在**挂着的时候**跑，撤下即停（`cleanup` 里 cancel）。
   *
   * `placement` 是唯一走 state 的量（它决定尾巴画在哪一边，改不了 DOM 算完）；
   * 跨过翻转阈值时才会 setState 一次，稳定后每帧都是 no-op（React 会对同值 bail out）。
   */
  useEffect(() => {
    if (!getAnchor) return
    let raf = 0
    const tick = (): void => {
      const anchor = getAnchor()
      const el = rootRef.current
      const size = sizeRef.current
      if (anchor && el && size.width > 0) {
        const p = placePetOverlay(anchor, size, {
          width: window.innerWidth,
          height: window.innerHeight,
        })
        el.style.left = `${p.left}px`
        el.style.top = `${p.top}px`
        if (tailRef.current) tailRef.current.style.left = `${p.tailX}px`
        setPlacement((prev) => (prev === p.placement ? prev : p.placement))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [getAnchor])

  /**
   * 卸载时必须补一次 `isHovering: false`。
   *
   * `onMouseLeave` 在"指针正压着气泡、气泡被 TTL 撤下"时**不会触发**——那样主进程
   * 会一直以为 `pet-bubble` 悬停着，窗口永远可点，症状就是**整个桌面点不动了**
   * （`pet-window-manager` 里那条日志专门为这个缺陷留的）。
   */
  const interactive = Boolean(action)
  useEffect(() => {
    if (!interactive) return
    return () => {
      window.electronAPI?.pet?.reportHover({ componentId: 'pet-bubble', isHovering: false })
    }
  }, [interactive])

  const below = placement === 'below'

  return (
    <div
      ref={rootRef}
      // 验证脚本的锚点（`verify/pet-sprite/check-agent-notice.mjs` 按它找气泡）。
      // 别删：控制坞的待办条目上也有同样文案的按钮，没有这个标记两条通道就分不开。
      data-pet-bubble={interactive ? 'notice' : 'plain'}
      // 翻转与否也是判据的一部分（宠物贴顶时应当翻到下方）
      data-pet-bubble-placement={placement}
      onMouseEnter={
        interactive
          ? () => window.electronAPI?.pet?.reportHover({ componentId: 'pet-bubble', isHovering: true })
          : undefined
      }
      onMouseLeave={
        interactive
          ? () => window.electronAPI?.pet?.reportHover({ componentId: 'pet-bubble', isHovering: false })
          : undefined
      }
      style={{
        position: 'absolute',
        // 首帧的近似位置；尺寸一量到（下一帧）就被 rAF 覆盖成精确值
        left: x,
        top: below ? y + 8 : y - petHeight,
        maxWidth: BUBBLE_MAX_WIDTH,
        padding: '10px 14px',
        borderRadius: 16,
        background: BUBBLE_BG,
        border: `${BORDER_PX}px solid ${BUBBLE_STROKE}`,
        color: 'var(--mt-fg-1)',
        // 14px：用户实测「太小了，不够醒目」——它要在一屏桌面上被**余光扫到**，
        // 12px 在 1080p 下基本等于"看不见"。
        fontSize: 14,
        // 1.6：漫画泡的呼吸感，也给长文案（带命令、带路径那种）留出换行的余地
        lineHeight: 1.6,
        letterSpacing: 0.2,
        // 深色气泡压在任意壁纸上都得有边界，否则暗色主题下会糊成一片
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.38)',
        pointerEvents: interactive ? 'auto' : 'none',
        // 不抢控制坞的层级：气泡只是"看一眼"的东西，不该盖住可点的 UI。
        // 可点的通知气泡抬到菜单同层之下、控制坞之上。
        zIndex: interactive ? 900 : 5,
        opacity: ready ? 1 : 0,
        transition: 'opacity 180ms ease-out',
        // 长句折行而不是撑破
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        // 用户 2026-09-23：「文字左对齐」。居中对短句好看，但通知文案常带命令与路径，
        // 居中会让每一行的起点都不一样，读起来找不到头。
        textAlign: 'left',
      }}
    >
      {text}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            display: 'block',
            margin: '8px 0 0',
            padding: '5px 16px',
            borderRadius: 999,
            border: `${BORDER_PX}px solid ${BUBBLE_STROKE}`,
            background: ACTION_BG,
            color: 'var(--mt-fg-1)',
            fontSize: 13,
            lineHeight: 1.5,
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
      {/*
        尾巴：**斜切三角**（顶点偏左，像手画的），而不是原先那个旋转 45° 的方块。

        用 SVG 而不是 border 三角：border 三角只有填充、**描不了边**，而漫画风全靠那圈
        描边。只画两条斜边、不画顶边 —— 顶边与气泡的底边重合，画了就是一条穿过去的横线。
      */}
      <svg
        ref={tailRef}
        width={TAIL_W + BORDER_PX * 2}
        height={TAIL_H}
        viewBox={`0 0 ${TAIL_W + BORDER_PX * 2} ${TAIL_H}`}
        aria-hidden="true"
        style={{
          position: 'absolute',
          // 上移一个描边宽，让尾巴的填充盖住气泡底边那一小段，接缝才干净
          [below ? 'top' : 'bottom']: -TAIL_H + BORDER_PX,
          left: '50%',
          marginLeft: -(TAIL_W + BORDER_PX * 2) / 2,
          pointerEvents: 'none',
          overflow: 'visible',
          // 翻到下方时整体镜像，尖角指向宠物
          transform: below ? 'scaleY(-1)' : undefined,
        }}
      >
        <path
          d={`M0,0 L${TAIL_W + BORDER_PX * 2},0 L${TAIL_W * 0.35},${TAIL_H} Z`}
          fill={BUBBLE_BG}
        />
        {/* 只描两条斜边（顶边与气泡底边重合，不必再画） */}
        <path
          d={`M0,0 L${TAIL_W * 0.35},${TAIL_H} L${TAIL_W + BORDER_PX * 2},0`}
          fill="none"
          stroke={BUBBLE_STROKE}
          strokeWidth={BORDER_PX}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  )
}
