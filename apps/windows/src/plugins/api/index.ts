/**
 * 插件架构的**对外唯一入口**。
 *
 * 核心侧只从这里拿插件相关的能力与类型：
 * - `defineServiceAccessor` —— 核心 ↔ 插件的运行期通路；
 * - `createIpcTable` —— 插件内注册 IPC 的唯一写法；
 * - `RendererPlugin` / `RendererPluginApi` —— 渲染层半边契约（内置与客户端插件同一形状）。
 *
 * 插件侧也从这个入口取类型：`import type { RendererPlugin } from '@/plugins/api'`。
 * 目录里除此之外的文件都属实现细节。
 */
export { defineServiceAccessor, type ServiceAccessor } from './service'
export {
  createIpcTable,
  type IpcHandler,
  type IpcRegistrarLike,
  type IpcTable,
} from './ipc'
export { rendererApi, type RendererPlugin, type RendererPluginApi } from './renderer'
