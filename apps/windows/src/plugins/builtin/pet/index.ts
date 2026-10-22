import { join } from 'node:path'

import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { registerPetModeIpc, isPetForceIgnore, disposePetModeIpc } from './pet-mode-ipc'

/**
 * 桌宠扩展（主进程侧）。
 *
 * ## 架构定位
 *
 * 这是一个**内建插件**（built-in plugin）：代码在主 bundle 里编译,但通过插件系统激活,
 * 可被用户禁用（设置 > 扩展）。禁用后:
 * - 桌宠窗口不创建
 * - 所有 pet:* IPC 通道不注册
 * - 全局快捷键不占用
 * - GPU 资源不占用
 *
 * 渲染层（`renderer/pet/`，13142 行）仍由现有路由提供，P4 才做 slot 化——
 * 所以现在桌宠「能禁用」但「不能独立升级」（要升级需更新整个应用）。
 *
 * ## 依赖与时序
 *
 * - **主窗口引用**: 通过 `S.mainWindow` 服务获取（避免循环依赖）
 * - **托盘服务**: 通过 `S.tray` 同步模式切换状态到托盘菜单
 * - **激活时机**: 等 `app:window-ready` 事件（无头模式下不激活）
 * - **Linux 屏蔽**: `registerPetModeIpc` 内部判断 `process.platform === 'linux'` 直接返回
 *
 * ## 资产依赖
 *
 * - `resources/pet-assets/` — Live2D 模型与动作配置（约 15.9MB）
 * - `resources/CubismSdkForWeb-5-r.1/` — Cubism Core WASM 运行时
 *
 * P1 阶段这些资产仍打包进安装包；P2 改为按需下载（manifest 声明 `assets: ['pet-assets']`,
 * 首次启用时检查并引导下载）。
 */
export const petExtension = {
  manifest: {
    id: 'com.lumii.pet',
    name: '桌面宠物',
    version: '0.1.0',
    description: '透明置顶窗口形态的桌宠，支持 Live2D 动画、语音互动与主动联系',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    // P2: assets: ['pet-assets', 'cubism-core'],
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.pet',
    provides: ['pet'],
    apply(ctx) {
      let started = false

      const setup = (): void => {
        if (started) return
        const mainWindowRef = ctx.get(S.mainWindow)
        if (!mainWindowRef?.get()) return
        started = true

        const getMainWindow = () => mainWindowRef.get()
        const getTray = () => ctx.get(S.tray)?.get() ?? null

        registerPetModeIpc(
          {
            getMainWindow,
            preloadPath: join(__dirname, '../preload/index.js'),
            rendererUrl: process.env.ELECTRON_RENDERER_URL,
            indexHtmlPath: join(__dirname, '../renderer/index.html'),
            onForceIgnoreChanged: (forceIgnore) => {
              getTray()?.updateForceIgnore(forceIgnore)
            },
            onModeChanged: (mode) => {
              // 所有切换路径（托盘/快捷键/控制坞/设置页）统一在此同步托盘文案与设置页状态
              const tray = getTray()
              tray?.updatePetMode(mode === 'pet')
              tray?.updateForceIgnore(isPetForceIgnore())
              const win = getMainWindow()
              if (win && !win.isDestroyed()) {
                win.webContents.send('pet-mode-changed', mode)
              }
            },
          },
          {
            // 通道挂在插件作用域上：停用桌宠时这些 handler 与监听一并摘掉
            handle: (channel, listener) => ctx.registerIpc?.(channel, listener),
            on: (channel, listener) => ctx.registerIpcListener?.(channel, listener),
          },
        )

        // 卸载/退出时销毁透明置顶窗口，释放 GPU 资源（与 performCleanup 里的调用同源，幂等）
        ctx.effect(() => {
          ctx.log.info('桌宠插件卸载，清理窗口与快捷键')
          disposePetModeIpc()
        })
        ctx.log.info('桌宠插件已激活（IPC + 全局快捷键已注册）')
      }

      // 等主窗口就绪后激活（无头模式或主窗创建失败时不激活）
      if (ctx.get(S.mainWindow)?.get()) setup()
      else ctx.on('app:window-ready', setup)
    },
  }),
}
