import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { startBrowserService, stopBrowserService } from '../browser-service'

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
 * ## 禁用的实现（P2 状态门，不是真热插拔）
 *
 * 服务启动与工具注册都不在 `apply()` 里，而是在两个核心模块中——用
 * `isExtensionActive('com.lumii.browser')` 决定接不接线：
 * - `kernel/stages/post-ready.ts`：`browserPluginEnabled` 为 false 时整段跳过
 *   （不走「启动失败」WARN，那看着像服务坏了）
 * - `bridge-tool-registrar.ts`：配置存在**且**插件启用才注册 browser.* 工具
 *
 * 仍是启动期判定：在设置里关掉要重启才生效（与扩展开关「重启后生效」一致）。
 * 真正的执行期激活需要工具动态注销（`toolRegistry` 无 unregister API），未做。
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
      // 工具要 registrar 的上下文（bridge 在 S7.4 才建），服务要配置就绪——都等
      // `agent:runtime-ready`。启动时 `post-ready.ts` 还会兜一次 start（幂等）。
      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge) return false
        ctx.effect(bridge.installBrowserTools())
        void startBrowserService()
        ctx.effect(() => {
          ctx.log.info('浏览器插件卸载，停止控制服务')
          void stopBrowserService()
        })
        return true
      }
      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }

      ctx.log.info('浏览器插件已加载（服务与工具随插件启停）')
    },
  }),
}
