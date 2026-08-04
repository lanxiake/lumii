/**
 * click-fireworks - 宠物点击特效（烟花粒子爆发）
 *
 * 点击宠物身体成功后，在点击位置绽放一簇彩色粒子并自然回落淡出，提供即时视觉反馈。
 * 纯 Canvas 2D 粒子动画，覆盖在透明宠物窗口上（pointer-events:none，不影响穿透/点击）。
 * 无外部依赖、无 React，直接挂到 document.body，动画结束自动清理。
 */

/** 单个粒子 */
interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  color: string
  life: number // 剩余寿命 0~1
  size: number
}

/** 粒子颜色调色板（明亮、适合透明背景） */
const PALETTE = [
  '#ff6b6b',
  '#ffd93d',
  '#6bcB77',
  '#4d96ff',
  '#ff9ff3',
  '#ffa502',
  '#7bed9f',
]

/** 每次爆发的粒子数 */
const PARTICLE_COUNT = 28
/** 重力加速度（px/s²，屏幕坐标向下为正） */
const GRAVITY = 900
/** 寿命衰减速率（/秒），约 1.1s 消失 */
const LIFE_DECAY = 0.9

/** 复用的覆盖层 canvas（懒创建） */
let overlayCanvas: HTMLCanvasElement | null = null
let overlayCtx: CanvasRenderingContext2D | null = null
/** 活跃粒子池（多次点击叠加） */
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
    })
  }
  if (rafId === null) {
    lastTs = performance.now()
    rafId = requestAnimationFrame(tick)
  }
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
    p.vy += GRAVITY * dt
    p.x += p.vx * dt
    p.y += p.vy * dt
    p.life -= LIFE_DECAY * dt
    if (p.life <= 0) {
      continue
    }
    alive++
    ctx.globalAlpha = Math.max(0, p.life)
    ctx.fillStyle = p.color
    ctx.beginPath()
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1

  if (alive === 0) {
    // 全部消失：清空并停止循环（保留 canvas 复用，下次点击直接用）
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
export function disposeClickFireworks(): void {
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
