/**
 * pet-particles - 宠物特效粒子层（纯 Canvas 2D，无 React、无外部依赖）
 *
 * 目前两种用法：
 *
 *   · `spawnClickFireworks(x, y)` —— 点击宠物身体的即时反馈：一簇彩色粒子炸开、
 *     受重力回落、淡出。
 *   · `spawnIdleSparkles(x, y)`   —— 待机时偶尔冒的几颗小星/爱心：**缓缓上浮**、
 *     不落地、更小更淡。
 *
 * 两者共用**同一块覆盖层 canvas 与同一个 RAF 循环**（`particles` 池里混装，
 * 靠每颗粒子自己的 `gravity`/`shape` 区分）。分成两个模块会让宠物窗里挂两块全屏
 * canvas、跑两个 RAF——那不是"解耦"，是重复。
 *
 * 覆盖层挂在 `document.body` 上、`pointer-events:none`，所以既不影响窗口穿透语义，
 * 也不参与命中判定。动画跑完自动停循环并清空（canvas 留着复用）。
 *
 * 素材无关：这里画的全是几何形状，不需要图集。**与角色强相关的效果**（比如尾巴上
 * 挂个铃铛）才该走素材——见 `docs/design/客户端UI/2026-09-21-宠物创作平台预留设计.md`。
 */

/** 粒子形状。**只画几何图形，不用字体**——宠物窗里的字体不可控，
 * 用 `fillText('✦')` 在别的机器上可能变成豆腐块或另一种风格。 */
type ParticleShape = 'dot' | 'star' | 'heart'

/** 单个粒子 */
interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  life: number // 剩余寿命 0~1
  size: number
  /** 重力倍率：烟花 1（正常下落），待机闪光 0（只上浮不回落） */
  gravity: number
  shape: ParticleShape
  /** 自转（弧度/秒）与当前角度，只有 star/heart 看得出 */
  spin: number
  angle: number
}

/**
 * 点击烟花用的调色板（明亮、适合透明背景）
 *
 * **刻意不接主题令牌**：宠物窗是独立窗口（`main.tsx` 直接渲染 `PetModeShell`，
 * 不挂 `ThemeProvider`，没有 `data-theme`），令牌取不到主题值；且这里每帧
 * 随机取色，改成读令牌要么每帧 `getComputedStyle`（强制样式重算，性能反模式），
 * 要么缓存 + 失效重读（复杂度不成比例）。"透明桌面背景上要够亮"也是独立于
 * 主题的语义。**下一轮重构请勿"顺手统一"。**
 */
const PALETTE = [
  '#ff6b6b',
  '#ffd93d',
  '#6bcB77',
  '#4d96ff',
  '#ff9ff3',
  '#ffa502',
  '#7bed9f',
]

/**
 * 待机闪光的调色板：**刻意比烟花淡**。
 *
 * 烟花是"你点了我，我回应你"，该抢眼；待机闪光是自己冒的，抢眼就成了干扰。
 * 所以取低饱和的暖亮色，尺寸也更小。
 */
const SPARKLE_PALETTE = ['#ffe066', '#ffd8a8', '#ffc9de', '#c5e8ff', '#d8f5c8']

/** 每次爆发的粒子数 */
const PARTICLE_COUNT = 28
/** 重力加速度（px/s²，屏幕坐标向下为正） */
const GRAVITY = 900
/** 寿命衰减速率（/秒），约 1.1s 消失 */
const LIFE_DECAY = 0.9

/** 待机闪光：每次冒几颗、飘多久 */
const SPARKLE_COUNT_MIN = 3
const SPARKLE_COUNT_MAX = 6
/** 上浮速度（px/s，负号向上） */
const SPARKLE_RISE_MIN = 18
const SPARKLE_RISE_MAX = 42
/** 约 1.6s 淡完——比烟花慢，飘得久一点才像"浮起来的光点" */
const SPARKLE_LIFE_DECAY = 0.6

/** 复用的覆盖层 canvas（懒创建） */
let overlayCanvas: HTMLCanvasElement | null = null
let overlayCtx: CanvasRenderingContext2D | null = null
/** 活跃粒子池（多次触发叠加） */
let particles: Particle[] = []
let rafId: number | null = null
let lastTs = 0

function ensureOverlay(): CanvasRenderingContext2D | null {
  if (overlayCanvas && overlayCtx) {
    syncCanvasSize()
    return overlayCtx
  }
  const canvas = document.createElement('canvas')
  canvas.style.position = 'fixed'
  canvas.style.inset = '0'
  canvas.style.width = '100vw'
  canvas.style.height = '100vh'
  canvas.style.pointerEvents = 'none' // 纯视觉，不拦截鼠标（保持窗口穿透语义）
  canvas.style.zIndex = '2147483646' // 尽量置顶，压在控制坞之上
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  overlayCanvas = canvas
  overlayCtx = canvas.getContext('2d')
  syncCanvasSize()
  return overlayCtx
}

