/**
 * WebGL 能力检测
 *
 * 设计依据：00-修订版设计 §4（WebGL 检测，不支持直接阻止进入并提示）
 * Live2D 渲染依赖 WebGL，集显/虚拟机/远程桌面可能不可用。
 */

export interface WebGLCheckResult {
  supported: boolean
  /** 不支持时的原因（用于提示） */
  reason?: string
  /** WebGL 版本（1 或 2，0 表示不支持） */
  version: 0 | 1 | 2
}

/** 检测当前环境的 WebGL 支持情况 */
export function checkWebGLSupport(): WebGLCheckResult {
  try {
    const canvas = document.createElement('canvas')
    const gl2 = canvas.getContext('webgl2')
    if (gl2) {
      return { supported: true, version: 2 }
    }
    const gl1 =
      canvas.getContext('webgl') ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null)
    if (gl1) {
      return { supported: true, version: 1 }
    }
    return {
      supported: false,
      version: 0,
      reason: '当前设备或显卡驱动不支持 WebGL，无法渲染 Live2D 宠物',
    }
  } catch (err) {
    return {
      supported: false,
      version: 0,
      reason: `WebGL 检测异常：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
