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
  PERCH_DEFAULTS,
  ceilingY,
  initialPlan,
  planNextActivity,
  shouldLetGo,
  stepClimb,
  stepCrawl,
  stepWalk,
  tryAttach,
  walkBoundsOf,
  wallX,
  type AmbientActivity,
  type AmbientConfig,
  type AmbientPlan,
  type PerchConfig,
  type PerchRect,
  type PerchSide,
  type PerchState,
  type PetPose,
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
  /**
   * 姿态变化（含首次）。上层据此播动作组。
   *
   * 报的是 `PetPose` 而不是 `AmbientActivity`：攀爬不进随机池（它由"附近有没有
   * 可爬的窗口"触发），但**播动作组这件事是同一个入口**，分两条回调会让上层
   * 多维护一份"当前该播什么"的状态。
   */
  onActivity: (pose: PetPose) => void
  /** 决策参数；省略用 `AMBIENT_DEFAULTS` */
  config?: AmbientConfig
  /** 攀附参数；省略用 `PERCH_DEFAULTS` */
  perchConfig?: PerchConfig
  /** 随机源，可注入以便测试确定性 */
  rand?: () => number
}

export class PetWanderDriver {
  private readonly renderer: PetRendererProvider
  private readonly onActivity: (pose: PetPose) => void
  private readonly config: AmbientConfig
  private readonly perchConfig: PerchConfig
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
   * 攀附状态。非 null 时**位置权威归攀爬**，`activity` 被冻结（回来时从 stand 重新计时）。
   *
   * 与 `activity` 分开存而不是塞进 `AmbientActivity`：攀爬有它自己的运动学
   * （沿墙/沿天花板），把"活动"这个枚举撑大只会让每个 switch 都多两个分支。
   */
  private perch: PerchState = null
  /** 可攀附的目标矩形（主进程推来）；null = 当前没有可爬的东西 */
  private perchRect: PerchRect | null = null
  /** 模型在屏幕上的高度，用来算攀爬时与墙的缝隙 */
  private modelHeight = 0

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
    this.perchConfig = opts.perchConfig ?? PERCH_DEFAULTS
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

  /** 当前是否攀在窗口上；非 null 时 `getActivity()` 是被冻结的值 */
  getPerch(): PerchState {
    return this.perch
  }

  /** 当前朝向（测试与诊断用） */
  getFacing(): -1 | 1 {
    return this.facing
  }

  /**
   * 推送可攀附的目标矩形（主进程 → 渲染层 → 这里）。
   *
   * 除了记下来，还负责一件事：**目标没了就地松手**。窗口被隐藏、最小化、拖走时
   * 都会走到这里，宠物必须掉下来——留在原地会显得它悬在空中。
   */
  setPerchRect(rect: PerchRect | null): void {
    this.perchRect = rect
    if (!this.perch) return
    if (shouldLetGo(this.perch, rect, this.x, this.y, this.perchConfig, this.minPerchHeight())) {
      this.releasePerch('目标不可用')
    }
  }

  /** 从渲染器读一次布局（缩放/锚点/模型高度）。攀爬的缝隙与判定高度都依赖它 */
  private refreshLayout(): void {
    const layout = this.renderer.getLayout?.()
    if (layout && layout.scale > 0) this.modelHeight = layout.modelHeight
  }

