/**
 * SpritePetRenderer — 精灵图渲染后端
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §4.3 / §5.2
 *
 * 纯逻辑（帧增量归一、口型取档、多边形命中）都在 @mtbot/pet-core 里，本文件只负责
 * 把解析结果画出来：建纹理、搭容器、跟 ticker、做缩放吸附。
 *
 * ## 两处与设计文档不同的实现选择
 *
 * 1. **不用 PIXI `AnimatedSprite`，改自驱帧计数。**
 *    §4.3 选的是 `AnimatedSprite`，但它的模型是「一个 sprite 一条帧序列」。分层方案下一帧要
 *    同时决定**所有层**的部件，用它就得为每层各建一条序列并逐帧保持同步——等于把同一件事
 *    做两遍，还多出一堆「某层没跟上」的失败模式。自驱一个计数器、每帧套用整份槽位快照，
 *    正好对上 pet-core 解析出来的全量帧结构。
 *
 * 2. **帧推进按真实时间累加，不按 ticker 帧数。**
 *    §5.2 要求「降帧后动作速度不变」。`setFpsCap` 会把 ticker 降到 15fps，若按 tick 次数推进，
 *    8fps 的动画就会变成慢动作。按 `deltaMS` 累加则天然与显示帧率解耦，无需再同步什么
 *    `animationSpeed`。
 */

import * as PIXI from 'pixi.js'
import {
  adaptiveScale,
  advanceSpriteFrame,
  BlinkScheduler,
  evaluateProcedural,
  findAnimation,
  hitTestPolygons,
  applyActivityModulation,
  IDENTITY_MODULATION,
  isIdentityModulation,
  mouthLevelIndex,
  parseAtlasIndex,
  randomAnimationIndex,
  applyOverrides,
  resolveSpriteRuntime,
  snapPixelScale,
  validateSpriteManifest,
  type ActivityModulation,
  type ResolvedAnimation,
  type SlotState,
  type SlotOverride,
  type SpriteManifest,
  type SpriteRuntimeModel,
} from '@mtbot/pet-core'
import type {
  HitArea,
  PetMotionPlayedInfo,
  PetRendererInitOptions,
  PetRendererProvider,
} from '../types'
import type { PetModelConfig } from '../../config/pet-model-types'
import { poseRotationRadians } from '../pose-units'

const log = {
  info: (...args: unknown[]) => console.log('[SpritePetRenderer]', ...args),
  warn: (...args: unknown[]) => console.warn('[SpritePetRenderer]', ...args),
  error: (...args: unknown[]) => console.error('[SpritePetRenderer]', ...args),
}

/**
 * 表情 / 口型的部件类别命名约定。
 *
 * 清单里没有「哪个类别是眼睛、哪个是嘴」的字段（`mouthLevels` 只给了一串图集条目名），
 * 所以按类别名认：命中 `mouth*` 的是口型，命中 `eye*` 的是表情。
 * 都不命中时退化为「同一槽位恰好两个类别，按声明顺序取前两个」。
 * 约定集中在这里，模型作者只需要知道这一条。
 */
const EYES_NAMES = ['eyes', 'eye', 'expression', 'face']
const MOUTH_NAMES = ['mouth', 'mouths']

/**
 * sprite 桌宠的视口高度占比上限。
 *
 * 不用 Live2D 那边的 0.78——那是"站姿全身角色"的口径，占屏高七八成是常态。
 * 桌宠是桌面上的小陪衬，占满屏幕既挡住工作区、又违背「不打扰」。0.35 是**兜底**，
 * 不是目标值：正常由注册表的 `scale` 决定大小，这条只防"某个模型把 scale 配大了"
 * 演变成占满整屏。
 */
export const SPRITE_MAX_HEIGHT_RATIO = 0.35

/**
 * 地面线距视口底边的距离（CSS 像素）。
 *
 * **0**：宠物窗口覆盖的是 `workArea`——**已经排除任务栏**——所以视口底边就是任务栏上沿，
 * 锚点（脚底）落在那里即可。
 *
 * 这里曾经是 48，注释还写着"48 大致是任务栏高度之上一点——工作区已经排除了任务栏，
 * 留出一个身位即可"。**那句话自己就把理由说反了**：既然工作区已经排除了任务栏，
 * 再往上留 48 就是**凭空悬空 48px**。实测症状：宠物站在任务栏上方一截的空气里。
 *
 * 取固定值而不是比例这条仍然成立：宠物的**绝对**体量不该随窗口大小变。
 */
export const GROUND_MARGIN_PX = 0

/**
 * 首次摆放的水平位置（视口宽度的比例）。
 *
 * **不是 0.5**：屏幕底部中央被控制坞占着（它的定位是 `bottom:120; left:50%`，
 * 宽 400，实测覆盖 x∈[1080,1480]），宠物站在正中会被整个挡住上半身。
 * 0.25 落在控制坞左侧、留出足够身位。
 *
 * 走动时仍会经过中间——那时从面板后面穿过去是自然的（真实桌宠也会走到 UI 后面），
 * 要避免的只是"一进宠物模式就看不见它"。
 */
