/**
 * SelectionLayer.tsx - 划词层（全局单例）
 *
 * 挂在 GlobalModals 里（而不是 App.tsx）：它就是「全局浮层」这一类，
 * 且 App.tsx 是并行会话的热点文件，少一次冲突。
 *
 * 职责边界：拿快照 → 取注册表里的动作 → 渲染浮条或菜单 → 把动作需要的 API 递过去。
 * 动作自己不认识浮条，浮条也不认识动作。
 */

import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { SelectionToolbar, type SelectionBarItem } from './SelectionToolbar'
import { SelectionContextMenu } from './SelectionContextMenu'
import { SelectionBubble } from './SelectionBubble'
import { useSelectionWatcher } from './useSelectionWatcher'
import { getActionsFor } from './actions/registry'
import type { SelectionActionApi } from './actions/types'
import { insertQuote } from './quote-bridge'
import { closeBubble } from './bubble-store'
import {
  IFRAME_SELECTION_MARKER,
  WEBVIEW_SELECTION_CHANNEL,
  toHostPoint,
  toSelectionSnapshot,
  type WebviewSelectionEvent,
} from './webview-bridge'
import { writeClipboardText } from '../services/clipboard-service'

/**
 * 不经过鼠标的跳转。
 *
 * 鼠标点侧栏 / 点导航已经有 mousedown 兜着，不用列。这里只管程序化派发的那几条：
 * Agent 收到消息后主动切会话、新建会话、以及从设置页等处跳页。
 * 这些跳转不发生 mousedown，而旧选区所在的 DOM 已经卸载 —— 不收起的话，
 * 快照里的 rect 会指着一片新内容，浮条就飘在无关的地方。
 *
 * 这些事件由本层监听（而不是走 useSelectionWatcher 的 closeOnEvents）：
 * 它们要连气泡一起收，而 watcher 的 close 只收浮条/菜单。
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
   * 气泡有自己的一棵根节点：它的生命周期与浮条解耦（见 bubble-store），
   * 不能共用一个 ref —— 只挂一个 surface 的写法会让「气泡是否属于本层」
   * 的判定随浮条的开合而变。
   */
  const bubbleRef = useRef<HTMLDivElement>(null)

  /**
   * 打在自己身上的事件一律放行。
   * 不能用 stopPropagation 代替：document 上的捕获监听先于它们自己的处理器执行。
   */
  const shouldIgnoreEvent = useCallback((e: MouseEvent) => {
    const target = e.target
    if (!(target instanceof Node)) return false
    return Boolean(surfaceRef.current?.contains(target) || bubbleRef.current?.contains(target))
  }, [])

  const { view, close: closeView, showView } = useSelectionWatcher({ shouldIgnoreEvent })

  /**
   * 程序化跳转时浮条与气泡一起收（两处坐标都会失效，气泡在飞的请求也没了意义）。
   *
   * 注意这里**不是**给动作用的那个 close —— 动作的 `api.close()` 只收入口，
   * 不能顺手关气泡。L2 动作一执行入口就收，气泡正是其结果落点，跟着收等于
   * 「点完菜单什么都没发生」（菜单路径实测踩过：请求刚发出去 5ms 就被 abort）。
   */
  const closeAll = useCallback(() => {
    closeView()
    closeBubble()
  }, [closeView])

  /** 程序化跳转要连气泡一起收，所以监听里走 closeAll 而不是 watcher 的 close */
  useEffect(() => {
    for (const eventName of CLOSE_ON_EVENTS) {
      window.addEventListener(eventName, closeAll)
    }
    return () => {
      for (const eventName of CLOSE_ON_EVENTS) {
        window.removeEventListener(eventName, closeAll)
      }
    }
  }, [closeAll])

  /**
   * HTML 预览（`<webview>`）里的划词。
   *
   * 那个文档不在宿主里，上面那些 document 监听一概收不到它的事件 —— 由 guest 的
   * preload 把选区送过来（`src/preload/webview-selection.ts`），这里翻译坐标后
   * 走与宿主选区同一条路（见 webview-bridge.ts）。
   *
   * 两处 Electron 的脾气，都实测过（`verify/selection/probe-webview-preload.cjs`）：
   *
   * 1. **必须挂捕获阶段**：webview 的事件是 `new Event(name)` 派发的，`bubbles`
   *    默认 false，挂冒泡阶段一条也收不到。
   * 2. **归属只认 `e.target`**：事件就派发在 `<webview>` 元素上，target 即发信的那个。
   *    曾经拿 `e.frameId` 去比 `getWebContentsId()` —— 那是 `[processId, frameId]`，
   *    与 webContents id 不是同一套编号，比下来**恒不相等**，消息被静默丢光。
   */
  useEffect(() => {
    const onIpcMessage = (e: Event) => {
      const event = e as Event & { channel?: string; args?: unknown[] }
      if (event.channel !== WEBVIEW_SELECTION_CHANNEL) return

      const payload = (event.args?.[0] ?? null) as WebviewSelectionEvent | null
      if (!payload || typeof payload !== 'object') return

      // 页面上可能不止一个 webview（Wiki 抽屉也有），认错了坐标就整体漂移
      const frame = e.target
      if (!(frame instanceof Element) || frame.tagName !== 'WEBVIEW') return

      if (payload.type === 'close') {
        showView(null)
        return
      }

      const box = frame.getBoundingClientRect()
      const origin = { left: box.left, top: box.top }
      const snapshot = toSelectionSnapshot(payload, origin)
      if (!snapshot) return

      showView({
        snapshot,
        surface: payload.surface === 'menu' ? 'menu' : 'bar',
        point: toHostPoint(payload.point, origin),
      })
    }

    document.addEventListener('ipc-message', onIpcMessage, true)
    return () => document.removeEventListener('ipc-message', onIpcMessage, true)
  }, [showView])

  /**
   * 静态预览（`<iframe srcDoc>`：CSS / SVG）里的划词。
   *
   * 与上面 webview 那条是同一套报文，区别只在传输方式：iframe 没有 preload，
   * 靠注入脚本 + `postMessage`（见 IFRAME_SELECTION_SCRIPT）。
   */
  useEffect(() => {
    const onWindowMessage = (e: MessageEvent) => {
      const payload = e.data as (WebviewSelectionEvent & { marker?: string }) | null
      if (!payload || typeof payload !== 'object') return
      if (payload.marker !== IFRAME_SELECTION_MARKER) return

      const frames = [...document.querySelectorAll('iframe')] as HTMLIFrameElement[]
      const frame = frames.find((el) => el.contentWindow === e.source)
      if (!frame) return

      if (payload.type === 'close') {
        showView(null)
        return
      }

      const box = frame.getBoundingClientRect()
      const origin = { left: box.left, top: box.top }
      const snapshot = toSelectionSnapshot(payload, origin)
      if (!snapshot) return

      showView({
        snapshot,
        surface: payload.surface === 'menu' ? 'menu' : 'bar',
        point: toHostPoint(payload.point, origin),
      })
    }

    window.addEventListener('message', onWindowMessage)
    return () => window.removeEventListener('message', onWindowMessage)
  }, [showView])

  const api = useMemo<SelectionActionApi>(
    // close 只收入口（见 closeAll 的说明）：动作执行后气泡要接着显示结果
    () => ({ close: closeView, copy: writeClipboardText, appendQuote: insertQuote }),
    [closeView],
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

  // 气泡独立成枝：它的存活不取决于 view（L2 动作一执行浮条就收，结果还得出）
  const bubble = <SelectionBubble rootRef={bubbleRef} />

  if (!view) return bubble

  if (view.surface === 'menu') {
    return (
      <>
        {bubble}
        <SelectionContextMenu
          snapshot={view.snapshot}
          position={view.point ?? { x: 0, y: 0 }}
          api={api}
          rootRef={surfaceRef}
        />
      </>
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
    <>
      {bubble}
      <SelectionToolbar
        anchorRect={view.snapshot.anchorRect}
        items={items}
        onAction={handleBarAction}
        rootRef={surfaceRef}
      />
    </>
  )
}

export default SelectionLayer
