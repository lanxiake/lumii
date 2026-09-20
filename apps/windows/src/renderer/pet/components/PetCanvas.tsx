/**
 * PetCanvas - 宠物渲染画布组件
 *
 * 设计依据：00-修订版设计 §2.3（穿透 hitTest）/ §4（WebGL 检测）
 *
 * 职责：
 *  - 全屏透明 canvas，挂载 Live2dPetRenderer
 *  - WebGL 检测 → 不支持回调降级
 *  - Cubism Core 加载 → 缺失回调降级
 *  - 模型加载（从注册表）
 *  - mousemove → hitTest → reportHover（穿透控制）
 *  - 点击命中区域 → 触发 tapMotion
 *  - 拖拽移动模型位置
 *
 * 通过 ref 暴露 renderer 给上层（PetLipSync/PetOrchestrator 在 Phase 2 使用）。
 */

import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react'
import { Live2dPetRenderer, CubismCoreMissingError } from '../renderer/live2d/Live2dPetRenderer'
import { SpritePetRenderer } from '../renderer/sprite/SpritePetRenderer'
import type { PetRendererProvider } from '../renderer/types'
import { checkWebGLSupport } from '../utils/webgl-check'
import { ensureCubismCore } from '../utils/cubism-core-loader'
import { getPetModelConfig } from '../config/pet-model-registry'
import type { PetModelConfig } from '../config/pet-model-types'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
import { estimateVelocity, isThrowable, stepThrow, type DragSample, type ThrowBody } from '@mtbot/pet-core'
import { petMetrics } from '../telemetry/pet-metrics'
import type { PetHoverUpdate } from '../../../shared/pet-mode'
import { spawnClickFireworks, disposeClickFireworks } from './click-fireworks'

const log = {
  info: (...args: unknown[]) => console.log('[PetCanvas]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetCanvas]', ...args),
  error: (...args: unknown[]) => console.error('[PetCanvas]', ...args),
}

/** 降级状态：上层据此显示提示 */
export type PetCanvasDegradeReason =
  | { kind: 'webgl'; message: string }
  | { kind: 'core-missing'; message: string }
  | { kind: 'model-load-failed'; message: string }

export interface PetCanvasProps {
  /** 模型 ID（空取默认） */
  modelId?: string
  /** 降级回调（WebGL 不支持 / Core 缺失 / 模型加载失败） */
  onDegrade?: (reason: PetCanvasDegradeReason) => void
  /** 模型加载成功回调 */
  onModelLoaded?: (config: PetModelConfig) => void
  /**
   * 物理交互事件（场景 A 的抓取与落地）。
   *
   * 由上层转给编排器播「被拎起」/「落地」动作。**不接也照常工作**——
   * 抛物线与落地是画布自己的事，动作衔接才是编排的事，两者解耦。
   */
  onInteraction?: (event: PetInteractionEvent) => void
}

/** 物理交互事件 */
export type PetInteractionEvent =
  | { type: 'picked' }
  | { type: 'landed'; x: number; y: number }

/** 暴露给上层的句柄 */
export interface PetCanvasHandle {
  getRenderer(): PetRendererProvider | null
}

function reportModelHover(isHovering: boolean): void {
  window.electronAPI?.pet?.reportHover({
    componentId: 'live2d-model',
    isHovering,
  } satisfies PetHoverUpdate)
}

/** 将鼠标事件坐标转换为 canvas 局部坐标（CSS 像素，与 PIXI stage 一致） */
function toCanvasLocal(e: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  }
}

