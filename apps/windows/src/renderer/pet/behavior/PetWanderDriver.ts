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
  screenWallX,
  shouldLetGo,
  stepClimb,
  stepCrawl,
  stepThrow,
  stepWalk,
  tryAttach,
  tryAttachScreen,
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
  type ThrowBody,
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
  /**
   * 攀附参数。**不是 readonly**：素材实测的留白比例（`layout.perchGaps`）会覆盖
   * 兜底值，见 `refreshLayout`。
   */
  private perchConfig: PerchConfig
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
   * 吸附前站的那条地面线。**掉下来要回到这里**，不是停在半空。
   *
   * 从窗口上沿松手时宠物在 `y ≈ 窗口上沿`，而它原来的地面线可能低一千多像素。
   * 不落回去的话它会悬在窗口边上的空中，并在那条看不见的地面线上走来走去——
   * 实测第一次跑通攀爬就是这个结果（`松手（爬到尽头）@(1980, 208)`，
   * 而它原本站在 `y = 1352`）。
   */
  private groundY = 0
  /** 坠落中的物体；非 null 时位置权威归它（与攀爬、拖拽三者互斥） */
  private falling: ThrowBody | null = null
  /**
   * 当前贴的是**屏幕边缘**（true）还是**主窗口**（false）。
   *
   * 两者的墙线公式方向相反——爬窗口时宠物在窗口**外面**，爬屏幕时它在屏幕**里面**。
   * 所以这一步必须记住，不能靠"现在的坐标离谁近"反推（宠物贴上去之后离两边都近）。
   */
  private perchOnScreen = false

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
    // 屏幕攀附不受主窗口影响——主窗口藏了、最小化了，宠物照样能爬屏幕边
    if (!this.perch || this.perchOnScreen) return
    if (this.shouldReleasePerch()) this.releasePerch('目标不可用')
  }

  /** 从渲染器读一次布局（缩放/锚点/模型高度）。攀爬的缝隙与判定高度都依赖它 */
  private refreshLayout(): void {
    const layout = this.renderer.getLayout?.()
    if (!layout || !(layout.scale > 0)) return
    this.modelHeight = layout.modelHeight
    // **素材实测的留白比例优先于兜底值**：每只宠物都不一样（实测五只 Shimeji 猫的
    // CLIMB 侧向留白 49~57px），用统一常量最坏差 6px、乘缩放就是屏幕上看得见的偏移。
    // 比例由切图工具量出来写进清单，这里只是把它接上。
    if (layout.perchGaps) {
      this.perchConfig = {
        ...this.perchConfig,
        wallGapRatio: layout.perchGaps.wall,
        ceilingGapRatio: layout.perchGaps.ceiling,
      }
    }
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

    // 先核对"还贴不贴在墙上"——用户可能正是在宠物爬着的时候把它拎走了。
    // 这一段必须在 `resetToStand` 之前：还在墙上时回到站立，宠物会在墙上播待机动画。
    if (this.perch) {
      const perch = this.perch
      if (this.revalidatePerch()) {
        log.info(`[resume] 恢复（${reason}）仍在墙上 @(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
        // 攀爬姿态要**重新报一次**：让位期间它已经被 Picked 之类的动作组顶掉了
        this.onActivity(perch.kind === 'wall' ? 'climb' : 'crawl')
      }
      // 判定脱离时已进入下落，落完自己会回站立。两条路都不走下面的"回站立"
      return
    }

    // 半空中被抓住又放下：接着往下掉，别站在空气里
    if (this.falling) {
      log.info(`[resume] 恢复（${reason}）继续坠落 @(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
      this.onActivity('fall')
      return
    }

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
  /**
   * 立刻检查一次该不该吸附。
   *
   * 两个调用点：走路途中（每步之后）、**拖拽松手时**。
   * 后者是补上的——参考项目里"松手时若在边缘 50px 内就吸附"是最自然的攀爬入口
   * （用户把宠物拎到窗口边上，本来就带着"放这儿"的意图），
   * 只在走路时检查的话，那个动作完全没反应（实测被用户这么试了好几轮）。
   *
   * **判定失败时不打日志**：这个方法每次 `resume`、几乎每一步走路都会跑，
   * 打了会淹没真正有用的信息。排查"为什么不吸"时临时在这里把 `perchRect`
   * 与 `minPerchHeight()` 打出来即可——**静默失败是这条链路最难查的形态**，
   * 上一轮整整一段排查就卡在"没日志所以看起来像没被调用"。
   */
  private tryAttachNow(): void {
    if (this.perch || this.falling || this.holds.size > 0) return
    const minH = this.minPerchHeight()
    // **主窗口优先**：用户把宠物拎到窗口边上，那个意图比"它正好走到屏幕边"明确得多。
    // 两者同时成立只发生在主窗口贴着屏幕边的时候，那时贴窗口看起来才对
    // （贴屏幕的话宠物会跑到窗口的另一侧去）。
    const onWindow = tryAttach(this.x, this.y, this.perchRect, this.perchConfig, minH)
    if (onWindow) {
      this.attachPerch(onWindow, false)
      return
    }
    const onScreen = tryAttachScreen(this.x, this.y, this.viewport(), this.perchConfig, minH)
    if (onScreen) this.attachPerch(onScreen, true)
  }

  /** 视口尺寸。宠物窗口是全屏透明窗口，所以视口 == 屏幕 */
  private viewport(): { width: number; height: number } {
    return { width: window.innerWidth, height: window.innerHeight }
  }

  /**
   * 当前该贴的墙线 x。
   *
   * 两种目标的公式**方向相反**（爬窗口时宠物在窗口外侧，爬屏幕时在屏幕内侧），
   * 分派在这里。**并且夹进视口**——主窗口贴着屏幕边时 `wallX` 会算出屏幕外的
   * 坐标，宠物于是爬到看不见的地方去；参考项目对这种情形是每帧 `coerceIn`。
   */
  private perchWallX(side: PerchSide): number {
    const raw = this.perchOnScreen
      ? screenWallX(this.viewport(), side, this.perchConfig, this.modelHeight)
      : this.perchRect
        ? wallX(this.perchRect, side, this.perchConfig, this.modelHeight)
        : this.x
    return Math.min(Math.max(raw, 0), window.innerWidth)
  }

  /** 当前该贴的天花板线 y。屏幕时窗口上沿就是 y=0 */
  private perchCeilingY(): number {
    const rect = this.perchTargetRect()
    if (!rect) return this.y
    return ceilingY(rect, this.perchConfig, this.modelHeight)
  }

  /**
   * 是否该松手。
   *
   * 屏幕那条路不走 `shouldLetGo`——它按"锚点在矩形外侧"算目标线，而爬屏幕时
   * 宠物在**内侧**，两边会差出两个缝隙，刚吸附就会被判成"已脱离"。
   */
  private shouldReleasePerch(): boolean {
    if (!this.perch) return false
    if (this.perchOnScreen) {
      const vp = this.viewport()
      if (vp.height < this.minPerchHeight()) return true
      const target = this.perch.kind === 'wall' ? this.perchWallX(this.perch.side) : this.perchCeilingY()
      const at = this.perch.kind === 'wall' ? this.x : this.y
      return Math.abs(at - target) > this.perchConfig.attachDistance * 4
    }
    return shouldLetGo(
      this.perch,
      this.perchRect,
      this.x,
      this.y,
      this.perchConfig,
      this.minPerchHeight(),
      this.modelHeight,
    )
  }

  /**
   * 让位结束后重新核对攀附状态，返回"是否仍然贴在墙上"。
   *
   * **必须核对**：宠物在墙上时被用户拎走，`perch` 还留着，而让位期间 `tick` 不跑，
   * 没人发现位置已经离墙很远了。不核对的话，恢复自主活动的第一帧 `stepPerch`
   * 会把它**瞬移回墙上**——用户看到的是"拖走了又弹回去"。
   *
   * 判定脱离时不直接回站立，而是转入下落：宠物此刻悬在半空，
   * 直接站着会像被钉在空中。
   */
  private revalidatePerch(): boolean {
    if (!this.perch) return false
    if (!this.shouldReleasePerch()) return true
    log.info(`[perch] 让位期间位置被改到 (${this.x.toFixed(0)}, ${this.y.toFixed(0)})，判定为已脱离`)
    this.perch = null
    this.startFall()
    return false
  }

  /**
   * 攀爬时要不要翻转。
   *
   * 素材面朝右，而爬墙时宠物**面朝墙**——墙在它哪一侧取决于是窗口还是屏幕：
   *
   * - 爬**窗口**时宠物在窗口**外侧**：爬左墙 → 墙在右边 → 面朝右 → 不翻
   * - 爬**屏幕**时宠物在屏幕**内侧**：爬左墙 → 墙在左边 → 面朝左 → **要翻**
   */
  private flipForPerch(side: PerchSide): boolean {
    return this.perchOnScreen ? side === 'left' : side === 'right'
  }

  /**
   * 吸附到墙线上（主窗口边缘或屏幕边缘）。
   *
   * 位置立刻贴到墙线上，不等下一步积分——差一帧会看到宠物"先飘到墙边、再开始爬"。
   */
  private attachPerch(side: PerchSide, onScreen: boolean): void {
    if (!onScreen && !this.perchRect) return
    // 记住脚下的地面线。**必须在改 y 之前**——掉下来要回到这里
    this.groundY = this.y
    this.perchOnScreen = onScreen
    this.perch = { kind: 'wall', side }
    this.x = this.perchWallX(side)
    const flip = this.flipForPerch(side)
    this.facing = flip ? -1 : 1
    this.renderer.setPosition(this.x, this.y)
    this.renderer.setFlip?.(flip)
    log.info(
      `[perch] 吸附到${onScreen ? '屏幕' : '窗口'}${side === 'left' ? '左' : '右'}墙 x=${this.x.toFixed(0)}`,
    )
    this.onActivity('climb')
  }

  /** 松手：从墙上/天花板上掉回地面。 */
  private releasePerch(reason: string): void {
    if (!this.perch) return
    log.info(`[perch] 松手（${reason}）@(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
    this.perch = null
    this.startFall()
  }

  /**
   * 开始自由落体。初速为零——是自己松手掉下来的，不是被扔出去的。
   *
   * 位置权威从攀爬交给坠落积分，落回 `groundY` 之后才还给常规活动。
   */
  private startFall(): void {
    this.falling = { x: this.x, y: this.y, vx: 0, vy: 0 }
    this.onActivity('fall')
  }

  /**
   * 坠落的一步。
   *
   * 复用 `stepThrow`：重力、左右边界反弹、落地即停都是同一套物理。自己掉下来与
   * 被用户扔出去走的是同一个函数，**差别只在初速度**——没有理由为前者另写一套。
   */
  private stepFall(dtSec: number): void {
    if (!this.falling) return
    const r = stepThrow(this.falling, dtSec, {
      minX: 0,
      maxX: window.innerWidth,
      groundY: this.groundY,
      // **不能飞出屏幕**：没有它的话一次猛甩（实测 vy 到过 -4050）会让宠物
      // 飞到屏幕上方 3400px 处、消失三四秒。撞顶边按 restitution 弹回来。
      minY: 0,
    })
    this.falling = r.body
    this.x = r.body.x
    this.y = r.body.y
    this.renderer.setPosition(this.x, this.y)
    if (r.landed) {
      this.falling = null
      log.info(`[fall] 落地 @(${this.x.toFixed(0)}, ${this.y.toFixed(0)})`)
      this.resetToStand()
    }
  }

  /**
   * 攀爬的一步。
   *
   * 两段：沿墙向上（`wall`）→ 到顶转沿上边缘横爬（`ceiling`）→ 爬到另一角掉落。
   * **到顶不折返**：折返会让宠物永远赖在窗口上，而"爬到头掉下来"是更有生命感的收尾。
   */
  private stepPerch(dtSec: number): void {
    const rect = this.perchTargetRect()
    if (!this.perch || !rect) return

    if (this.perch.kind === 'wall') {
      const r = stepClimb(this.y, rect, dtSec, this.perchConfig, this.modelHeight)
      this.y = r.y
      this.x = this.perchWallX(this.perch.side)
      this.renderer.setPosition(this.x, this.y)
      if (r.reachedTop) {
        // 到顶：转成沿上边缘爬，从哪面墙上来的就往对面爬
        this.perch = { kind: 'ceiling', side: this.perch.side }
        log.info(`[perch] 爬到顶，转为沿${this.perchOnScreen ? '屏幕' : '窗口'}上边缘爬行`)
        this.onActivity('crawl')
      }
      return
    }

    const r = stepCrawl(this.x, rect, this.perch.side, dtSec, this.perchConfig)
    this.x = r.x
    this.y = this.perchCeilingY()
    this.renderer.setPosition(this.x, this.y)
    if (r.reachedEnd) this.releasePerch('爬到尽头')
  }

  /**
   * 当前攀附目标的矩形。
   *
   * **屏幕就是用整个视口**——`stepClimb`/`stepCrawl` 要它算天花板与爬行终点，
   * 而屏幕攀附本来没有"矩形"这个概念。视口的 `y=0` 正好是屏幕顶，
   * 于是两者在几何上统一了。
   */
  private perchTargetRect(): PerchRect | null {
    if (this.perchOnScreen) {
      const vp = this.viewport()
      return { x: 0, y: 0, width: vp.width, height: vp.height }
    }
    return this.perchRect
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
      } else if (this.falling) {
        // 坠落同理：落地才 `resetToStand`，半空中不推进活动计时
        this.stepFall(dtMs / 1000)
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
