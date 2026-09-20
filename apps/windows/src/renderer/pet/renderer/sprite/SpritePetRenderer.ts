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
  bobOffset,
  breatheScale,
  findAnimation,
  hitTestPolygons,
  mouthLevelIndex,
  nodAngle,
  parseAtlasIndex,
  randomAnimationIndex,
  applyOverrides,
  resolveSpriteRuntime,
  snapPixelScale,
  swayAngle,
  validateSpriteManifest,
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

  /** 锚点在画布上的逻辑位置（程序化浮动不改它，命中判定也不受浮动影响） */
  private posX = 0
  private posY = 0
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
    this.centerModel()

    // 载入后先摆出默认姿态；编排器随后会 playMotion('Idle')
    this.applyState(runtime.defaultState)
    log.info(`[loadModel] 模型加载完成 ${config.id}（${textures.size} 张纹理）`)
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
    } else {
      this.expressionBinding = null
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
      this.maybeCompleteOnce(p)
      return
    }

    const frameDuration = 1000 / Math.max(1, p.anim.fps)
    p.acc += deltaMS
    let advanced = false
    while (p.acc >= frameDuration) {
      p.acc -= frameDuration
      if (p.anim.kind === 'loop') {
        p.frame = (p.frame + 1) % frames.length
      } else if (p.frame < frames.length - 1) {
        p.frame += 1
      } else {
        break
      }
      advanced = true
    }
    if (advanced) this.applyState(frames[p.frame])
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

  /** 程序化原语：每 tick 按当前动画的 params 求值 */
  private applyProcedural(): void {
    const root = this.root
    const p = this.playing
    if (!root) return

    const params = p?.anim.params
    if (!params) {
      root.position.set(this.posX, this.posY)
      root.rotation = 0
      root.scale.set(this.effectiveScale())
      return
    }

    const t = performance.now() / 1000
    // pet-core 的纯函数求值；未声明的原语返回 0 / 1，叠加起来就是恒等
    const bob = params.bob !== undefined ? bobOffset(t, params.bob) : 0
    const sway = params.sway !== undefined ? swayAngle(t, params.sway) : 0
    const nod = params.nod !== undefined ? nodAngle(t, params.nod) : 0
    const breathe = params.breathe !== undefined ? breatheScale(t, params.breathe) : 1

    root.position.set(this.posX, this.posY + bob)
    root.rotation = sway + nod
    root.scale.set(this.effectiveScale() * breathe)
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

  private centerModel(): void {
    if (!this.app) return
    this.posX = this.app.renderer.width / 2
    this.posY = this.app.renderer.height / 2
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

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    this.centerModel()
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
