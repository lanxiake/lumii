/**
 * PetWanderDriver — 空闲时的自主活动驱动
 *
 * 把 pet-core 的 `ambient`（决策）与 `locomotion`（运动）接到渲染器上：
 * 每帧推进活动计时，走路时积分位置、撞墙折返，活动切换时通知上层播对应动作组。
 *
 * ## 三条边界
 *
 * 1. **位置权威是排他的**。同一时刻只能有一个东西在写宠物位置：鼠标（拖拽中）、
 *    抛物线积分（抛出后）、本驱动（落地静止）。三者靠 `suspend()`/`resume()` 互斥，
 *    不是"各自算各自的"——那样两个写者会互相覆盖，表现为宠物一边走一边被拽回去。
 *
 * 2. **不碰垂直方向**。地面线就是宠物**当前所在的 y**，只有拖拽与抛物线能改它。
 *    这与 `throw-physics` 的 `ThrowBounds.groundY` 是同一条语义：桌宠站在它的"桌面"上，
 *    用屏幕底部当地面会让它落到一个从没待过的地方。
 *
 * 3. **动作播放权不在这里**。驱动只把「现在该走/该坐/该站」报上去
 *    （`onActivity`），由编排器决定播哪个组、要不要让位给对话。渲染器那边
 *    `playMotion` 是单一入口，两个写者会互相打断。
 *
 * ## 为什么是独立的 requestAnimationFrame 而不是挂在 PIXI ticker 上
 *
 * 渲染器的 ticker 会被 `setFpsCap(15)` 降频（失焦时），但**行为的时间基准不该跟着变**：
 * 降频的目的是省 GPU，不是让宠物走得慢一点或决策变迟钝。位置更新本来也不依赖渲染帧率。
 */

import {
  AMBIENT_DEFAULTS,
  initialPlan,
  planNextActivity,
  stepWalk,
  walkBoundsOf,
  type AmbientActivity,
  type AmbientConfig,
  type AmbientPlan,
} from '@mtbot/pet-core'
import type { PetRendererProvider } from '../renderer/types'

const log = {
  info: (...args: unknown[]) => console.log('[PetWander]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetWander]', ...args),
}

/**
 * 单帧时间上限（毫秒）。
 *
 * 与 `stepWalk` 内部的 50ms 上限是两道独立的闸：那一道保护位置积分，
 * 这一道保护**计时**——窗口最小化几分钟后恢复，`elapsedMs` 会一口气跨过好几个活动时长，
 * 于是宠物瞬间连切好几个姿势。夹住之后最多只切一次。
 */
const MAX_FRAME_MS = 100

export interface PetWanderOptions {
  renderer: PetRendererProvider
  /** 活动变化（含首次）。上层据此播动作组 */
  onActivity: (activity: AmbientActivity) => void
  /** 决策参数；省略用 `AMBIENT_DEFAULTS` */
  config?: AmbientConfig
  /** 随机源，可注入以便测试确定性 */
  rand?: () => number
}

export class PetWanderDriver {
  private readonly renderer: PetRendererProvider
  private readonly onActivity: (activity: AmbientActivity) => void
  private readonly config: AmbientConfig
  private readonly rand: () => number

  private rafId: number | null = null
  private lastMs = 0
  /** 当前活动与它的计划 */
  private activity: AmbientActivity = 'stand'
  private plan: AmbientPlan
  /** 当前活动已持续毫秒 */
  private elapsedMs = 0

  /** 位置权威：本驱动只在未挂起时写它 */
  private x = 0
  private y = 0
  /** 朝向：-1 左 / +1 右。素材面朝右，故 facing=-1 时才翻转 */
  private facing: -1 | 1 = 1

  /**
   * 让位来源集合（**不是计数器**）。
   *
   * 起初用的是计数，实测立刻泄漏：`mousedown` 记一次 `suspend('drag')`，
   * 而 `mouseup` 的点击分支改记 `suspend('tap')` 并在 2.5 秒后解除自己——
   * 两次 reason 不同，第一次再也无人解除，**每点一下泄漏一个**，
   * 两次点击后宠物永久卡在"让位"状态（日志：`仍有 4 个让位方未解除`）。
   *
   * 换成按 reason 记账后，同一个来源重复让位只算一次、重复解除是无害的，
   * 调用方不必再小心翼翼地配对。代价是**同一件事必须用同一个 reason**。
   */
  private readonly holds = new Set<string>()
  private started = false

  constructor(opts: PetWanderOptions) {
    this.renderer = opts.renderer
    this.onActivity = opts.onActivity
    this.config = opts.config ?? AMBIENT_DEFAULTS
    this.rand = opts.rand ?? Math.random
    // 首次一定是站着（见 ambient.initialPlan）：进宠物模式第一帧就走起来很突兀
    this.plan = initialPlan(this.rand, this.config)
    this.activity = this.plan.activity
  }

  /** 是否在跑（挂起中也算"跑着"，只是不推进） */
  isRunning(): boolean {
    return this.started
  }

