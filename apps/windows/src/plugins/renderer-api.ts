import { registerCard } from '../renderer/components/A2UIRenderer/card-registry'
import { registerSlot } from '../renderer/components/slots/slot-registry'

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
}

export interface RendererPlugin {
  /** 必须与主进程 manifest.id 一致：启停状态按它对齐 */
  id: string
  /** 返回清理函数；禁用时调用，槽位条目随之注销 */
  setup(api: RendererPluginApi): () => void
}

export const rendererApi: RendererPluginApi = { registerSlot, registerCard }
