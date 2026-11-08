/**
 * boot-visual — 开机动画的视觉层（零依赖：DOM + Canvas2D + CSS）。
 *
 * 设计要点：
 * - **不阻塞首帧**：全同步绘制，首帧不加载任何媒体，React 挂载前即可出画面。
 *   原来的 splash.mp4 要等解码器，首帧反而更晚。
 * - **进度由真实启动阶段驱动**：主进程 `startup:progress` 广播推进，
 *   慢启动就慢慢走，不靠固定时长假装加载。
 * - **底图程序化烘焙**：星云用分形噪声真算一遍，星场按幂律分布撒点。
 *   两者都是一次性烘焙成位图，逐帧只贴图，代价接近零。
 * - **五幕叙事**：standby → 核心唤醒 → 神经链接 → 能量充能 → 意识聚合 → 门户。
 *   每幕的粒子与音效都跟同一个节拍时钟走，画面才有「拍子」。
 *   气质：前段克制极简，cognition / gate 才仪式爆发。
 * - **卡住态**：同一阶段约 6s 无进展 → 慢呼吸 +「仍在：阶段 · 已等待 Ns」，
 *   进度条不假爬升、不提供跳过（见 `boot-stall.ts`）。
 * - 音效由 `boot-audio.ts` 现场合成，不引入音频文件。
 */

import logoSrc from '@app-assets/logo.png'
import {
  formatStallPhaseText,
  shouldApplyFallbackCurve,
  shouldEnterStall,
  STALL_MS,
} from './boot-stall'
import { BOOT_STYLE } from './boot-style'

export const BOOT_ID = 'lumii-boot'
/** 退场溶解时长：画面带羽化蒙版化开，露出下面的界面 */
export const BOOT_FADE_MS = 900

/**
 * 阶段名 → 画面文字。
 *
 * 这些是**真实启动阶段**，与主进程 `runStartupStage` 的 name 一一对应。
 * 未列出的阶段直接显示原名——宁可露出内部名，也不要显示错误的友好名。
 */
const PHASE_LABELS: Record<string, string> = {
  'S0-app-shell': '初始化运行时',
  'S1-extensions': '装载核心扩展',
  'S2-S5-ui': '构建主界面',
  window: '创建窗口',
  'S6-config': '读取配置',
  'S7-services': '启动本地服务',
  'S7.1-seed-skills': '同步内置技能',
  'S7.2-skill-runtime': '初始化技能引擎',
  'S7.3-skill-watcher': '监听技能变更',
  'S7.4-agent-runtime': '唤醒智能内核',
  'S8-post-ready': '连接外部服务',
  'screen-record': '准备录制模块',
}

/** 与主进程广播顺序一致的阶段名列表 */
const STAGE_ORDER = [
  'S0-app-shell',
  'S1-extensions',
  'S2-S5-ui',
  'window',
  'S6-config',
  'S7-services',
  'S7.1-seed-skills',
  'S7.2-skill-runtime',
  'S7.3-skill-watcher',
  'S7.4-agent-runtime',
  'S8-post-ready',
]

/** 阶段序号 → 标签，供右上角进度表逐条显示 */
function _stageLabelAt(index: number): string {
  return PHASE_LABELS[STAGE_ORDER[index]] ?? STAGE_ORDER[index] ?? ''
}

/** 供手写自检用：阶段名映射是否覆盖全部真实阶段 */
export function _phaseLabelFor(phase: string): string {
  return PHASE_LABELS[phase] ?? phase
}

/** 启动阶段总数，与主进程 BOOT_TOTAL_PHASES 一致 */
const TOTAL_PHASES = 11
/** 未收到任何进度信号前的稳态上限：绝不走到 100% */
const CURVE_CEILING = 88

export interface BootProgress {
  phase: string
  index: number
  total: number
}

export interface BootVisualOptions {
  /** 系统偏好减少动效：去掉粒子，只保留进度 */
  reducedMotion?: boolean
  /** 进度信号订阅（由调用方注入，便于测试与解耦 preload） */
  subscribe?: (cb: (p: BootProgress) => void) => () => void
  /** 每推进一个真实阶段时回调，供音效层跟随 */
  onPhase?: (label: string, index: number) => void
  /** 卡住态进入 / 退出时回调，供音效层切心跳 */
  onStall?: (stalled: boolean) => void
  /** 可注入时钟（单测用假时间）；默认 performance.now */
  now?: () => number
  /** 卡住阈值覆盖（毫秒）；默认 STALL_MS */
  stallMs?: number
}

export interface BootVisualHandle {
  /** 主壳就绪：冲到 100%、门户展开、溶解退场 */
  complete: () => Promise<void>
  /** 立刻移除（跳过/出错兜底） */
  destroy: () => void
  /** 确定性完成（测试用） */
  getProgress: () => number
}

/* ── 节奏 ─────────────────────────────────────────────────────── */
const BPM = 90
const BEAT = 60 / BPM
const EASE = {
  outCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  elastic: (t: number) => {
    if (t <= 0) return 0
    if (t >= 1) return 1
    return Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
  },
}

/** 五幕的叙事顺序，portal 单独收尾 */
type Act = 'dark' | 'dormant' | 'neural' | 'energize' | 'cognition' | 'gate'

