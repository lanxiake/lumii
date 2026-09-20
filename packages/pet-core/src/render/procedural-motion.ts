/**
 * procedural-motion — 程序化动画原语（pet-core，零依赖）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §5.2
 *
 * 用途：让**单张静态部件**动起来，无需逐帧美术。这是「AI 出静态部件 + 代码做动画」
 * 路线的基础 —— 生图模型做不出序列帧，但生成一张静态角色图完全可行。
 *
 * 全部为纯函数（眨眼调度器除外，它天生有状态），输入归一化时间 t（秒），
 * 输出变换量。变换**以锚点为原点**施加（脚底中心），锚点应用由渲染层负责 ——
 * 本模块不做任何坐标变换，只产出数值。
 *
 * 约束（务必保持）：本包为纯 TS，禁止 import 任何运行时依赖。
 */

// ---------------------------------------------------------------------------
// 参数与类型
// ---------------------------------------------------------------------------

/**
 * 程序化动画参数。
 *
 * **安全约束**：全部字段只接受有限数值。清单文件里的 `params` 是**数据不是代码**，
 * 一旦允许字符串表达式/函数，等于给宠物系统开了任意代码执行入口 ——
 * 校验由 `validateProceduralParams` 强制，禁止绕过。
 */
export interface ProceduralParams {
  /** 垂直浮动振幅（像素） */
  bob?: number
  /** 呼吸缩放峰值倍率（如 1.02） */
  breathe?: number
  /** 左右摇摆角度（度） */
  sway?: number
  /** 点头角度（度） */
  nod?: number
  /** 眨眼平均间隔（毫秒），0 表示不眨眼 */
  blink?: number
}

/** 原语的合法字段白名单（未知字段一律拒绝，防止夹带） */
const ALLOWED_KEYS = ["bob", "breathe", "sway", "nod", "blink"] as const

/** 缺省值：**缺省即静止**（breathe 的静止值是 1，其余为 0） */
export const PROCEDURAL_DEFAULTS: Required<ProceduralParams> = {
  bob: 0,
  breathe: 1,
  sway: 0,
  nod: 0,
  blink: 0,
}

/** 各原语的默认周期（秒）。周期之间取互质感的比值，避免合拍后显得机械。 */
export const PROCEDURAL_PERIODS = {
  bob: 3.0,
  breathe: 4.0,
  sway: 6.0,
  nod: 2.2,
} as const

/** 眨眼时长固定（毫秒）：单次闭眼时长不随间隔变化 */
export const BLINK_DURATION_MS = 120

/** 眨眼间隔抖动比例：间隔落在 mean×(1±jitter) */
export const BLINK_JITTER = 0.4

/** 合成后的变换量（施加于锚点坐标系） */
export interface ProceduralTransform {
  offsetX: number
  offsetY: number
  /** 均匀缩放（呼吸） */
  scale: number
  /** 旋转角度（度，摇摆 + 点头） */
  rotation: number
  /** 该帧是否应显示闭眼 */
  blinkClosed: boolean
}

// ---------------------------------------------------------------------------
// 校验（安全边界）
// ---------------------------------------------------------------------------

export type ProceduralValidation =
  | { ok: true; params: ProceduralParams }
  | { ok: false; errors: string[] }

/**
 * 校验程序化参数：只接受有限数值，未知字段一律拒绝。
 *
 * 这是「清单是数据不是代码」约束的落点。若这里放宽到接受字符串，
 * 后续解释层就不得不做表达式求值，从而引入任意代码执行面。
 */
export function validateProceduralParams(input: unknown): ProceduralValidation {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: [`params 必须是对象，收到 ${describe(input)}`] }
  }

  const errors: string[] = []
  const params: ProceduralParams = {}

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      errors.push(`未知字段 "${key}"（允许的字段：${ALLOWED_KEYS.join(", ")}）`)
      continue
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(`字段 "${key}" 必须是有限数值，收到 ${describe(value)}`)
      continue
    }
    params[key as keyof ProceduralParams] = value
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, params }
}

/** 供错误信息用的类型描述（不泄露内容，只说明类型） */
function describe(v: unknown): string {
  if (v === null) return "null"
  if (Array.isArray(v)) return "数组"
  if (typeof v === "function") return "函数"
  if (typeof v === "string") return "字符串"
  return typeof v
}

// ---------------------------------------------------------------------------
// 原语
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2

/**
 * 垂直浮动：正弦，t=0 与 t=周期 归零，峰值 = 振幅。
 * 归零保证循环播放时首尾无缝（不会出现跳变）。
 */
export function bobOffset(
  amplitude: number,
  tSec: number,
  periodSec: number = PROCEDURAL_PERIODS.bob,
): number {
  if (amplitude === 0 || periodSec <= 0) return 0
  return amplitude * Math.sin((TAU * tSec) / periodSec)
}

/**
 * 呼吸缩放：t=0 为 1（自静止起步，不突变），峰值达到声明倍率。
 * 用 (1−cos)/2 而非 |sin| —— 前者在 t=0 处导数为 0，起步更自然。
 */
export function breatheScale(
  maxScale: number,
  tSec: number,
  periodSec: number = PROCEDURAL_PERIODS.breathe,
): number {
  if (maxScale === 1 || periodSec <= 0) return 1
  return 1 + (maxScale - 1) * ((1 - Math.cos((TAU * tSec) / periodSec)) / 2)
}

