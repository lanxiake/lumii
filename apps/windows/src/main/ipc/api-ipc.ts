/**
 * API 相关 IPC handlers (本地配置、用量、资讯、Agent 管理等)
 */
import { ipcMain, app } from 'electron'
import {
  readSoulFile,
  readUserMemoryFile,
  writeSoulFile,
  writeUserMemoryFile,
} from '../ipc/plugin-ipc'
import {
  loadProviderConfig,
  loadProviderSlotsConfig,
  saveProviderConfig,
  saveProviderSlotsConfig,
  loadSlotConfig,
  applyImageSlotToDrawEnv,
  isCapabilitySlot,
  type LocalProviderConfigView,
  type ProviderSlotsConfigView,
  type CapabilitySlot,
} from '../provider-config'
import { listProviderModels, testProviderConnection } from '../provider-probe'
import { getOpenAtLogin, setOpenAtLogin } from '../platform/autostart'
import { getFeatureAvailability } from '../platform/feature-probe'
import { FEATURE_BLOCK_MESSAGES } from '../../shared/feature-availability'
import { queryUsage, type UsageQuery } from '../usage-store'
import { getLatency } from '../provider-latency'
import { NEWS_PIPELINE_TASK_TEXT, NEWS_PIPELINE_SYSTEM_PROMPT } from '../seed-cron-jobs'
import {
  newsFeedAgentId,
  newsFeedConversationId,
  newsFeedConversationTitle,
  resolveNewsFeedJob,
} from '../news-feed-job'
import { diffFindings, listMaintenanceReports } from '../maintenance-report-store'
import {
  readActiveDashboardFeedSnapshot,
  readActiveDashboardFeedId,
  readDashboardFeedMeta,
  readDashboardFeedPage,
  readDashboardFeedBatches,
  ensureDashboardFeedMigrated,
  setActiveDashboardFeedId,
} from '../dashboard-feed-store'
import {
  listAgents,
  getAgentRecord,
  forkAgentRecord,
  updateAgentRecord,
  deleteAgentRecord,
} from '../agents-repo'
import type { AgentRuntimeBridge } from '../agent-runtime'
import { invalidateAgentInstancesForProviderChange } from '../agent-runtime'

