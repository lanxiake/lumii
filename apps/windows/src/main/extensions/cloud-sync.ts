import { definePlugin } from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { S } from '../kernel/services'
import { CloudSyncManager } from '../cloud-sync/sync-manager'
import { SyncScheduler } from '../cloud-sync/sync-scheduler'
import { setCloudSyncManager, setCloudSyncWorkspaceChangedHandler } from '../cloud-sync/sync-accessor'

/**
 * 云同步扩展。
 *
 * 这一片**只搬生命周期，不搬实现**：`sync-manager` / `sync-scheduler` / 18 个
 * cloud-sync 文件原地不动，扩展负责「谁来创建、谁来回调、谁来销毁」。
 * 这正是「先接线后搬家」——先让云同步能被关掉，再谈把 5000 行搬进插件目录。
 *
 * 时序上的两个约束（不是巧合，是既有代码的要求）：
 * 1. 管理器必须在 `setupIpcHandlers()` 之前创建，否则 `registerCloudSyncIpcHandlers`
 *    订阅不到 status 事件 —— 扩展在 S1b 激活，早于它，满足。
 * 2. 调度器**不能**在这里 start：`syncScheduler.start()` 惰性读工作空间目录，
 *    必须等配置就绪。start 仍留在 index.ts 的配置阶段之后。
 */
export const cloudSyncExtension = {
  manifest: {
    id: 'com.lumii.cloud-sync',
    name: '云同步',
    version: '0.1.0',
    description: '把用户文件与记忆同步到自建 Git 仓库',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
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

      // 真正的 teardown：热卸载/禁用时停掉调度器与文件监听。
      // 不做的话，卸载扩展后同步仍在后台跑——只是启动路径上看不出来
      ctx.effect(() => scheduler.stop())

      ctx.provide(S.cloudSync, manager)
      ctx.provide(S.syncScheduler, scheduler)
      ctx.log.info('云同步已装配（调度器等待配置就绪后启动）')
    },
  }),
}
