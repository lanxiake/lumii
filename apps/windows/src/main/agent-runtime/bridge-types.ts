/**
 * AgentRuntimeBridge 公共类型定义
 *
 * 拆自 bridge.ts，集中存放跨模块共享的接口类型。
 */

import type { BrowserWindow } from 'electron'
import type {
  SkillInfo,
  CustomAgentInfo,
  UserDeviceInfo,
  AgentDefinition,
} from '@mtbot/agent-runtime'

export interface AgentRuntimeBridgeConfig {
  gatewayUrl: string
  getAuthToken: () => Promise<string>
  /**
   * 读取本地 LLM Provider 配置（灵栖/Lumii 独立版：无网关，direct 直连）。
   * 返回 enabled=true 时 Agent 走 direct 直连（凭据本机注入），否则回退 gateway。
   */
  getProviderConfig?: () => import('../provider-config.js').LocalProviderConfigView
  /** 获取设备 ID（用于 LLM 代理设备 token 认证） */
  getDeviceId?: () => string | undefined
  getWindow: () => BrowserWindow | null
  getCwd: () => string
  /** 自定义数据库路径（默认 ~/.lumii/data/agent-runtime.db） */
  dbPath?: string
  /** 获取已启用的技能列表（用于注入系统提示词） */
  getSkills?: () => Promise<readonly SkillInfo[]>
  /** 根据本轮统计批量更新技能激活范围（由 LocalSkillStore.updateAutoScopeBatch 实现，用户无感知） */
  updateSkillAutoScope?: (deltas: Map<string, { invokeSuccess?: number; searchCount?: number }>) => Promise<void>
  /**
   * 是否启用 Pre-LLM Router（默认 true）。
   * 关闭后客户端走旧路径：主 LLM 看到全部 skills / customAgents 清单。
   * 详见 .qoder/design/Agent-Skill编排优化/
   */
  routerEnabled?: boolean
  /** Router 调用超时（ms），默认 800 */
  routerTimeoutMs?: number
  /** 获取可用的自定义 Agent 列表（用于注入多 Agent 协作 section） */
  getCustomAgents?: () => Promise<readonly CustomAgentInfo[]>
  /** 获取用户设备列表（用于注入系统提示词） */
  getUserDevices?: () => Promise<readonly UserDeviceInfo[]>
  /** 获取用户 SOUL 内容（人格/风格/边界） */
  getSoulContent?: () => Promise<string | undefined>
  /** 读取用户记忆全文（Markdown） */
  getUserMemory?: () => Promise<{ content: string; updatedAt?: string } | undefined>
  /** 更新用户记忆全文（Markdown） */
  updateUserMemory?: (content: string) => Promise<{ updatedAt?: string } | undefined>
  /** 更新用户 SOUL 内容（仅系统默认 Agent 可用） */
  updateSoulContent?: (content: string) => Promise<{ updatedAt?: string } | undefined>
  /**
   * 按 ID 从 API 拉取 AgentDefinition（用于 DefinitionStore）
   */
  fetchAgentDefinitionById?: (id: string) => Promise<AgentDefinition | undefined>
  /**
   * 列出当前用户可用的全部 Agent 定义（GET /api/agents 映射结果）
   */
  fetchAgentDefinitionsFromApi?: () => Promise<readonly AgentDefinition[]>
  /**
   * 通过 Gateway WebSocket 调用指定方法（用于 cron / 集成类工具实现）
   */
  callGateway?: (method: string, params?: unknown) => Promise<unknown>
  /**
   * 本地定时任务触发时发送系统通知（由 index.ts 注入，使用 Electron Notification + tray balloon）
   * 不依赖任何会话 ID，纯系统级弹窗。
   */
  showCronNotification?: (title: string, body: string) => void
  /**
   * 通过微信通道发送消息给用户（由 index.ts 注入，调用 weixinLoginService）。
   * channelUserId 和 contextToken 从当前活跃的微信会话上下文中获取。
   */
  sendWeixinMessage?: (params: { text?: string; filePath?: string }) => Promise<{ ok: boolean; error?: string }>
  /**
   * 主动推送文本到飞书（由 index.ts 注入，调用 feishuLoginService.pushText）。
   * 收件人是登录时记录的 openId，定时任务结果推送用。
   */
  sendFeishuMessage?: (text: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 惰性获取渠道出站 Router（Hub 在登录服务初始化后才装配，故用 getter）。
   */
  getChannelRouter?: () => import('../channel/channel-outbound-router').ChannelOutboundRouter | null | undefined
  /**
   * 将文本合成为语音文件并返回文件绝对路径（由 index.ts 注入，调用 voiceCallService）。
   */
  generateVoiceFile?: (
    text: string,
    opts?: { speaker?: string; speed?: number },
  ) => Promise<string>
  /**
   * 设置 ACP 后端（由 index.ts 注入，调用 AcpBackendManager.setBackend）
   */
  setAcpBackend?: (backendId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 执行本地 executable 技能（由 execute_skill 工具调用）
   */
  executeSkill?: (skillId: string, params: Record<string, unknown>) => Promise<{ success: boolean; error?: string; executionTimeMs: number; [key: string]: unknown }>
  /**
   * 对话结束后回调（用于客户端侧记忆记录，如 MemPalace）。
   * fire-and-forget，不阻塞事件处理。
   */
  onConversationEnd?: (convId: string, assistantText: string) => void
  /**
   * Fork 系统 Agent 创建自定义 Agent（由 index.ts 注入，调用 apiClient.forkAgent）
   */
  forkAgent?: (systemAgentId: string, data: { name?: string; description?: string }) => Promise<{ ok: boolean; agentId?: string; error?: string }>
  /**
   * 更新自定义 Agent 配置（由 index.ts 注入，调用 apiClient.updateAgent）
   */
  updateAgent?: (agentId: string, data: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  /**
   * 删除自定义 Agent（由 index.ts 注入，调用 apiClient.deleteAgent）
   */
  deleteAgent?: (agentId: string) => Promise<{ ok: boolean; error?: string }>
  /**
   * 获取浏览器路由上下文（由 index.ts 注入，供浏览器工具调用 browser.proxy 命令）
   */
  getBrowserContext?: () => import('../browser-service.js').BrowserRouteContext | null
  /**
   * 技能自进化引擎（可选，由 index.ts 注入）
   */
  skillEvolutionEngine?: import('../skill-evolution/index').SkillEvolutionEngine
  /**
   * MemPalace 语义搜索（由 index.ts 注入，调用 MemPalaceMcpBridge.searchDrawers）
   * 返回 null 表示 MemPalace 未安装/未运行，此时降级到 user_memory 文本搜索
   */
  searchMempalace?: (query: string, limit?: number) => Promise<Array<{ text: string; wing: string; room: string; similarity: number; drawer_id: string }> | null>
  /**
   * 按 drawer_id 读取记忆宫殿归档原文（由 index.ts 注入，调用 MemPalaceMcpBridge.getDrawer）
   * 返回 null 表示未找到或 MemPalace 不可用
   */
  readMempalaceDrawer?: (drawerId: string) => Promise<{
    drawer_id: string
    content: string
    wing: string
    room: string
    metadata?: Record<string, unknown>
  } | null>
  /**
   * 读取记忆注入开关（由 index.ts 从渲染进程 localStorage 同步读取）
   * 未配置时默认两项均开启
   */
  getMemoryInjectionSettings?: () => Promise<{
    injectPersonalMemory: boolean
    injectWorkMemory: boolean
  }>
  /**
   * 段原文归档进 MemPalace（由 index.ts 注入，调用 MemPalaceMcpBridge.callTool）。
   * drawer_id 由 runtime 内容寻址确定性生成（P2），传给 Python 做幂等 upsert。
   * 返回宫殿实际写入的 drawer_id（可能与传入相同）；未安装/失败返回 undefined。
   * 记忆系统升级阶段一 · 诉求 A · 宫殿互引。
   */
  archiveMempalaceDrawer?: (params: {
    content: string
    wing: string
    room: string
    drawerId: string
    metadata?: Record<string, unknown>
  }) => Promise<{ drawerId?: string } | undefined>
}

/** 按 Agent 定义 ID 聚合的运行时快照（DetailPanel「运行状态」） */
export interface AgentLifecycleSnapshot {
  readonly definitionId: string
  /** 该定义当前活跃实例数 */
  readonly instanceCount: number
  /** 处于 running 状态的实例数 */
  readonly runningCount: number
  /** 是否有任一实例在运行 */
  readonly anyRunning: boolean
  /** 最早进入 running 的时间戳（ms），用于展示已运行时长 */
  readonly runningSinceMs: number | null
  /** 累计完成的 agent 轮次（agent:end） */
  readonly totalTurns: number
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
  /** 由该定义实例 spawn 出的、当前仍在运行的子实例数 */
  readonly subAgentsRunning: number
}
