import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { UpdaterService, setupUpdaterIpcHandlers } from '../../../main/updater-service'

/**
 * 自动更新扩展。
 *
 * 从 index.ts 的 initUpdaterService() 迁来。
 * 生产默认 autoCheck + 每 4 小时检查；开发态关闭（仅打包产物可走 electron-updater）。
 *
 * 主窗口引用不在这里设——扩展激活时窗口还没创建。宿主在 createWindow 之后
 * 通过 `S.updater` 取回实例再 setMainWindow（见 index.ts 的 initUiStages）。
 */
export const updaterExtension = {
  manifest: {
    id: 'com.lumii.updater',
    name: '自动更新',
    version: '0.1.0',
    description: '检查、下载并安装新版本',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.updater',
    provides: ['updater'],
    apply(ctx) {
      // 开发态不自动查（electron-updater 只对打包产物有效）；
      // 生产默认开启，设置页「启动时检查更新」可再关。
      const isProd = process.env.NODE_ENV !== 'development'
      const service = new UpdaterService({
        autoCheck: isProd,
        checkInterval: 4 * 60 * 60 * 1000,
        autoDownload: false,
        autoInstall: false,
        allowPrerelease: false,
      })

      // 卸载/禁用时停掉定时检查。destroy() 幂等（stopAutoCheck + removeAllListeners），
      // performCleanup 里那句 destroy 可以在退出路径上重复调用
      ctx.effect(() => service.destroy())

      // 先提供服务再挂副作用：IPC 处理器或自动检查里若能读到 S.updater，必须已经可用
      ctx.provide(S.updater, service)

      setupUpdaterIpcHandlers(service)
      if (isProd) {
        service.startAutoCheck()
      }

      ctx.log.info('自动更新已启动')
    },
  }),
}
