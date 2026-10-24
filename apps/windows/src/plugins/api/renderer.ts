import { registerCard } from '../../renderer/components/A2UIRenderer/card-registry'
import { registerSlot } from '../../renderer/components/slots/slot-registry'
import { registerTimelineCard } from '../../renderer/pages/ChatPage/components/TimelineCards/registry'

/**
 * 渲染层插件契约。
 *
 * 一个插件目录里有两半：
 * - `index.ts`     主进程（manifest + apply(ctx)），注册 IPC / 定时器；
 * - `renderer.tsx` 渲染层（本文件定义的 `RendererPlugin`），注册槽位与卡片。
 *
 * 两半的启停由同一个开关驱动：主进程 `host.activate/stop`，渲染层执行
 * `setup()` 返回的清理函数（见 `renderer/sync.ts`）。
 *
 * **只给受控的最小面**，不给 `window.electronAPI` 全量：
 * 插件要调什么 IPC 由它自己的主进程半边提供，这条约束让「前后端一体」
 * 不至于变成「渲染层绕过主进程随便调」。
 */
export interface RendererPluginApi {
  registerSlot: typeof registerSlot
  registerCard: typeof registerCard

  /**
   * 注册一张**对话时间线卡片**：按工具名把一个工具调用单独渲染成卡片。
   *
   * 内置三张（转交 / 委托 / 任务完成）order 10–30，插件默认 100 ——
   * 插件只能补空缺，顶不掉内置卡片。匹配规则、是否露在「执行过程」折叠区外，
   * 都由注册项自己声明（见 `TimelineCards/registry.ts`）。
   */
  registerTimelineCard: typeof registerTimelineCard

  /**
   * 以下是**外部/客户端插件宿主**额外注入的能力（可选）。
   *
   * 内置插件的 `renderer.tsx` 直接 import React 与这些工具即可，不需要它们；
   * 外部插件是运行时读进来的裸 JS，拿不到模块系统，宿主才把这几样注入进去。
   * 类型放在同一处，是为了让两种宿主提供**同一形状**的 api（阶段 3b）。
   */
  React?: typeof import('react')
  ReactDOM?: typeof import('react-dom')
  Page?: typeof import('../../renderer/components/slots/PluginPage').PluginPage
  format?: typeof import('../../renderer/utils/format').pluginFormat
  storage?: ReturnType<typeof import('../../renderer/plugins/plugin-storage').createPluginStorage>
}

export interface RendererPlugin {
  /** 必须与主进程 manifest.id 一致：启停状态按它对齐 */
  id: string
  /** 返回清理函数；禁用时调用，槽位条目随之注销 */
  setup(api: RendererPluginApi): () => void
}

export const rendererApi: RendererPluginApi = { registerSlot, registerCard, registerTimelineCard }
