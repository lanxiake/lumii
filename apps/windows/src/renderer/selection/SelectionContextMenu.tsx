/**
 * SelectionContextMenu.tsx - 划词右键菜单
 *
 * 复用会话列表/文件树那套 ContextMenu 的渲染与交互（毛玻璃、捕获阶段点外关闭），
 * items 从动作注册表来 —— 与浮条同一份定义，见 actions/registry.ts。
 */

import React from 'react'
import { createPortal } from 'react-dom'
import ContextMenu, { type ContextMenuItem } from '../pages/ChatPage/components/ContextMenu'
import type { SelectionSnapshot } from './snapshot'
import { getActionsFor } from './actions/registry'
import type { SelectionActionApi } from './actions/types'

interface SelectionContextMenuProps {
  snapshot: SelectionSnapshot
  /** 指针位置（右键点） */
  position: { x: number; y: number }
  api: SelectionActionApi
  /** 交给上层判断「这次点击是不是打在菜单上」 */
  rootRef: React.RefObject<HTMLDivElement>
}

export const SelectionContextMenu: React.FC<SelectionContextMenuProps> = ({
  snapshot,
  position,
  api,
  rootRef,
}) => {
  const items: ContextMenuItem[] = []
  let previousTier: string | null = null

  for (const action of getActionsFor('menu')) {
    const enabled = action.isEnabled ? action.isEnabled(snapshot) : true
    items.push({
      id: action.id,
      label: action.label,
      icon: action.icon,
      disabled: !enabled,
      // 换档位就分一条线：本地动作 / 单轮 LLM / Agent 三档的代价差一个量级
      separatorBefore: previousTier !== null && previousTier !== action.tier,
      onClick: () => {
        if (enabled) void action.run(snapshot, api)
      },
    })
    previousTier = action.tier
  }

  return createPortal(
    // 包一层只为拿到可判定的根节点（ContextMenu 的 ref 是它自己内部的）：
    // 没有它，点在菜单上的 mousedown 会先把整个菜单收掉，click 根本落不到菜单项上
    <div ref={rootRef}>
      <ContextMenu
        items={items}
        position={position}
        onClose={api.close}
        // 见 tokens.css 的 --z-selection：选区可能在文件预览弹窗等浮层之上
        zIndex="var(--z-selection)"
      />
    </div>,
    document.body,
  )
}

export default SelectionContextMenu
