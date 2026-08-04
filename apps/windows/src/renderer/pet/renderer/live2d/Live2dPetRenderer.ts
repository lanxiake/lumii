/**
 * Live2dPetRenderer - 基于 pixi-live2d-display 的 Live2D 渲染后端
 *
 * 设计依据：00-修订版设计 §2.7 / ADR-02（仅渲染+口型，不播音频）
 * 技术选型决策 D3：用 pixi-live2d-display + pixi.js@6（社区成熟方案）。
 *
 * 依赖 window.Live2DCubismCore（live2dcubismcore.min.js，Live2D 官方专有文件）。
 * Core 缺失时 loadModel 抛出可识别错误，由 PetCanvas 优雅降级为提示，不崩溃。
 */

import * as PIXI from 'pixi.js'
import type { Live2DModel as Live2DModelType } from 'pixi-live2d-display/cubism4'
import type {
  HitArea,
  PetRendererInitOptions,
  PetRendererProvider,
  PetMotionPlayedInfo,
} from '../types'
import type { PetModelConfig } from '../../config/pet-model-types'
import { PET_MOTION_GROUP_UNNAMED } from '../../config/pet-model-types'

const log = {
  info: (...args: unknown[]) => console.log('[Live2dPetRenderer]', ...args),
  warn: (...args: unknown[]) => console.warn('[Live2dPetRenderer]', ...args),
  error: (...args: unknown[]) => console.error('[Live2dPetRenderer]', ...args),
}

/** Cubism Core 缺失错误（PetCanvas 据此降级提示） */
export class CubismCoreMissingError extends Error {
  constructor() {
    super('live2dcubismcore.min.js 未加载（window.Live2DCubismCore 不存在）')
    this.name = 'CubismCoreMissingError'
  }
}

type Live2DModelClass = typeof Live2DModelType

/** pixi-live2d-display/cubism4 须在 Cubism Core 注入后再加载（模块顶层会检查全局） */
let live2DModelClass: Live2DModelClass | null = null

/**
 * 延迟加载 Live2DModel 类。调用前须已通过 ensureCubismCore() 注入 window.Live2DCubismCore。
 */
async function loadLive2DModelClass(): Promise<Live2DModelClass> {
  if (!live2DModelClass) {
    const mod = await import('pixi-live2d-display/cubism4')
    // 关键：默认 false 时，播放 NORMAL 优先级动作会调用 resetExpression()，
    // 把 setExpression 设置的表情立刻重置回默认 → 表情肉眼不可见。
    // 置为 true 后，动作与表情各自独立驱动，互不覆盖。
    mod.config.preserveExpressionOnMotion = true
    live2DModelClass = mod.Live2DModel
  }
  return live2DModelClass
}

/** 口型参数常见 ID（模型未声明 LipSync 组时的回退） */
const DEFAULT_LIP_SYNC_PARAM_IDS = ['ParamMouthOpenY', 'PARAM_MOUTH_OPEN_Y', 'ParamA']

/**
 * 口型输出总增益：整体收敛张口幅度。实机反馈（UG 模型对齐良好但张口略大）后
 * 下调约 20%，让闭合更自然。对 mao_pro 的 ParamA 另有 ×1.4 补偿（见 applyMouthParams），
 * 净效果仍略高于 UG，以抵消 ParamA 对小幅输入不敏感。
 */
const MOUTH_OUTPUT_SCALE = 0.6

// pixi-live2d-display 需要从 window.PIXI 取 Ticker 等；注册一次
function ensurePixiOnWindow(): void {
  const w = window as unknown as { PIXI?: typeof PIXI }
  if (!w.PIXI) {
    w.PIXI = PIXI
  }
}

/** 注册表占位符：解析为模型内未命名（空字符串 key）或多动作组 */
// 导出供编排器使用（定义在 pet-model-types.ts）
export { PET_MOTION_GROUP_UNNAMED } from '../../config/pet-model-types'

