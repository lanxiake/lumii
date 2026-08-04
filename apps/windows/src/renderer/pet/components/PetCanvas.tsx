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
import type { PetRendererProvider } from '../renderer/types'
import { checkWebGLSupport } from '../utils/webgl-check'
import { ensureCubismCore } from '../utils/cubism-core-loader'
import { getPetModelConfig } from '../config/pet-model-registry'
import type { PetModelConfig } from '../config/pet-model-types'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
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
}

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
  ({ modelId, onDegrade, onModelLoaded }, ref) => {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const rendererRef = useRef<Live2dPetRenderer | null>(null)
    const [ready, setReady] = useState(false)
    /** 渲染器（PIXI app）是否已初始化，模型加载 effect 据此等待 */
    const [rendererReady, setRendererReady] = useState(false)
    // 拖拽状态
    const dragRef = useRef<{ active: boolean; offsetX: number; offsetY: number; hit: boolean }>({
      active: false,
      offsetX: 0,
      offsetY: 0,
      hit: false,
    })

    useImperativeHandle(ref, () => ({
      getRenderer: () => rendererRef.current,
    }))

    // 一次性初始化渲染器（WebGL 检测 → Cubism Core → PIXI app）。
    // 关键：renderer.init() 创建的 PIXI Application 绑定在 canvas 的 WebGL context 上，
    // 绝不能随 modelId 变化而 destroy（会损坏 React 复用的 canvas，导致切模型后整个画面空白）。
    useEffect(() => {
      let disposed = false
      const canvas = canvasRef.current
      if (!canvas) return

      const setup = async () => {
        const webgl = checkWebGLSupport()
        if (!webgl.supported) {
          log.warn(`[setup] WebGL 不支持: ${webgl.reason}`)
          onDegrade?.({ kind: 'webgl', message: webgl.reason ?? 'WebGL 不可用' })
          return
        }

        try {
          await ensureCubismCore()
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          log.warn(`[setup] Cubism Core 加载失败: ${message}`)
          onDegrade?.({ kind: 'core-missing', message })
          return
        }
        if (disposed) return

        const renderer = new Live2dPetRenderer()
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
        log.info('[setup] 渲染器初始化完成')
      }

      void setup()

      return () => {
        disposed = true
        rendererRef.current?.destroy()
        rendererRef.current = null
        setRendererReady(false)
      }
    }, [onDegrade])

    // 模型加载 / 热切换：渲染器就绪后，modelId 变化只重载模型（不碰 WebGL context）。
    // loadModel 内部已含"卸载旧模型 + 加载新模型"，故切换/切回都安全。
    useEffect(() => {
      if (!rendererReady) return
      const renderer = rendererRef.current
      if (!renderer) return
      let cancelled = false

      const loadModel = async () => {
        try {
          const config = await getPetModelConfig(modelId ?? '')
          if (!config) {
            onDegrade?.({ kind: 'model-load-failed', message: '未找到模型配置（注册表为空？）' })
            return
          }
          const loadStart = performance.now()
          await renderer.loadModel(config)
          petMetrics.recordModelLoad(performance.now() - loadStart)
          if (cancelled) return
          setReady(true)
          onModelLoaded?.(config)
          log.info(`[loadModel] 模型就绪 ${config.id}`)
        } catch (err) {
          if (cancelled) return
          if (err instanceof CubismCoreMissingError) {
            onDegrade?.({ kind: 'core-missing', message: err.message })
          } else {
            const message = err instanceof Error ? err.message : String(err)
            log.error(`[loadModel] 模型加载失败: ${message}`)
            onDegrade?.({ kind: 'model-load-failed', message })
          }
        }
      }

      void loadModel()
      return () => {
        cancelled = true
      }
    }, [rendererReady, modelId, onDegrade, onModelLoaded])

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
          reportModelHover(true)
          return
        }
        reportModelHover(renderer.isPointerOverModel(x, y))
      }

      const onMouseDown = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        const hit = renderer.hitTest(x, y)
        const over = hit || renderer.isPointerOverModel(x, y)
        if (over) {
          reportModelHover(true)
          const pos = renderer.getPosition()
          dragRef.current = {
            active: true,
            offsetX: x - pos.x,
            offsetY: y - pos.y,
            hit: !!hit,
          }
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
        dragRef.current.active = false
        dragRef.current.hit = false
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