export const PetCanvas = forwardRef<PetCanvasHandle, PetCanvasProps>(
  ({ modelId, onDegrade, onModelLoaded, onInteraction }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const rendererRef = useRef<PetRendererProvider | null>(null)
    /** 模型配置：**必须先于渲染器拿到**，因为后端类型由它决定 */
    const [config, setConfig] = useState<PetModelConfig | null>(null)
    const [ready, setReady] = useState(false)
    /** 渲染器（PIXI app）是否已初始化，模型加载 effect 据此等待 */
    const [rendererReady, setRendererReady] = useState(false)
    /**
     * 后端类型。**配置未到位前是 null，不能默认成 'live2d'**：
     * 初始化 effect 只依赖它，若默认成 'live2d'，那么「首个模型就是 live2d」时
     * 类型从头到尾没变过，effect 不会跑，渲染器永远不会被创建。
     */
    const rendererType = config?.rendererType ?? null

    /**
     * 回调放进 ref。初始化 effect **不能依赖父组件传来的回调**——父组件每次渲染都可能
     * 给出新的函数身份，effect 就会重跑：先 destroy 再在同一个 canvas 上重建 PIXI，
     * 而那个 canvas 的 WebGL context 刚随 destroy 失效，结果是 init 完立刻
     * 「WebGL context lost」。这正是本文件一直警告的那个坑，实测踩过一次。
     */
    const onDegradeRef = useRef(onDegrade)
    const onModelLoadedRef = useRef(onModelLoaded)
    onDegradeRef.current = onDegrade
    onModelLoadedRef.current = onModelLoaded
    /**
     * 交互回调同样放 ref：它被鼠标 effect 用，而那个 effect 的依赖是 `[ready]`。
     * 直接当依赖会让父组件每次渲染都重装一遍鼠标监听（中途松手/丢失拖拽状态）。
     */
    const onInteractionRef = useRef(onInteraction)
    onInteractionRef.current = onInteraction
    /**
     * 拖拽状态。
     *
     * `groundY` 是**拖拽开始时宠物所在的高度**——它就是这只宠物的"桌面"。
     * 用屏幕底部当地面会让宠物落到一个从没待过的地方，用户视角里就是「掉出屏幕了」。
     *
     * `samples` 供释放时估速度；只看最后两个点会被鼠标事件间隔的不均匀坑到
     * （详见 pet-core 的 estimateVelocity）。
     */
    const dragRef = useRef<{
      active: boolean
      offsetX: number
      offsetY: number
      hit: boolean
      groundY: number
      samples: DragSample[]
    }>({
      active: false,
      offsetX: 0,
      offsetY: 0,
      hit: false,
      groundY: 0,
      samples: [],
    })
    /** 抛掷中的 rAF 句柄 */
    const throwRef = useRef<number | null>(null)

    useImperativeHandle(ref, () => ({
      getRenderer: () => rendererRef.current,
    }))

    // 1) 先取配置。后端类型由 rendererType 决定，所以这一步必须排在初始化之前。
    //
    // **不要在这里 setConfig(null)**：那会让 rendererType 短暂变成 null，canvas 的 key
    // 跟着变，于是每次切模型都换一次 canvas 元素、销毁一次 WebGL context。
    // 保留旧配置直到新配置到达；只有后端类型**真的变了**才该换 canvas。
    useEffect(() => {
      let cancelled = false
      void (async () => {
        const cfg = await getPetModelConfig(modelId ?? '')
        if (cancelled) return
        if (!cfg) {
          onDegradeRef.current?.({ kind: 'model-load-failed', message: '未找到模型配置（注册表为空？）' })
          return
        }
        setConfig(cfg)
      })()
      return () => {
        cancelled = true
      }
    }, [modelId])

    // 2) 按 rendererType 初始化对应后端。**依赖只有 rendererType**（见上方 ref 说明）。
    //
    // canvas 用 key={rendererType} 绑定：切换后端类型时 React 会换一个**新的 canvas 元素**。
    // 这是刻意的——renderer.init() 创建的 PIXI Application 绑定在 canvas 的 WebGL context 上，
    // 在同一个元素上销毁重建会拿到已丢失的 context（现有注释警告过的那个坑）。
    // 换元素则旧 context 随旧元素整体消亡，不存在"在坏 context 上重建"。
    // 同类型切换（live2d→live2d、sprite→sprite）时 key 不变、effect 不重跑，
    // 只走下面的"重载模型"分支。
    useEffect(() => {
      if (!rendererType) return
      let disposed = false
      const canvas = canvasRef.current
      if (!canvas) return

      const setup = async () => {
        const webgl = checkWebGLSupport()
        if (!webgl.supported) {
          log.warn(`[setup] WebGL 不支持: ${webgl.reason}`)
          onDegradeRef.current?.({ kind: 'webgl', message: webgl.reason ?? 'WebGL 不可用' })
          return
        }

        // Cubism Core 只服务 Live2D 后端。sprite 后端用普通纹理，不该被专有 Core 的
        // 加载失败连带拖下水——那是两件不相干的事。
        if (rendererType === 'live2d') {
          try {
            await ensureCubismCore()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.warn(`[setup] Cubism Core 加载失败: ${message}`)
            onDegradeRef.current?.({ kind: 'core-missing', message })
            return
          }
          if (disposed) return
        }

        const renderer =
          rendererType === 'sprite' ? new SpritePetRenderer() : new Live2dPetRenderer()
        await renderer.init({
          canvas,
          width: window.innerWidth,
          height: window.innerHeight,
        })
        if (disposed) {
          renderer.destroy()
          return
        }
        rendererRef.current = renderer
        setRendererReady(true)
        log.info(`[setup] 渲染器初始化完成（${rendererType}）`)
      }

      void setup()

      return () => {
        disposed = true
        rendererRef.current?.destroy()
        rendererRef.current = null
        setRendererReady(false)
        setReady(false)
      }
    }, [rendererType])

    // 3) 模型加载 / 热切换：渲染器就绪后加载配置里的模型（**不碰 WebGL context**）。
    // loadModel 内部已含"卸载旧模型 + 加载新模型"，故切换/切回都安全。
    useEffect(() => {
      if (!rendererReady || !config) return
      const renderer = rendererRef.current
      if (!renderer) return
      let cancelled = false

      const loadModel = async () => {
        try {
          const loadStart = performance.now()
          await renderer.loadModel(config)
          petMetrics.recordModelLoad(performance.now() - loadStart)
          if (cancelled) return
          setTapModelConfig(config)
          setReady(true)
          onModelLoadedRef.current?.(config)
          log.info(`[loadModel] 模型就绪 ${config.id}`)
        } catch (err) {
          if (cancelled) return
          if (err instanceof CubismCoreMissingError) {
            onDegradeRef.current?.({ kind: 'core-missing', message: err.message })
          } else {
            const message = err instanceof Error ? err.message : String(err)
            log.error(`[loadModel] 模型加载失败: ${message}`)
            onDegradeRef.current?.({ kind: 'model-load-failed', message })
          }
        }
      }

      void loadModel()
      return () => {
        cancelled = true
      }
    }, [rendererReady, config])

    // 视口尺寸变化
    useEffect(() => {
      const onResize = () => {
        rendererRef.current?.resize(window.innerWidth, window.innerHeight)
      }
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [])

    // 性能：失焦降帧（~15 FPS），聚焦恢复（60 FPS）
    useEffect(() => {
      if (!ready) return
      const renderer = rendererRef.current
      if (!renderer) return

      const onBlur = () => renderer.setFpsCap(15)
      const onFocus = () => renderer.setFpsCap(60)
      window.addEventListener('blur', onBlur)
      window.addEventListener('focus', onFocus)
      // 初始按当前焦点状态设定
      if (!document.hasFocus()) renderer.setFpsCap(15)

      return () => {
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('focus', onFocus)
      }
    }, [ready])

    // 鼠标交互：hover hitTest 上报 + 点击动作 + 拖拽
    useEffect(() => {
      if (!ready) return
      const renderer = rendererRef.current
      const canvas = canvasRef.current
      if (!renderer || !canvas) return

      const onMouseMove = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        if (dragRef.current.active) {
          renderer.setPosition(x - dragRef.current.offsetX, y - dragRef.current.offsetY)
          dragRef.current.samples.push({ x, y, t: performance.now() })
          // 采样窗只需要最近一小段，长拖时不清会让数组无限增长
          if (dragRef.current.samples.length > 200) dragRef.current.samples.shift()
          reportModelHover(true)
          return
        }
        reportModelHover(renderer.isPointerOverModel(x, y))
      }

      /** 停掉正在进行的抛掷（再抓住时、卸载时都要） */
      const cancelThrow = () => {
        if (throwRef.current !== null) {
          cancelAnimationFrame(throwRef.current)
          throwRef.current = null
        }
      }

      /**
       * 按初速度做抛物线。
       *
       * `dt` 上限 50ms：标签页切回来、断点续跑时两帧间隔可能是几秒，
       * 不夹住的话宠物会一步跨到屏幕外。
       */
      const startThrow = (from: { x: number; y: number }, v: { vx: number; vy: number }, groundY: number) => {
        let body: ThrowBody = { x: from.x, y: from.y, vx: v.vx, vy: v.vy }
        const bounds = { minX: 0, maxX: canvas.clientWidth, groundY }
        let last = performance.now()

        const step = () => {
          const now = performance.now()
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const r = stepThrow(body, dt, bounds)
          body = r.body
          renderer.setPosition(body.x, body.y)
          if (r.landed) {
            throwRef.current = null
            onInteractionRef.current?.({ type: 'landed', x: body.x, y: body.y })
            return
          }
          throwRef.current = requestAnimationFrame(step)
        }
        throwRef.current = requestAnimationFrame(step)
      }

      const onMouseDown = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        const hit = renderer.hitTest(x, y)
        const over = hit || renderer.isPointerOverModel(x, y)
        if (over) {
          reportModelHover(true)
          // 抓住正在飞的宠物：中断抛物线，不叠加
          cancelThrow()
          const pos = renderer.getPosition()
          dragRef.current = {
            active: true,
            offsetX: x - pos.x,
            offsetY: y - pos.y,
            hit: !!hit,
            groundY: pos.y,
            samples: [{ x, y, t: performance.now() }],
          }
          onInteractionRef.current?.({ type: 'picked' })
        }
      }

      const onMouseUp = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        const wasDrag = dragRef.current.active
        const startX = renderer.getPosition().x + dragRef.current.offsetX
        const startY = renderer.getPosition().y + dragRef.current.offsetY
        // 位移超阈值视为拖拽，否则视为点击（用 x/y 双轴距离判断，比单看 X 更准）
        const movedFar =
          Math.abs(x - startX) > 5 || Math.abs(y - startY) > 5
        const { groundY, samples } = dragRef.current
        dragRef.current.active = false
        dragRef.current.hit = false
        dragRef.current.samples = []
        // 点击（非拖拽）落在模型身上即触发互动：优先用命中的 hitArea，
        // 无命名 hitArea 的模型（如 mao_pro Name 全空）回退到 body，
        // 保证"点击宠物身上有反应"，不再因缺 hitArea 而静默。
        if (wasDrag && !movedFar) {
          const hit = renderer.hitTest(x, y)
          const over = hit || renderer.isPointerOverModel(x, y)
          if (over) {
            triggerTapMotion(renderer, hit ?? 'body')
            // 点击特效：在点击位置绽放一簇烟花（受鼠标点击开关控制）
            if (tapInteractionEnabled) spawnClickFireworks(e.clientX, e.clientY)
          }
          onInteractionRef.current?.({ type: 'landed', x: renderer.getPosition().x, y: renderer.getPosition().y })
        } else if (wasDrag) {
          // 拖过：按释放速度决定"抛出去"还是"原地落下"
          const v = estimateVelocity(samples)
          const pos = renderer.getPosition()
          if (isThrowable(v)) {
            log.info(`[onMouseUp] 抛出 v=(${v.vx.toFixed(0)}, ${v.vy.toFixed(0)}) px/s`)
            startThrow(pos, v, groundY)
          } else {
            log.info(`[onMouseUp] 速度不足（${Math.hypot(v.vx, v.vy).toFixed(0)} px/s），原地落下`)
            onInteractionRef.current?.({ type: 'landed', x: pos.x, y: pos.y })
          }
        }
        reportModelHover(renderer.isPointerOverModel(x, y))
      }

      const onMouseLeave = () => {
        if (!dragRef.current.active) reportModelHover(false)
      }

      // 滚轮缩放：挂到 window（canvas 为 pointer-events:none，收不到 wheel）
      const onWheel = (e: WheelEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        if (renderer.isPointerOverModel(x, y)) {
          e.preventDefault()
          renderer.adjustScaleByDelta?.(e.deltaY)
          log.info(`[onWheel] 缩放 deltaY=${e.deltaY}`)
        }
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      window.addEventListener('wheel', onWheel, { passive: false })
      canvas.addEventListener('mouseleave', onMouseLeave)
      return () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('wheel', onWheel)
        canvas.removeEventListener('mouseleave', onMouseLeave)
        reportModelHover(false)
        disposeClickFireworks()
      }
    }, [ready])

    return (
      <canvas
        // key 绑定后端类型：类型切换时换新元素（见上方初始化 effect 的说明）
        key={rendererType ?? 'pending'}
        ref={canvasRef}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none', // 穿透由主进程 setIgnoreMouseEvents 控制，canvas 自身不拦截
          background: 'transparent',
        }}
      />
    )
  },
)

