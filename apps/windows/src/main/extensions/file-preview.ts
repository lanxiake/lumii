import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import type { PreviewWindowManagerDeps } from '../file-preview/preview-window-manager'
import { registerFilePreviewWindowIpc } from '../file-preview/preview-window-ipc'

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
 * - **激活时机**: `app:ready` 后,非无头模式下注册 IPC
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
 *    - 无头模式下跳过预览窗口初始化
 *
 * ## P1 vs P2
 *
 * - **P1**（包装式）：只声明插件，IPC 注册仍在核心模块里，禁用不影响功能
 * - **P2**（IPC 迁移式，当前实现）：IPC 注册逻辑迁移到插件内，导出 `registerFilePreviewIpc` 函数，
 *   调用点用 `isExtensionActive('com.lumii.file-preview')` 决定接不接线
 *   - 禁用插件 = 不注册 IPC，预览窗口不可用
 *
 * ## 迁移检查清单
 *
 * - [x] 创建插件文件（`extensions/file-preview.ts`）
 * - [x] 将 `registerFilePreviewWindowIpc` 逻辑迁移到插件导出函数
 * - [x] 复用 `preview-window-ipc.ts` 的注册逻辑
 * - [x] 调用点接入插件状态门（`index.ts` L1454）
 * - [ ] 端到端验证：禁用后重启，`file-preview:open` 应报 no handler
 */
export const filePreviewExtension = {
  manifest: {
    id: 'com.lumii.file-preview',
    name: '文件预览',
    version: '0.2.0',
    description: '独立窗口预览文件（文本/图片/Markdown/代码等）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.file-preview',
    provides: ['file-preview'],
    apply(ctx) {
      ctx.log.info('文件预览插件已启动')
    },
  }),
}

/**
 * 注册文件预览 IPC（从 index.ts 迁移）。
 *
 * 由 index.ts 在 `app:ready` 后、非无头模式下调用。
 * 时序在插件 apply() 之后、Electron app 就绪后。
 */
export function registerFilePreviewIpc(deps: PreviewWindowManagerDeps): void {
  // 直接复用原有的注册逻辑。
  // **必须静态 import**：`require(...)` 会被原样打进 `out/main/index.js`，
  // 运行时按产物目录解析成 `out/file-preview/...`（不存在）——真启动就炸，tsc 看不见。
  registerFilePreviewWindowIpc(deps)
}