export class Live2dPetRenderer implements PetRendererProvider {
  private app: PIXI.Application | null = null
  private model: Live2DModelType | null = null
  private config: PetModelConfig | null = null
  private mouthValue = 0
  /**
   * 口型接管标志：setMouthOpen 被调用即置位，speaking 期间每帧无条件覆写嘴参数（含 0），
   * 把嘴部张口度完全从动作手里接管，避免 TTS 静音间隙被动作片段带动张合。
   * releaseLipSync() 时清除，嘴部交还动作驱动。
   */
  private lipSyncActive = false
  /** 当前模型 LipSync 组参数 ID（mao_pro=ParamA，shizuku=PARAM_MOUTH_OPEN_Y） */
  private lipSyncParamIds: string[] = [...DEFAULT_LIP_SYNC_PARAM_IDS]
  /**
   * 口型覆写钩子：挂在模型自身的 internalModel `beforeModelUpdate` 事件上。
   *
   * 关键（mao_pro 口型失效根因）：库在 PIXI.Ticker.shared 上驱动 internalModel.update()，
   * 其内部顺序为 motionManager.update()（此处待机动作把 ParamA 写 0）→ … → 发出
   * `beforeModelUpdate` → model.update() 刷新到网格。若在 app.ticker（另一条 ticker）上
   * 重写嘴参数，与 shared ticker 无固定先后，重写可能发生在动作清 0 之前 → 被覆盖，
   * 表现为"经常没口型"。改挂到 beforeModelUpdate：写入必落在动作/表情/物理之后、
   * model.update() 之前，动作再也无法覆盖口型。UG 待机无嘴曲线故此前也正常。
   */
  private readonly onBeforeModelUpdate = (): void => {
    if (this.lipSyncActive && this.model && this.loaded) {
      this.applyMouthParams(this.mouthValue)
    }
  }
  /** 已绑定 beforeModelUpdate 的 internalModel（用于卸载/换模型时解绑，避免泄漏） */
  private lipSyncHookTarget: { off: (e: string, fn: () => void) => void } | null = null
  private fpsCap = 60
  private loaded = false
  /** 用户通过滚轮调整的额外缩放倍数（叠加在自适应缩放上） */
  private userScaleFactor = 1.0
  /**
   * 自适应缩放确定的"基准 scale"（模型适配到屏幕合理尺寸后的实际 scale.y）。
   * 滚轮缩放以此为基准做相对倍率：finalScale = baseScale * userScaleFactor，
   * 避免直接用 config.scale（原始未适配值）导致滚轮一动就跳变、缩到极小。
   */
  private baseScale = 0
  /** 模型内多动作组 key（mao_pro 为 ""），由 loadModel 后扫描 definitions 得到 */
  private unnamedMotionGroupKey: string | null = null
  private motionPlayedListener: ((info: PetMotionPlayedInfo) => void) | null = null

  /** 订阅动作播放结果（编排器用于同步控制坞展示） */
  setMotionPlayedListener(listener: ((info: PetMotionPlayedInfo) => void) | null): void {
    this.motionPlayedListener = listener
  }

