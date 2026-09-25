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
 * 2. **垂直方向只受重力支配**。地面线固定在**工作区底边**（任务栏上沿），拖拽与抛物线
 *    可以把宠物带到别的高度，但**落下来一定回到那条线**——既不会停在半空，也不会
 *    把"自己走过的地方"变成地面。（早先的语义是后者，成因见 `groundY()` 的注释。）
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
  adjustAmbientConfig,
  PERCH_DEFAULTS,
  ceilingY,
  flushEdges,
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
  type AmbientTuningInput,
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
  /**
   * 是否让宠物爬**主程序窗口**的边缘。默认 **false**（只爬屏幕边）。
   *
   * 关掉不只是优先级问题，先说清楚它开着会发生什么（2026-09-22 实测）：宠物爬上去
   * → 沿窗口上沿爬到另一角 → 松手 → 落在窗口那个角上（落点固定在 `rect.x` 与
   * `rect.x + rect.width`，实测 580 / 1980）→ **一起步就又在吸附区里** → 再爬。
   * 它被锁死在窗口附近，永远走不到屏幕边缘——"在屏幕边缘运行"根本没机会发生。
   * 实测日志里连续四轮都是这个循环。
   *
   * 用户对这一步的原话是「先就在屏幕上移动吧，主程序窗口后面再说」。所以订阅链路
   * （`onPerch` / `getPerchRect`）保持不动，只是矩形不喂给驱动；窗口攀附真要做时，
   * 把这个开关打开即可。
   *
   * ⚠️ **另有尚未定性的问题**：用户同时说过「其窗口边界的判断似乎也有些问题」
   * （2026-09-22），但没说具体现象。重启这条线之前**先问清楚是什么现象**——
   * 别默认它只是上面那条"落点固定在两角"的循环。可疑处至少有三个：
   * `tryAttach` 的"宠物必须站在窗口底边之下"、`wallX` 的缝隙方向、
   * `ceilingY` 的倒挂补偿，三者都还没对着**真实窗口**量过（只在单元测试的
   * 合成矩形上验过）。
   */
  windowPerchEnabled?: boolean
  /** 随机源，可注入以便测试确定性 */
  rand?: () => number
}

export class PetWanderDriver {
  private readonly renderer: PetRendererProvider
  private readonly onActivity: (pose: PetPose) => void
  /**
   * 生效中的活动配置。**不是 readonly**：性格/情绪会把它整表替换（`setTuning`）。
   * 初始值就是调用方给的 base，中性输入下 `adjustAmbientConfig` 原样返回它。
   */
  private config: AmbientConfig
  /** 调用方给的基准配置，`setTuning` 每次都从它重新算（不叠乘） */
  private readonly baseConfig: AmbientConfig
  /**
   * 攀附参数。**不是 readonly**：素材实测的留白比例（`layout.perchGaps`）会覆盖
   * 兜底值，见 `refreshLayout`。
   */
  private perchConfig: PerchConfig
  /** 是否爬主程序窗口的边缘；见 `PetWanderOptions.windowPerchEnabled` */
  private readonly windowPerchEnabled: boolean
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
   * 地面线 = **工作区底边**。宠物窗口覆盖的是 `workArea`（已排除任务栏），
   * 所以视口底边就是任务栏上沿（见 `SpritePetRenderer` 的 `GROUND_MARGIN_PX`）。
   *
   * ⚠️ 这里曾经是一个**跟着宠物漂移**的字段：`attachPerch` 每次吸附都把当刻的 `y`
   * 记下来当成新的地面。名义是"掉下来要回到吸附前站的地方"，可**吸附前的 `y` 本身
   * 已经被上一次抛掷/掉落改过了**，于是地面线一级一级往上抬。实测（2026-09-22
   * 同一次会话的日志）：
   *
   *   `[fall] 落地 @(580, 1284)` → `@(2560, 1174)` → `@(0, 972)`
   *   `[PetWander] [resume] 恢复（pointer）位置 (1823, 1132)`   ← 扔到半空后就停那儿了
   *
   * 症状正是用户报的「悬空运动」：宠物在一条看不见的、越抬越高的地面线上走来走去。
   *
   * 用 getter 而不是字段是**刻意的**——地面线是物理常量，不是状态；没有字段就没有
   * "某处忘了更新它"这个失败模式。
   */
  private groundY(): number {
    return this.viewport().height
  }
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
    this.baseConfig = this.config
    this.perchConfig = opts.perchConfig ?? PERCH_DEFAULTS
    this.windowPerchEnabled = opts.windowPerchEnabled ?? false
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
   * 按性格 / 情绪重算活动配置（第二期 T2.2）。
   *
   * **从基准配置重算，不叠乘**——否则每次换模型或情绪更新都会再乘一遍，
   * 权重会一路漂走（实测过一版就是这样：越切越极端，且没有任何一步看着不对）。
   *
   * **已经抽好的这一轮计划不重掷**：`plan.durationMs` 是用旧时长定的，
   * 中途改它会表现成"刚坐下就被拎起来重抽"。新参数从**下一次**活动切换起生效。
   *
   * @param expressiveness 表达增益（默认 1 = 不增益）。无表情层模型传
   *   `NO_EXPRESSION_LAYER_GAIN`：它只有举止这一条表达通道，把性格给的偏移放大。
   *   数值由调用方决定，本模块不认识"表情层"这件事。
   */
  setTuning(
    mood: AmbientTuningInput | null,
    traits: AmbientTuningInput | null,
    expressiveness: number = 1,
  ): void {
    const next = adjustAmbientConfig(this.baseConfig, mood, traits, expressiveness)
    if (next === this.config) return
    this.config = next
    log.info(
      `[setTuning]${expressiveness !== 1 ? `（表达增益 ×${expressiveness}）` : ''} ` +
        `权重 stand=${next.weights.stand.toFixed(2)} walk=${next.weights.walk.toFixed(2)} ` +
        `sit=${next.weights.sit.toFixed(2)}；` +
        `时长 stand=${next.durations.stand.min}~${next.durations.stand.max}ms ` +
        `walk=${next.durations.walk.min}~${next.durations.walk.max}ms`,
    )
  }

