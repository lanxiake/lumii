/**
 * A2UI 渲染器 — 从 A2UI JSON spec 渲染原生 React 组件
 *
 * 规格必须已经过 `normalizeA2UISpec` 收窄（`parseA2UIBlocks` 里统一做），所以这里
 * 的组件可以假定字段形状正确；仍保留渲染期兜底，因为插件注册的卡片不经过收窄。
 */

import React from 'react'

import { getCardRenderer, type ActionHandler } from './card-registry'
import type { A2UIComponent, A2UISpec } from './types'
import { ChartComponent } from './Chart'
import { DataTableComponent } from './DataTable'
import styles from './A2UIRenderer.module.css'

// ---------------------------------------------------------------
// 组件分发
// ---------------------------------------------------------------

const ComponentDispatch: React.FC<{ component: A2UIComponent; onAction?: ActionHandler }> = ({ component, onAction }) => {
  // 插件卡片优先：统一吃 { component, onAction }
  const PluginCard = getCardRenderer(component.type)
  if (PluginCard) return <PluginCard component={component} onAction={onAction} />

  // 内建卡片（插件无法覆盖这些 type，见 card-registry）
  switch (component.type) {
    case 'Chart':
      return <ChartComponent {...component} />
    case 'DataTable':
      return <DataTableComponent {...component} />
    default:
      return <div className={styles['a2ui-fallback']}>未知组件类型: {(component as { type: string }).type}</div>
  }
}

// ---------------------------------------------------------------
// 主渲染器
// ---------------------------------------------------------------

interface A2UIRendererProps {
  spec: A2UISpec
  onAction?: ActionHandler
}

export const A2UIRenderer: React.FC<A2UIRendererProps> = ({ spec, onAction }) => {
  if (!spec.components || spec.components.length === 0) return null
  return (
    <div className={styles['a2ui-surface']}>
      {spec.components.map((comp) => (
        <ComponentDispatch key={comp.id} component={comp} onAction={onAction} />
      ))}
    </div>
  )
}