  start(): void {
    if (this.started) return
    this.started = true

    // 位置从渲染器读一次作为起点——宠物可能已经被拖到别处，不该被拽回原点
    const pos = this.renderer.getPosition()
    this.x = pos.x
    this.y = pos.y
    this.refreshLayout()
    // 拖拽没有边界检查，宠物可能停在屏幕外（实测 y=-21589）；不夹的话
    // 这条"地面线"就在视口之外，宠物再也看不见
    this.clampPosition()
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
    this.refreshLayout()
    this.clampPosition()
    this.lastMs = performance.now()
    this.resetToStand()
    log.info(`[resume] 恢复（${reason}）位置 (${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
    // 用户可能刚把宠物**放在**窗口边缘上——这是最自然的攀爬入口，不能等他走过去
    this.tryAttachNow()
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

  /** 攀附的判定高度：模型屏幕高度的一半。太扁的窗口爬上去立刻到顶，没有意义 */
  private minPerchHeight(): number {
    return Math.max(120, this.modelHeight * 0.5)
  }

  /**
   * 把位置夹回视口内。
   *
   * **踩过**：拖拽的 `setPosition` 没有任何边界检查，宠物可以被拖到屏幕外——
   * 实测到了 `y = -21589`。而驱动把"读到的位置"当成宠物的**地面线**，
   * 于是它从此在屏幕外两万像素的地方"站着"，再也看不见。
   *
   * 只夹不校正语义：夹完仍把结果当那条地面线，只是保证它在可见范围内。
   */
  private clampPosition(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.x = Math.min(Math.max(this.x, 0), w)
    this.y = Math.min(Math.max(this.y, 16), h - 8)
  }

  /**
   * 立刻检查一次该不该吸附。
   *
   * 两个调用点：走路途中（每步之后）、**拖拽松手时**。
   * 后者是补上的——参考项目里"松手时若在边缘 50px 内就吸附"是最自然的攀爬入口
   * （用户把宠物拎到窗口边上，本来就带着"放这儿"的意图），
   * 只在走路时检查的话，那个动作完全没反应（实测被用户这么试了好几轮）。
   */
  private tryAttachNow(): void {
    if (this.perch || this.holds.size > 0) return
    const side = tryAttach(this.x, this.y, this.perchRect, this.perchConfig, this.minPerchHeight())
    if (side) this.attachPerch(side)
  }

  /**
   * 攀爬时要不要翻转。
   *
   * 素材面朝右，而爬墙时宠物是**面朝墙**的：爬左墙（宠物在墙左侧、朝右）不翻转，
   * 爬右墙才翻转。天花板沿用的是"从哪面墙上来的"同一个朝向，一路保持一致。
   */
  private flipForPerch(side: PerchSide): boolean {
    return side === 'right'
  }

  /**
   * 吸附到窗口边缘。
   *
   * 位置立刻贴到墙线上（对齐 `wallX`），不等下一步积分——差一帧会看到宠物
   * "先飘到墙边、再开始爬"。
   */
  private attachPerch(side: PerchSide): void {
    const rect = this.perchRect
    if (!rect) return
    this.perch = { kind: 'wall', side }
    this.x = wallX(rect, side, this.perchConfig, this.modelHeight)
    this.facing = side === 'left' ? 1 : -1
    this.renderer.setPosition(this.x, this.y)
    this.renderer.setFlip?.(this.flipForPerch(side))
    log.info(`[perch] 吸附到${side === 'left' ? '左' : '右'}墙 x=${this.x.toFixed(0)}`)
    this.onActivity('climb')
  }

  /** 松手：从墙上/天花板上掉回地面，位置权威交还给常规活动 */
  private releasePerch(reason: string): void {
    if (!this.perch) return
    log.info(`[perch] 松手（${reason}）@(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
    this.perch = null
    this.resetToStand()
  }

  /**
   * 攀爬的一步。
   *
   * 两段：沿墙向上（`wall`）→ 到顶转沿上边缘横爬（`ceiling`）→ 爬到另一角掉落。
   * **到顶不折返**：折返会让宠物永远赖在窗口上，而"爬到头掉下来"是更有生命感的收尾。
   *
   * 掉落只改状态、不做自由落体——`y` 保持在天花板线上会悬空，所以这里把 `perch`
   * 清掉后**顺手把 y 交还给常规活动**（下次走路时它仍在那条 y 上，视觉上就是
   * "从窗口边缘掉到那儿站着"）。真正的抛物线留给用户的投掷，不在这里造。
   */
  private stepPerch(dtSec: number): void {
    const rect = this.perchRect
    if (!this.perch || !rect) return

    if (this.perch.kind === 'wall') {
      const r = stepClimb(this.y, rect, dtSec, this.perchConfig, this.modelHeight)
      this.y = r.y
      this.x = wallX(rect, this.perch.side, this.perchConfig, this.modelHeight)
      this.renderer.setPosition(this.x, this.y)
      if (r.reachedTop) {
        // 到顶：转成沿上边缘爬，从哪面墙上来的就往对面爬
        this.perch = { kind: 'ceiling', side: this.perch.side }
        log.info(`[perch] 爬到顶，转为沿窗口上边缘爬行`)
        this.onActivity('crawl')
      }
      return
    }

    const r = stepCrawl(this.x, rect, this.perch.side, dtSec, this.perchConfig)
    this.x = r.x
    this.y = ceilingY(rect, this.perchConfig, this.modelHeight)
    this.renderer.setPosition(this.x, this.y)
    if (r.reachedEnd) this.releasePerch('爬到尽头')
  }

  private tick = (now: number): void => {
    if (!this.started) return
    const dtMs = Math.min(MAX_FRAME_MS, Math.max(0, now - this.lastMs))
    this.lastMs = now

    if (this.holds.size === 0) {
      if (this.perch) {
        // 攀爬期间**冻结活动计时**：回到地面时从 stand 重新起算，
        // 而不是把墙上耗掉的时间算进"这一轮待机还剩多久"
        this.stepPerch(dtMs / 1000)
      } else {
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
    this.modelHeight = layout.modelHeight

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

    // 走到主窗口边缘就爬上去。放在**最后**：先按正常步进移动，再判断这一步是否
    // 踏进了吸附区——反过来的话宠物会在判定区外就贴上去，看起来是隔空吸。
    // （`tryAttachNow` 里还有"已攀附/正在让位就不重复判"的守卫）
    this.tryAttachNow()
  }
}