export const GROUND_START_X_RATIO = 0.25

/** 正在播放的动画状态 */
interface PlayingState {
  anim: ResolvedAnimation
  /** 当前帧下标 */
  frame: number
  /** 距下一帧的累计时间（ms） */
  acc: number
  /** 是否已触发过 once 的完成回调（防止同一次播放回调多次） */
  completed: boolean
}

/** 纹理索引：图集条目名 → PIXI 纹理 */
type TextureMap = Map<string, PIXI.Texture>

export class SpritePetRenderer implements PetRendererProvider {
  /**
   * 精灵图后端**不会自己循环待机组**——它只播 `playMotion` 启动的东西。
   *
   * 这是与 Live2D 后端的实质差异：`pixi-live2d-display` 的 MotionManager 内部循环
   * `groups.idle`，所以编排器在无随机待机源时可以什么都不做；这里不行，必须由编排器
   * 主动启动。实测踩过：单待机组的模型（只有 Idle + Talk）完全不动的根因就是这个。
   */
  readonly autoLoopsIdle = false

  private app: PIXI.Application | null = null
  /** 根容器：位置 = 锚点在画布上的位置，旋转/缩放都绕它发生（正是"脚底中心"的语义） */
  private root: PIXI.Container | null = null
  /** 内部容器：把清单坐标 (0,0) 平移到锚点 */
  private pivot: PIXI.Container | null = null

  private runtime: SpriteRuntimeModel | null = null
  private config: PetModelConfig | null = null
  private textures: TextureMap = new Map()
  private baseTexture: PIXI.BaseTexture | null = null

  /** base 槽的 sprite（整体帧方案下这是唯一的可见层） */
  private baseSprite: PIXI.Sprite | null = null
  /** 分层槽：槽名 → 部件类别 → sprite */
  private layeredSprites: Record<string, Record<string, PIXI.Sprite>> = {}

  /** 口型绑定：承载 mouthLevels 的槽位与类别 */
  private mouthBinding: { slot: string; cat: string; levels: string[] } | null = null
  /** 表情绑定：承载表情切换的槽位与类别，以及其全部候选部件 */
  private expressionBinding: { slot: string; cat: string; parts: string[] } | null = null

  private playing: PlayingState | null = null
  private currentState: SlotState | null = null

  /**
   * 表情 / 口型覆盖层。
   *
   * 这两项**必须叠加在帧快照之上**，不能直接改 `currentState`：动画每推进一帧都会套用
   * 整份槽位快照（`applyState`），直接改状态会在下一帧被冲掉——表现就是「表情设了没反应」
   * 或「说话时嘴在闪」。Live2D 那边表情也是独立于动作的层，语义上要对齐。
   */
  private expressionPart: string | null = null
  private mouthPart: string | null = null

  /** 眨眼调度器：由当前动画的 params.blink 建立；未声明则为 null（不眨眼） */
  private blinkScheduler: BlinkScheduler | null = null
  /** 当前是否处于闭眼（只在变化时改图层） */
  private blinkClosed = false
  /** 「闭眼」部件名；由表情类别里名字匹配 shut/close/闭 的那一项解析而来 */
  private blinkPart: string | null = null

  /** 锚点在画布上的逻辑位置（程序化浮动不改它，命中判定也不受浮动影响） */
  private posX = 0
  private posY = 0
  /**
   * 水平镜像。
   *
   * Shimeji 这类素材**只画一个朝向**（面朝右），向左走时靠整体翻转。
   * 打包期烘一份镜像图集是另一条路，代价是图集翻倍——运行时翻转不需要。
   */
  private flipped = false
  /** 自适应得到的基准缩放（不含用户倍率） */
  private baseScale = 1
  private userScaleFactor = 1
  /** 像素风：缩放取整数倍 */
  private pixelArt = false

