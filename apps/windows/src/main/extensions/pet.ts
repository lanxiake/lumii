import { join } from 'node:path'

import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { registerPetModeIpc, isPetForceIgnore, disposePetModeIpc } from '../pet/pet-mode-ipc'

/**
 * 桌宠扩展（主进程侧）。
 *
 * 只接**主进程**这一段：独立透明窗口的创建、模式切换 IPC、托盘与设置页的状态同步。
 * 渲染层（`renderer/pet/`，13142 行）仍由现有路由提供，P4 才做 slot 化——
 * 所以 P3 完成后桌宠「能禁用」但「不能独立升级」。
 *
 * 时序：`registerPetModeIpc` 需要主窗口引用与 preload 路径，等 `app:window-ready`。
 * 无头模式下没有窗口，扩展自然不装配（与原先跳过注册一致）。
 */
export const petExtension = {
  manifest: {
    id: 'com.lumii.pet',
    name: '桌宠',
    version: '0.1.0',
    description: '独立透明窗口形态的桌宠与模式切换',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
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

        registerPetModeIpc({
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
        })

        // 卸载/退出时销毁透明置顶窗口，释放 GPU 资源（与 performCleanup 里的调用同源，幂等）
        ctx.effect(() => disposePetModeIpc())
        ctx.log.info('桌宠模式 IPC 已注册')
      }

      if (ctx.get(S.mainWindow)?.get()) setup()
      else ctx.on('app:window-ready', setup)
    },
  }),
}