  getActivity(): AmbientActivity {
    return this.activity
  }

  /** 当前朝向（测试与诊断用） */
  getFacing(): -1 | 1 {
    return this.facing
  }

  start(): void {
    if (this.started) return
    this.started = true

    // 位置从渲染器读一次作为起点——宠物可能已经被拖到别处，不该被拽回原点
    const pos = this.renderer.getPosition()
    this.x = pos.x
    this.y = pos.y
    // y 从此不再由本驱动修改（见头部第 2 条）
    log.info(
      `[start] 起点 (${this.x.toFixed(0)}, ${this.y.toFixed(0)})，首个活动=${this.activity} 持续 ${Math.round(this.plan.durationMs)}ms`,
    )
    this.onActivity(this.activity)

    this.lastMs = performance.now()
    this.rafId = requestAnimationFrame(this.tick)
  }

  stop(): void {
    this.started = false
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /**
   * 让位：拖拽 / 抛掷 / 对话进行中。
   *
   * 同一个 reason 重复调用是**无害的**（已在让位中就什么都不做），
   * 所以调用方不需要小心翼翼地和 `resume` 配对。
   *
   * **会重置成"站着"重新计时**：被拎起来的宠物放下后不该接着走没走完的那一段，
   * 那会让"松手就往前冲"看起来像惯性。
   */
  suspend(reason: string): void {
    if (this.holds.has(reason)) {
      log.info(`[suspend] "${reason}" 已在让位中，忽略重复调用`)
      return
    }
    const first = this.holds.size === 0
    this.holds.add(reason)
    if (first) {
      this.resetToStand()
      log.info(`[suspend] 让位开始（${reason}）`)
    } else {
      log.info(`[suspend] 追加让位（${reason}），当前 ${this.holds.size} 个`)
    }
  }

  /** 解除某个来源的让位；全部解除后才恢复自主活动 */
  resume(reason: string): void {
    if (!this.holds.delete(reason)) {
      // 没记过这个 reason：多半是调用方用了不同的名字。**打日志**——
      // 这正是"计数泄漏"那次事故的形态，静默忽略会让它再次隐身
      log.warn(`[resume] "${reason}" 没有对应的让位记录（现有：${[...this.holds].join(',') || '无'}）`)
      return
    }
    if (this.holds.size > 0) {
      log.info(`[resume] 解除（${reason}），仍有 ${this.holds.size} 个让位方`)
      return
    }
    // 期间位置可能被拖拽/抛物线改过，重新对齐
    const pos = this.renderer.getPosition()
    this.x = pos.x
    this.y = pos.y
    this.lastMs = performance.now()
    this.resetToStand()
    log.info(`[resume] 恢复（${reason}）位置 (${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
  }

  isSuspended(): boolean {
    return this.holds.size > 0
  }

  /** 某个来源当前是否在让位（开关类调用方据此避免"解除一个从没记过的 reason"） */
  isHeldBy(reason: string): boolean {
    return this.holds.has(reason)
  }

  /** 回到站立并重新计时；suspend/resume 与活动切换都走它，保证状态一致 */
  private resetToStand(): void {
    this.activity = 'stand'
    this.plan = initialPlan(this.rand, this.config)
    this.elapsedMs = 0
    this.onActivity(this.activity)
  }

  private tick = (now: number): void => {
    if (!this.started) return
    const dtMs = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastMs))
    this.lastMs = now

    if (this.holds.size === 0) {
      this.elapsedMs += dtMs
      this.stepPosition(dtMs / 1000)

      if (this.elapsedMs >= this.plan.durationMs) {
        const prev = this.activity
        this.plan = planNextActivity(this.rand, this.config)
        this.activity = this.plan.activity
        this.elapsedMs = 0
        log.info(
          `[tick] ${prev} → ${this.activity}，持续 ${Math.round(this.plan.durationMs)}ms`,
        )
        this.onActivity(this.activity)
      }
    }

    this.rafId = requestAnimationFrame(this.tick)
  }

  /** 只有 walk 会改位置；其余活动原地不动（但朝向保留） */
  private stepPosition(dtSec: number): void {
    if (this.activity !== 'walk') return

    const layout = this.renderer.getLayout?.()
    if (!layout || !(layout.scale > 0)) {
      // 模型还没加载完 / 后端不支持布局查询：这一步跳过，下一个 tick 再试。
      // **不 warn**——加载期与切后端时会短暂出现，刷日志没有信息量。
      return
    }

    const bounds = walkBoundsOf(window.innerWidth, layout.anchorX, layout.scale)
    const r = stepWalk({ x: this.x, facing: this.facing }, dtSec, this.config.walkSpeed, bounds)

    this.x = r.x
    if (r.facing !== this.facing) {
      this.facing = r.facing
      // 素材面朝右：朝左时才翻转
      this.renderer.setFlip?.(this.facing < 0)
      log.info(`[stepPosition] 撞边界折返 → facing=${this.facing}`)
    }
    this.renderer.setPosition(this.x, this.y)
  }
}
