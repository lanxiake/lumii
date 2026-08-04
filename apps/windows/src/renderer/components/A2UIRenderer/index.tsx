/**
 * A2UI 渲染器 — 从 A2UI JSON spec 渲染原生 React 组件
 */

import React from 'react'
import type {
  A2UISpec,
  A2UIComponent,
  A2UIText,
  A2UICard,
  A2UIImage,
  A2UIButton,
  A2UIList,
  A2UIDivider,
} from './types'
import { ChartComponent } from './Chart'
import { MathVisualizerComponent } from './MathVisualizer'
import { AudioPlayerComponent } from './AudioPlayer'
import { VideoPlayerComponent } from './VideoPlayer'
import { FilePreviewComponent } from './FilePreview'
import { DataTableComponent } from './DataTable'
import styles from './A2UIRenderer.module.css'

// ---------------------------------------------------------------
// 基础组件
// ---------------------------------------------------------------

const TextComponent: React.FC<A2UIText> = ({ content, variant }) => {
  const className = variant === 'heading'
    ? styles['a2ui-heading']
    : variant === 'caption'
      ? styles['a2ui-caption']
      : styles['a2ui-text']
  return <p className={className}>{content}</p>
}

const CardComponent: React.FC<A2UICard & { onAction?: ActionHandler }> = ({ title, subtitle, components, onAction }) => (
  <div className={styles['a2ui-card']}>
    {title && <div className={styles['a2ui-card-title']}>{title}</div>}
    {subtitle && <div className={styles['a2ui-card-subtitle']}>{subtitle}</div>}
    {components && components.map((comp) => (
      <ComponentDispatch key={comp.id} component={comp} onAction={onAction} />
    ))}
  </div>
)

const ImageComponent: React.FC<A2UIImage> = ({ src, alt, width, height }) => (
  <img
    className={styles['a2ui-image']}
    src={src}
    alt={alt || ''}
    width={width}
    height={height}
    loading="lazy"
    onClick={() => src && window.open(src, '_blank')}
  />
)

const ButtonComponent: React.FC<A2UIButton & { onAction?: ActionHandler }> = ({ id, label, variant, disabled, onAction }) => (
  <button
    className={`${styles['a2ui-button']} ${styles[`a2ui-button-${variant || 'primary'}`] || ''}`}
    disabled={disabled}
    onClick={() => onAction?.(id, 'click', { label })}
  >
    {label}
  </button>
)

const ListComponent: React.FC<A2UIList & { onAction?: ActionHandler }> = ({ items, ordered, onAction }) => {
  const Tag = ordered ? 'ol' : 'ul'
  return (
    <Tag className={styles['a2ui-list']}>
      {items.map((item) => (
        <li key={item.id}>
          <ComponentDispatch component={item} onAction={onAction} />
        </li>
      ))}
    </Tag>
  )
}

const DividerComponent: React.FC = () => <hr className={styles['a2ui-divider']} />

const FallbackComponent: React.FC<{ type: string }> = ({ type }) => (
  <div className={styles['a2ui-fallback']}>未知组件类型: {type}</div>
)

// ---------------------------------------------------------------
// 组件分发
// ---------------------------------------------------------------

type ActionHandler = (componentId: string, action: string, payload?: unknown) => void

const ComponentDispatch: React.FC<{ component: A2UIComponent; onAction?: ActionHandler }> = ({ component, onAction }) => {
  switch (component.type) {
    case 'Text':
      return <TextComponent {...component} />
    case 'Card':
      return <CardComponent {...component} onAction={onAction} />
    case 'Image':
      return <ImageComponent {...component} />
    case 'Button':
      return <ButtonComponent {...component} onAction={onAction} />
    case 'List':
      return <ListComponent {...component} onAction={onAction} />
    case 'Divider':
      return <DividerComponent />
    case 'Chart':
      return <ChartComponent {...component} />
    case 'MathVisualizer':
      return <MathVisualizerComponent {...component} />
    case 'AudioPlayer':
      return <AudioPlayerComponent {...component} />
    case 'VideoPlayer':
      return <VideoPlayerComponent {...component} />
    case 'FilePreview':
      return <FilePreviewComponent {...component} />
    case 'DataTable':
      return <DataTableComponent {...component} />
    default:
      return <FallbackComponent type={(component as { type: string }).type} />
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