const ACT_LABELS: Record<Act, string> = {
  dark: 'STANDBY',
  dormant: 'CORE WAKE',
  neural: 'NEURAL LINK',
  energize: 'ENERGIZE',
  cognition: 'COGNITION',
  gate: 'GATE OPEN',
}

/**
 * 真实阶段 → 幕的映射。
 *
 * 启动阶段的先后顺序是固定的，但视觉叙事只有五幕，
 * 所以按索引把阶段分配到幕上：前段是唤醒与生长，中段是充能，后段是聚合并开启。
 */
function actForPhase(index: number, total: number): Act {
  const r = index / Math.max(1, total)
  if (r <= 0.09) return 'dormant'
  if (r <= 0.45) return 'neural'
  if (r <= 0.72) return 'energize'
  if (r < 1) return 'cognition'
  return 'gate'
}

export function mountBootVisual(options: BootVisualOptions = {}): BootVisualHandle {
  document.getElementById(BOOT_ID)?.remove()

  if (!document.getElementById(`${BOOT_ID}-style`)) {
    const style = document.createElement('style')
    style.id = `${BOOT_ID}-style`
    style.textContent = BOOT_STYLE
    document.head.appendChild(style)
  }

  const root = document.createElement('div')
  root.id = BOOT_ID
  root.dataset.act = 'dark'
  root.setAttribute('role', 'presentation')
  root.setAttribute('aria-label', '灵栖启动中')
  root.innerHTML = `
  <div class="void-bg"></div>
  <div class="floor"></div>
  <canvas id="bk-fx"></canvas>

  <div class="hud-layer">
    <div class="armor tl"></div>
    <div class="armor tr"></div>
    <div class="armor bl"></div>
    <div class="armor br"></div>

    <div class="frame-line fl-top"></div>
    <div class="frame-line fl-bottom"></div>
    <div class="frame-line fl-left"></div>
    <div class="frame-line fl-right"></div>

    <div class="compass cx-tl"></div>
    <div class="compass cx-tr"></div>
    <div class="compass cx-bl"></div>
    <div class="compass cx-br"></div>

    <div class="topbar mono">
      <span><i class="led"></i>LUMII // UNIT-01 // BOOT</span>
      <span id="bk-act-name">STANDBY</span>
    </div>

    <div class="telemetry mono">
      <div><span class="k">CORE</span> &nbsp;<span class="v" id="bk-t-core">0x00</span></div>
      <div><span class="k">PWR&nbsp;</span> &nbsp;<span class="v" id="bk-t-pwr">0.0%</span></div>
      <div><span class="k">SYNC</span> &nbsp;<span class="v" id="bk-t-sync">--</span></div>
    </div>

    <div class="checks mono" id="bk-checks"></div>

    <div class="bar-wrap">
      <div class="bar">
        <div class="bar-fill" id="bk-bar-fill"></div>
        <div class="bar-ticks"></div>
      </div>
      <div class="bar-row mono">
        <span id="bk-phase-text">准备启动</span>
        <span id="bk-pct-text">0%</span>
      </div>
    </div>
  </div>

  <div class="gate"></div>
  <div class="gate-seam"></div>
  <img class="signature" src="${logoSrc}" alt="" />

  <div class="shock"></div>
  <div class="flash"></div>
  <div class="scanlines"></div>
  <div class="vignette"></div>
  <div class="noise"></div>
  <div class="barTop"></div>
  <div class="barBot"></div>
  `
  document.body.appendChild(root)

  const q = <T extends Element>(sel: string) => root.querySelector<T>(sel)
  const cv = q<HTMLCanvasElement>('#bk-fx')!
  /**
   * 拿不到 2D 上下文时（jsdom、GPU 初始化失败）用一个空实现顶上。
   *
   * 开机画面是纯装饰，没画布也不该拖垮启动流程——HUD、进度、阶段文字
   * 都不依赖 canvas，照常工作。所有绘制调用变成空操作即可。
   */
  const ctx = (cv?.getContext('2d') ??
    new Proxy(
      {},
      {
        get: (_t, prop) => {
          if (prop === 'canvas') return cv
          if (prop === 'createImageData') return () => null
          if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
            return () => ({ addColorStop: () => {} })
          }
          return () => {}
        },
        set: () => true,
      },
    )) as CanvasRenderingContext2D

  // 高清：3x 屏上 2x 会被插值放大，肉眼可见发软
  const DPR = Math.min(window.devicePixelRatio || 1, 3)
  let W = 0
  let H = 0
  let CX = 0
  let CY = 0

  let act: Act = 'dark'
  let beatClock = 0
  let lastBeatNo = -1
  let progress = 0
  let destroyed = false
  let completed = false
  let raf = 0
  let lastT = performance.now()
  const startedAt = performance.now()

  let dust: Particle[] = []
  let nebulaCanvas: HTMLCanvasElement | null = null
  let starCanvas: HTMLCanvasElement | null = null

  let targetProgress = 0
  /**
   * 是否已收到过真实阶段。
   *
   * 兜底曲线只在「一条真实信号都没有」时接管；一旦有真进度，
   * 就完全交给它——否则曲线会一路把进度推到 88%，和阶段清单脱节。
   */
  let hasRealProgress = false
  let coreGlow = 0
  let targetCore = 0.18
  let circuitGrow = 0
  let streamInflow = 0

  const clock = options.now ?? (() => performance.now())
  const stallThreshold = options.stallMs ?? STALL_MS
  let lastPhaseAt = clock()
  let phaseLabel = '准备启动'
  let lastProgressIndex = 0
  let stalled = false

  const reduced =
    options.reducedMotion ??
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ??
    false

  /* ── 阶段推进 ───────────────────────────────────────────────── */
  let renderedStages = 0
  const checksEl = q<HTMLElement>('#bk-checks')!
  const phaseTextEl = q<HTMLElement>('#bk-phase-text')!
  const pctEl = q<HTMLElement>('#bk-pct-text')!
  const fillEl = q<HTMLElement>('#bk-bar-fill')!
  const actNameEl = q<HTMLElement>('#bk-act-name')!
  const syncEl = q<HTMLElement>('#bk-t-sync')!
  const coreEl = q<HTMLElement>('#bk-t-core')!
  const pwrEl = q<HTMLElement>('#bk-t-pwr')!

  function renderChecks(count: number, allDone = false): void {
    const target = Math.max(0, Math.min(TOTAL_PHASES, count))
    if (target < renderedStages) {
      checksEl.innerHTML = ''
      renderedStages = 0
    }
    while (renderedStages < target) {
      const div = document.createElement('div')
      div.className = 'enter'
      div.innerHTML = `<i>◇</i>${_stageLabelAt(renderedStages)}`
      checksEl.appendChild(div)
      renderedStages++
    }
    for (let i = 0; i < renderedStages; i++) {
      const div = checksEl.children[i]
      const done = allDone || i < renderedStages - 1
      div.classList.toggle('on', done)
      div.querySelector('i')!.textContent = done ? '◆' : '◇'
    }
  }

  function setAct(next: Act): void {
    if (act === next) return
    act = next
    root.dataset.act = next
    actNameEl.textContent = ACT_LABELS[next]
    // 装甲 / 框线 / 罗盘透明度交给 CSS 的 data-act 控制，避免 inline 盖掉「前弱后强」
  }

  /** 卡住态展示用的阶段名：无真实进度时走规格文案「等待启动信号」 */
  function stallLabel(): string {
    return hasRealProgress ? phaseLabel : ''
  }

  /**
   * 刷新卡住态：进入时改文案与 SYNC；退出时恢复阶段名。
   */
  function refreshStall(): void {
    if (destroyed || completed) {
      if (stalled) applyStall(false)
      return
    }
    const now = clock()
    const next = shouldEnterStall(now, lastPhaseAt, {
      completed,
      stallMs: stallThreshold,
    })
    if (next !== stalled) applyStall(next)
    if (stalled) {
      const waitedSec = (now - lastPhaseAt) / 1000
      const text = formatStallPhaseText(stallLabel(), waitedSec)
      if (phaseTextEl.textContent !== text) phaseTextEl.textContent = text
      if (syncEl.textContent !== 'HOLD') syncEl.textContent = 'HOLD'
    }
  }

  /** 写入卡住态 DOM / 回调 */
  function applyStall(next: boolean): void {
    stalled = next
    if (next) {
      root.dataset.stall = '1'
      syncEl.textContent = 'HOLD'
      options.onStall?.(true)
    } else {
      delete root.dataset.stall
      phaseTextEl.textContent = phaseLabel
      options.onStall?.(false)
    }
  }

  /* ── 订阅真实进度 ───────────────────────────────────────────── */
  const off = options.subscribe?.((p) => {
    if (destroyed || completed) return
    // 广播补发 / history 可能重复同一批阶段：忽略回退索引，避免重置卡住计时
    if (p.index <= lastProgressIndex) return
    lastProgressIndex = p.index
    const total = p.total > 0 ? p.total : TOTAL_PHASES

    // 进度条与右上角清单必须同源：都按「已完成阶段数」折算。
    // 否则会出现「进度 62% 但清单只走到第 4 条」这种自相矛盾的画面——
    // 之前两者一个跑时间曲线、一个按索引走，就是这么错开的。
    const done = Math.max(0, Math.min(total, p.index - 1))
    const ratio = done / total
    // 真实阶段只推到 96%：最后 4% 留给主壳真正可交互的那一刻
    targetProgress = Math.max(targetProgress, Math.min(96, ratio * 96))
    hasRealProgress = true

    const label = _phaseLabelFor(p.phase)
    phaseLabel = label
    lastPhaseAt = clock()
    if (stalled) applyStall(false)
    else phaseTextEl.textContent = label
    renderChecks(p.index)
    setAct(actForPhase(p.index, total))
    options.onPhase?.(label, p.index)
  })

  /** 卡住态轮询：不依赖 rAF，假时钟单测也能推进 */
  const stallTimer = window.setInterval(refreshStall, 250)

  /* ── 底图烘焙 ───────────────────────────────────────────────── */
  function makeNoise2D(seed: number): (x: number, y: number) => number {
    const perm = new Uint8Array(512)
    let s = seed
    const rnd = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1))
      const tmp = p[i]
      p[i] = p[j]
      p[j] = tmp
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255]

    const grad = (h: number, x: number, y: number) => {
      switch (h & 7) {
        case 0: return x + y
        case 1: return x - y
        case 2: return -x + y
        case 3: return -x - y
        case 4: return x
        case 5: return -x
        case 6: return y
        default: return -y
      }
    }
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)

    return (x, y) => {
      const X = Math.floor(x) & 255
      const Y = Math.floor(y) & 255
      const xf = x - Math.floor(x)
      const yf = y - Math.floor(y)
      const u = fade(xf)
      const v = fade(yf)
      const aa = perm[perm[X] + Y]
      const ab = perm[perm[X] + Y + 1]
      const ba = perm[perm[X + 1] + Y]
      const bb = perm[perm[X + 1] + Y + 1]
      const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf))
      const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1))
      return (x1 + v * (x2 - x1)) * 0.5 + 0.5
    }
  }

  function bakeNebula(): void {
    const nw = Math.max(420, Math.min(1400, Math.round(W * 0.62)))
    const nh = Math.max(260, Math.min(900, Math.round(H * 0.62)))
    const c = document.createElement('canvas')
    c.width = nw
    c.height = nh
    const g = c.getContext('2d')
    // 无画布实现的环境（jsdom、极早期 GPU 失败）直接跳过烘焙：
    // 底图缺失只会让背景空一点，绝不能让开机画面挂掉。
    if (!g) return
    const img = g.createImageData(nw, nh)
    if (!img?.data) return
    const data = img.data
    const noise = makeNoise2D(20260107)
    const noise2 = makeNoise2D(777)

    const fbm = (x: number, y: number) => {
      let v = 0
      let amp = 0.5
      let fx = x
      let fy = y
      for (let o = 0; o < 5; o++) {
        v += noise(fx, fy) * amp
        fx *= 2.03
        fy *= 2.01
        amp *= 0.5
      }
      return v
    }

    const tilt = (-21 * Math.PI) / 180
    const cosT = Math.cos(tilt)
    const sinT = Math.sin(tilt)
    const cxp = nw * 0.5
    const cyp = nh * 0.5

    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        const dx = (x - cxp) / (nw * 0.5)
        const dy = (y - cyp) / (nh * 0.5)
        const rx = dx * cosT - dy * sinT
        const ry = dx * sinT + dy * cosT

        const band = Math.exp(-(ry * ry) / (2 * 0.052 * 0.052))
        const taper = Math.exp(-(rx * rx) / (2 * 0.72 * 0.72))
        let density = band * taper

        const n1 = fbm((x / nw) * 11 + 3.1, (y / nh) * 11 + 1.7)
        const n2 = noise2((x / nw) * 2.6, (y / nh) * 2.6)
        const n3 = fbm((x / nw) * 26 + 9.4, (y / nh) * 26 + 5.2)
        density *= (0.12 + n1 * n1 * 1.9) * (0.5 + n2 * 0.95)
        density *= 0.45 + n3 * 0.95

        const laneW = 0.02 + 0.01 * Math.sin(rx * 2.3 + 1.1)
        const dustLane = Math.exp(-Math.pow((ry + 0.05 * Math.sin(rx * 4)) / laneW, 2))
        density *= 1 - dustLane * 0.62

        const halo = Math.exp(-(rx * rx + ry * ry * 3.4) / (2 * 0.42 * 0.42)) * 0.16
        density += halo * (0.2 + n1 * 0.8)

        density *= 0.52
        density = Math.max(0, Math.min(1, density))
        if (density < 0.004) continue

        const i4 = (y * nw + x) * 4
        const warm = Math.min(1, density * 1.8)
        data[i4] = Math.round(48 + 150 * warm)
        data[i4 + 1] = Math.round(96 + 140 * warm)
        data[i4 + 2] = Math.round(150 + 105 * warm)
        data[i4 + 3] = Math.round(Math.pow(density, 1.35) * 255)
      }
    }
    g.putImageData(img, 0, 0)
    nebulaCanvas = c
  }

  function bakeStars(): void {
    const c = document.createElement('canvas')
    c.width = Math.round(W * DPR)
    c.height = Math.round(H * DPR)
    const g = c.getContext('2d')
    if (!g) return
    g.scale(DPR, DPR)

    const count = Math.round(Math.min(1100, (W * H) / 1750))
    const temps = [
      { r: 200, g: 228, b: 255, w: 0.46 },
      { r: 255, g: 255, b: 255, w: 0.3 },
      { r: 255, g: 236, b: 200, w: 0.17 },
      { r: 255, g: 176, b: 130, w: 0.07 },
    ]
    const pickTemp = () => {
      let r = Math.random()
      for (const t of temps) {
        if ((r -= t.w) <= 0) return t
      }
      return temps[0]
    }

    for (let i = 0; i < count; i++) {
      const x = Math.random() * W
      const y = Math.random() * H
      // 幂律：绝大多数是小星，约 4% 带星芒
      const mag = Math.pow(Math.random(), 4.6)
      const radius = 0.26 + mag * 1.55
      const alpha = 0.14 + Math.pow(mag, 1.6) * 0.66
      const t = pickTemp()

      if (mag > 0.62) {
        const haloR = radius * (6 + mag * 8)
        const hg = g.createRadialGradient(x, y, 0, x, y, haloR)
        hg.addColorStop(0, `rgba(${t.r},${t.g},${t.b},${(alpha * 0.34).toFixed(3)})`)
        hg.addColorStop(0.35, `rgba(${t.r},${t.g},${t.b},${(alpha * 0.1).toFixed(3)})`)
        hg.addColorStop(1, `rgba(${t.r},${t.g},${t.b},0)`)
        g.fillStyle = hg
        g.beginPath()
        g.arc(x, y, haloR, 0, 6.2832)
        g.fill()

        const spike = haloR * (1.4 + mag * 1.2)
        for (const ang of [0, Math.PI / 2]) {
          g.save()
          g.translate(x, y)
          g.rotate(ang)
          const lg = g.createLinearGradient(-spike, 0, spike, 0)
          lg.addColorStop(0, `rgba(${t.r},${t.g},${t.b},0)`)
          lg.addColorStop(0.5, `rgba(${t.r},${t.g},${t.b},${(alpha * 0.4).toFixed(3)})`)
          lg.addColorStop(1, `rgba(${t.r},${t.g},${t.b},0)`)
          g.fillStyle = lg
          g.fillRect(-spike, -0.45, spike * 2, 0.9)
          g.restore()
        }
      }

      g.fillStyle = `rgba(${t.r},${t.g},${t.b},${alpha.toFixed(3)})`
      g.beginPath()
      g.arc(x, y, radius, 0, 6.2832)
      g.fill()
    }
    starCanvas = c
  }

  function bakeBackdrop(): void {
    bakeNebula()
    bakeStars()
  }

  function seedDust(): void {
    const n = reduced ? 0 : Math.round(Math.min(150, (W * H) / 12000))
    dust = Array.from({ length: n }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: 0.9 + Math.random() * 1.9,
      a: 0.1 + Math.random() * 0.26,
      vy: -0.09 - Math.random() * 0.26,
      vx: (Math.random() - 0.5) * 0.14,
      ph: Math.random() * 6.28,
    }))
  }

  function drawBackdrop(): void {
    if (!nebulaCanvas || !starCanvas) return
    const driftX = Math.sin(beatClock * 0.045) * 10
    const driftY = Math.cos(beatClock * 0.037) * 7

    ctx.save()
    ctx.globalAlpha = 0.58
    ctx.drawImage(nebulaCanvas, -driftX * 0.6 - W * 0.04, -driftY * 0.6 - H * 0.06, W * 1.08, H * 1.08)
    ctx.restore()

    ctx.save()
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(starCanvas, -driftX * 0.18, -driftY * 0.18, W * 1.02, H * 1.02)
    ctx.restore()
  }

  function drawDust(dt: number): void {
    if (!dust.length) return
    const surge = Math.pow(1 - beatPhase(), 5) * 5
    for (const p of dust) {
      p.y += p.vy * dt * 60
      p.x += p.vx * dt * 60
      if (p.y < -8) {
        p.y = H + 8
        p.x = Math.random() * W
      }
      if (p.x < -8) p.x = W + 8
      if (p.x > W + 8) p.x = -8

      const tw = 0.5 + 0.5 * Math.pow(0.5 + 0.5 * Math.sin(beatClock * 2.2 + p.ph), 2)
      let dx = 0
      let dy = 0
      if (surge > 0.05) {
        const vx = p.x - CX
        const vy = p.y - CY
        const d = Math.hypot(vx, vy) || 1
        dx = (vx / d) * surge
        dy = (vy / d) * surge
      }
      const px = p.x + dx
      const py = p.y + dy

      const g = ctx.createRadialGradient(px, py, 0, px, py, p.r * 6)
      g.addColorStop(0, `rgba(180,235,255,${(p.a * tw * 0.6).toFixed(3)})`)
      g.addColorStop(1, 'rgba(180,235,255,0)')
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(px, py, p.r * 6, 0, 6.2832)
      ctx.fill()
    }
  }

  /* ── 核心与刻度环 ───────────────────────────────────────────── */
  function drawCore(): void {
    if (coreGlow <= 0.01) return
    const thump = stalled ? 0 : Math.pow(1 - beatPhase(), 4)
    // 卡住态：更慢、更大的「仍在唤醒」呼吸；正常态跟拍子
    const breathe = stalled
      ? 0.78 + 0.28 * Math.sin(slowPhase(8) * Math.PI * 2)
      : 0.84 + 0.16 * Math.sin(slowPhase(4) * Math.PI * 2) + thump * 0.22
    const glowMul = stalled ? 1.15 : act === 'cognition' ? 1.2 : 1

    // 横向变形镜头光晕：电影感最直接的来源
    const streakW = (stalled ? 620 : act === 'cognition' ? 580 : 520) * breathe
    const streakH = 2.2 + thump * 1.6 + (stalled ? 1.1 : 0)
    const sg = ctx.createLinearGradient(CX - streakW, CY, CX + streakW, CY)
    sg.addColorStop(0, 'rgba(90,180,255,0)')
    sg.addColorStop(0.28, `rgba(120,205,255,${(0.16 * coreGlow * glowMul).toFixed(3)})`)
    sg.addColorStop(0.5, `rgba(200,240,255,${(0.55 * coreGlow * glowMul).toFixed(3)})`)
    sg.addColorStop(0.72, `rgba(120,205,255,${(0.16 * coreGlow * glowMul).toFixed(3)})`)
    sg.addColorStop(1, 'rgba(90,180,255,0)')
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    ctx.fillStyle = sg
    ctx.beginPath()
    ctx.ellipse(CX, CY, streakW, streakH, 0, 0, 6.2832)
    ctx.fill()

    const haloR = (stalled ? 62 : 46) * breathe
    const g = ctx.createRadialGradient(CX, CY, 0, CX, CY, haloR)
    g.addColorStop(0, `rgba(180,240,255,${(0.34 * coreGlow * glowMul).toFixed(3)})`)
    g.addColorStop(0.45, `rgba(80,180,255,${(0.13 * coreGlow * glowMul).toFixed(3)})`)
    g.addColorStop(1, 'rgba(40,120,220,0)')
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(CX, CY, haloR, 0, 6.2832)
    ctx.fill()
    ctx.restore()

    const ringN = stalled ? 3 : 2
    for (let k = 0; k < ringN; k++) {
      const ph = (beatPhase() + k * (1 / ringN)) % 1
      const radius = 26 + ph * (stalled ? 160 : 132)
      ctx.beginPath()
      ctx.strokeStyle = `rgba(150,235,255,${((1 - ph) * 0.26 * coreGlow * glowMul).toFixed(3)})`
      ctx.lineWidth = 1.1 * (1 - ph) + 0.25
      ctx.arc(CX, CY, radius, 0, 6.2832)
      ctx.stroke()
    }

    // 精密刻度：每 6 根一根长刻度，有疏密节奏才有仪器感
    const tickR = 30 * breathe
    const tickN = 72
    for (let i = 0; i < tickN; i++) {
      const a = (i / tickN) * 6.2832 + slowPhase(16) * 0.6
      const major = i % 6 === 0
      const len = major ? 7 : 3
      const rr0 = tickR + 8
      const rr1 = rr0 + len
      ctx.beginPath()
      ctx.strokeStyle = `rgba(150,225,255,${((major ? 0.4 : 0.18) * coreGlow).toFixed(3)})`
      ctx.lineWidth = major ? 0.9 : 0.6
      ctx.moveTo(CX + Math.cos(a) * rr0, CY + Math.sin(a) * rr0)
      ctx.lineTo(CX + Math.cos(a) * rr1, CY + Math.sin(a) * rr1)
      ctx.stroke()
    }

    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    const coreR = (3.4 + thump * 2.2) * (1 + 0.06 * Math.sin(beatClock * 9))
    const cg = ctx.createRadialGradient(CX, CY, 0, CX, CY, coreR * 3.2)
    cg.addColorStop(0, `rgba(255,255,255,${(0.98 * coreGlow).toFixed(3)})`)
    cg.addColorStop(0.22, `rgba(225,250,255,${(0.72 * coreGlow).toFixed(3)})`)
    cg.addColorStop(1, 'rgba(120,220,255,0)')
    ctx.fillStyle = cg
    ctx.beginPath()
    ctx.arc(CX, CY, coreR * 3.2, 0, 6.2832)
    ctx.fill()

    ctx.fillStyle = `rgba(255,255,255,${(0.97 * coreGlow).toFixed(3)})`
    ctx.beginPath()
    ctx.arc(CX, CY, coreR, 0, 6.2832)
    ctx.fill()
    ctx.restore()
  }

  /* ── 能量环 ─────────────────────────────────────────────────── */
  function drawRings(strength: number): void {
    if (strength <= 0.02) return
    const ringDefs = [
      { r: 118, seg: 12, gap: 0.34, w: 2.4, dir: 1, beats: 6 },
      { r: 152, seg: 8, gap: 0.52, w: 1.4, dir: -1, beats: 9 },
      { r: 186, seg: 36, gap: 0.1, w: 1, dir: 1, beats: 4 },
    ]
    for (const d of ringDefs) {
      const segAng = (Math.PI * 2) / d.seg
      const spin = ((beatClock / BEAT / d.beats) * (Math.PI * 2)) / d.beats
      const base = d.dir > 0 ? spin : -spin
      const glow = 0.4 + 0.18 * Math.pow(1 - beatPhase(), 3)
      for (let i = 0; i < d.seg; i++) {
        const a0 = base + i * segAng
        const a1 = a0 + segAng * (1 - d.gap)
        ctx.beginPath()
        ctx.strokeStyle = `rgba(120,230,255,${(glow * strength).toFixed(3)})`
        ctx.lineWidth = d.w
        ctx.arc(CX, CY, d.r, a0, a1)
        ctx.stroke()
      }
    }
  }

  /* ── 电路纹路 ───────────────────────────────────────────────── */
  const circuits = [
    [[0, -40], [0, -96], [38, -134], [38, -196], [96, -254]],
    [[0, -40], [0, -96], [-38, -134], [-38, -196], [-96, -254]],
    [[0, 40], [0, 96], [42, 138], [42, 196], [104, 258]],
    [[0, 40], [0, 96], [-42, 138], [-42, 196], [-104, 258]],
    [[40, 0], [96, 0], [140, 44], [206, 44]],
    [[-40, 0], [-96, 0], [-140, 44], [-206, 44]],
    [[40, 0], [96, 0], [140, -44], [206, -44]],
    [[-40, 0], [-96, 0], [-140, -44], [-206, -44]],
  ]

  function drawCircuits(strength: number): void {
    if (strength <= 0.01) return
    const K = Math.min(1, circuitGrow)
    ctx.lineWidth = 1.2

    for (let i = 0; i < circuits.length; i++) {
      const path = circuits[i]
      const local = Math.max(0, Math.min(1, (K - i * 0.05) / 0.72))
      if (local <= 0) continue

      const pts = path.map(([x, y]) => [CX + x, CY + y] as const)
      let totalSeg = 0
      for (let s = 1; s < pts.length; s++) {
        totalSeg += Math.hypot(pts[s][0] - pts[s - 1][0], pts[s][1] - pts[s - 1][1])
      }
      const drawLen = totalSeg * local

      ctx.beginPath()
      ctx.moveTo(pts[0][0], pts[0][1])
      let drawn = 0
      for (let s = 1; s < pts.length; s++) {
        const [x0, y0] = pts[s - 1]
        const [x1, y1] = pts[s]
        const len = Math.hypot(x1 - x0, y1 - y0)
        if (drawn + len <= drawLen) {
          ctx.lineTo(x1, y1)
          drawn += len
        } else {
          const remain = drawLen - drawn
          if (remain > 0) {
            const t = remain / len
            ctx.lineTo(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t)
          }
          break
        }
      }
      ctx.strokeStyle = `rgba(110,215,255,${(0.5 * strength).toFixed(3)})`
      ctx.stroke()
    }
  }

  /* ── 数据流线 ───────────────────────────────────────────────── */
  function drawStreams(dt: number): void {
    if (streamInflow <= 0.01) return
    const n = reduced ? 60 : 220
    ctx.save()
    ctx.globalCompositeOperation = 'lighter'
    for (let i = 0; i < n; i++) {
      const t = (beatClock * 0.35 + i / n) % 1
      const ang = i * 2.399963 + beatClock * 0.35
      const rr = (1 - t) * Math.max(W, H) * 0.55
      const x = CX + Math.cos(ang) * rr
      const y = CY + Math.sin(ang) * rr * 0.62
      const alpha = Math.sin(t * Math.PI) * 0.4 * streamInflow
      ctx.fillStyle = `rgba(140,225,255,${alpha.toFixed(3)})`
      ctx.beginPath()
      ctx.arc(x, y, 0.9, 0, 6.2832)
      ctx.fill()
    }
    ctx.restore()
  }

  /* ── 主循环 ─────────────────────────────────────────────────── */
  function beatPhase(): number {
    return (beatClock % BEAT) / BEAT
  }
  function slowPhase(beats = 4): number {
    return (beatClock % (BEAT * beats)) / (BEAT * beats)
  }

  function frame(now: number): void {
    if (destroyed) return
    const dt = Math.min(0.05, (now - lastT) / 1000)
    lastT = now
    beatClock += dt

    const beatNo = Math.floor(beatClock / BEAT)
    if (beatNo !== lastBeatNo) lastBeatNo = beatNo

    ctx.clearRect(0, 0, W, H)

    const isNeural = act === 'neural'
    const isEnergize = act === 'energize'
    const isCognition = act === 'cognition'
    const isGate = act === 'gate'

    // 前段克制、高潮更亮；卡住态保持可见呼吸底光
    targetCore = stalled
      ? Math.max(0.42, act === 'dark' || act === 'dormant' ? 0.48 : 0.55)
      : act === 'dark'
        ? 0.22
        : act === 'dormant'
          ? 0.32
          : isCognition
            ? 0.88
            : isGate
              ? 0.55
              : isEnergize
                ? 0.72
                : 0.58
    coreGlow += (targetCore - coreGlow) * Math.min(1, dt * 3)

    {
      const coreText = `0x${Math.round(coreGlow * 255).toString(16).padStart(2, '0')}`
      if (coreEl.textContent !== coreText) coreEl.textContent = coreText
      const pwrText = `${progress.toFixed(1)}%`
      if (pwrEl.textContent !== pwrText) pwrEl.textContent = pwrText
      if (!stalled) {
        const syncText = hasRealProgress ? `${Math.round(progress)}%` : '--'
        if (syncEl.textContent !== syncText) syncEl.textContent = syncText
      }
    }

    streamInflow = isNeural
      ? Math.min(1, streamInflow + dt * 0.7)
      : isEnergize || isCognition || isGate
        ? Math.max(0, streamInflow - dt * 0.35)
        : 0

    circuitGrow = isNeural
      ? Math.min(1, circuitGrow + dt * 0.55)
      : isEnergize || isCognition
        ? 1
        : isGate
          ? Math.max(0, circuitGrow - dt * 0.6)
          : 0

    // 兜底曲线：只在一条真实信号都没收到、且未卡住时接管。
    // 卡住态必须冻结进度条——否则文案说「已等待」，条却还在假爬升。
    if (shouldApplyFallbackCurve({ completed, hasRealProgress, stalled })) {
      const curve = CURVE_CEILING * (1 - Math.exp(-(now - startedAt) / 5200))
      targetProgress = Math.max(targetProgress, curve)
    }
    const cap = completed ? 100 : 96
    const goal = Math.min(targetProgress, cap)
    // 卡住态冻结百分比：不 lerp、不曲线，避免「等待文案 vs 条还在动」
    if (!stalled || completed) {
      progress += (goal - progress) * 0.12
      if (Math.abs(goal - progress) < 0.05) progress = goal
    }

    fillEl.style.width = `${progress.toFixed(1)}%`
    pctEl.textContent = `${Math.round(progress)}%`

    drawBackdrop()
    drawDust(dt)
    drawStreams(dt)
    drawCircuits(isNeural ? 0.5 + streamInflow * 0.5 : circuitGrow > 0 ? 0.55 : 0)
    drawCore()
    drawRings(isEnergize ? 1 : isCognition ? 0.75 : isGate ? 0.5 : 0)

    // 镜头呼吸：幅度必须小，大了是晕船
    const sp = slowPhase(4)
    const camX = Math.sin(sp * Math.PI * 2) * 1.5
    const camY = Math.cos(sp * Math.PI * 2 * 0.7) * 1.2
    const camScale = 1.008 + Math.sin(sp * Math.PI * 2) * 0.006
    cv.style.transform = `translate(${camX.toFixed(2)}px, ${camY.toFixed(2)}px) scale(${camScale.toFixed(4)})`

    raf = requestAnimationFrame(frame)
  }

  function resize(): void {
    W = cv.clientWidth
    H = cv.clientHeight
    CX = W / 2
    CY = H * 0.46
    cv.width = Math.round(W * DPR)
    cv.height = Math.round(H * DPR)
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0)
    seedDust()
    bakeBackdrop()
  }

  resize()
  raf = requestAnimationFrame(frame)

  const onResize = () => resize()
  window.addEventListener('resize', onResize)

  const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms))

  function cleanup(): void {
    destroyed = true
    window.clearInterval(stallTimer)
    cancelAnimationFrame(raf)
    window.removeEventListener('resize', onResize)
    off?.()
  }

  return {
    async complete() {
      if (completed || destroyed) return
      completed = true
      if (stalled) applyStall(false)
      phaseLabel = '系统就绪'
      targetProgress = 100
      progress = 100
      fillEl.style.width = '100%'
      pctEl.textContent = '100%'
      phaseTextEl.textContent = '系统就绪'
      renderChecks(TOTAL_PHASES, true)
      setAct('gate')

      // 门户：竖缝先裂开，再向两侧张开
      q<HTMLElement>('.gate-seam')?.classList.add('open')
      await sleep(320)
      q<HTMLElement>('.gate')?.classList.add('open')
      await sleep(680)

      // logo 从门户中心飞向左上角（主界面侧栏原位）
      flySignature()
      await sleep(760)

      // 白场收尾，然后溶解
      q<HTMLElement>('.flash')?.classList.add('fire')
      await sleep(560)

      q<HTMLElement>('.barTop')?.classList.remove('on')
      q<HTMLElement>('.barBot')?.classList.remove('on')
      await sleep(340)

      // 溶解交接：不切黑，整块带羽化蒙版化开，露出下面的界面
      root.classList.add('fading')
      await sleep(BOOT_FADE_MS)

      cleanup()
      root.remove()
    },
    destroy() {
      cleanup()
      root.remove()
    },
    getProgress: () => progress,
  }

  /**
   * logo 飞向左上角，落到主界面侧栏原位。
   *
   * 终点必须精确对齐主界面侧栏的品牌位（16px 边距），而起点是门户中心，
   * 两个点都依赖运行时尺寸，写死在 CSS 里会随窗口大小漂移。
   */
  function flySignature(): void {
    const img = q<HTMLImageElement>('.signature')
    if (!img) return
    const targetSize = 26
    const margin = 16
    const targetX = margin
    const targetY = margin
    const startX = CX - 90
    const startY = CY - 90
    const dur = 900
    const t0 = performance.now()

    img.style.width = '180px'
    img.style.height = '180px'
    img.style.left = '0'
    img.style.top = '0'
    img.style.opacity = '1'

    const step = (now: number) => {
      if (destroyed) return
      const k = Math.min(1, (now - t0) / dur)
      const e = 1 - Math.pow(1 - k, 3)
      const size = 180 + (targetSize - 180) * e
      const x = startX + (targetX - startX) * e
      const y = startY + (targetY - startY) * e
      img.style.width = `${size}px`
      img.style.height = `${size}px`
      img.style.transform = `translate(${x}px, ${y}px)`
      img.style.opacity = String(k < 0.12 ? k / 0.12 : 1)
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }
}

interface Particle {
  x: number
  y: number
  r: number
  a: number
  vy: number
  vx: number
  ph: number
}




export const _TOTAL_PHASES = TOTAL_PHASES
