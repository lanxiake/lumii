/**
 * throw-physics — 抓取/投掷的物理与速度估计（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 场景 A「抓取—拖拽—投掷—落地」的数学部分。放 pet-core 而不是画布里，
 * 理由是纯函数能脱开浏览器单测——与帧归一化当初放进来的同一个理由。
 *
 * **驱动留在客户端**：谁在什么时候开始积分、落地后通知谁，是编排的事；
 * 这里只回答「经过 dt 之后物体在哪、有没有落地」。
 */

export interface ThrowBody {
  x: number
  y: number
  /** 水平速度（像素/秒） */
  vx: number
  /** 垂直速度（像素/秒，向下为正） */
  vy: number
}

export interface ThrowBounds {
  minX: number
  maxX: number
  /**
   * 地面高度（y 向下为正，`y >= groundY` 即落地）。
   *
   * 取**拖拽开始时宠物所在的高度**，不是屏幕底部——桌宠站在它的"桌面"上，
   * 用屏幕底部当地面会让它落到一个从没待过的地方，用户看到的就是「掉出屏幕了」。
   */
  groundY: number
}

export interface ThrowStepOptions {
  /** 重力加速度（像素/秒²）；默认 2400（比真实重力夸张，桌宠要"脆"一点才好玩） */
  gravity?: number
  /** 撞左右边界的能量保留比例；默认 0.55 */
  restitution?: number
}

export interface ThrowStepResult {
  body: ThrowBody
  /** 本步是否落地（落地后速度归零，调用方应停止积分） */
  landed: boolean
  /** 本步是否撞了左右边界 */
  bouncedX: boolean
}

const DEFAULT_GRAVITY = 2400
const DEFAULT_RESTITUTION = 0.55

/** 非有限数一律归零：物理量漏出 NaN 会让宠物直接消失在屏幕上，且极难反查 */
const finite = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback)

/**
 * 推进一个时间步。
 *
 * 用**半隐式欧拉**（先更新速度再更新位置）：显式欧拉在重力下会随步长累积能量，
 * 表现为宠物越弹越高。半隐式稳定得多，且和浏览器 rAF 的不均匀步长配合良好。
 */
export function stepThrow(
  body: ThrowBody,
  dtSec: number,
  bounds: ThrowBounds,
  options: ThrowStepOptions = {},
): ThrowStepResult {
  const gravity = finite(options.gravity ?? DEFAULT_GRAVITY, DEFAULT_GRAVITY)
  const restitution = clamp01(finite(options.restitution ?? DEFAULT_RESTITUTION, DEFAULT_RESTITUTION))

  // **先净化再判 dt**：早退路径若直接返回原始 body，NaN 会原样漏出去——
  // 不变量用例抓过这个（dt=NaN 时 finite(NaN)→0 走了早退分支，返回了带 NaN 的 body）。
  let { x, y, vx, vy } = body
  x = finite(x)
  y = finite(y)
  vx = finite(vx)
  vy = finite(vy)

  const dt = finite(dtSec)

  // 步长为 0 或负数时原样返回（换帧、页面切回来时 dt 可能是 0 甚至负）
  if (dt <= 0) return { body: { x, y, vx, vy }, landed: false, bouncedX: false }

  vy += gravity * dt
  x += vx * dt
  y += vy * dt

  let bouncedX = false
  if (x < bounds.minX) {
    x = bounds.minX
    vx = Math.abs(vx) * restitution
    bouncedX = true
  } else if (x > bounds.maxX) {
    x = bounds.maxX
    vx = -Math.abs(vx) * restitution
    bouncedX = true
  }

  if (y >= bounds.groundY) {
    // 落地即停：不模拟二次弹跳。桌宠"啪"一下停住比蹦跶两下更像被放下
    return { body: { x, y: bounds.groundY, vx: 0, vy: 0 }, landed: true, bouncedX }
  }

  return { body: { x, y, vx, vy }, landed: false, bouncedX }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

// ---------------------------------------------------------------------------
// 速度估计
// ---------------------------------------------------------------------------

/** 一次拖拽采样：位置 + 时间戳（毫秒） */
export interface DragSample {
  x: number
  y: number
  t: number
}

export interface Velocity {
  vx: number
  vy: number
}

/** 默认时间窗（毫秒）。太短受抖动支配，太长会把「先慢后快」抹平 */
export const DEFAULT_VELOCITY_WINDOW_MS = 100

/**
 * 用时间窗内的**首尾位移**估计释放速度（像素/秒）。
 *
 * 为什么不用最后两个采样点：鼠标事件间隔不均（快甩十几毫秒一个、慢拖上百毫秒一个），
 * 只看最后两点，一次抖动就能把速度估到天上或归零。取一个窗口的首尾，等于对窗口内的
 * 抖动做了一次平均。
 *
 * 采样不足两点、或时间差非正时返回零速度——调用方据此退化为「原地落下」，
 * 比猜一个速度安全。
 */
export function estimateVelocity(
  samples: readonly DragSample[],
  windowMs: number = DEFAULT_VELOCITY_WINDOW_MS,
): Velocity {
  if (samples.length < 2) return { vx: 0, vy: 0 }

  const last = samples[samples.length - 1]
  const lastT = finite(last.t)
  const cutoff = lastT - Math.max(1, finite(windowMs, DEFAULT_VELOCITY_WINDOW_MS))

  // 窗口内第一个采样点；一个都没有（采样密度过低）时退回用最早的那个
  let first = samples[0]
  for (let i = samples.length - 1; i >= 0; i--) {
    if (finite(samples[i].t) < cutoff) break
    first = samples[i]
  }

  const dtMs = lastT - finite(first.t)
  if (dtMs <= 0) return { vx: 0, vy: 0 }

  const dtSec = dtMs / 1000
  return {
    vx: finite((finite(last.x) - finite(first.x)) / dtSec),
    vy: finite((finite(last.y) - finite(first.y)) / dtSec),
  }
}

/**
 * 速度是否够得上「抛出」。
 *
 * 低于阈值时退化为原地落下：慢拖之后松手，宠物应该原地待着，
 * 而不是因为几像素的抖动被甩出去。
 */
export function isThrowable(v: Velocity, minSpeedPxPerSec = 320): boolean {
  const speed = Math.hypot(finite(v.vx), finite(v.vy))
  return speed >= Math.max(0, finite(minSpeedPxPerSec, 320))
}