  private fpsCap = 60
  private loaded = false
  private motionListener: ((info: PetMotionPlayedInfo) => void) | null = null

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  async init(options: PetRendererInitOptions): Promise<void> {
    const app = new PIXI.Application({
      view: options.canvas,
      width: options.width,
      height: options.height,
      backgroundAlpha: 0,
      // 抗锯齿保持开启（与 Live2D 后端一致）。像素风"糊不糊"由 BaseTexture 的
      // NEAREST 采样决定，与这里的几何抗锯齿是两回事——PIXI Application 的抗锯齿
      // 只在建 app 时定一次，而 pixelArt 是逐模型属性、切换模型不会重建 app，
      // 拿它来控制反而会把高清模型的边缘一起削掉。
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })
    this.app = app

    options.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      log.error('[init] WebGL context lost — 渲染将暂停，避免白屏崩溃')
      this.loaded = false
    })

    app.ticker.add(this.onTick)
    log.info(`[init] PIXI Application 创建完成 ${options.width}x${options.height}`)
  }

  setMotionPlayedListener(listener: ((info: PetMotionPlayedInfo) => void) | null): void {
    this.motionListener = listener
  }

  async loadModel(config: PetModelConfig): Promise<void> {
    if (!this.app) throw new Error('渲染器未初始化，请先 init()')
    this.unloadModel()

    log.info(`[loadModel] 开始加载模型 ${config.id} from ${config.modelUrl}`)

    const manifestRaw = await fetchJson(config.modelUrl)
    const validated = validateSpriteManifest(manifestRaw)
    if (!validated.ok) {
      const detail = validated.errors.map((e) => `${e.path}: ${e.message}`).join('; ')
      throw new Error(`清单校验未通过 — ${detail}`)
    }
    const manifest = validated.manifest

    const runtime = resolveSpriteRuntime(manifest)
    const textures = await this.loadTextures(config.modelUrl, manifest.atlas, manifest.atlasJson)

    this.runtime = runtime
    this.config = config
    this.textures = textures
    this.pixelArt = manifest.pixelArt === true

    this.buildLayers(manifest, runtime, textures)
    this.bindMouthAndExpression(manifest)

    this.loaded = true
    this.userScaleFactor = 1
    this.applyAdaptiveScale(manifest)
    // 首次摆放：站到地面线上、水平居中
    this.resetToGround(true)

    // 载入后先摆出默认姿态；编排器随后会 playMotion('Idle')
    this.applyState(runtime.defaultState)
    log.info(`[loadModel] 模型加载完成 ${config.id}（${textures.size} 张纹理）`)
    // 「待机不许浮动」规则改过这个模型的声明就**必须出声**：安静地改数据、作者还以为
    // 自己写的 bob 生效了，是最难查的一类问题（症状是"宠物在飘"，而原因在很久以前
    // 某一行 params 上）。判据与规则本体同在 pet-core 的 `stripIdleDrift`。
    if (runtime.idleDriftStripped.length > 0) {
      log.warn(
        `[loadModel] 「待机不许浮动」规则丢掉了 ${runtime.idleDriftStripped.join('、')}` +
          `（待机是站着不动的：见 pet-core 的 stripIdleDrift）`,
      )
    }
  }

  private unloadModel(): void {
    if (this.root) {
      this.root.destroy({ children: true })
      this.root = null
    }
    this.pivot = null
    this.baseSprite = null
    this.layeredSprites = {}
    for (const t of this.textures.values()) t.destroy()
    this.textures = new Map()
    this.baseTexture?.destroy()
    this.baseTexture = null
    this.runtime = null
    this.mouthBinding = null
    this.expressionBinding = null
    this.expressionPart = null
    this.mouthPart = null
    this.blinkScheduler = null
    this.blinkClosed = false
    this.blinkPart = null
    this.playing = null
    this.currentState = null
    this.loaded = false
  }

  // -------------------------------------------------------------------------
  // 资源加载
  // -------------------------------------------------------------------------

  private async loadTextures(
    manifestUrl: string,
    atlasFile: string,
    atlasJsonFile: string,
  ): Promise<TextureMap> {
    // manifestUrl 可能是相对路径（dev 下是 `/pet-models/...` 交给 Vite 中间件），
    // 而 `new URL(相对, base)` 要求 base 是绝对 URL，否则直接抛 Invalid base URL。
    // 先按文档地址补全，dev / 打包 / lumii-pet 三种形态就都统一成绝对 URL 了。
    const base0 = new URL(manifestUrl, window.location.href).href
    const atlasUrl = new URL(atlasFile, base0).href
    const jsonUrl = new URL(atlasJsonFile, base0).href

    const parsed = parseAtlasIndex(await fetchJson(jsonUrl))
    if (!parsed.ok) throw new Error(`图集索引解析失败 — ${parsed.errors.join('; ')}`)
    log.info(`[loadTextures] 图集条目 ${parsed.atlas.frames.length} 个`)

    // BaseTexture.from 而非 new BaseTexture：走 PIXI 的缓存与资源自动识别，
    // 与 Live2D 那边加载纹理是同一条路径
    const base = PIXI.BaseTexture.from(atlasUrl)
    if (this.pixelArt) base.scaleMode = PIXI.SCALE_MODES.NEAREST
    this.baseTexture = base

    await new Promise<void>((resolve, reject) => {
      if (base.valid) return resolve()
      base.once('loaded', () => resolve())
      base.once('error', () => reject(new Error(`图集加载失败：${atlasUrl}`)))
    })

    const map: TextureMap = new Map()
    for (const frame of parsed.atlas.frames) {
      map.set(frame.name, new PIXI.Texture(base, new PIXI.Rectangle(frame.x, frame.y, frame.w, frame.h)))
    }
    return map
  }

  private textureFor(name: string): PIXI.Texture {
    return this.textures.get(name) ?? PIXI.Texture.EMPTY
  }

  // -------------------------------------------------------------------------
  // 图层搭建
  // -------------------------------------------------------------------------

  private buildLayers(manifest: SpriteManifest, runtime: SpriteRuntimeModel, textures: TextureMap): void {
    const app = this.app!
    const root = new PIXI.Container()
    const pivot = new PIXI.Container()
    // 清单坐标 (0,0) 落在锚点上：内部内容整体左移/上移一个锚点
    pivot.position.set(-manifest.anchor[0], -manifest.anchor[1])
    root.addChild(pivot)
    app.stage.addChild(root)

    this.root = root
    this.pivot = pivot

    // base 槽：整帧方案下的主角，分层方案下是身体层
    const baseSprite = new PIXI.Sprite(PIXI.Texture.EMPTY)
    baseSprite.visible = false
    pivot.addChild(baseSprite)
    this.baseSprite = baseSprite

    // 分层槽
    const layered: Record<string, Record<string, PIXI.Sprite>> = {}
    for (const [slotName, def] of Object.entries(manifest.slots ?? {})) {
      if (slotName === 'base' || def.kind !== 'layered') continue
      const cats: Record<string, PIXI.Sprite> = {}
      for (const cat of Object.keys(def.parts ?? {})) {
        const s = new PIXI.Sprite(PIXI.Texture.EMPTY)
        s.position.set(def.at?.[0] ?? 0, def.at?.[1] ?? 0)
        s.visible = false
        pivot.addChild(s)
        cats[cat] = s
      }
      layered[slotName] = cats
    }
    this.layeredSprites = layered

    void runtime
    void textures
    log.info(
      `[buildLayers] 画布 ${manifest.canvas.w}×${manifest.canvas.h}，锚点 (${manifest.anchor[0]}, ${manifest.anchor[1]})，分层槽 ${Object.keys(layered).length} 个`,
    )
  }

  /**
   * 认出口型层与表情层。
   *
   * 清单没有专门的字段指明「哪个类别是眼睛、哪个是嘴」——`mouthLevels` 只给了一串图集条目名。
   * 所以按**命名约定**找：类别名命中 `mouth*` 的是口型，命中 `eye*` 的是表情；
   * 都不命中时退化为「同一槽位里恰好两个类别，按声明顺序取前两个」。
   * 约定写在这里而不是散在调用点，模型作者只需要知道这一条。
   */
  private bindMouthAndExpression(manifest: SpriteManifest): void {
    const levels = manifest.mouthLevels ?? []
    let mouth: { slot: string; cat: string } | null = null
    let expression: { slot: string; cat: string } | null = null

    for (const [slotName, def] of Object.entries(manifest.slots ?? {})) {
      if (def.kind !== 'layered') continue
      const cats = Object.keys(def.parts ?? {})
      for (const cat of cats) {
        const lower = cat.toLowerCase()
        if (!mouth && MOUTH_NAMES.includes(lower)) mouth = { slot: slotName, cat }
        else if (!expression && EYES_NAMES.includes(lower)) expression = { slot: slotName, cat }
      }
      // 命名约定没命中时：同一槽位两个类别，按声明顺序当作 表情 / 口型
      if (!mouth && !expression && cats.length === 2) {
        expression = { slot: slotName, cat: cats[0] }
        mouth = { slot: slotName, cat: cats[1] }
      }
    }

    this.mouthBinding =
      mouth && levels.length > 0 ? { slot: mouth.slot, cat: mouth.cat, levels } : null

    if (expression) {
      const parts = manifest.slots?.[expression.slot]?.parts?.[expression.cat] ?? []
      this.expressionBinding = { slot: expression.slot, cat: expression.cat, parts }
      // 眨眼部件按名字认（shut / close / 闭）。认不出就不眨眼——
      // 随便挑一个部件当闭眼，效果是「眨眼时脸突然变了」，比不眨更糟。
      this.blinkPart = parts.find((n) => /shut|close|closed|闭/i.test(n)) ?? null
    } else {
      this.expressionBinding = null
      this.blinkPart = null
    }

    if (!this.mouthBinding) {
      log.info('[bindMouthAndExpression] 该模型没有独立口型层（口型可能烘在整帧里）')
    }
  }

  // -------------------------------------------------------------------------
  // 帧推进
  // -------------------------------------------------------------------------

  private onTick = (): void => {
    const app = this.app
    if (!app || !this.loaded || !this.runtime || !this.root) return

    const deltaMS = app.ticker.deltaMS
    this.advanceAnimation(deltaMS)
    this.applyProcedural()
  }

  /** 按真实时间推进帧；once 播完触发回调并跳 next */
  private advanceAnimation(deltaMS: number): void {
    const p = this.playing
    if (!p) return
    const frames = p.anim.frames
    if (frames.length <= 1) {
      // 单帧动画也得**等够它自己的时长**再算完成。原先这里直接判完成，于是
      // 单帧的 `once` 在一帧内就结束——像 Jump 这种"素材只有一帧、靠停留时间
      // 做出节奏"的动作根本播不出来（切过去立刻就切回来了）。
      const holdMs = p.anim.durationsMs?.[0] ?? (p.anim.fps > 0 ? 1000 / p.anim.fps : 0)
      p.acc += deltaMS
      if (p.acc >= holdMs) this.maybeCompleteOnce(p)
      return
    }

    // 帧推进的算法（逐帧时长 / 均速回落 / once 停尾 / 防挂死上限）在 pet-core 里，
    // 那边能脱开 WebGL 单测；这里只把结果套到图层上。
    const stepped = advanceSpriteFrame(p.anim, { frame: p.frame, elapsedMs: p.acc }, deltaMS)
    p.frame = stepped.frame
    p.acc = stepped.elapsedMs
    if (stepped.advanced) this.applyState(frames[p.frame])
    this.maybeCompleteOnce(p)
  }

  private maybeCompleteOnce(p: PlayingState): void {
    if (p.anim.kind !== 'once' || p.completed) return
    if (p.frame < p.anim.frames.length - 1) return
    p.completed = true
    this.motionListener?.({ group: p.anim.group, index: p.anim.index })
    if (p.anim.next) this.playMotion(p.anim.next)
  }

  /** 把一份槽位快照套到各层上，随后**重新盖上表情/口型覆盖层** */
  private applyState(state: SlotState): void {
    // 覆盖层最后盖：动画帧只决定"没被覆盖的那些槽位"。
    // 合成规则在 pet-core（applyOverrides），不在渲染器里各写一遍。
    const overrides: SlotOverride[] = []
    const expr = this.expressionBinding
    if (expr && this.expressionPart) {
      overrides.push({ slot: expr.slot, cat: expr.cat, part: this.expressionPart })
    }
    const mouth = this.mouthBinding
    if (mouth && this.mouthPart) {
      overrides.push({ slot: mouth.slot, cat: mouth.cat, part: this.mouthPart })
    }
    // 眨眼盖在表情之上：闭眼是瞬时状态，不该被「当前表情」顶掉
    if (expr && this.blinkClosed && this.blinkPart) {
      overrides.push({ slot: expr.slot, cat: expr.cat, part: this.blinkPart })
    }
    const effective = applyOverrides(state, overrides)
    this.currentState = effective

    if (this.baseSprite) {
      const has = effective.base.length > 0 && this.textures.has(effective.base)
      this.baseSprite.texture = has ? this.textureFor(effective.base) : PIXI.Texture.EMPTY
      this.baseSprite.visible = has
    }

    for (const [slotName, cats] of Object.entries(effective.layered)) {
      for (const [cat, partName] of Object.entries(cats)) {
        this.setLayer(slotName, cat, partName)
      }
    }
  }

  /** 设置某一层的纹理与可见性 */
  private setLayer(slotName: string, cat: string, partName: string): void {
    const sprite = this.layeredSprites[slotName]?.[cat]
    if (!sprite) return
    const has = partName.length > 0 && this.textures.has(partName)
    sprite.texture = has ? this.textureFor(partName) : PIXI.Texture.EMPTY
    sprite.visible = has
  }

  /**
   * Agent 活动的姿态调制（L1 表达层）。**默认恒等**——没接线时本渲染器的行为与
   * 这个字段存在之前逐像素一致（`applyActivityModulation` 在恒等元下原样返回入参）。
   */
  private agentModulation: ActivityModulation = IDENTITY_MODULATION

  /**
   * 接收**已平滑**的调制量，在下一次 `applyProcedural` 生效。
   *
   * 平滑在 pet-core 的 `activityModulation()` 里做（它是纯函数，给定 `now` 就有确定值），
   * 渲染器不攒上一帧——攒了就变成"帧率决定观感"，且没法写断言。
   */
  setAgentActivityModulation(mod: ActivityModulation): void {
    const wasIdentity = isIdentityModulation(this.agentModulation)
    this.agentModulation = mod
    const nowIdentity = isIdentityModulation(mod)

    // 只在 **恒等 ⇄ 非恒等** 的跨越上报一行。这是「Agent 活动此刻是否正在影响姿态」
    // 的边界，一个 turn 最多两次（起、止），不刷屏。
    //
    // 为什么不报"首个非恒等"（第一版）：那条日志是**一次性**的，同一个应用实例里
    // 跑第二次验证就再也看不到，读日志的人会得到"链路断了"的**假阴性**。
    // 同理也不要报数值——跨越这一刻的值是**平滑起点**，必然贴近恒等（1.0000 / 1.0000 / 0.000），
    // 报出来只会让人误以为"调制没生效"。
    if (wasIdentity !== nowIdentity) {
      log.info(
        `[setAgentActivityModulation] 姿态调制${nowIdentity ? '回到基线（activity 已 idle）' : '开始生效'}`,
      )
    }
  }

  /** 程序化原语：每 tick 求值一次 */
  private applyProcedural(): void {
    const root = this.root
    const p = this.playing
    if (!root) return

    const params = p?.anim.params
    // 用 pet-core 的 `evaluateProcedural` 合成，**不要在渲染器里手写一遍**。
    //
    // 手写过一次并踩了坑：四个原语的签名都是 `(量, tSec, periodSec?)`，量在前时间在后。
    // 传反不会报错，只会静默跑飞——把「已运行秒数」当倍率传进去，breathe 随 t 线性增长，
    // 表现为宠物一边动一边持续变大；bob 则恰好因 sin(2π·整数)=0 而静默失效。
    // 现成的合成函数已经被单测钉住了签名，绕开它等于把防线拆掉。
    const t = performance.now() / 1000
    const transform = params
      ? evaluateProcedural(params, t, this.blinkScheduler ?? undefined)
      : { offsetY: 0, rotation: 0, scale: 1, blinkClosed: false }

    // Agent 活动调制（L1 表达层）：叠加交给 pet-core 的纯函数，**不要在这里手写
    // 那三个乘法**——「呼吸倍率乘偏离量而不是总量」这条约定极易写错，且错了看不出来
    //（宠物整体胀一圈，不报错、不 NaN、只是"有点怪"）。它现在由
    // `applyActivityModulation` 的单测钉着，绕开它等于把防线拆掉。
    // 恒等元下它原样返回入参，所以没接线时这里逐字段不变。
    const posed = applyActivityModulation(transform, this.agentModulation)

    root.position.set(this.posX, this.posY + posed.offsetY)
    // 两个分量都是**度**（procedural-motion 的约定），而 PIXI 的 `rotation` 是**弧度**——
    // 换算收在 `poseRotationRadians` 里，别在这里手写乘法。
    //
    // 这个换算曾经漏掉，长期没暴露：所有模型都没声明 sway/nod，`transform.rotation`
    // 恒为 0，症状是**摇摆方向不对**。
    root.rotation = poseRotationRadians(posed.rotation)

    // 水平镜像作用在 root.scale.x 上（不是 pivot）。
    //
    // 锚点校正 `pivot.position.x = -anchor[0]` **不需要跟着改**：sprite 的世界坐标是
    // `root.position + root.scale × (pivot.position + local)`，要让 local=anchorX 落到
    // root 原点上，条件 `scale.x × (pivot.x + anchorX) = 0` 与 scale 的符号无关。
    // 曾经的结论是"渲染层没有翻转能力、镜像只能落打包期且图集翻倍"——那是没找到这条。
    //
    // 旋转（sway/nod/注视倾斜）在 scale 外层，镜像后会视觉反向，这正是期望行为：
    // 宠物朝左时摇摆方向也该跟着镜像。
    const s = this.effectiveScale() * posed.scale
    root.scale.set(s * (this.flipped ? -1 : 1), s)

    this.applyBlink(transform.blinkClosed)
  }

  /**
   * 眨眼：闭眼期间把表情层临时换成「闭眼」部件，睁眼时还原。
   *
   * 只在状态**变化**时改图层——`applyState` 会重建覆盖层，每帧无脑调用纯属浪费。
   */
  private applyBlink(closed: boolean): void {
    if (closed === this.blinkClosed) return
    this.blinkClosed = closed
    if (!this.blinkPart) return
    if (this.currentState) this.applyState(this.currentState)
  }

  private effectiveScale(): number {
    return this.baseScale * this.userScaleFactor
  }

  // -------------------------------------------------------------------------
  // 缩放与定位
  // -------------------------------------------------------------------------

  private applyAdaptiveScale(manifest: SpriteManifest): void {
    if (!this.app) return
    const requested = this.config?.scale ?? 1
    const s = adaptiveScale(
      manifest.canvas.h,
      this.app.renderer.height,
      requested,
      this.pixelArt,
      SPRITE_MAX_HEIGHT_RATIO,
    )
    this.baseScale = s
    log.info(
      `[applyAdaptiveScale] 画布高 ${manifest.canvas.h}，请求缩放 ${requested} → 实际 ${s}${this.pixelArt ? '（像素取整）' : ''}，` +
        `屏幕高约 ${(manifest.canvas.h * s).toFixed(0)}px（视口 ${this.app.renderer.height}px）`,
    )
  }

  /**
   * 摆到地面上。
   *
   * 与 Live2D 后端的 `centerModel`（画布正中）是**有意的差异**：那边是立绘，居中才对；
   * 这边是桌宠，"站在地面"是它的前提——悬在屏幕正中的宠物既挡工作区，
   * 又让「自己走动」这件事失去参照（走在哪条线上？）。参考项目同样把宠物放在屏幕下方。
   *
   * @param center 是否重置水平位置。**首次摆放才置中**；视口变化时不重置——
   *   那会把正在走动的宠物一把拽回中间，而用户改窗口大小跟宠物位置毫无关系。
   */
  private resetToGround(center: boolean): void {
    if (!this.app) return
    this.posY = this.app.renderer.height - GROUND_MARGIN_PX
    if (center) {
      // 偏左摆放而不是居中——底部中央被控制坞占着（见 GROUND_START_X_RATIO）
      this.posX = this.app.renderer.width * GROUND_START_X_RATIO
    } else {
      // 视口变窄时 x 可能落到界外，夹回来；自治行为那边每帧也会夹，这里只是兜底
      this.posX = Math.min(Math.max(this.posX, 0), this.app.renderer.width)
    }
    if (this.root) this.root.position.set(this.posX, this.posY)
  }

  adjustScaleByDelta(delta: number): void {
    if (!this.root) return
    if (this.pixelArt) {
      // 像素风：直接在整数倍上台阶，避免出现 1.6 倍这种"每列宽度不齐"的缩放
      const current = snapPixelScale(this.effectiveScale())
      const next = Math.max(1, current + (delta < 0 ? 1 : -1))
      // 已经顶到上下限时不再改动、也不打日志：滚轮是高频事件，
      // 触底后每滚一格刷一行会把日志淹掉（实测刷了 143 行）
      if (next === current) return
      this.userScaleFactor = next / (this.baseScale || 1)
      log.info(`[adjustScaleByDelta] 像素吸附 ${current} → ${next}`)
      return
    }
    const FACTOR = 0.0015
    const before = this.userScaleFactor
    this.userScaleFactor = Math.max(0.4, Math.min(5.0, this.userScaleFactor * (1 - delta * FACTOR)))
    if (Math.abs(this.userScaleFactor - before) < 1e-6) return
    log.info(`[adjustScaleByDelta] userScale=${this.userScaleFactor.toFixed(3)}`)
  }

  setPosition(x: number, y: number): void {
    this.posX = x
    this.posY = y
    if (this.root) this.root.position.set(x, y)
  }

  getPosition(): { x: number; y: number } {
    return { x: this.posX, y: this.posY }
  }

  /**
   * 设置水平镜像。
   *
   * 翻转不重建任何东西：图集、多边形、锚点全部沿用，只在 `root.scale.x` 上加符号
   * （推导见 `applyProcedural`）。命中判定跟着走——`modelTransform()` 会带上 `flipX`，
   * 由 pet-core 的 `toManifestPoint` 反算回清单坐标，**漏掉这一步会「点左肩中右肩」**。
   *
   * 幂等：同值重复调用直接返回（行为层每帧都可能来问一次）。
   */
  setFlip(flipX: boolean): void {
    if (this.flipped === flipX) return
    this.flipped = flipX
    // 立刻套用，不等下一帧 ticker：转向与位移是同一 tick 里发生的，
    // 差一帧会看到「先平移过去、再翻过来」
    this.applyProcedural()
    log.info(`[setFlip] 水平镜像=${flipX}`)
  }

  getFlip(): boolean {
    return this.flipped
  }

  /**
   * 布局查询：锚点与当前缩放。自主行走用它把画布边界换算成「脚能走到哪」。
   *
   * 不复用 `getHitTransform()`：那个方法的契约是**命中判定的诊断口径**
   * （pet-lab 拿它反算期望值），往上面挂行为层的需求会让两边互相牵制。
   */
  getLayout(): {
    anchorX: number
    scale: number
    modelHeight: number
    perchGaps?: { wall: number; ceiling: number }
  } | null {
    if (!this.runtime) return null
    const scale = this.effectiveScale()
    const gaps = this.runtime.manifest.perchGaps
    return {
      anchorX: this.runtime.manifest.anchor[0],
      scale,
      // 攀爬时用它算"身体与墙面留多宽缝隙"（见 pet-core 的 perch.gapRatio）：
      // 缝隙得跟体型成比例，换个大小的模型才不用重新调
      modelHeight: this.runtime.manifest.canvas.h * scale,
      // **素材实测的留白比例**，由切图工具量出来写进清单——每只宠物都不一样
      // （五只 Shimeji 猫的 CLIMB 侧向留白 49~57px），用一个统一常量最坏差 6px，
      // 乘缩放就是屏幕上看得见的偏移。没有这个字段的模型由 PERCH_DEFAULTS 兜底。
      ...(gaps ? { perchGaps: gaps } : {}),
    }
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    // 只更新地面线，不重置水平位置（见 resetToGround 的 @param center）
    this.resetToGround(false)
  }

  setFpsCap(fps: number): void {
    this.fpsCap = Math.max(1, fps)
    if (this.app) this.app.ticker.maxFPS = this.fpsCap
    // 帧推进按真实时间累加，故这里不需要再同步任何 animationSpeed
  }

  getCurrentFps(): number {
    return this.app ? Math.round(this.app.ticker.FPS) : 0
  }

  isModelLoaded(): boolean {
    return this.loaded
  }

  // -------------------------------------------------------------------------
  // 语义接口
  // -------------------------------------------------------------------------

  playMotion(motionGroup: string, index?: number): void {
    const runtime = this.runtime
    if (!runtime || !this.loaded) return
    const anim = findAnimation(runtime, motionGroup, index)
    if (!anim) {
      log.warn(`[playMotion] 找不到动作组 "${motionGroup}" index=${index}`)
      return
    }
    this.playing = { anim, frame: 0, acc: 0, completed: false }
    // 眨眼调度器跟动画走：不同动作可以有各自的眨眼节奏；没声明就不眨
    const blinkMs = anim.params?.blink
    this.blinkScheduler = blinkMs && blinkMs > 0 ? new BlinkScheduler(blinkMs) : null
    this.blinkClosed = false
    if (anim.frames.length > 0) this.applyState(anim.frames[0])
    log.info(`[playMotion] group="${motionGroup}" index=${anim.index} 帧数=${anim.frames.length}`)
  }

  playRandomMotion(motionGroup: string): void {
    const runtime = this.runtime
    if (!runtime) return
    const idx = randomAnimationIndex(runtime, motionGroup)
    if (idx < 0) {
      log.warn(`[playRandomMotion] 组 "${motionGroup}" 没有可用动作`)
      return
    }
    this.playMotion(motionGroup, idx)
  }

  getMotionCount(motionGroup: string): number {
    const runtime = this.runtime
    if (!runtime) return 0
    const list = runtime.animationsByGroup.get(motionGroup)
    if (!list) return 0
    return list.filter((a) => a !== undefined).length
  }

  setExpression(expressionIndex: number): void {
    const binding = this.expressionBinding
    if (!binding || binding.parts.length === 0) return
    // 越界夹住：emotionMap 的索引来自注册表，改模型时可能对不上
    const idx = Math.max(0, Math.min(binding.parts.length - 1, expressionIndex))
    this.expressionPart = binding.parts[idx]
    if (this.currentState) this.applyState(this.currentState)
    log.info(`[setExpression] index=${expressionIndex} → ${this.expressionPart}`)
  }

  setMouthOpen(value: number): void {
    const binding = this.mouthBinding
    if (!binding) return
    const level = mouthLevelIndex(value, binding.levels.length)
    if (level < 0) return
    const partName = binding.levels[level]
    if (this.mouthPart === partName) return // 同档不重复刷
    this.mouthPart = partName
    if (this.currentState) this.applyState(this.currentState)
  }

  releaseLipSync(): void {
    const binding = this.mouthBinding
    if (!binding) return
    this.mouthPart = binding.levels[0]
    if (this.currentState) this.applyState(this.currentState)
  }

  // -------------------------------------------------------------------------
  // 命中
  // -------------------------------------------------------------------------

  /** 当前的模型变换（用于把画布坐标换算回清单坐标） */
  private modelTransform(manifest: SpriteManifest) {
    return {
      positionX: this.posX,
      positionY: this.posY,
      // 命中判定用**未施加程序化变换**的缩放：否则呼吸/浮动会让命中区一直抖
      scale: this.effectiveScale(),
      anchorX: manifest.anchor[0],
      anchorY: manifest.anchor[1],
      // 镜像必须进命中变换，否则宠物朝左时点击判定左右颠倒
      flipX: this.flipped,
    }
  }

  /**
   * 诊断用：把当前生效的姿态变换暴露出去。
   *
   * 命中判定走的是这一份变换（不含程序化浮动）。pet-lab 的命中区探测要拿它反算
   * 「某个屏幕点落在清单坐标的哪里」，才能独立于渲染器自己算一遍期望值——
   * 用渲染器的输出去验证渲染器自己是没有意义的。
   */
  getHitTransform(): {
    positionX: number
    positionY: number
    scale: number
    anchorX: number
    anchorY: number
    flipX: boolean
  } | null {
    if (!this.runtime) return null
    return this.modelTransform(this.runtime.manifest)
  }

  hitTest(localX: number, localY: number): HitArea {
    const runtime = this.runtime
    if (!runtime || !this.loaded) return null
    return hitTestPolygons(
      runtime.manifest,
      this.playing?.anim.group ?? null,
      localX,
      localY,
      this.modelTransform(runtime.manifest),
    )
  }

  /**
   * 可交互判定：先看声明的 hitArea，再看**当前帧实际绘制范围**。
   *
   * 兜底用 `root.getBounds()`（当前各层的实际绘制矩形）而不是清单画布——
   * 后者会把角色周围一圈透明区也算进去，鼠标在那里被吃掉、无法穿透到下层窗口。
   */
  isPointerOverModel(localX: number, localY: number): boolean {
    if (this.hitTest(localX, localY)) return true
    if (!this.root) return false
    try {
      const b = this.root.getBounds()
      return (
        localX >= b.x && localX <= b.x + b.width && localY >= b.y && localY <= b.y + b.height
      )
    } catch {
      return false
    }
  }

  getModelScreenBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.root) return null
    try {
      const b = this.root.getBounds()
      const pad = 12
      return {
        x: Math.max(0, b.x - pad),
        y: Math.max(0, b.y - pad),
        width: b.width + pad * 2,
        height: b.height + pad * 2,
      }
    } catch {
      return null
    }
  }

  destroy(): void {
    this.unloadModel()
    if (this.app) {
      this.app.ticker.remove(this.onTick)
      // 不销毁外部传入的 canvas（由 React 管理）
      this.app.destroy(false, { children: true, texture: true, baseTexture: true })
      this.app = null
    }
    log.info('[destroy] 渲染器已销毁')
  }
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

async function fetchJson(url: string): Promise<unknown> {
  // 不用 fetch()：打包模式下宠物窗口从 file:// 加载，Chromium 不允许 fetch 读 file://，
  // 而 XHR 可以（Live2D 的加载器也是走 XHR，所以这条路已被现网验证）。
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('GET', url, true)
    xhr.responseType = 'json'
    xhr.onload = () => {
      // file:// 下成功时 status 为 0，不能按"非 2xx 即失败"判
      if ((xhr.status >= 200 && xhr.status < 300) || (xhr.status === 0 && xhr.response)) {
        resolve(xhr.response)
      } else {
        reject(new Error(`读取失败 ${url}（HTTP ${xhr.status}）`))
      }
    }
    xhr.onerror = () => reject(new Error(`读取失败 ${url}`))
    xhr.send()
  })
}