  /**
   * 推送可攀附的目标矩形（主进程 → 渲染层 → 这里）。
   *
   * 除了记下来，还负责一件事：**目标没了就地松手**。窗口被隐藏、最小化、拖走时
   * 都会走到这里，宠物必须掉下来——留在原地会显得它悬在空中。
   */
  setPerchRect(rect: PerchRect | null): void {
    // 关掉窗口攀附时**不记**矩形：`tryAttach` 拿不到目标，自然就不吸窗口了。
    // 比在 `tryAttachNow` 里再加一个 if 好——那里已经有"主窗口优先"的分支，
    // 条件一多，"为什么没吸"就更难查。见 `windowPerchEnabled` 的说明。
    this.perchRect = this.windowPerchEnabled ? rect : null
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

    // 水平位置从渲染器读一次作为起点——宠物可能已经被拖到别处，不该被拽回原点
    const pos = this.renderer.getPosition()
    this.x = pos.x
    // 竖直方向**不**沿用渲染器里的值：地面线是常量，而渲染器可能还留着上一次的半空
    // 坐标（宠物窗口是复用的，切模式回来并不重建它）。照抄就会在空气里开始走。
    this.y = this.groundY()
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
   * 让位：拖拽 / 抛掷 / 对话进行中 / **文字气泡挂着**。
   *
   * 同一个 reason 重复调用是**无害的**（已在让位中就什么都不做），
   * 所以调用方不需要小心翼翼地和 `resume` 配对。
   *
   * **默认会重置成"站着"重新计时**：被拎起来的宠物放下后不该接着走没走完的那一段，
   * 那会让"松手就往前冲"看起来像惯性。
   *
   * `keepPose` 关掉那次重置 —— 2026-09-23 为气泡加的。**攀爬中必须用它**：
   * 宠物在墙上/天花板上时 `resetToStand` 会让它播站立动作却仍贴着墙面，看着像贴了
   * 一张立牌。气泡要的是"原地定格"，不是"站好"。
   * `resume` 一侧不用动：它已经有 `perch` 分支，会重新报一次攀爬姿态。
   *
   * **两侧都报位置**（2026-09-24 补）：`resume` 一直报 `位置 (x, y)`，而 `suspend` 不报，
   * 于是"让位期间宠物有没有被别的东西推走"这件事**只能靠猜**。补上之后一次让位就是
   * 一个天然的判据——`suspend` 与 `resume` 两个位置**逐位相同 = 期间没动过**
   * （`tick` 在 `holds.size > 0` 时整段不推进，这是它的日志面）。
   * 注意这里读的是 `renderer` 的位置，与 `resume` 同源，才可比。
   */
  suspend(reason: string, options?: { keepPose?: boolean }): void {
    if (this.holds.has(reason)) {
      log.info(`[suspend] "${reason}" 已在让位中，忽略重复调用`)
      return
    }
    const first = this.holds.size === 0
    this.holds.add(reason)
    if (first) {
      const pos = this.renderer.getPosition()
      const at = `位置 (${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`
      if (options?.keepPose) {
        log.info(`[suspend] 让位开始（${reason}），保持当前姿态，${at}`)
      } else {
        this.resetToStand()
        log.info(`[suspend] 让位开始（${reason}），${at}`)
      }
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

    // **先看该不该吸附，再考虑坠落。**
    //
    // 顺序是实测逼出来的：用户把宠物拖到屏幕边上/顶上松手时，宠物正在
    // `y < groundY` 的半空——落在下面的坠落分支里就**直接掉下去了**，
    // 而"拖到边缘要吸住"正是这一步要的。判据是"内容贴住了某条边"
    // （画布那边已经把位置夹在视口里了），悬在半空的不贴，自然走到坠落。
    if (this.tryAttachNow()) return

    // 拖拽结束时宠物悬在地面线上方（没到抛掷阈值就松手，或用户就是把它举高了放下）：
    // **接着往下掉**。这是"悬空运动"最直接的那条路径——`[onMouseUp] 速度不足` 原先
    // 直接 `resume()`，宠物就停在被举到的高度上不再下来（实测日志：此后一直
    // `[resume] 恢复（pointer）位置 (511, 972)`，而地面线在 1400）。
    if (this.y < this.groundY() - 1) {
      log.info(
        `[resume] 恢复（${reason}）悬在地面线上方 @(${this.x.toFixed(0)}, ${this.y.toFixed(0)})，转为坠落`,
      )
      this.startFall()
      return
    }

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

  /** 攀附的判定高度：模型屏幕高度的一半。太扁的窗口爬上去立刻到顶，没有意义 */
  private minPerchHeight(): number {
    return Math.max(120, this.modelHeight * 0.5)
  }

  /**
   * 把位置夹回视口内。
   *
   * **踩过**：拖拽的 `setPosition` 没有任何边界检查，宠物可以被拖到屏幕外——
   * 实测到了 `y = -21589`。而驱动把"读到的位置"当成宠物的地面线，
   * 于是它从此在屏幕外两万像素的地方"站着"，再也看不见。
   *
   * 下界 0、上界就是**地面线本身**（`h`）。
   * 上界曾经是 `h - 8`，那个 8 与地面线（`h`）差了一截：宠物被夹到 `h - 8` 之后，
   * `resume` 里"悬在地面线上方"的判定就成了**恒真**，每次恢复都白掉一次。
   *
   * ⚠ 下界曾经是 **16**（"别爬到屏幕顶之上"）。改成 0 是因为拖动那条线现在自己会夹：
   * 判据是**内容不出视口**（`dragBoundsOf`），比一个写死的 16 准。而 16 会**吃掉
   * 贴顶吸附**——矮姿势的内容上伸量可能不到 16px，锚点被抬到 16 就不再"贴着上沿"了，
   * `flushEdges` 判定失败，拖到顶端反而不吸。
   */
  private clampPosition(): void {
    const w = window.innerWidth
    const h = window.innerHeight
    this.x = Math.min(Math.max(this.x, 0), w)
    this.y = Math.min(Math.max(this.y, 0), h)
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
   *
   * @returns 是否吸上了（`resume` 据此决定"停在这儿"还是"接着坠落"）
   */
  private tryAttachNow(): boolean {
    if (this.perch || this.falling || this.holds.size > 0) return false
    const plan = this.planAttach()
    if (!plan) return false
    this.attachPerch(plan.kind, plan.side, plan.onScreen)
    return true
  }

  /**
   * 从**当前**位置能不能吸住——只判不做。
   *
   * 调用方（画布）拿它决定"松手后是吸上去还是自由落体"。**必须能先问再做**：
   * 拖到屏幕边/顶松手时，`startThrow(pos, {0,0})` 会先把宠物摔到地面，等
   * `resume` 再判吸附时它已经在地上了——位置早就不贴边。
   *
   * 与 `tryAttachNow` 共用 `planAttach`，两边不会走偏；差别只有一条：
   * 这里**不看 `holds`**——问的时候指针那次让位还没解除。
   */
  canAttachHere(): boolean {
    // **不看 `this.perch`**：拖动期间它还是"被拎起来之前"那次攀附的残留（`suspend`
    // 不清它），而宠物此刻在哪由渲染器说了算。拿残留判会得出"从天花板把它拎起来
    // 再放回天花板，它却掉到地上"这种结果。
    if (this.falling) return false
    // **位置以渲染器为准，不能用自己的 `x/y`。** 拖动期间画布是直接写
    // `renderer.setPosition()` 的（驱动被让位挂着，不参与），驱动这边的坐标还停在
    // "被拎起来之前"——拿它判会得出"在原来的地方能不能吸"，与用户手上那一拖无关。
    const pos = this.renderer.getPosition()
    return this.planAttach(pos.x, pos.y) !== null
  }

  /** 该吸到哪——纯读，不改任何状态。位置由调用方给（默认用驱动记的那份） */
  private planAttach(
    x = this.x,
    y = this.y,
  ): { kind: 'wall' | 'ceiling'; side: PerchSide; onScreen: boolean } | null {
    const minH = this.minPerchHeight()
    // **主窗口优先**：用户把宠物拎到窗口边上，那个意图比"它正好走到屏幕边"明确得多。
    // 两者同时成立只发生在主窗口贴着屏幕边的时候，那时贴窗口看起来才对
    // （贴屏幕的话宠物会跑到窗口的另一侧去）。
    const onWindow = tryAttach(x, y, this.perchRect, this.perchConfig, minH)
    if (onWindow) return { kind: 'wall', side: onWindow, onScreen: false }

    // **内容贴住了哪条边**——拖动松手走这条。
    //
    // 它比下面按距离判的那条更准：距离判据量的是**锚点**，而锚点在脚底中心、周围还有
    // 一圈素材留白，同一个"看着贴上了"在不同姿势下差几十像素（实测锚点到边界
    // 27~68px 都出现过）。用内容就没有这个口径问题。
    //
    // 走路**不会**误触发：走路时内容离屏幕边还有一截（`walkBoundsOf` 比内容宽）。
    const flush = this.flushAgainstEdges(x, y)
    if (flush) return flush

    // 走到屏幕边上自己爬上去（`tryAttachScreen` 里那两条判据的来历见它的注释）
    const onScreen = tryAttachScreen(x, y, this.viewport(), this.perchConfig, minH, this.modelHeight)
    if (onScreen) return { kind: 'wall', side: onScreen, onScreen: true }
    return null
  }

  /** 内容正贴着屏幕的哪条边 → 该吸到哪；没贴或量不出内容包围盒时 null */
  private flushAgainstEdges(
    x: number,
    y: number,
  ): { kind: 'wall' | 'ceiling'; side: PerchSide; onScreen: boolean } | null {
    const ext = this.renderer.getContentExtents?.()
    if (!ext) return null
    const vp = this.viewport()
    if (vp.height < this.minPerchHeight()) return null
    // ⚠ **容差用 `attachDistance`，不能是 1px**（2026-09-23 实测）。
    //
    // 拖动是直接操作：光标最低只能到屏幕顶（y=0），而宠物相对光标有个抓取偏移
    // （`want.y = pointerY + 抓取点距离`）。**光标推不动的地方，宠物也到不了**——
    // 实测从墙上把猫往上拖到 (200, 0)，锚点只到 y=44，而内容上伸量是 40，
    // 差 4px 就判不成"贴住"，松手掉了下来。1px 的判据等于要求"把宠物恰好推到
    // 边缘"，人手做不到。
    const f = flushEdges(x, y, ext, vp, this.perchConfig.attachDistance)
    // 上沿最优先：拖到顶时水平方向往往也贴着一侧，用户要的是"挂上去"
    if (f.top) return { kind: 'ceiling', side: this.crawlSide(), onScreen: true }
    if (f.left) return { kind: 'wall', side: 'left', onScreen: true }
    if (f.right) return { kind: 'wall', side: 'right', onScreen: true }
    return null
  }

  /**
   * 上顶之后往哪边爬。
   *
   * 取自**当前朝向**：`stepCrawl` 里 `side: 'left'` 是向右爬，而素材面朝右，所以朝右
   * 时从左边上顶、朝左时从右边上顶——与 `flipForCeiling` 的规则一致，
   * 于是吸附瞬间**不会翻面**。
   */
  private crawlSide(): PerchSide {
    return this.facing >= 0 ? 'left' : 'right'
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
    // ⚠ 夹取的下界**不是 0，是一个缝隙**。
    //
    // 夹的是**锚点**，而身体从锚点向两侧伸出去（月兔实测：画布空间左 148 / 右 124，
    // 屏幕上各 ~36px）。夹到 0 的话锚点落在屏幕最边缘，**半个身子在屏幕外** ——
    // 用户实测报的"从天花板掉下来每次都有半边身体在屏幕外"就是这条：主窗口贴着
    // 屏幕边时 `wallX` 算出负数（宠物本该在窗口外侧，可那儿没地方站），
    // 一夹到 0 就正好把左半身推出去。
    //
    // 缝隙取 `wallGapRatio × modelHeight` —— 这正是这个比值本来的定义
    // （"爬墙时身体侧边与墙面的缝隙"）。屏幕那条路的 `screenWallX` 本来就返回
    // 一个缝隙，所以夹取对它是恒等的，只对"窗口贴边"这一种情形起作用。
    const margin = this.modelHeight * this.perchConfig.wallGapRatio
    return Math.min(Math.max(raw, margin), Math.max(margin, window.innerWidth - margin))
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
   * 沿上边缘爬行时的翻转。**与墙上的规则不同，不能沿用 `flipForPerch` 的结果。**
   *
   * 墙上判的是"墙在宠物哪一侧"；上边缘判的是**爬行方向**——`stepCrawl` 让从左墙上来的
   * 往右爬、从右墙上来的往左爬（`perch.ts` 里 `dir = side === 'left' ? 1 : -1`），
   * 而素材只画面朝右，于是**只有从右墙上来的那一种要翻**。两种攀附目标（屏幕 / 主窗口）
   * 在这一条上规则相同，所以不分 `perchOnScreen`。
   *
   * ⚠️ 这里原先**什么都不做**，`setFlip` 一直停在吸附墙时的值，两种来路都是反的。
   * 用户实测报的就是"从右往左爬的时候头尾方向反了"（2026-09-22）：
   * `[perch] 吸附到屏幕右墙 x=2448` → `爬到顶` → 往左爬，而屏幕模式下
   * `flipForPerch('right')` 是 `false`（不翻）——头朝右，与前进方向相反。
   */
  private flipForCeiling(side: PerchSide): boolean {
    return side === 'right'
  }

  /** 设定朝向并同步给渲染器。`facing` 与 `flip` 是同一件事的两半，永远一起改 */
  private applyFacing(flip: boolean): void {
    this.facing = flip ? -1 : 1
    this.renderer.setFlip?.(flip)
  }

  /**
   * 吸附到墙线上（主窗口边缘或屏幕边缘）。
   *
   * 位置立刻贴到墙线上，不等下一步积分——差一帧会看到宠物"先飘到墙边、再开始爬"。
   */
  private attachPerch(kind: 'wall' | 'ceiling', side: PerchSide, onScreen: boolean): void {
    if (!onScreen && !this.perchRect) return
    // 墙上的 y 是**临时的**：松手后由 `stepFall` 送回固定的地面线（见 `groundY()`）。
    // 这里曾经把当刻的 y 记成"地面线"，那正是宠物越爬越高的根源。
    this.perchOnScreen = onScreen
    this.perch = kind === 'wall' ? { kind: 'wall', side } : { kind: 'ceiling', side }
    if (kind === 'wall') {
      this.x = this.perchWallX(side)
      // 墙上判的是"墙在宠物哪一侧"
      this.applyFacing(this.flipForPerch(side))
    } else {
      // 从**拖动**直接吸到上沿（没经过爬墙）。位置贴到天花板线上，朝向按爬行方向算
      this.y = this.perchCeilingY()
      this.applyFacing(this.flipForCeiling(side))
    }
    this.renderer.setPosition(this.x, this.y)
    log.info(
      `[perch] 吸附到${onScreen ? '屏幕' : '窗口'}` +
        (kind === 'wall' ? `${side === 'left' ? '左' : '右'}墙 x=${this.x.toFixed(0)}` : `上沿 y=${this.y.toFixed(0)}`),
    )
    this.onActivity(kind === 'wall' ? 'climb' : 'crawl')
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
      groundY: this.groundY(),
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
        // 朝向必须**跟着重新算**：墙上判的是"墙在哪一侧"，上边缘判的是爬行方向
        this.applyFacing(this.flipForCeiling(this.perch.side))
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
