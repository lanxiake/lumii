/**
 * PetRendererProvider - 宠物渲染后端抽象接口
 *
 * 设计依据：00-修订版设计 §2.7（渲染后端可插拔），删去 startLipSync，改用 setMouthOpen
 * 与 AnalyserNode 口型方案对齐（ADR-03）。
 *
 * MVP 仅实现 Live2dPetRenderer（pixi-live2d-display），精灵帧后端留远期。
 */

import type { PetCoreRenderer, PetMotionPlayedInfo, ProceduralScales } from '@mtbot/pet-core'
import type { PetModelConfig } from '../config/pet-model-types'

/** hitTest 命中结果：命中的区域名（如 'Head' / 'Body'），未命中返回 null */
export type HitArea = string | null

export type { PetMotionPlayedInfo }

/** 渲染器初始化参数 */
export interface PetRendererInitOptions {
  /** 挂载的 canvas 元素 */
  canvas: HTMLCanvasElement
  /** 视口宽度（CSS 像素） */
  width: number
  /** 视口高度（CSS 像素） */
  height: number
}

/**
 * 宠物渲染后端统一接口。
 * 表现层（PetCanvas）只依赖此接口，不关心 Live2D / 精灵帧实现细节。
 */
export interface PetRendererProvider extends PetCoreRenderer {
  /** 初始化渲染器（创建 PIXI app / WebGL 上下文） */
  init(options: PetRendererInitOptions): Promise<void>

  /** 加载模型 */
  loadModel(config: PetModelConfig): Promise<void>

  /** 订阅动作实际播放结果（可选，Live2D 实现） */
  setMotionPlayedListener?(listener: ((info: PetMotionPlayedInfo) => void) | null): void

  /**
   * 设置程序化原语的倍率（可选，精灵后端实现）。
   *
   * 与 `setAgentActivityModulation` 是**同一层**的两路输入：那一路是"Agent 在忙什么"，
   * 这一路是"它自己的性格与精力"。倍率乘在**清单声明的参数**上，清单没声明原语的
   * 动作组不受影响（不凭空造动作）。
   */
  setProceduralScales?(scales: ProceduralScales): void

  /**
   * 命中测试：给定 canvas 局部坐标，返回命中的区域名。
   * 用于穿透 hover 恢复点击 + 点击触发动作。
   */
  hitTest(localX: number, localY: number): HitArea

  /**
   * 指针是否在模型可交互范围内（hitArea 或外接矩形兜底，用于拖拽/穿透恢复）。
   */
  isPointerOverModel(localX: number, localY: number): boolean

  /** 视口尺寸变化时调整 */
  resize(width: number, height: number): void

  /** 设置模型位置（拖拽移动，相对 canvas 的中心点偏移，CSS 像素） */
  setPosition(x: number, y: number): void

  /** 获取当前模型位置 */
  getPosition(): { x: number; y: number }

  /**
   * 水平镜像（可选，精灵后端的自主行走需要）。
   *
   * 素材通常只画一个朝向，向左走时要整体翻转。Live2D 后端不需要——它的模型自带
   * 朝向，且翻转会破坏变形器。命中判定必须跟着镜像一起翻，否则点击会左右颠倒。
   */
  setFlip?(flipX: boolean): void

  /**
   * 布局查询：锚点在清单坐标里的 X、当前缩放、模型屏幕高度（可选）。
   *
   * 自主行走要据此把「画布宽度」换算成「脚能走到哪」——锚点在脚底中心，
   * 左右各留 `anchorX × scale` 才是可达区间，用半个模型宽度会算歪。
   * `modelHeight` 给攀爬用：与墙面留的缝隙要跟体型成比例。
   *
   * `perchGaps`（有攀爬动作的模型才有）：CLIMB/CRAWL 两行的**素材留白占帧高的比例**，
   * 由切图工具量出来写进清单。**每只宠物都不一样**，几何侧据此覆盖兜底值——
   * 用统一常量最坏差 6px，乘缩放就是屏幕上看得见的偏移。
   */
  getLayout?(): {
    anchorX: number
    scale: number
    modelHeight: number
    perchGaps?: { wall: number; ceiling: number }
  } | null

  /**
   * 当前动作的**内容**相对锚点往四边伸出多少（屏幕像素，已含镜像与缩放）。
   *
   * 拖动时用它把宠物夹在视口里、并判断它贴住了哪条边——**不能用画布**：
   * 整个 `canvas` 是有留白的，H3 出的素材内容只占中间一块，拿画布当边界
   * 宠物会停在离屏幕边 20 多像素的地方，看着像没拖到位。
   *
   * 取的是当前正在播的那一组（拖动时是 `Picked`），姿势换了数也换。
   */
  getContentExtents?(): { left: number; right: number; top: number; bottom: number } | null

  /** 获取模型身体外接矩形（窗口坐标，用于 setShape 点击区域） */
  getModelScreenBounds(): { x: number; y: number; width: number; height: number } | null

  /** 设置渲染帧率上限（失焦降帧用） */
  setFpsCap(fps: number): void

  /** 滚轮缩放（delta 为 WheelEvent.deltaY，正值缩小，负值放大） */
  adjustScaleByDelta?(delta: number): void

  /** 读取当前实际 FPS（可观测指标 pet_render_fps） */
  getCurrentFps(): number

  /** 当前是否已成功加载模型 */
  isModelLoaded(): boolean

  /** 销毁渲染器，释放 WebGL/GPU 资源 */
  destroy(): void
}

/** 点击区域 → 动作回调（PetCanvas 注册，命中 hitArea 时触发） */
type TapHandler = (hitArea: string) => void
