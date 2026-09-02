/**
 * API 相关 IPC handlers (本地配置、用量、资讯、Agent 管理等)
 */
import { ipcMain, app } from 'electron'
import { dirname } from 'path'
import { promises as fs, existsSync } from 'fs'
import {
  getSoulFilePath,
  readUserMemoryFile,
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
import { queryUsage, type UsageQuery } from '../usage-store'
import { getLatency } from '../provider-latency'
import { readNewsSnapshot } from '../news-store'
import { NEWS_PIPELINE_TASK_TEXT, NEWS_PIPELINE_SYSTEM_PROMPT } from '../seed-cron-jobs'
import {
  readActiveDashboardFeedSnapshot,
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
      const p = getSoulFilePath()
      const content = existsSync(p) ? await fs.readFile(p, 'utf-8') : ''
      const updatedAt = existsSync(p) ? (await fs.stat(p)).mtime.toISOString() : new Date(0).toISOString()
      return { success: true, data: { content, updatedAt } }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle('api:updateSoulContent', async (_event, content: string) => {
    try {
      const p = getSoulFilePath()
      await fs.mkdir(dirname(p), { recursive: true })
      await fs.writeFile(p, content ?? '', 'utf-8')
      return { success: true, data: { updatedAt: new Date().toISOString() } }
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
    // 配置变更后销毁旧实例，避免继续走创建时快照的 Gateway/旧凭据
    invalidateAgentInstancesForProviderChange()
    return loadProviderSlotsConfig()
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

  // === 概览页资讯（数据由「资讯抓取与综述」定时任务写入 ~/.lumii/news/latest.json）===
  ipcMain.handle('news:latest', async () => {
    try {
      return { success: true, data: await readNewsSnapshot() }
    } catch (error) {
      console.error('[IPC] news:latest 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // === Dashboard 通用 feed（资讯只是默认 feed，后续工作流可替换其内容）===
  ipcMain.handle('dashboard-feed:latest', async () => {
    try {
      return { success: true, data: await readActiveDashboardFeedSnapshot() }
    } catch (error) {
      console.error('[IPC] dashboard-feed:latest 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 手动「立即抓取」：与定时任务走同一条 Agent 驱动路径，复用相同的固定 sessionKey，
   * 两者在会话列表里是同一个会话，用户能看到 Agent 具体搜索/调用工具的完整过程。
   */
  ipcMain.handle('dashboard-feed:refresh', async () => {
    try {
      const agentRuntimeBridge = deps!.getAgentRuntimeBridge()
      if (!agentRuntimeBridge) throw new Error('Agent Runtime 未就绪')
      const convId = 'cron:news-pipeline'
      agentRuntimeBridge.ensureConversationExists(convId, '定时任务 · 资讯抓取与综述')
      const instanceId = await agentRuntimeBridge.createInstanceById('assistant', convId, convId)
      try {
        await agentRuntimeBridge.prompt(instanceId, `${NEWS_PIPELINE_SYSTEM_PROMPT}\n\n---\n\n${NEWS_PIPELINE_TASK_TEXT}`)
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

  // === 开机启动 ===
  ipcMain.handle('app:getOpenAtLogin', async () => {
    const loginItemSettings = app.getLoginItemSettings()
    deps!.log.info('获取开机启动状态:', loginItemSettings.openAtLogin)
    return loginItemSettings.openAtLogin
  })

  ipcMain.handle('app:setOpenAtLogin', async (_event, enable: boolean) => {
    if (typeof enable !== 'boolean') {
      throw new Error('参数必须为布尔值')
    }
    deps!.log.info('设置开机启动:', enable)
    app.setLoginItemSettings({
      openAtLogin: enable,
      // 开机启动时携带参数，用于检测是否由系统自动启动（隐藏到托盘）
      args: enable ? ['--startup-launched'] : [],
    })
    return app.getLoginItemSettings().openAtLogin
  })

  // === 灵栖/Lumii 独立版：无后端，云端技能文件上传接口降级为本地报错 ===
  ipcMain.handle('api:uploadSkillFile', async () => {
    return { success: false, error: '独立版不支持技能文件上传' }
  })

  // --- Agent 管理接口 ---

  /**
   * 获取 Agent 列表
   */
  ipcMain.handle('api:getAgents', async () => {
    return { success: true, data: listAgents() }
  })

  /**
   * 获取用户有效模型提供商列表（聊天模型选择器）
   * 独立版：直接用本地模型映射，返回扁平结构（与 LiteLLM catalog 一致）
   */
  ipcMain.handle('api:getConfigModels', async () => {
    const agentRuntimeBridge = deps!.getAgentRuntimeBridge()
    const mapping = agentRuntimeBridge?.getModelMapping() ?? {}
    const modelIds = [...new Set(Object.values(mapping))]
    return { success: true, data: modelIds.map((id) => ({ id, label: id })) }
  })

  /**
   * 获取 chat 槽候选模型与用户当前选择
   */
  ipcMain.handle('api:getChatModels', async () => {
    return { success: true, data: { candidates: [], selected: '' } }
  })

  /**
   * 保存用户选择的 chat 模型（独立版无后端，noop）
   */
  ipcMain.handle('api:setChatModel', async () => {
    return { success: true }
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

  /**
   * 获取用户技能列表（独立版无后端，返回空）
   */
  ipcMain.handle('api:getUserSkills', async () => {
    return { success: true, data: [] }
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
