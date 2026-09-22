/**
 * SelectionLayer.tsx - 划词层（全局单例）
 *
 * 挂在 GlobalModals 里（而不是 App.tsx）：它就是「全局浮层」这一类，
 * 且 App.tsx 是并行会话的热点文件，少一次冲突。
 *
 * 职责边界：拿快照 → 取注册表里的动作 → 渲染浮条或菜单 → 把动作需要的 API 递过去。
 * 动作自己不认识浮条，浮条也不认识动作。
 */

import React, { useCallback, useMemo, useRef } from 'react'
import { SelectionToolbar, type SelectionBarItem } from './SelectionToolbar'
import { SelectionContextMenu } from './SelectionContextMenu'
import { useSelectionWatcher } from './useSelectionWatcher'
import { getActionsFor } from './actions/registry'
import type { SelectionActionApi } from './actions/types'
import { insertQuote } from './quote-bridge'
import { writeClipboardText } from '../services/clipboard-service'

/**
 * 不经过鼠标的跳转（见 useSelectionWatcher 的 closeOnEvents）。
 *
 * 鼠标点侧栏 / 点导航已经有 mousedown 兜着，不用列。这里只管程序化派发的那几条：
 * Agent 收到消息后主动切会话、新建会话、以及从设置页等处跳页。
 * 这些跳转不发生 mousedown，而旧选区所在的 DOM 已经卸载 —— 不收起的话，
 * 快照里的 rect 会指着一片新内容，浮条就飘在无关的地方。
 */
const CLOSE_ON_EVENTS = [
  'mtbot:navigate-request',
  'mtbot:session-switch-request',
  'mtbot:session-create-request',
] as const

export const SelectionLayer: React.FC = () => {
  /**
   * 当前挂载的那个入口的根节点。浮条与菜单互斥，所以一个 ref 够用。
   */
  const surfaceRef = useRef<HTMLDivElement>(null)

  /**
   * 打在自己身上的事件一律放行。
   * 不能用 stopPropagation 代替：document 上的捕获监听先于它们自己的处理器执行。
   */
  const shouldIgnoreEvent = useCallback((e: MouseEvent) => {
    const el = surfaceRef.current
    return el !== null && e.target instanceof Node && el.contains(e.target)
  }, [])

  const { view, close } = useSelectionWatcher({ shouldIgnoreEvent, closeOnEvents: CLOSE_ON_EVENTS })

  const api = useMemo<SelectionActionApi>(
    () => ({ close, copy: writeClipboardText, appendQuote: insertQuote }),
    [close],
  )

  const handleBarAction = useCallback(
    (id: string) => {
      if (!view) return
      const action = getActionsFor('bar').find((a) => a.id === id)
      if (!action) return
      if (action.isEnabled && !action.isEnabled(view.snapshot)) return
      void action.run(view.snapshot, api)
    },
    [view, api],
  )

  if (!view) return null

  if (view.surface === 'menu') {
    return (
      <SelectionContextMenu
        snapshot={view.snapshot}
        position={view.point ?? { x: 0, y: 0 }}
        api={api}
        rootRef={surfaceRef}
      />
    )
  }

  // 非 hook 的普通计算，放在 null 分支之后：动作数很少，不值得 memo
  const items: SelectionBarItem[] = getActionsFor('bar').map((action) => {
    const enabled = action.isEnabled ? action.isEnabled(view.snapshot) : true
    return {
      id: action.id,
      label: action.label,
      icon: action.icon,
      disabled: !enabled,
      disabledReason: action.disabledReason,
    }
  })

  return (
    <SelectionToolbar
      anchorRect={view.snapshot.anchorRect}
      items={items}
      onAction={handleBarAction}
      rootRef={surfaceRef}
    />
  )
}

export default SelectionLayer
