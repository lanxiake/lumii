import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { UpdaterService, setupUpdaterIpcHandlers } from '../updater-service'

/**
 * 自动更新扩展。
 *
 * 从 index.ts 的 initUpdaterService() 迁来，配置一项没改：
 * 发布渠道未配置前不自动检查（autoCheck: false），生产环境每 4 小时看一次。
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
      const service = new UpdaterService({
        autoCheck: false,
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
      if (process.env.NODE_ENV !== 'development') {
        service.startAutoCheck()
      }

      ctx.log.info('自动更新已启动')
    },
  }),
}
