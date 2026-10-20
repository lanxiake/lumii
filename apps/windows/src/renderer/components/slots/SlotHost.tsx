import React, { useSyncExternalStore } from 'react'

import { getSlotEntries, subscribeSlots } from './slot-registry'

export interface SlotHostProps<P = Record<string, unknown>> {
  /** slot 名，如 `dashboard.card` */
  name: string
  /** 传给每个条目的上下文 props（页面自己的数据/回调） */
  context?: P
  /** 一个条目都没有时渲染什么；默认什么都不渲染 */
  fallback?: React.ReactNode
  /** 包在条目外层的容器；默认不包（由页面自己控制布局） */
  wrap?: (children: React.ReactNode) => React.ReactNode
}

/**
 * 渲染一个 slot 的所有注册条目。
 *
 * 刻意做得很薄：**布局属于页面，不属于 slot**。页面决定把 slot 放在哪、
 * 用什么容器包（`wrap`）、传什么上下文（`context`）；slot 只负责「按顺序渲染谁」。
 *
 * 订阅用 `useSyncExternalStore`：插件在运行时注册/注销（热重载）时能即时反映，
 * 且服务端快照稳定，不会出现撕裂。
 */
export function SlotHost<P extends object = Record<string, unknown>>({
  name,
  context,
  fallback = null,
  wrap,
}: SlotHostProps<P>): React.ReactElement | null {
  const entries = useSyncExternalStore(
    subscribeSlots,
    () => getSlotEntries(name),
    () => getSlotEntries(name),
  )

  if (entries.length === 0) return <>{fallback}</>

  const nodes = entries.map((entry) => {
    const Component = entry.component as React.ComponentType<P>
    return (
      <React.Fragment key={entry.id}>
        <Component {...((context ?? {}) as P)} />
      </React.Fragment>
    )
  })

  return <>{wrap ? wrap(nodes) : nodes}</>
}
