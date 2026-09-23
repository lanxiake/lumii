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

import React, { useEffect, useRef, useState } from 'react'

/** 气泡上的一个按钮（目前只有「去审批」/「去回答」那一类） */
export interface PetSpeechBubbleAction {
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
  readonly getAnchor?: () => { x: number; y: number; petHeight: number } | null
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

/** 气泡尾巴的尺寸（指向宠物的那个小三角） */
const TAIL_W = 10
const TAIL_H = 6

export const PetSpeechBubble: React.FC<PetSpeechBubbleProps> = ({
  text,
  x,
  y,
  petHeight,
  getAnchor,
  action,
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  // 淡入用的一次性标志：挂载时为 false，下一帧置 true。直接给 opacity:1 会"闪一下
  // 就出现"，而一个突然出现的气泡在安静的工作流里相当扎眼。
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  /**
   * 跟着宠物走：每帧从锚点重算位置，**直接写 DOM**（不走 state，理由见 `getAnchor` 的注释）。
   *
   * 用 `requestAnimationFrame` 而不是渲染器的 ticker：气泡是 DOM、与 PIXI 不同源；
   * 而且它只在**挂着的时候**跑，撤下即停（`cleanup` 里 cancel）。
   */
  useEffect(() => {
    if (!getAnchor) return
    let raf = 0
    const tick = (): void => {
      const anchor = getAnchor()
      const el = rootRef.current
      if (anchor && el) {
        el.style.left = `${anchor.x}px`
        el.style.top = `${anchor.y - anchor.petHeight - TAIL_H - 6}px`
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

  // 抬到头顶上方：锚点是脚底，宠物高 petHeight，再留一个尾巴 + 一点空隙。
  // `translate(-50%, -100%)` 让 (x, y) 成为气泡**底边中点**，于是尾巴能对准锚点。
  const bottomY = y - petHeight - TAIL_H - 6

  return (
    <div
      ref={rootRef}
      // 验证脚本的锚点（`verify/pet-sprite/check-agent-notice.mjs` 按它找气泡）。
      // 别删：控制坞的待办条目上也有同样文案的按钮，没有这个标记两条通道就分不开。
      data-pet-bubble={interactive ? 'notice' : 'plain'}
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
        left: x,
        top: bottomY,
        transform: 'translate(-50%, -100%)',
        maxWidth: BUBBLE_MAX_WIDTH,
        padding: '9px 14px',
        borderRadius: 14,
        background: 'rgba(24, 26, 32, 0.94)',
        border: '1px solid rgba(255, 255, 255, 0.14)',
        color: 'rgba(240, 242, 247, 0.98)',
        // 14px：用户实测「太小了，不够醒目」——它要在一屏桌面上被**余光扫到**，
        // 12px 在 1080p 下基本等于"看不见"。
        fontSize: 14,
        lineHeight: 1.5,
        letterSpacing: 0.2,
        // 深色气泡压在任意壁纸上都得有边界，否则暗色主题下会糊成一片
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.38)',
        pointerEvents: interactive ? 'auto' : 'none',
        // 不抢控制坞的层级：气泡只是"看一眼"的东西，不该盖住可点的 UI。
        // 可点的通知气泡抬到菜单同层之下、控制坞之上。
        zIndex: interactive ? 900 : 5,
        opacity: shown ? 1 : 0,
        transition: 'opacity 180ms ease-out',
        // 长句折行而不是撑破
        wordBreak: 'break-word',
        whiteSpace: 'pre-wrap',
        textAlign: 'center',
      }}
    >
      {text}
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          style={{
            display: 'block',
            margin: '8px auto 0',
            padding: '5px 16px',
            borderRadius: 999,
            border: '1px solid rgba(255, 255, 255, 0.28)',
            background: 'rgba(255, 255, 255, 0.14)',
            color: 'rgba(240, 242, 247, 0.98)',
            fontSize: 13,
            lineHeight: 1.5,
            cursor: 'pointer',
          }}
        >
          {action.label}
        </button>
      )}
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
