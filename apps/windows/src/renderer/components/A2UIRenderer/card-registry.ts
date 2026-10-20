import type React from 'react'

import type { A2UIComponent } from './types'

/** 卡片动作回调（与 A2UIRenderer 的 onAction 同签名） */
export type ActionHandler = (componentId: string, action: string, payload?: unknown) => void

/** 插件卡片的渲染实现：统一吃 `{ component, onAction }` */
export type CardRenderer = React.FC<{
  component: A2UIComponent
  onAction?: ActionHandler
}>

/**
 * 内建卡片类型（与 `A2UIRenderer` 里的 switch 一一对应）。
 *
 * 这些由渲染器自己实现，**不接受插件注册**——否则插件可以把 `Text`、`Button`
 * 换掉，等于劫持整个渲染面。
 */
export const BUILTIN_CARD_TYPES: readonly string[] = [
  'Text',
  'Card',
  'Image',
  'Button',
  'List',
  'Divider',
  'Chart',
  'MathVisualizer',
  'AudioPlayer',
  'VideoPlayer',
  'FilePreview',
  'DataTable',
]

const registry = new Map<string, CardRenderer>()

export class CardRegistryError extends Error {
  name = 'CardRegistryError'
}

/**
 * 注册一种**插件**卡片类型。
 *
 * 规则：
 * - 与内建类型同名 → 抛错（防劫持）；
 * - 重复注册同一 type → 抛错，而不是后者静默生效（否则「谁生效」取决于加载顺序）；
 * - 返回注销函数，调用方（插件作用域）负责撤销。
 */
export function registerCard(type: string, renderer: CardRenderer): () => void {
  if (BUILTIN_CARD_TYPES.includes(type)) {
    throw new CardRegistryError(`"${type}" 是内建卡片类型，不允许被插件覆盖`)
  }
  if (registry.has(type)) {
    throw new CardRegistryError(`卡片类型 "${type}" 已被注册`)
  }

  registry.set(type, renderer)
  return () => {
    if (registry.get(type) === renderer) registry.delete(type)
  }
}

/** 取插件卡片的渲染实现；未注册返回 undefined（调用方回落内建 switch / fallback） */
export function getCardRenderer(type: string): CardRenderer | undefined {
  return registry.get(type)
}

/** 已注册的插件卡片类型（诊断/开发者面板用） */
export function listPluginCardTypes(): string[] {
  return [...registry.keys()].sort()
}

/** 仅测试用：清空注册表 */
export function __resetCardRegistryForTest(): void {
  registry.clear()
}
