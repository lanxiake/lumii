/**
 * 文件预览内容缩放工具
 *
 * 纯函数，供 FilePreviewModal 与相关预览组件复用。
 */

/** 缩放下限（50%） */
export const ZOOM_MIN = 0.5
/** 缩放上限（300%） */
export const ZOOM_MAX = 3
/** 缩放步进（每档 10%，与浏览器 Ctrl+= 习惯一致） */
export const ZOOM_STEP = 0.1

/**
 * 将缩放值收敛到 [ZOOM_MIN, ZOOM_MAX] 并按 0.1 取整，消除浮点累计误差
 */
export function clampZoom(value: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 10) / 10))
}

/**
 * 为 html-static 沙箱（CSS/SVG 原文直渲）注入缩放样式。
 *
 * CSS zoom 无法穿透 iframe 元素边界（不会缩放内部文档，已实测验证），
 * 只能在 srcDoc 内部注入 <style>body{zoom:...}</style>：
 * SVG 原文经 HTML 解析为 body 内联 svg，CSS 原文则渲染为 body 文本，
 * 两种情况对 body 设置 zoom 均生效。
 */
export function buildZoomedSrcDoc(content: string, zoom: number): string {
  if (zoom === 1) return content
  return `<style>body{zoom:${zoom}}</style>${content}`
}
