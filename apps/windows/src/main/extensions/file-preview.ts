import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 文件预览扩展。
 *
 * ## 架构定位
 *
 * 内建插件,可禁用。禁用后:
 * - 文件预览窗口无法打开
 * - 相关 IPC (`file-preview:open` / `close` / `getPayload`) 不可用
 * - 渲染层预览入口（如"打开预览"按钮）应隐藏或禁用
 *
 * ## 依赖与时序
 *
 * - **主窗口**: 预览窗口管理器需要 `getMainWindow()` 定位主窗口位置
 * - **Preload 脚本**: 预览窗渲染层需要 preload 与主进程通信
 * - **激活时机**: `app:ready` 后,非无头模式下注册 IPC（index.ts L1454）
 *
 * ## 核心逻辑
 *
 * 1. **预览窗口管理器** (`preview-window-manager.ts`):
 *    - 单例窗口: 只创建一个预览窗,重复打开时复用
 *    - 独立窗口: 带系统标题栏,可移出主窗口外
 *    - 载荷更新: 打开新文件时通知已存在的预览窗刷新
 *    - 窗口定位: 居中于主窗口所在屏幕的工作区（70% 宽度,80% 高度）
 *
 * 2. **IPC 注册** (`preview-window-ipc.ts`):
 *    - `file-preview:open`: 打开预览窗并传入载荷（fileName / fileId / filePath）
 *    - `file-preview:close`: 关闭预览窗
 *    - `file-preview:getPayload`: 预览窗渲染层拉取当前载荷
 *
 * 3. **渲染入口**:
 *    - 预览窗路由: `?mode=file-preview`
 *    - 主窗口触发: 文件列表/附件点击 → IPC → 预览窗打开
 *
 * 4. **无头模式处理**:
 *    - 无头模式下跳过预览窗口初始化（index.ts L1453）
 *
 * ## P1 vs P2
 *
 * - P1: 包装成插件,支持禁用/启用,核心逻辑不动（IPC 注册在 index.ts L1454,
 *   在 `app:ready` 后同步调用）
 * - P2: IPC 注册迁移到插件内（`ctx.registerIpc(...)`),预览窗口管理器改为按需激活,
 *   渲染层预览入口做容错（插件禁用时隐藏按钮）
 *
 * ## 为什么 P1 不做热插拔
 *
 * 文件预览的 IPC 注册在主进程启动阶段:
 * 1. `registerFilePreviewWindowIpc(...)` 在 index.ts L1454 调用（`app:ready` 后）
 * 2. 预览窗口管理器（PreviewWindowManager）在 IPC 注册时创建单例
 * 3. 渲染层主窗口的"打开预览"按钮无条件渲染
 *
 * 要做真正的热插拔需要:
 * 1. 将 IPC 注册从 index.ts 移到插件 `apply(ctx)`
 * 2. 预览窗口管理器改为按需激活（首次打开预览时创建）
 * 3. 渲染层预览入口做容错（插件禁用时隐藏"打开预览"按钮）
 * 4. 支持运行时注销 IPC（目前 ipcMain.handle 无对应的 `removeHandler` API）
 *
 * P1 先做声明式包装,P2 再做执行期迁移。
 */
export const filePreviewExtension = {
  manifest: {
    id: 'com.lumii.file-preview',
    name: '文件预览',
    version: '0.1.0',
    description: '独立窗口预览文件（文本/图片/Markdown/代码等）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.file-preview',
    provides: ['file-preview'],
    apply(ctx) {
      // 文件预览 IPC 实际注册在 `index.ts` L1454（registerFilePreviewWindowIpc）,
      // 在 `app:ready` 后同步调用。本插件作为"声明式开关"存在:
      // - 启用时: IPC 正常注册,预览窗口可打开
      // - 禁用时: P2 改造后在此处跳过 IPC 注册
      //
      // P1 阶段禁用插件 = 代码不加载,但 index.ts 照旧执行,IPC 照旧注册——
      // 所以 P1 禁用插件**不影响**文件预览功能。
      //
      // 为什么不在这里注册 IPC:
      // 1. IPC 注册时机在 `app:ready` 后（index.ts L1454）
      // 2. 预览窗口管理器在 IPC 注册时创建单例（preview-window-ipc.ts L27）
      // 3. 渲染层主窗口的"打开预览"按钮无条件渲染
      //
      // P1 目标: 包装 + 文档完善,不改行为; P2 才做真正的按需激活与热插拔。

      ctx.log.info('文件预览插件已加载（IPC 注册由 index.ts 完成）')

      // P2: 禁用时注销 IPC
      // ctx.effect(() => {
      //   ipcMain.removeHandler('file-preview:open')
      //   ipcMain.removeHandler('file-preview:close')
      //   ipcMain.removeHandler('file-preview:getPayload')
      //   previewWindowManager?.close()
      //   ctx.log.info('文件预览插件卸载,已注销 IPC')
      // })
    },
  }),
}
