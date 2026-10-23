import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import {
  setCloudSyncManager,
  setCloudSyncWorkspaceChangedHandler,
} from '../../../main/kernel/cloud-sync-contract'
import { CloudSyncManager } from './impl/sync-manager'
import { SyncScheduler } from './impl/sync-scheduler'
import { registerCloudSyncIpc } from './impl/sync-ipc'

/**
 * 云同步扩展。
 *
 * 实现全在 `impl/`，核心只认 `main/kernel/cloud-sync-contract.ts` 里的接口与访问器。
 * IPC（`cloudSync:*`）也由这里注册：停用后设置页的云同步区块随 `OfficialExtensionGate`
 * 一起消失，不存在「没有 handler」的窗口。
 *
 * 时序约束：
 * 1. 管理器与 IPC 同步创建/注册，status 事件订阅不会落空；
 * 2. 调度器**不能**在这里 start：`start()` 惰性读工作空间目录，必须等工作空间 getter
 *    就绪。start 仍由核心在配置阶段之后调（`scheduler.start()` 自己读已保存配置）。
 */
export const cloudSyncExtension = {
  manifest: {
    id: 'com.lumii.cloud-sync',
    name: '云同步',
    version: '0.1.0',
    description: '把用户文件与记忆同步到自建 Git 仓库',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    // 官方可选扩展：由 build-official-extensions.mjs 打包，启动时同步到 ~/.lumii/extensions
    origin: 'official' as const,
    main: './main.js',
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.cloud-sync',
    provides: ['cloudSync', 'syncScheduler'],
    apply(ctx) {
      const manager = new CloudSyncManager()
      const scheduler = new SyncScheduler(manager)

      setCloudSyncManager(manager)
      setCloudSyncWorkspaceChangedHandler(() => scheduler.onWorkspaceChanged())

      // 冲突检测 → 驱动 Agent 处理。Agent 此时可能还没创建，用延迟绑定的 getter，
      // 回调真正触发时才会解析到实例。
      manager.setOnConflictDetected((conflict) => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge || !bridge.isInitialized) {
          ctx.log.warn(`检测到冲突但 Agent Runtime 未就绪，仅创建目标等待心跳驱动（${conflict.files.length} 个文件）`)
          return
        }
        // executeSyncConflictGoal 内部有 in-flight 守卫，不重入
        void bridge.executeSyncConflictGoal().then(
          (summary) => {
            if (summary) ctx.log.info(`冲突 Agent 处理完成: ${summary}`)
          },
          (err) => {
            ctx.log.error('冲突 Agent 处理异常', err)
          },
        )
      })

      // 设置页改配置 → 按新间隔重启调度（配置已由 sync-config 落盘）
      registerCloudSyncIpc(
        { handle: (channel, listener) => ctx.registerIpc?.(channel, listener) },
        manager,
        {
          getMainWindow: () => ctx.get(S.mainWindow)?.get() ?? null,
          onConfigChanged: (cfg) => scheduler.start(cfg),
        },
      )

      // 真正的 teardown：热卸载/禁用/卸载扩展时停掉调度器与文件监听，
      // 并把访问器清空——否则 IPC/工具层还会拿旧实例继续手动同步。
      ctx.effect(() => {
        scheduler.stop()
        setCloudSyncManager(null)
        setCloudSyncWorkspaceChangedHandler(null)
      })

      ctx.provide(S.cloudSync, manager)
      ctx.provide(S.syncScheduler, scheduler)
      ctx.log.info('云同步已装配（调度器等待配置就绪后启动）')
    },
  }),
}

// 外部扩展加载器按 `export default { manifest, definition }` 读取。
export default cloudSyncExtension