  async init(options: PetRendererInitOptions): Promise<void> {
    ensurePixiOnWindow()

    this.app = new PIXI.Application({
      view: options.canvas,
      width: options.width,
      height: options.height,
      backgroundAlpha: 0, // 透明背景，叠在桌面上
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
    })

    options.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      log.error('[init] WebGL context lost — 渲染将暂停，避免白屏崩溃')
      this.loaded = false
    })

    log.info(`[init] PIXI Application 创建完成 ${options.width}x${options.height}`)
    // 口型覆写改由 loadModel 后挂到模型自身的 beforeModelUpdate 事件（见 bindLipSyncHook），
    // 保证写入落在动作更新之后，避免待机动作把 ParamA 覆盖回 0。
  }

  isCubismCoreReady(): boolean {
    return typeof (window as unknown as { Live2DCubismCore?: unknown }).Live2DCubismCore !== 'undefined'
  }

  async loadModel(config: PetModelConfig): Promise<void> {
    if (!this.app) throw new Error('渲染器未初始化，请先 init()')
    if (!this.isCubismCoreReady()) {
      throw new CubismCoreMissingError()
    }

    // 卸载旧模型
    if (this.model) {
      this.unbindLipSyncHook()
      this.app.stage.removeChild(this.model)
      this.model.destroy()
      this.model = null
      this.loaded = false
    }

    log.info(`[loadModel] 开始加载模型 ${config.id} from ${config.modelUrl}`)
    const startedAt = performance.now()

    const Live2DModel = await loadLive2DModelClass()
    const model = await Live2DModel.from(config.modelUrl, {
      autoInteract: false, // 自己接管 hitTest / 拖拽
      // 关键：把每模型的待机组喂给库，库内 MotionManager.update() 会在任意动作播完后
      // 自动 startRandomMotion(groups.idle, IDLE)，实现"动作播完自动回到待机循环"。
      // 不传则库默认 groups.idle="Idle"，对非 Idle 命名的待机组会失效。
      idleMotionGroup: config.idleMotionGroup,
    })

    this.model = model
    this.config = config
    this.userScaleFactor = 1.0

    // 先用 registry scale 做初始设置，再自适应到合理尺寸（不超屏幕高度的 60%）
    model.scale.set(config.scale)
    model.anchor.set(0.5, 0.5)
    this.applyAdaptiveScale()
    this.centerModel()

    this.app.stage.addChild(model)
    this.loaded = true
    this.refreshMotionGroupIndex()
    this.refreshLipSyncParams()
    this.bindLipSyncHook()

    // 待机由库原生驱动：modelLoaded 后库已据 idleMotionGroup 自动 startRandomMotion(IDLE)，
    // 此处不再手动 playMotion(idle)——手动 NORMAL 触发会与库的 IDLE 预约冲突（被判 reserved 拦截）。

    const durationMs = Math.round(performance.now() - startedAt)
    log.info(`[loadModel] 模型加载完成 ${config.id} durationMs=${durationMs}`)
  }

  /**
   * 从 model3.json Groups.LipSync 解析嘴型驱动参数。
   * mao_pro 为 ParamA，shizuku 为 PARAM_MOUTH_OPEN_Y。
   */
  private refreshLipSyncParams(): void {
    const settings = this.model?.internalModel?.settings as
      | { groups?: { Target?: string; Name?: string; Ids?: string[] }[] }
      | undefined
    const lipGroup = settings?.groups?.find(
      (g) => g.Target === 'Parameter' && g.Name === 'LipSync',
    )
    if (lipGroup?.Ids?.length) {
      this.lipSyncParamIds = [...lipGroup.Ids]
      log.info(`[refreshLipSyncParams] ${this.lipSyncParamIds.join(', ')}`)
      return
    }
    this.lipSyncParamIds = [...DEFAULT_LIP_SYNC_PARAM_IDS]
    log.warn(`[refreshLipSyncParams] 未找到 LipSync 组，使用默认: ${this.lipSyncParamIds.join(', ')}`)
  }

  /**
   * 把口型覆写钩子挂到模型自身的 internalModel `beforeModelUpdate` 事件。
   * 该事件在库的 update() 内、motionManager/expression/physics 之后、model.update() 之前发出，
   * 因此此刻写入的嘴参数不会被待机动作（mao_pro 待机把 ParamA 写 0）覆盖。
   */
  private bindLipSyncHook(): void {
    const internal = this.model?.internalModel as unknown as
      | { on?: (e: string, fn: () => void) => void; off?: (e: string, fn: () => void) => void }
      | undefined
    if (!internal?.on || !internal.off) {
      log.warn('[bindLipSyncHook] internalModel 不支持事件订阅，口型可能被动作覆盖')
      return
    }
    internal.on('beforeModelUpdate', this.onBeforeModelUpdate)
    this.lipSyncHookTarget = { off: internal.off.bind(internal) }
    log.info('[bindLipSyncHook] 已挂载 beforeModelUpdate 口型覆写')
  }

  /** 解绑口型覆写钩子（换模型/销毁时调用），避免旧模型引用泄漏 */
  private unbindLipSyncHook(): void {
    if (this.lipSyncHookTarget) {
      try {
        this.lipSyncHookTarget.off('beforeModelUpdate', this.onBeforeModelUpdate)
      } catch {
        /* 已销毁 */
      }
      this.lipSyncHookTarget = null
    }
  }

  /** 将嘴开度写入全部 LipSync 参数 */
  private applyMouthParams(value: number): void {
    const coreModel = this.model?.internalModel?.coreModel as
      | { setParameterValueById?: (id: string, v: number) => void }
      | undefined
    if (!coreModel?.setParameterValueById) return
    const out = value * MOUTH_OUTPUT_SCALE
    for (const id of this.lipSyncParamIds) {
      try {
        // mao_pro 的 ParamA 对小幅输入不敏感，略增益以便肉眼可见
        const scaled = id === 'ParamA' ? Math.min(1, out * 1.4) : out
        coreModel.setParameterValueById(id, scaled)
      } catch {
        // 单参数失败不影响其余
      }
    }
  }

  /**
   * 扫描模型动作组定义，记录未命名组（空 key）供 $unnamed 占位符解析。
   */
  private refreshMotionGroupIndex(): void {
    const defs = this.getMotionDefinitions()
    if (!defs) {
      this.unnamedMotionGroupKey = null
      return
    }
    const keys = Object.keys(defs)
    const label = keys.map((k) => (k === '' ? '(unnamed)' : k)).join(', ')
    log.info(`[refreshMotionGroupIndex] 动作组: ${label}`)

    const idleCount = Array.isArray(defs.Idle) ? defs.Idle.length : 0
    if (Array.isArray(defs['']) && defs[''].length > idleCount) {
      this.unnamedMotionGroupKey = ''
      log.info(`[refreshMotionGroupIndex] $unnamed → (unnamed) count=${defs[''].length}`)
      return
    }

    let richestKey: string | null = null
    let richestCount = idleCount
    for (const k of keys) {
      const n = Array.isArray(defs[k]) ? defs[k]!.length : 0
      if (n > richestCount) {
        richestCount = n
        richestKey = k
      }
    }
    this.unnamedMotionGroupKey = richestKey
    if (richestKey !== null) {
      log.info(
        `[refreshMotionGroupIndex] $unnamed → ${richestKey === '' ? '(unnamed)' : richestKey} count=${richestCount}`,
      )
    }
  }

  /** 读取 motionManager.definitions（类型不安全，仅内部使用） */
  private getMotionDefinitions(): Record<string, unknown[] | undefined> | null {
    return (
      this.model?.internalModel?.motionManager?.definitions as
        | Record<string, unknown[] | undefined>
        | undefined
    ) ?? null
  }

  /**
   * 将注册表动作组名解析为模型内真实 key（$unnamed / 空串 → 扫描结果）。
   */
  private resolveMotionGroupKey(group: string): string {
    if (group === PET_MOTION_GROUP_UNNAMED || group === '') {
      const resolved = this.unnamedMotionGroupKey ?? this.config?.idleMotionGroup ?? 'Idle'
      return resolved
    }
    return group
  }

  /** 捕获 motion/expression 返回的 Promise，避免未处理 rejection 导致渲染进程崩溃 */
  private catchLive2dPromise(result: unknown, label: string): void {
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      void (result as Promise<unknown>).catch((err: unknown) => {
        log.warn(`[${label}] 异步失败: ${err instanceof Error ? err.message : String(err)}`)
      })
    }
  }

  /**
   * 自适应缩放：让模型高度不超过 canvas 高度的 78%（尽量大，避免虚拟人太小看不清）。
   * 先取 registry scale 渲染一帧拿到实际 bounds，再按比例调整；
   * 同时记录确定后的 scale 为 baseScale，供滚轮缩放做相对倍率。
   */
  private applyAdaptiveScale(): void {
    if (!this.model || !this.app) return
    const canvasH = this.app.renderer.height
    const maxH = canvasH * 0.78
    try {
      const bounds = this.model.getBounds()
      if (bounds.height > 0 && bounds.height > maxH) {
        const ratio = maxH / bounds.height
        const cur = this.model.scale.y
        const next = cur * ratio * this.userScaleFactor
        this.model.scale.set(next)
        log.info(`[applyAdaptiveScale] 模型高度 ${bounds.height.toFixed(0)} > 上限 ${maxH.toFixed(0)}，缩放 ${cur.toFixed(3)} → ${next.toFixed(3)}`)
      } else {
        this.model.scale.set(this.model.scale.y * this.userScaleFactor)
      }
      // 记录当前生效 scale 作为滚轮缩放基准（除去用户倍率，得到 userScaleFactor=1 时的基准）
      this.baseScale = this.model.scale.y / (this.userScaleFactor || 1)
    } catch {
      // getBounds 失败（模型尚未完全初始化）时保持原始 scale
      this.baseScale = this.model.scale.y
    }
  }

  /**
   * 滚轮缩放（渲染层统一入口，PetCanvas 调用）。
   * 以自适应确定的 baseScale 为基准做相对倍率，倍率范围 0.4~5.0：
   * finalScale = baseScale * userScaleFactor。
   * @param delta 正值放大，负值缩小（单位 wheel deltaY，自动归一化）
   */
  adjustScaleByDelta(delta: number): void {
    if (!this.model) return
    const FACTOR = 0.0015
    const change = 1 - delta * FACTOR
    this.userScaleFactor = Math.max(0.4, Math.min(5.0, this.userScaleFactor * change))
    const base = this.baseScale > 0 ? this.baseScale : this.config?.scale ?? 0.4
    this.model.scale.set(base * this.userScaleFactor)
    log.info(
      `[adjustScaleByDelta] userScale=${this.userScaleFactor.toFixed(3)} base=${base.toFixed(3)} final=${(base * this.userScaleFactor).toFixed(3)}`,
    )
  }

  private centerModel(): void {
    if (!this.app || !this.model) return
    this.model.position.set(this.app.renderer.width / 2, this.app.renderer.height / 2)
  }

  playMotion(motionGroup: string, index?: number): void {
    if (!this.model || !this.loaded) return
    const group = this.resolveMotionGroupKey(motionGroup)
    const count = this.getMotionCount(group)
    if (count === 0) {
      log.warn(`[playMotion] 动作组不存在或为空: config="${motionGroup}" resolved="${group === '' ? '(unnamed)' : group}"`)
      return
    }
    const resolvedIndex =
      typeof index === 'number' ? index : count > 1 ? Math.floor(Math.random() * count) : 0
    try {
      log.info(
        `[playMotion] group="${group === '' ? '(unnamed)' : group}" index=${resolvedIndex} count=${count}`,
      )
      // model.motion() 异步解析为 boolean：true=动作真正开始播放，false=被优先级拦截/加载失败。
      // 仅在真正播放后才通知监听方，避免控制坞展示与实际动作脱节（动作描述对不上）。
      const result = this.model.motion(group, resolvedIndex)
      this.handleMotionResult(result, motionGroup, resolvedIndex)
    } catch (err) {
      log.warn(`[playMotion] 同步异常 ${motionGroup}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 等待 model.motion() 的 Promise，仅在动作真正开始时通知监听方 */
  private handleMotionResult(result: unknown, motionGroup: string, index: number): void {
    if (result && typeof (result as Promise<boolean>).then === 'function') {
      void (result as Promise<boolean>)
        .then((started) => {
          if (started) {
            this.notifyMotionPlayed(motionGroup, index)
          } else {
            log.warn(`[playMotion] 动作未播放（被优先级拦截或加载失败）: group="${motionGroup}" index=${index}`)
          }
        })
        .catch((err: unknown) => {
          log.warn(`[playMotion] 异步失败: ${err instanceof Error ? err.message : String(err)}`)
        })
      return
    }
    // 同步返回（非 Promise）时退化为乐观通知
    this.notifyMotionPlayed(motionGroup, index)
  }

  /** 读取指定动作组内的动作数量（用于随机播放；读不到返回 0） */
  getMotionCount(motionGroup: string): number {
    const group = this.resolveMotionGroupKey(motionGroup)
    const defs = this.getMotionDefinitions()
    const arr = defs?.[group]
    return Array.isArray(arr) ? arr.length : 0
  }

  /**
   * 随机播放指定动作组内的一个动作。
   * 组内有多个动作时随机选 index，避免待机只播第一个；
   * 仅 1 个或读不到数量时退化为默认播放（等价 playMotion(group)）。
   */
  playRandomMotion(motionGroup: string): void {
    if (!this.model) return
    const count = this.getMotionCount(motionGroup)
    if (count > 1) {
      const index = Math.floor(Math.random() * count)
      this.playMotion(motionGroup, index)
    } else {
      this.playMotion(motionGroup, 0)
    }
  }

  /** 读取动作文件路径并通知监听方 */
  private notifyMotionPlayed(motionGroup: string, index: number): void {
    const group = this.resolveMotionGroupKey(motionGroup)
    const defs = this.getMotionDefinitions()
    const arr = defs?.[group]
    const entry = Array.isArray(arr) ? (arr[index] as { File?: string } | undefined) : undefined
    const fileName = entry?.File
    this.motionPlayedListener?.({ group: motionGroup, index, fileName })
  }

  setExpression(expressionIndex: number): void {
    if (!this.model || !this.loaded) {
      log.warn('[setExpression] 模型未加载，跳过')
      return
    }
    // 防御：模型本身没有 Expressions 定义时 expressionManager 为 undefined（如 shizuku）
    if (!this.model.internalModel?.motionManager?.expressionManager) {
      log.warn('[setExpression] 模型未定义 Expressions，无法切换表情')
      return
    }
    const settings = this.model.internalModel?.settings as
      | { expressions?: { name: string }[] }
      | undefined
    const expressions = settings?.expressions ?? []
    const byName = expressions[expressionIndex]?.name
    log.info(
      `[setExpression] index=${expressionIndex} name=${byName ?? '(unknown)'} total=${expressions.length}`,
    )
    try {
      this.catchLive2dPromise(this.model.expression(expressionIndex), 'setExpression:index')
      log.info(`[setExpression] 已派发 index=${expressionIndex}`)
    } catch (err) {
      log.warn(
        `[setExpression] index 同步异常: ${err instanceof Error ? err.message : String(err)}`,
      )
      if (byName) {
        try {
          this.catchLive2dPromise(this.model.expression(byName), 'setExpression:name')
          log.info(`[setExpression] 已派发 name=${byName}`)
        } catch (err2) {
          log.warn(
            `[setExpression] name 同步异常: ${err2 instanceof Error ? err2.message : String(err2)}`,
          )
        }
      }
    }
  }

  setMouthOpen(value: number): void {
    if (!this.model || !this.loaded) return
    this.mouthValue = Math.max(0, Math.min(1, value))
    this.lipSyncActive = true
    try {
      this.applyMouthParams(this.mouthValue)
    } catch (err) {
      log.warn(`[setMouthOpen] 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 结束口型接管：清除激活标志并把嘴归零一次，之后 beforeModelUpdate 钩子不再覆写，
   * 嘴部交还动作驱动。由 PetLipSync.stop() 在 speaking 结束/打断时调用。
   */
  releaseLipSync(): void {
    this.lipSyncActive = false
    this.mouthValue = 0
    if (!this.model || !this.loaded) return
    try {
      this.applyMouthParams(0)
    } catch (err) {
      log.warn(`[releaseLipSync] 失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  hitTest(localX: number, localY: number): HitArea {
    if (!this.model) return null
    try {
      // pixi-live2d-display 用 hitArea.Name 作 key，mao_pro 的 Name 全为空字符串，
      // 导致库的 hitTest() 返回 [""]（falsy），点击命中永远失败。
      // 绕过库的 name-keyed 实现：直接读 internalModel.getHitAreaDefs() 用 Id 做碰撞检测。
      const internalModel = this.model.internalModel as unknown as
        | {
            getHitAreaDefs?: () => { id: string; index: number }[]
            getDrawableBounds?: (
              index: number,
              bounds?: object,
            ) => { x: number; y: number; width: number; height: number }
          }
        | undefined
      const defs = internalModel?.getHitAreaDefs?.()
      if (defs && defs.length > 0) {
        for (const def of defs) {
          if (def.index < 0) continue
          const b = internalModel?.getDrawableBounds?.(def.index)
          if (!b) continue
          if (localX >= b.x && localX <= b.x + b.width && localY >= b.y && localY <= b.y + b.height) {
            return def.id
          }
        }
        return null
      }
      // 兜底：走库原生 hitTest（Name 有值的模型）
      const hits = this.model.hitTest(localX, localY)
      return hits && hits.length > 0 ? hits[0] || null : null
    } catch {
      return null
    }
  }

  /** 命中区域或外接矩形内均视为可交互（部分模型 hitArea 未配置时的兜底） */
  isPointerOverModel(localX: number, localY: number): boolean {
    if (this.hitTest(localX, localY)) return true
    if (!this.model) return false
    try {
      const bounds = this.model.getBounds()
      return (
        localX >= bounds.x &&
        localX <= bounds.x + bounds.width &&
        localY >= bounds.y &&
        localY <= bounds.y + bounds.height
      )
    } catch {
      return false
    }
  }

  resize(width: number, height: number): void {
    if (!this.app) return
    this.app.renderer.resize(width, height)
    this.centerModel()
  }

  setPosition(x: number, y: number): void {
    this.model?.position.set(x, y)
  }

  getPosition(): { x: number; y: number } {
    if (!this.model) return { x: 0, y: 0 }
    return { x: this.model.position.x, y: this.model.position.y }
  }

  /** 模型身体外接矩形（含少量边距，用于区域点击而非全屏） */
  getModelScreenBounds(): { x: number; y: number; width: number; height: number } | null {
    if (!this.model) return null
    try {
      const b = this.model.getBounds()
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

  setFpsCap(fps: number): void {
    this.fpsCap = Math.max(1, fps)
    if (this.app) {
      this.app.ticker.maxFPS = this.fpsCap
    }
  }

  getCurrentFps(): number {
    return this.app ? Math.round(this.app.ticker.FPS) : 0
  }

  isModelLoaded(): boolean {
    return this.loaded
  }

  /** 诊断：口型接管标志是否激活（beforeModelUpdate 钩子是否每帧覆写嘴参数）。false 说明嘴交还给动作驱动。 */
  isLipSyncActive(): boolean {
    return this.lipSyncActive
  }

  destroy(): void {
    this.unbindLipSyncHook()
    if (this.model) {
      this.model.destroy()
      this.model = null
    }
    if (this.app) {
      // 不销毁外部传入的 canvas（由 React 管理），仅销毁 PIXI app
      this.app.destroy(false, { children: true, texture: true, baseTexture: true })
      this.app = null
    }
    this.loaded = false
    log.info('[destroy] 渲染器已销毁')
  }
}