/** 左右摇摆：正弦，正负对称（t 与 t+半周期 反号） */
export function swayAngle(
  amplitudeDeg: number,
  tSec: number,
  periodSec: number = PROCEDURAL_PERIODS.sway,
): number {
  if (amplitudeDeg === 0 || periodSec <= 0) return 0
  return amplitudeDeg * Math.sin((TAU * tSec) / periodSec)
}

/** 点头：与 sway 同形状，周期更快，用于与摇摆叠加 */
export function nodAngle(
  amplitudeDeg: number,
  tSec: number,
  periodSec: number = PROCEDURAL_PERIODS.nod,
): number {
  if (amplitudeDeg === 0 || periodSec <= 0) return 0
  return amplitudeDeg * Math.sin((TAU * tSec) / periodSec)
}

// ---------------------------------------------------------------------------
// 眨眼
// ---------------------------------------------------------------------------

/**
 * 确定性整数哈希 → [0,1)。
 * 用哈希而非 Math.random 是为了让眨眼序列**可复现**：同参数永远得到同一串时刻，
 * 测试与录屏都能稳定重放。
 */
function hash01(i: number): number {
  let x = (i + 0x9e3779b9) >>> 0
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad) >>> 0
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  return x / 4294967296
}

/**
 * 第 i 次眨眼与前一次之间的间隔（毫秒）。
 * 间隔在 mean×(1±jitter) 内随机，并强制 ≥ 2×时长，保证不会「连续两次眨眼」。
 */
function blinkIntervalAt(meanMs: number, i: number, durationMs: number, jitter: number): number {
  const raw = meanMs * (1 + jitter * (2 * hash01(i) - 1))
  return Math.max(raw, 2 * durationMs + 1)
}

/**
 * 生成前 count 次眨眼的起始时刻（毫秒，单调递增）。
 * 纯函数，供测试与调试使用；渲染循环用 `BlinkScheduler`（避免重复累积）。
 */
export function blinkStartTimes(
  meanMs: number,
  count: number,
  durationMs: number = BLINK_DURATION_MS,
  jitter: number = BLINK_JITTER,
): number[] {
  const out: number[] = []
  let t = 0
  for (let i = 0; i < count; i++) {
    t += blinkIntervalAt(meanMs, i, durationMs, jitter)
    out.push(t)
  }
  return out
}

/**
 * 眨眼调度器（渲染循环用）。有状态，但状态只与时间推进有关。
 *
 * 按需向前生成眨眼时刻并推进索引，单次 `update` 摊销 O(1)，
 * 不会随时间线性变慢。时间回退（重播/重置）时自动重建序列。
 */
export class BlinkScheduler {
  private starts: number[] = []
  private idx = 0
  private lastT = Number.NEGATIVE_INFINITY

  constructor(
    private readonly meanMs: number,
    private readonly durationMs: number = BLINK_DURATION_MS,
    private readonly jitter: number = BLINK_JITTER,
  ) {}

  /** @returns 该时刻是否处于闭眼 */
  update(tMs: number): boolean {
    if (this.meanMs <= 0 || this.durationMs <= 0) return false

    // 时间回退：重建序列（重播或模型热切换）
    if (tMs < this.lastT) {
      this.starts = []
      this.idx = 0
    }
    this.lastT = tMs

    this.ensureCovering(tMs)
    const start = this.starts[this.idx]
    if (start === undefined) return false
    return tMs >= start && tMs < start + this.durationMs
  }

  /** 生成足够的起始时刻覆盖 tMs，并把索引推进到当前区间 */
  private ensureCovering(tMs: number): void {
    const horizon = tMs + this.durationMs
    while (this.starts.length === 0 || this.starts[this.starts.length - 1]! < horizon) {
      const i = this.starts.length
      const prev = this.starts[this.starts.length - 1] ?? 0
      this.starts.push(prev + blinkIntervalAt(this.meanMs, i, this.durationMs, this.jitter))
    }
    while (
      this.idx < this.starts.length - 1 &&
      tMs >= this.starts[this.idx]! + this.durationMs
    ) {
      this.idx++
    }
  }
}

// ---------------------------------------------------------------------------
// 合成
// ---------------------------------------------------------------------------

/**
 * 合成全部原语为单个变换量。
 *
 * @param params 校验后的程序化参数（未经校验的输入请先过 validateProceduralParams）
 * @param tSec 归一化时间（秒）
 * @param blink 眨眼调度器；省略时视为不眨眼
 */
export function evaluateProcedural(
  params: ProceduralParams,
  tSec: number,
  blink?: BlinkScheduler,
): ProceduralTransform {
  const bob = params.bob ?? PROCEDURAL_DEFAULTS.bob
  const breathe = params.breathe ?? PROCEDURAL_DEFAULTS.breathe
  const sway = params.sway ?? PROCEDURAL_DEFAULTS.sway
  const nod = params.nod ?? PROCEDURAL_DEFAULTS.nod

  return {
    offsetX: 0,
    offsetY: bobOffset(bob, tSec),
    scale: breatheScale(breathe, tSec),
    rotation: swayAngle(sway, tSec) + nodAngle(nod, tSec),
    blinkClosed: blink ? blink.update(tSec * 1000) : false,
  }
}