PetCanvas.displayName = 'PetCanvas'

/** 命中区域 → tapMotion（当前模型 tapMotions 映射在 config，简化：直接用 hitArea 名作动作组兜底） */
let cachedTapModelConfig: PetModelConfig | null = null
export function setTapModelConfig(config: PetModelConfig | null): void {
  cachedTapModelConfig = config
}

/** 鼠标点击控制开关：关闭时点击宠物身体不触发互动动作（默认开启） */
let tapInteractionEnabled = true
export function setTapInteractionEnabled(enabled: boolean): void {
  tapInteractionEnabled = enabled
}

function triggerTapMotion(renderer: PetRendererProvider, hitArea: string): void {
  if (!tapInteractionEnabled) return
  const tapMotions = cachedTapModelConfig?.tapMotions?.[hitArea]
  if (tapMotions) {
    const [group, index] = Object.entries(tapMotions)[0] ?? []
    if (group) {
      renderer.playMotion(group, typeof index === 'number' ? index : undefined)
      return
    }
  }
  // 兜底：命中区域名对应的动作组存在就用它，否则退到 Tap/tap 组，
  // 再退到装饰动作组（如 mao_pro 的 $unnamed），保证点击总有可见反馈。
  const candidates = [
    hitArea,
    'Tap',
    'tap',
    'TapBody',
    cachedTapModelConfig?.idleMotionFallbackGroup ?? PET_MOTION_GROUP_UNNAMED,
  ]
  for (const group of candidates) {
    if (group && renderer.getMotionCount(group) > 0) {
      renderer.playRandomMotion(group)
      return
    }
  }
}

export default PetCanvas
