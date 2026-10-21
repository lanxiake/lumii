import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'

/**
 * 浏览器控制扩展（CDP + 扩展中继）。
 *
 * ## 架构定位
 *
 * 内建插件，可禁用。禁用后：
 * - 浏览器控制服务不启动（CDP 不监听、Chromium 不启动）
 * - 浏览器工具不注册（`browser_navigate` 等工具不可用）
 * - 扩展中继服务不启动
 *
 * ## 依赖与时序
 *
 * - **浏览器可执行文件**: 依赖系统已安装的 Chrome/Edge/Brave，或环境变量 `LUMII_BROWSER_EXECUTABLE`
 * - **激活时机**: 等 `app:ready`（`post-ready.ts` S8 阶段启动服务）
 *
 * ## 核心逻辑
 *
 * 1. **浏览器控制服务** (`browser-service.ts`):
 *    - 通过 CDP (Chrome DevTools Protocol) 控制本机浏览器
 *    - 默认端口：CDP 18791、扩展中继 18793
 *    - 支持 `LUMII_BROWSER_EXECUTABLE` / `LUMII_BROWSER_NO_SANDBOX` 环境变量覆盖
 *
 * 2. **工具注册** (`bridge-browser-tools.ts`):
 *    - `browser_navigate` / `browser_click` / `browser_type` 等
 *    - 通过 `getBrowserContext()` 获取运行时上下文
 *
 * 3. **扩展中继** (`extension-relay.ts`):
 *    - 支持 Chrome 扩展与 Agent 通信（可选，启动失败不阻塞主服务）
 *
 * ## P1 vs P2
 *
 * - P1: 包装成插件，支持禁用/启用，核心逻辑不动（服务启动在 `post-ready.ts`，
 *   工具注册在 `bridge-tool-registrar.ts`）
 * - P2: 服务启动与工具注册迁移到插件内（`ctx.provide(BROWSER_SERVICE)` +
 *   `ctx.registerTool(...)`），按需激活
 *
 * ## 为什么 P1 不做热插拔
 *
 * 浏览器服务在 `post-ready.ts` 里启动，这是 S8 阶段（bridge 已初始化、IPC 已注册）。
 * 工具注册在 `bridge-tool-registrar.ts` 的构造期完成（通过 `getBrowserContext` 判断
 * 是否注册）。要做真正的热插拔需要：
 * 1. 将 `startBrowserService` 移到插件 `apply(ctx)`
 * 2. 将工具注册从 bridge 构造期移到插件激活期
 * 3. 支持工具动态注销（目前 `toolRegistry` 无 unregister API）
 *
 * P1 先做声明式包装，P2 再做执行期迁移。
 */
export const browserExtension = {
  manifest: {
    id: 'com.lumii.browser',
    name: '浏览器控制',
    version: '0.1.0',
    description: 'CDP 浏览器自动化与扩展中继（browser_navigate/click/type 等工具）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.browser',
    provides: ['browser'],
    apply(ctx) {
      // 浏览器服务实际启动在 `post-ready.ts`（S8 阶段），工具注册在
      // `bridge-tool-registrar.ts` 构造期。本插件作为"声明式开关"存在：
      // - 启用时：服务正常启动，工具正常注册
      // - 禁用时：P2 改造后在此处跳过服务启动与工具注册
      //
      // P1 阶段禁用插件 = 代码不加载，但 `post-ready.ts` 照旧执行，
      // 浏览器服务照旧启动——所以 P1 禁用插件**不影响**浏览器功能。
      //
      // 为什么不在这里调 `startBrowserService`：
      // 1. 服务启动需要 app ready（主窗口已创建、IPC 已注册）
      // 2. 工具注册在 bridge 构造期（早于 app:ready）
      // 3. 移动启动点会破坏现有初始化顺序，且工具注册缺 unregister API
      //
      // P1 目标：包装 + 文档完善，不改行为；P2 才做真正的按需激活。

      ctx.log.info('浏览器插件已加载（服务启动由 post-ready.ts 执行）')

      // P2: 禁用时停止服务
      // ctx.effect(() => {
      //   stopBrowserService()
      //   ctx.log.info('浏览器插件卸载，已停止浏览器服务')
      // })
    },
  }),
}