/** 同步 canvas 像素尺寸到视口（含 DPR），避免拉伸模糊 */
function syncCanvasSize(): void {
  if (!overlayCanvas) {
    return
  }
  const dpr = window.devicePixelRatio || 1
  const w = Math.round(window.innerWidth * dpr)
  const h = Math.round(window.innerHeight * dpr)
  if (overlayCanvas.width !== w || overlayCanvas.height !== h) {
    overlayCanvas.width = w
    overlayCanvas.height = h
    overlayCtx?.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
}

/** 有粒子在飞就保证循环在跑；重复调用安全 */
function ensureLoop(): void {
  if (rafId === null) {
    lastTs = performance.now()
    rafId = requestAnimationFrame(tick)
  }
}

/**
 * 在 (x, y)（视口 CSS 像素坐标，通常取 event.clientX/Y）绽放一簇烟花。
 */
export function spawnClickFireworks(x: number, y: number): void {
  const ctx = ensureOverlay()
  if (!ctx) {
    return
  }
  for (let i = 0; i < PARTICLE_COUNT; i++) {
    const angle = (Math.PI * 2 * i) / PARTICLE_COUNT + Math.random() * 0.3
    const speed = 120 + Math.random() * 180
    particles.push({
      x,
      y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 60, // 略微上扬，更像绽放
      color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
      life: 1,
      size: 2 + Math.random() * 3,
      gravity: 1,
      shape: 'dot',
      spin: 0,
      angle: 0,
    })
  }
  ensureLoop()
}

/**
 * 在 (x, y) 冒一小簇**缓缓上浮**的星星/爱心（待机特效）。
 *
 * 与烟花的三个区别，每个都是有意的：
 *   · `gravity = 0` —— 只上浮不回落。待机是"安静地冒个泡"，不是"炸一下"
 *   · 数量 3~6 —— 少到不会喧宾夺主
 *   · 淡得更慢（`SPARKLE_LIFE_DECAY`）—— 飘得久一点才像光点，一闪而过像 bug
 *
 * 位置由调用方给（宠物头顶），本模块不认识宠物。
 */
export function spawnIdleSparkles(x: number, y: number): void {
  const ctx = ensureOverlay()
  if (!ctx) {
    return
  }
  const count =
    SPARKLE_COUNT_MIN + Math.floor(Math.random() * (SPARKLE_COUNT_MAX - SPARKLE_COUNT_MIN + 1))
  for (let i = 0; i < count; i++) {
    // 从头顶一小片区域里各自起步，而不是同一个点——同点起步会看出"一束"
    const ox = (Math.random() - 0.5) * 46
    const oy = (Math.random() - 0.5) * 22
    particles.push({
      x: x + ox,
      y: y + oy,
      vx: (Math.random() - 0.5) * 14,
      vy: -(SPARKLE_RISE_MIN + Math.random() * (SPARKLE_RISE_MAX - SPARKLE_RISE_MIN)),
      color: SPARKLE_PALETTE[Math.floor(Math.random() * SPARKLE_PALETTE.length)]!,
      life: 1,
      size: 2.5 + Math.random() * 2.5,
      gravity: 0,
      // 偶尔来一颗爱心，其余是星星：全是同一种形状会显得像噪声
      shape: Math.random() < 0.25 ? 'heart' : 'star',
      spin: (Math.random() - 0.5) * 2.4,
      angle: Math.random() * Math.PI * 2,
    })
  }
  ensureLoop()
}

/** 画一颗粒子（按形状） */
function drawParticle(ctx: CanvasRenderingContext2D, p: Particle): void {
  ctx.fillStyle = p.color
  if (p.shape === 'dot') {
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
    return
  }
  ctx.save()
  ctx.translate(p.x, p.y)
  ctx.rotate(p.angle)
  ctx.beginPath()
  if (p.shape === 'star') {
    // 四角星：外半径与内半径交替 8 个顶点，比五角星更"闪光"
    const outer = p.size * 1.7
    const inner = p.size * 0.45
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? outer : inner
      const a = (Math.PI / 4) * i - Math.PI / 2
      const px = Math.cos(a) * r
      const py = Math.sin(a) * r
      if (i === 0) ctx.moveTo(px, py)
      else ctx.lineTo(px, py)
    }
  } else {
    // 爱心：两段三次贝塞尔，尺寸按 size 缩放
    const s = p.size * 0.9
    ctx.moveTo(0, s * 0.75)
    ctx.bezierCurveTo(-s * 1.6, -s * 0.35, -s * 0.5, -s * 1.5, 0, -s * 0.5)
    ctx.bezierCurveTo(s * 0.5, -s * 1.5, s * 1.6, -s * 0.35, 0, s * 0.75)
  }
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function tick(ts: number): void {
  const ctx = overlayCtx
  const canvas = overlayCanvas
  if (!ctx || !canvas) {
    rafId = null
    return
  }
  const dt = Math.min(0.05, (ts - lastTs) / 1000)
  lastTs = ts

  ctx.clearRect(0, 0, canvas.width, canvas.height)

  let alive = 0
  for (const p of particles) {
    if (p.life <= 0) {
      continue
    }
    p.vy += GRAVITY * p.gravity * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.angle += p.spin * dt
    p.life -= (p.gravity === 0 ? SPARKLE_LIFE_DECAY : LIFE_DECAY) * dt
    if (p.life <= 0) {
      continue
    }
    alive++
    // 上浮那类到后半程才淡，前半程保持亮度（不然一冒出来就像要没了）
    ctx.globalAlpha = Math.max(0, Math.min(1, p.gravity === 0 ? p.life * 1.6 : p.life))
    drawParticle(ctx, p)
  }
  ctx.globalAlpha = 1

  if (alive === 0) {
    // 全部消失：清空并停止循环（保留 canvas 复用，下次触发直接用）
    particles = []
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    rafId = null
    return
  }
  // 剔除死亡粒子，控制数组增长
  if (particles.length > PARTICLE_COUNT * 4) {
    particles = particles.filter((p) => p.life > 0)
  }
  rafId = requestAnimationFrame(tick)
}

/** 清理覆盖层（宠物模式退出时调用，释放 DOM/动画） */
export function disposePetParticles(): void {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
  particles = []
  if (overlayCanvas?.parentNode) {
    overlayCanvas.parentNode.removeChild(overlayCanvas)
  }
  overlayCanvas = null
  overlayCtx = null
}