interface ApiIpcDeps {
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
  getConfigManager: () => any // ConfigManager 实例
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

let deps: ApiIpcDeps | null = null

export function setApiIpcDeps(d: ApiIpcDeps): void {
  deps = d
}

export function registerApiIpcHandlers(): void {
  if (!deps) throw new Error('ApiIpc deps not set')

  deps.log.info('设置 API Server IPC 处理器')

  // --- AI 灵魂 / 个人记忆（本地文件，返回渲染层期望的 {success, data} 形态） ---
  ipcMain.handle('api:getSoulContent', async () => {
    try {
      const soul = await readSoulFile()
      return {
        success: true,
        data: soul ?? { content: '', updatedAt: new Date(0).toISOString() },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:updateSoulContent', async (_event, content: string) => {
    try {
      const result = await writeSoulFile(content ?? '')
      if (!result) return { success: false, error: '写入 AI 灵魂失败' }
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:getUserMemory', async () => {
    const mem = await readUserMemoryFile()
    return { success: true, data: mem ?? { content: '', updatedAt: new Date(0).toISOString() } }
  })

  ipcMain.handle('api:updateUserMemory', async (_event, content: string) => {
    const result = await writeUserMemoryFile(content ?? '')
    if (!result) return { success: false, error: '写入个人记忆失败' }
    return { success: true, data: result }
  })

  // === 本地 LLM Provider 配置（灵栖/Lumii：按能力槽 chat/vision/image） ===
  ipcMain.handle('provider:getConfig', async () => loadProviderSlotsConfig())

  ipcMain.handle('provider:setConfig', async (_event, cfg: ProviderSlotsConfigView | LocalProviderConfigView) => {
    if (!cfg || typeof cfg !== 'object') throw new Error('无效的 provider 配置')
    // 兼容旧单槽：无 chat/vision/image 字段时视为 chat
    if ('chat' in cfg || 'vision' in cfg || 'image' in cfg) {
      const slots = cfg as ProviderSlotsConfigView
      saveProviderSlotsConfig({
        chat: slots.chat ?? loadSlotConfig('chat'),
        vision: slots.vision ?? loadSlotConfig('vision'),
        image: slots.image ?? loadSlotConfig('image'),
      })
      applyImageSlotToDrawEnv()
    } else {
      saveProviderConfig(cfg as LocalProviderConfigView)
    }
    const saved = loadProviderSlotsConfig()
    const availableChatModels = saved.chat.enabled
      ? [saved.chat.modelId, ...(saved.chat.allowedModelIds ?? [])]
        .map((modelId) => modelId?.trim())
        .filter((modelId): modelId is string => Boolean(modelId))
      : []
    deps!.getAgentRuntimeBridge()?.clearInvalidSessionPreferredModels(availableChatModels)
    // 配置变更后销毁旧实例，避免继续走创建时快照的 Gateway/旧凭据
    invalidateAgentInstancesForProviderChange()
    return saved
  })

  ipcMain.handle('provider:listModels', async (_event, slot: CapabilitySlot, draftCfg?: LocalProviderConfigView) => {
    if (!isCapabilitySlot(slot)) throw new Error(`无效能力槽: ${slot}`)
    const cfg = draftCfg ?? loadSlotConfig(slot)
    const models = await listProviderModels(cfg)
    return { success: true, data: models }
  })

  ipcMain.handle('provider:testConnection', async (_event, slot: CapabilitySlot, draftCfg?: LocalProviderConfigView) => {
    if (!isCapabilitySlot(slot)) throw new Error(`无效能力槽: ${slot}`)
    const cfg = draftCfg ?? loadSlotConfig(slot)
    return testProviderConnection(slot, cfg)
  })

  // === 本地用量查询（Task 4.3）===
  ipcMain.handle('usage:query', async (_e, query: UsageQuery) => {
    try {
      return { success: true, data: await queryUsage(query) }
    } catch (error) {
      console.error('[IPC] usage:query 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // === 服务商首字节延迟（Task 4.4）===
  ipcMain.handle('usage:latency', () => ({ success: true, data: getLatency() }))

  // === Dashboard 通用 feed（资讯只是默认 feed，后续工作流可替换其内容）===
  ipcMain.handle('dashboard-feed:latest', async () => {
    try {
      await ensureDashboardFeedMigrated(await readActiveDashboardFeedId())
      return { success: true, data: await readActiveDashboardFeedSnapshot() }
    } catch (error) {
      console.error('[IPC] dashboard-feed:latest 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 读取 feed 元信息（标题/综述/更新时间），供概览页头部展示。
   */
  ipcMain.handle('dashboard-feed:meta', async (_event, feedId: string) => {
    try {
      const id = feedId ?? 'news'
      await ensureDashboardFeedMigrated(id)
      return { success: true, data: await readDashboardFeedMeta(id) }
    } catch (error) {
      console.error('[IPC] dashboard-feed:meta 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 滑动分页读取 feed 条目（时间倒序，游标分页）。
   * before 传上一页返回的 nextCursor；首屏传 null。
   */
  ipcMain.handle('dashboard-feed:page', async (_event, feedId: string, opts?: { limit?: number; before?: { timestamp: number; id: string } | null }) => {
    try {
      const id = feedId ?? 'news'
      await ensureDashboardFeedMigrated(id)
      return { success: true, data: await readDashboardFeedPage(id, opts ?? {}) }
    } catch (error) {
      console.error('[IPC] dashboard-feed:page 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 按期读取（期刊视图）：一期为一组，组内是该期推送的条目。
   * 概览页资讯卡用它渲染「第 N 期」式的分组，而不是一条无界流水。
   */
  ipcMain.handle(
    'dashboard-feed:batches',
    async (_event, feedId: string, opts?: { limit?: number; before?: { createdAt: string; id: string } | null }) => {
      try {
        const id = feedId ?? 'news'
        await ensureDashboardFeedMigrated(id)
        return { success: true, data: await readDashboardFeedBatches(id, opts ?? {}) }
      } catch (error) {
        console.error('[IPC] dashboard-feed:batches 失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  )

  /**
   * 手动「立即抓取」：与定时任务走同一条 Agent 驱动路径，复用相同的固定 sessionKey，
   * 两者在会话列表里是同一个会话，用户能看到 Agent 具体搜索/调用工具的完整过程。
   *
   * 会话与执行者都取自**当前承载资讯管线的那条定时任务**（`news-feed-job.ts`）：
   * 任务在定时任务页被改过执行者 / 改过指令时，手动抓取跟着一起变；
   * 任务被删时退回 `cron:news-pipeline` + 「灵栖情报」，手动抓取不因此失效。
   */
  ipcMain.handle('dashboard-feed:refresh', async () => {
    try {
      const agentRuntimeBridge = deps!.getAgentRuntimeBridge()
      if (!agentRuntimeBridge) throw new Error('Agent Runtime 未就绪')
      const job = resolveNewsFeedJob(agentRuntimeBridge.db)
      const convId = newsFeedConversationId(job)
      const agentId = newsFeedAgentId(job)
      agentRuntimeBridge.ensureConversationExists(convId, newsFeedConversationTitle(job))
      // 会话归属对齐执行者：侧栏据此把这条记录归到「情报」分组
      agentRuntimeBridge.conversationRepo.updateAgentParticipant(convId, agentId)
      const instanceId = await agentRuntimeBridge.createInstanceById(agentId, convId, convId)
      try {
        const systemPrompt = job?.systemPrompt?.trim() || NEWS_PIPELINE_SYSTEM_PROMPT
        const taskText = job?.taskText?.trim() || NEWS_PIPELINE_TASK_TEXT
        await agentRuntimeBridge.prompt(instanceId, `${systemPrompt}\n\n---\n\n${taskText}`)
      } finally {
        agentRuntimeBridge.destroy(instanceId)
      }
      return { success: true, data: { snapshot: await readActiveDashboardFeedSnapshot() } }
    } catch (error) {
      console.error('[IPC] dashboard-feed:refresh 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('dashboard-feed:set-active', async (_event, feedId: string) => {
    try {
      await setActiveDashboardFeedId(feedId)
      return { success: true, data: await readActiveDashboardFeedSnapshot() }
    } catch (error) {
      console.error('[IPC] dashboard-feed:set-active 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 维护体检报告（概览页「资产体检」卡片）。
   *
   * 一次返回最近 N 期 + 「最新一期 vs 上一期」的差分：差分在主进程算，
   * 因为它依赖 findings 的稳定 key 语义（`diffFindings`），渲染层不该重复实现一遍。
   */
  ipcMain.handle('maintenance-report:overview', async (_event, limit?: number) => {
    try {
      const reports = listMaintenanceReports({ limit: Math.max(1, Math.min(10, Math.trunc(limit ?? 5))) })
      const [latest, previous] = reports
      return {
        success: true,
        data: {
          reports,
          diff: latest && previous ? diffFindings(previous.findings, latest.findings) : null,
        },
      }
    } catch (error) {
      console.error('[IPC] maintenance-report:overview 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // === 开机启动 ===
  // 平台差异收敛到 platform/autostart.ts：Windows/macOS 走 Electron 的
  // setLoginItemSettings，Linux 走 XDG autostart（Electron 不支持该 API）。
  ipcMain.handle('app:getOpenAtLogin', async () => {
    const enabled = getOpenAtLogin()
    deps!.log.info('获取开机启动状态:', enabled)
    return enabled
  })

  ipcMain.handle('app:setOpenAtLogin', async (_event, enable: boolean) => {
    if (typeof enable !== 'boolean') {
      throw new Error('参数必须为布尔值')
    }
    deps!.log.info('设置开机启动:', enable)
    return setOpenAtLogin(enable)
  })

  // === 功能可用性（能力矩阵，设计 §7）===
  //
  // 渲染层据此把不支持的入口置灰并展示原因（D4「屏蔽入口 + 文案说明，
  // 禁止静默失败」）。矩阵本身是纯函数（shared/feature-availability.ts），
  // 这里只负责把 main 侧的探测结果递过去。
  ipcMain.handle('app:getFeatureAvailability', async () => {
    return {
      features: getFeatureAvailability(),
      messages: FEATURE_BLOCK_MESSAGES,
    }
  })

  // --- Agent 管理接口 ---

  /**
   * 获取 Agent 列表
   */
  ipcMain.handle('api:getAgents', async () => {
    return { success: true, data: listAgents() }
  })

  /**
   * 获取 Agent 详情
   */
  ipcMain.handle('api:getAgent', async (_event, agentId: string) => {
    const agent = getAgentRecord(agentId)
    if (!agent) return { success: false, error: `Agent 不存在: ${agentId}` }
    return { success: true, data: agent }
  })

  /**
   * Fork 系统/任意 Agent 为用户 Agent（本地存储）
   */
  ipcMain.handle('api:forkAgent', async (_event, systemAgentId: string, data: { name?: string; description?: string }) => {
    try {
      return { success: true, data: forkAgentRecord(systemAgentId, data) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 更新用户 Agent（本地存储）
   */
  ipcMain.handle('api:updateAgent', async (_event, agentId: string, data: Record<string, unknown>) => {
    try {
      return { success: true, data: updateAgentRecord(agentId, data) }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /**
   * 删除用户 Agent（本地存储）
   */
  ipcMain.handle('api:deleteAgent', async (_event, agentId: string) => {
    try {
      deleteAgentRecord(agentId)
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  // === 搜索工具配置 ===
  ipcMain.handle('api:getSearchConfig', async () => {
    try {
      const config = deps!.getConfigManager().getSearchConfig()
      return { success: true, data: config }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:setSearchConfig', async (_event, searchConfig: { langSearchApiKey?: string; searxngBaseUrl?: string }) => {
    try {
      await deps!.getConfigManager().updateSearchConfig(searchConfig)
      // 更新 process.env 以便立即生效
      if (searchConfig.langSearchApiKey !== undefined) {
        if (searchConfig.langSearchApiKey) {
          process.env.LANGSEARCH_API_KEY = searchConfig.langSearchApiKey
        } else {
          delete process.env.LANGSEARCH_API_KEY
        }
      }
      if (searchConfig.searxngBaseUrl !== undefined) {
        if (searchConfig.searxngBaseUrl) {
          process.env.SEARXNG_BASE_URL = searchConfig.searxngBaseUrl
        } else {
          delete process.env.SEARXNG_BASE_URL
        }
      }
      return { success: true }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
