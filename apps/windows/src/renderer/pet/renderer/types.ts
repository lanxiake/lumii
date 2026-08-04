/**
 * PetRendererProvider - 宠物渲染后端抽象接口
 *
 * 设计依据：00-修订版设计 §2.7（渲染后端可插拔），删去 startLipSync，改用 setMouthOpen
 * 与 AnalyserNode 口型方案对齐（ADR-03）。
 *
 * MVP 仅实现 Live2dPetRenderer（pixi-live2d-display），精灵帧后端留远期。
 */

import type { PetCoreRenderer, PetMotionPlayedInfo } from '@mtbot/pet-core'
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
export type TapHandler = (hitArea: string) => void
