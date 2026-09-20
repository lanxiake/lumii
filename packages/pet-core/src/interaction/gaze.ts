/**
 * gaze — 注视换算（pet-core，零依赖）
 *
 * 设计依据：docs/plans/客户端UI/2026-09-20-宠物自制系统P2-b实施计划.md §3.4
 *
 * 把「光标相对宠物」换算成**倾斜 + 位移**。纯函数，可脱开 DOM 单测。
 *
 * 两个参数不是拍的：
 * - **死区**：光标贴到宠物身上时不做任何偏移。没有它，鼠标在角色身上划过去，
 *   宠物会抽搐——那是"被戳"而不是"在看"。
 * - **上限**：桌宠是陪衬，「死死盯着你」会让人不适。默认尺寸约 110px 高时，
 *   6° 在头部（半径约 40px）上约 4px 位移，肉眼刚好看出"它在看我"，再大就成"瞪"了。
 *
 * 与程序化原语的关系：呼吸/浮动是**振荡**（时间驱动），注视是**朝向**（位置驱动），
 * 两者性质不同，不能混进同一套参数；渲染层把它们叠起来用。
 */

export interface GazeInput {
  /** 光标相对宠物锚点的水平偏移（像素，右为正） */
  dx: number
  /** 光标相对宠物锚点的垂直偏移（像素，下为正） */
  dy: number
  /** 宠物可视高度（像素）——把像素偏移归一化，让大小不同的模型表现一致 */
  petHeight: number
}

export interface GazeOutput {
  /** 倾斜角度（度，顺时针为正） */
  tiltDeg: number
  /** 水平位移（画布像素） */
  shiftX: number
  /** 垂直位移（画布像素） */
  shiftY: number
}

export interface GazeOptions {
  /** 死区半径，以宠物高度的比例表示；默认 0.25 */
  deadZoneRatio?: number
  /**
   * 达到满响应的距离，以宠物高度的比例表示；默认 0.8。
   *
   * **这个值实测调过一次**：初版取 2.5，结果光标离宠物 88px（归一化距离 0.65）时
   * `t ≈ 0.08`，倾斜 0.14°、眼睛位移 0.05px——用户看到的就是「完全没反应」。
   * 满量程定得太远等于把响应压没：桌宠周围一两个身位内才是光标最常待的地方，
   * 0.8 倍宠高（约一个身位）到满响应，手感才成立。
   */
  fullRangeRatio?: number
  /** 最大倾斜角度（度）；默认 6 */
  maxTiltDeg?: number
  /** 最大位移，以宠物高度的比例表示；默认 0.04 */
  maxShiftRatio?: number
}

export const GAZE_DEFAULTS: Required<GazeOptions> = {
  deadZoneRatio: 0.25,
  fullRangeRatio: 0.8,
  maxTiltDeg: 6,
  maxShiftRatio: 0.04,
}

/** 零输出常量：死区内外、非法输入都返回它 */
export const GAZE_ZERO: GazeOutput = { tiltDeg: 0, shiftX: 0, shiftY: 0 }

/** 取有限数：`undefined` 与 NaN/Infinity 一律退化为 fallback */
const finite = (v: number | undefined, fallback = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * 计算注视偏移。
 *
 * 极坐标映射：**方向**取光标的单位向量，**大小**取距离（先扣死区、再按满量程夹住）。
 * 距离用 smoothstep 过渡，避免在死区边界上"啪"地跳一下。
 *
 * 非有限输入一律返回零——NaN 旋转会让角色直接消失，而且极难反查。
 */
export function gazeOffset(input: GazeInput, options: GazeOptions = {}): GazeOutput {
  // 默认值只在 GAZE_DEFAULTS 里写一遍：`??` 只管得住 undefined，NaN 得靠 finite 的兜底，
  // 两处各写一个字面量就会漏掉兜底那份——fullRangeRatio 从 2.5 改成 0.8 时就这么漏过一次。
  const deadZoneRatio = Math.max(0, finite(options.deadZoneRatio, GAZE_DEFAULTS.deadZoneRatio))
  const fullRangeRatio = Math.max(
    deadZoneRatio + 1e-6,
    finite(options.fullRangeRatio, GAZE_DEFAULTS.fullRangeRatio),
  )
  const maxTiltDeg = Math.max(0, finite(options.maxTiltDeg, GAZE_DEFAULTS.maxTiltDeg))
  const maxShiftRatio = Math.max(0, finite(options.maxShiftRatio, GAZE_DEFAULTS.maxShiftRatio))

  const petHeight = finite(input.petHeight)
  const dx = finite(input.dx)
  const dy = finite(input.dy)

  // 宠物高度未知（模型还没加载）时不动：没有归一化基准，任何偏移都是瞎猜
  if (petHeight <= 0) return { ...GAZE_ZERO }

  const dist = Math.hypot(dx, dy)
  const dead = petHeight * deadZoneRatio
  if (dist <= dead) return { ...GAZE_ZERO }

  const full = petHeight * fullRangeRatio
  const t0 = clamp01((dist - dead) / (full - dead))
  // smoothstep：起步与到顶都平缓，中段灵敏
  const t = t0 * t0 * (3 - 2 * t0)

  const ux = dx / dist
  const uy = dy / dist
  const maxShift = petHeight * maxShiftRatio

  return {
    tiltDeg: maxTiltDeg * t * ux,
    shiftX: maxShift * t * ux,
    shiftY: maxShift * t * uy,
  }
}
