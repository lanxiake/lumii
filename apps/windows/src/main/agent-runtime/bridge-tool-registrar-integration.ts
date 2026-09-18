/**
 * 渠道出站工具（channel_list / channel_send）与客户端集成工具
 * （message / memory_search / memory_read / profile_memory / system_prompt / tts / image_generate）。
 *
 * 从 bridge-tool-registrar.ts 抽离，纯函数式注册，仅依赖注入的 deps。
 */

import {
  createMtBotTool,
  isKnownImageGenerationModel,
  normalizeImageModelId,
  type MtBotToolConfig,
  channelListToolConfig,
  channelSendToolConfig,
  messageToolConfig,
  memorySearchToolConfig,
  memoryReadToolConfig,
  profileMemoryToolConfig,
  sceneMemoryToolConfig,
  systemPromptToolConfig,
  speechGenerateToolConfig,
  imageGenerateToolConfig,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult, removeMarkdownSection } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'
import { resolveOriginChannel } from './bridge-tool-registrar-client-cmd'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import {
  findProject,
  listScenes,
  loadRegistry,
  readSceneMemory,
  registerProject,
  resolveSceneFilePath,
  writeSceneMemory,
} from './scene-memory-store'
import { resolveChannel } from './scene-resolver'

/**
 * 注册渠道出站工具 channel_list / channel_send（走 ChannelOutboundRouter）。
 */
export function registerChannelTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const channelList: MtBotToolConfig = {
    ...channelListToolConfig,
    execute: async () => {
      const router = deps.getChannelRouter()
      if (!router) {
        return jsonToolResult({
          ok: false,
          errorCode: 'HUB_NOT_READY',
          message: '渠道出站 Hub 尚未就绪，请稍后再试（非未登录）',
          channels: [],
        })
      }
      const channels = await router.list()
      return jsonToolResult({ channels })
    },
  }
  deps.toolRegistry.register(createMtBotTool(channelList, ctx))

  const channelSend: MtBotToolConfig = {
    ...channelSendToolConfig,
    execute: async (toolCallId, rawParams) => {
      const router = deps.getChannelRouter()
      if (!router) {
        return jsonToolResult({
          ok: false,
          errorCode: 'HUB_NOT_READY',
          message: '渠道出站 Hub 尚未就绪，请稍后再试（非未登录）',
        })
      }
      const p = rawParams as {
        channel?: string
        to?: string
        text?: string
        mediaPath?: string
        fileName?: string
      }

      // 省略 channel/to = 回本轮消息来源渠道的当前会话：
      // 「发给我」的默认语义，避免模型在只有一个渠道有 peer 时误发到别的渠道。
      const origin = resolveOriginChannel(deps, toolCallId)
      const requestedChannel = String(p.channel ?? '').trim()
      const requestedTo = String(p.to ?? '').trim()
      const channel = requestedChannel || (origin?.channelType ?? '')
      if (channel !== 'feishu' && channel !== 'weixin' && channel !== 'qbot' && channel !== 'wecom') {
        return jsonToolResult({
          ok: false,
          errorCode: 'PEER_NOT_FOUND',
          message: requestedChannel
            ? "channel 必须是 'feishu' | 'weixin' | 'qbot' | 'wecom'"
            : '当前不在任何消息渠道会话里，无法推断目标渠道；请先 channel_list 再显式指定 channel 和 to',
          channels: null,
        })
      }
      const to = requestedTo || origin?.replyTo || ''
      if (!to) {
        return jsonToolResult({
          ok: false,
          errorCode: 'PEER_NOT_FOUND',
          message: origin
            ? `省略 to 时只能在当前 ${channel} 会话内回复；本会话未提供默认收件人（可能是群聊或非会话内轮次），请先 channel_list 再显式指定 to`
            : '收件人 to 必填，请先调用 channel_list 获取 peer id',
        })
      }
      const result = await router.send({
        channel,
        to,
        text: String(p.text ?? ''),
        ...(p.mediaPath ? { mediaPath: String(p.mediaPath) } : {}),
        ...(p.fileName ? { fileName: String(p.fileName) } : {}),
      })
      return jsonToolResult(result)
    },
  }
  deps.toolRegistry.register(createMtBotTool(channelSend, ctx))
  log.info('[registerChannelTools] channel_list/channel_send registered')
}

/**
 * 注册客户端集成工具（message / memory_search / profile_memory / system_prompt）
 */
export function registerIntegrationTools(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const messageTool: MtBotToolConfig = {
    ...messageToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as Record<string, unknown>
      const channel = String(p.channel ?? '').toLowerCase()

      // 微信通道发送判定：
      // 1. agent 显式指定 channel='weixin'，或
      // 2. 当前对话本就是活跃微信会话，且 agent 未指定其它真实通道（默认即微信）
      // 后者让 agent 无需显式设 channel/to 即可回当前微信用户，避免被 'to' 必填误导。
      const isImplicitWeixin =
        channel === '' || channel === 'windows-agent-runtime'
      const weixinCtx = deps.weixinCtx.getCurrent()
      if (channel === 'weixin' || (isImplicitWeixin && weixinCtx)) {
        if (!weixinCtx) {
          log.warn('[message tool] channel=weixin 但无活跃微信会话上下文，无法发送')
          return jsonToolResult({ status: 'error', message: '当前没有活跃的微信会话，无法发送消息。请先在微信发送消息建立会话后再试。' })
        }
        const router = deps.getChannelRouter()
        if (!router) {
          return jsonToolResult({ status: 'error', message: '渠道出站 Hub 尚未就绪，请稍后再试' })
        }
        const text = p.text ? String(p.text) : ''
        const filePath = p.mediaUrl ? String(p.mediaUrl) : undefined
        log.info(`[message tool] 微信本地发送（经 ChannelOutboundRouter）channelUserId=${weixinCtx.channelUserId} text=${text.slice(0, 50)} filePath=${filePath}`)
        const result = await router.send({
          channel: 'weixin',
          to: weixinCtx.channelUserId,
          text,
          ...(filePath ? { mediaPath: filePath } : {}),
        })
        if (result.ok) {
          deps.weixinCtx.markSentViaTool()
        }
        return jsonToolResult(result.ok
          ? {
              status: 'ok',
              message: '消息已发送',
              note: '消息已通过微信投递给用户。本轮请回复 NO_REPLY，避免对话流再次重复发送相同内容。',
            }
          : { status: 'error', message: result.message ?? '发送失败' })
      }

      // 非微信通道：message 工具不再支持主动出站（原 Gateway send RPC 为迁移遗留代码，已移除）
      return jsonToolResult({
        status: 'error',
        message: '该场景请改用 channel_list 查询可发送的 peer，再调用 channel_send 发送；message 工具仅用于回复当前会话（含隐式回微信）。',
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(messageTool, ctx))

  /**
   * 记忆检索结果的一条命中。`provider` 标出来源通道——三条通道的分数量纲不可比
   * （BM25 相关性分数、文件行匹配硬编码分），故不跨通道比大小，只分段返回。
   */
  type MemorySearchHit = {
    provider: 'work-memory' | 'palace' | 'profile' | 'scene'
    content: string
    score: number
    /** 工作记忆条目的 id（可接 memory_manage 读取/修正） */
    id?: string
    drawer_id?: string
    category?: string
    source?: string
    line?: number
    /** 宫殿命中：原文总长度。远大于 content.length 时说明 content 只是摘录 */
    char_count?: number
    /** 宫殿命中：content 是否为摘录（true 则需 memory_read 读全文） */
    truncated?: boolean
  }

  const resolveToolInstanceId = (toolCallId: string): string | undefined =>
    deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()

  const memorySearchTool: MtBotToolConfig = {
    ...memorySearchToolConfig,
    description:
      'Search your memory. Covers working memory (task/project facts recorded by you or other agents), the memory palace (archived conversation transcripts), and the user profile / scene memory files. Results carry a `provider` field telling you where each hit came from — weight them accordingly. To read a full archived transcript, take its `drawer_id` to `memory_read`.',
    execute: async (toolCallId, rawParams) => {
      const p = rawParams as { query?: string; maxResults?: number; sessionKey?: string }
      const query = (p.query ?? '').trim()
      if (!query) {
        return jsonToolResult({ status: 'error', message: 'query is required' })
      }
      const limit = Math.max(1, Math.min(p.maxResults ?? 10, 50))
      const sessionKey = (p.sessionKey ?? '').trim()

      const hits: MemorySearchHit[] = []
      const counts = { workMemory: 0, palace: 0, profile: 0, scene: 0 }

      // ── 通道 1：工作记忆（SQLite agent_memories，FTS5 + BM25，中文 bigram 分词）──
      // 2026-09-17 接通：此前 memory_search 从不查这张表，导致 Agent 只能看见每轮注入的
      // 6 条热记忆，其余 200+ 条毫无通道（评审 §2.4.1）。
      const instanceId = resolveToolInstanceId(toolCallId)
      const agentId = (instanceId && deps.getDefinitionIdByInstanceId(instanceId)) ?? 'default'
      const readScope = instanceId ? deps.getMemoryReadScopeByInstanceId(instanceId) : 'agent'

      const memoryManager = deps.getMemoryManager()
      if (memoryManager) {
        try {
          const entries = memoryManager.searchMemories(
            agentId,
            'local-user',
            query,
            limit,
            readScope,
          )
          for (const e of entries) {
            hits.push({
              provider: 'work-memory',
              id: e.id,
              content: e.content,
              category: e.category,
              score: 1,
            })
          }
          counts.workMemory = entries.length
        } catch (err) {
          log.warn('[memory_search] 工作记忆通道失败:', err)
        }
      }

      /**
       * 取某会话已归档段的 palace drawer_id 集合，用于 memory_search 会话级过滤。
       */
      const drawerIdsForSession = (conversationId: string): Set<string> => {
        const rows = deps.localDb.db
          .prepare(
            `SELECT palace_drawer_id FROM memory_segments
             WHERE conversation_id = ? AND palace_drawer_id IS NOT NULL`,
          )
          .all(conversationId) as { palace_drawer_id: string }[]
        return new Set(rows.map((r) => r.palace_drawer_id).filter(Boolean))
      }

      // ── 通道 2：记忆宫殿（自建 SQLite PalaceRepo；后端不可用/失败则跳过，不影响通道 1）──
      // 2026-09-17 换掉 MemPalace：Python + chromadb 后端在本机 upsert 直接崩，覆盖率 2.3%。
      // 命中返回的是**摘录**（段原文最长 94473 字符），全文走 memory_read。
      if (deps.config.searchPalace && hits.length < limit) {
        try {
          const items = await deps.config.searchPalace(query, limit - hits.length, {
            userId: 'local-user',
            // 与工作记忆通道同一作用域规则：agent 作用域只看本 Agent，user 作用域跨 Agent
            ...(readScope === 'agent' ? { agentId } : {}),
          })
          if (items !== null) {
            let taken = items
            if (sessionKey) {
              const allowed = drawerIdsForSession(sessionKey)
              if (allowed.size > 0) {
                taken = taken.filter((item) => allowed.has(item.drawer_id))
              }
            }
            for (const item of taken) {
              hits.push({
                provider: 'palace',
                drawer_id: item.drawer_id,
                content: item.text,
                score: item.score,
                source: `${item.wing}/${item.room}`,
                ...(item.char_count != null ? { char_count: item.char_count } : {}),
                ...(item.truncated ? { truncated: true } : {}),
              })
            }
            counts.palace = taken.length
          }
        } catch (err) {
          log.warn('[memory_search] 宫殿通道失败，跳过:', err)
        }
      }

      // ── 通道 3：个人记忆 + 场景记忆文件（行级关键词匹配）──
      if (hits.length < limit) {
        const q = query.toLowerCase()
        const matched: MemorySearchHit[] = []

        const memory = await deps.config.getUserMemory?.()
        const content = memory?.content ?? ''
        if (content.trim()) {
          content.split(/\r?\n/).forEach((line, idx) => {
            if (line.toLowerCase().includes(q)) {
              matched.push({
                provider: 'profile',
                content: line.trim(),
                line: idx + 1,
                score: 0.8,
                source: 'user_memory',
              })
            }
          })
        }

        // 场景记忆：来源标注适用范围，方便 agent 判断该规则是否适用于当前任务
        try {
          const baseDir = resolveWindowsClientDataRoot()
          const scenes = await listScenes(baseDir)
          for (const scene of scenes) {
            if (!scene.hasMemory) continue
            const file = await readSceneMemory(
              resolveSceneFilePath(baseDir, scene.scene, scene.key, scene.path),
            )
            if (!file?.content) continue
            const sourceLabel =
              scene.scene === 'project' ? `项目记忆:${scene.name}` : `渠道记忆:${scene.name}`
            file.content.split(/\r?\n/).forEach((line, idx) => {
              if (line.toLowerCase().includes(q)) {
                matched.push({
                  provider: 'scene',
                  content: line.trim(),
                  line: idx + 1,
                  score: 0.75,
                  source: sourceLabel,
                })
              }
            })
          }
        } catch {
          // 场景记忆读取失败不影响全局记忆搜索
        }

        const room = limit - hits.length
        const taken = matched.slice(0, room)
        hits.push(...taken)
        counts.profile = taken.filter((h) => h.provider === 'profile').length
        counts.scene = taken.filter((h) => h.provider === 'scene').length
      }

      if (hits.length === 0) {
        return jsonToolResult({
          results: [],
          provider: 'none',
          query,
          note: 'no match in work-memory / palace / profile / scene',
        })
      }
      return jsonToolResult({
        results: hits,
        providers: counts,
        query,
        ...(sessionKey ? { sessionKey, sessionScoped: true } : {}),
      })
    },
  }
  deps.toolRegistry.register(createMtBotTool(memorySearchTool, ctx))

  const memoryReadTool: MtBotToolConfig = {
    ...memoryReadToolConfig,
    execute: async (_id, rawParams) => {
      const drawerId = String((rawParams as { drawerId?: string }).drawerId ?? '').trim()
      if (!drawerId) {
        return jsonToolResult({ ok: false, message: 'drawerId is required' })
      }
      // 只挡明显非法的输入。宫殿 drawer_id 现行是内容寻址 16 位 hex，但历史上存在
      // Python 时代的 `drawer_<agent>_<user>_<date>_<hash>` 格式（实测库里仍有这种行）。
      // 严格限 hex 会把它们判成「格式无效」——而模型手里的指针是**我们自己注入给它的**，
      // 用格式挡掉自己的入口，比让它查一次、查不到再如实报错更糟。
      if (!/^[A-Za-z0-9_:[\]-]{4,140}$/.test(drawerId)) {
        return jsonToolResult({ ok: false, message: 'drawerId 格式无效' })
      }
      const readDrawer = deps.config.readPalaceDrawer
      if (!readDrawer) {
        return jsonToolResult({
          ok: false,
          message: '记忆宫殿后端未配置或不可用，无法读取归档原文',
        })
      }
      try {
        let detail = await readDrawer(drawerId)
        // 容错：模型常把注入的指针 `[d:xxxx]` 原样或半剥地传进来（实测传过 `d:xxxx`，
        // 少了方括号于是查不到）。这里再剥一次——模型写得不对不该让整个回溯失败，
        // 而正确格式只可能是裸 id，剥完不匹配说明本来就不是指针。
        if (!detail) {
          // `^\s*` 与 `\s*$` 都要有：模型可能写出 ` d:xxx ` 这种两头带空白的形式，
          // 而 `d:` 前缀与尾部 `]` 的顺序不固定（实测出现过 `[d:xxx` 缺后半括号）。
          const salvage = /^\s*(?:\[?d:)?\s*([0-9a-f]{4,64})\s*\]?\s*$/i.exec(drawerId)
          if (salvage && salvage[1] !== drawerId) detail = await readDrawer(salvage[1])
        }
        if (!detail) {
          return jsonToolResult({
            ok: false,
            drawerId,
            // 错误信息要能自我纠正：只说"没找到"时模型会再试同样的写法，
            // 写上正确形状它下一轮就能改对。
            message: '未找到该 drawer（可能已被删除）。注意 drawerId 只传裸 id（如 a3f9c21b8e4d0077），不要把 [d: 与 ] 带进来。',
          })
        }
        return jsonToolResult({
          ok: true,
          drawerId: detail.drawer_id,
          wing: detail.wing,
          room: detail.room,
          content: detail.content,
          metadata: detail.metadata,
          provider: 'palace',
        })
      } catch (err) {
        return jsonToolResult({
          ok: false,
          drawerId,
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(memoryReadTool, ctx))

  const profileMemoryTool: MtBotToolConfig = {
    ...profileMemoryToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { action?: string; content?: string; section?: string }
      const action = (p.action ?? '').trim()
      if (action === 'read_memory') {
        const memory = await deps.config.getUserMemory?.()
        return jsonToolResult({
          ok: true,
          content: memory?.content ?? '',
          updatedAt: memory?.updatedAt,
        })
      }
      if (action === 'update_memory') {
        const content = (p.content ?? '').trim()
        if (!content) {
          return jsonToolResult({ ok: false, message: 'content is required for update_memory' })
        }
        const updated = await deps.config.updateUserMemory?.(content)
        return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
      }
      if (action === 'append') {
        const block = (p.content ?? '').trim()
        if (!block) {
          return jsonToolResult({ ok: false, message: 'content is required for append' })
        }
        const existing = (await deps.config.getUserMemory?.())?.content ?? ''
        const next = existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`
        const updated = await deps.config.updateUserMemory?.(next)
        return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
      }
      if (action === 'remove_section') {
        const section = (p.section ?? '').trim()
        if (!section) {
          return jsonToolResult({ ok: false, message: 'section is required for remove_section' })
        }
        const existing = (await deps.config.getUserMemory?.())?.content ?? ''
        if (!existing.trim()) {
          return jsonToolResult({ ok: false, message: 'memory document is empty' })
        }
        const { content: next, removed } = removeMarkdownSection(existing, section)
        if (!removed) {
          return jsonToolResult({ ok: false, message: `section not found: ${section}` })
        }
        const updated = await deps.config.updateUserMemory?.(next)
        return jsonToolResult({ ok: true, removed: true, updatedAt: updated?.updatedAt })
      }
      if (action === 'get_preferences') {
        // 客户端 Runtime 暂无独立偏好配置，返回空偏好让 AI 直接使用记忆文档中的信息
        return jsonToolResult({
          ok: true,
          preferences: null,
          message: '暂无偏好配置，请参考用户记忆文档中的沟通规则章节',
        })
      }
      return jsonToolResult({ ok: false, message: `unknown action: ${action}` })
    },
  }
  deps.toolRegistry.register(createMtBotTool(profileMemoryTool, ctx))

  const sceneMemoryTool: MtBotToolConfig = {
    ...sceneMemoryToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as {
        action?: string
        scene?: string
        key?: string
        path?: string
        content?: string
        section?: string
      }
      const action = (p.action ?? '').trim()
      const baseDir = resolveWindowsClientDataRoot()

      if (action === 'list') {
        const scenes = await listScenes(baseDir)
        return jsonToolResult({ ok: true, scenes })
      }

      const scene = (p.scene ?? '').trim() as 'project' | 'channel' | ''
      if (scene !== 'project' && scene !== 'channel') {
        return jsonToolResult({ ok: false, message: "scene must be 'project' or 'channel'" })
      }
      const key = (p.key ?? '').trim()

      // 解析目标文件：渠道缺省用当前会话渠道；项目按 key/路径登记或查找
      let filePath: string
      let targetName: string
      if (scene === 'channel') {
        let channelType = key
        if (!channelType) {
          const instanceId = deps.getCurrentToolExecutorInstanceId()
          const sessionKey = instanceId ? deps.instanceToConversation.get(instanceId) : undefined
          // 归属取落库值（10-S2）：前缀只说明会话从哪来，落库值才是权威
          const stored = sessionKey
            ? deps.getConversationRepo()?.getConversation(sessionKey)?.channel_type ?? null
            : null
          const channel = resolveChannel(sessionKey, stored)
          if (!channel) {
            return jsonToolResult({
              ok: false,
              message:
                'key is required for scene=channel（当前会话不是渠道会话，无法推断渠道；请显式指定 weixin/feishu/wecom/qbot）',
            })
          }
          channelType = channel.channelType
        }
        filePath = resolveSceneFilePath(baseDir, 'channel', channelType)
        targetName = channelType
      } else {
        if (!key) {
          return jsonToolResult({
            ok: false,
            message: "key is required for scene=project（项目名或路径）",
          })
        }
        const registry = await loadRegistry(baseDir)
        let project = findProject(registry, key)
        if (!project) {
          project = await registerProject(baseDir, {
            name: key,
            path: p.path?.trim() || null,
          })
        } else if (p.path?.trim() && !project.path) {
          // 已知项目补全目录
          project = await registerProject(baseDir, { name: project.name, path: p.path.trim() })
        }
        filePath = resolveSceneFilePath(baseDir, 'project', project.key, project.path)
        targetName = project.name
      }

      if (action === 'read') {
        const file = await readSceneMemory(filePath)
        return jsonToolResult({
          ok: true,
          scene,
          key: targetName,
          path: filePath,
          content: file?.content ?? '',
          updatedAt: file?.updatedAt,
        })
      }

      if (action === 'write' || action === 'append') {
        const content = (p.content ?? '').trim()
        if (!content) {
          return jsonToolResult({ ok: false, message: `content is required for ${action}` })
        }
        let next: string
        if (action === 'write') {
          next = content
        } else {
          const existing = (await readSceneMemory(filePath))?.content ?? ''
          next = existing.trim() ? `${existing.trimEnd()}\n\n${content}\n` : `${content}\n`
        }
        const ok = await writeSceneMemory(filePath, next)
        if (!ok) {
          return jsonToolResult({
            ok: false,
            message: '写入失败（内容可能超出容量上限），请精简后重试',
          })
        }
        log.info(
          `[scene_memory] ${action} scene=${scene} key=${targetName} path=${filePath} chars=${content.length}`,
        )
        return jsonToolResult({
          ok: true,
          scene,
          key: targetName,
          path: filePath,
          updatedAt: new Date().toISOString(),
          note:
            '已写入场景记忆。该项目/渠道相关的偏好会在此后相关对话中自动加载；请勿重复写入 profile_memory（全局记忆）。',
        })
      }

      if (action === 'remove_section') {
        const section = (p.section ?? '').trim()
        if (!section) {
          return jsonToolResult({ ok: false, message: 'section is required for remove_section' })
        }
        const existing = (await readSceneMemory(filePath))?.content ?? ''
        if (!existing.trim()) {
          return jsonToolResult({ ok: false, message: '场景记忆文档为空' })
        }
        const { content: next, removed } = removeMarkdownSection(existing, section)
        if (!removed) {
          return jsonToolResult({ ok: false, message: `section not found: ${section}` })
        }
        const ok = await writeSceneMemory(filePath, next)
        return jsonToolResult({ ok, removed: true, scene, key: targetName, path: filePath })
      }

      return jsonToolResult({ ok: false, message: `unknown action: ${action}` })
    },
  }
  deps.toolRegistry.register(createMtBotTool(sceneMemoryTool, ctx))

  const systemPromptTool: MtBotToolConfig = {
    ...systemPromptToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { action?: string; content?: string }
      const action = (p.action ?? '').trim()
      if (action === 'read' || action === 'soul_read') {
        const content = (await deps.config.getSoulContent?.()) ?? ''
        return jsonToolResult({ ok: true, isDefault: !content.trim(), content })
      }
      if (action === 'update' || action === 'soul_update') {
        const content = (p.content ?? '').trim()
        if (!content) {
          return jsonToolResult({ ok: false, message: 'content is required for update' })
        }
        // 写入用户 SOUL 内容（人格/风格/边界）
        const updated = await deps.config.updateSoulContent?.(content)
        return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
      }
      if (action === 'reset') {
        const updated = await deps.config.updateSoulContent?.('')
        return jsonToolResult({ ok: true, updatedAt: updated?.updatedAt })
      }
      return jsonToolResult({ ok: false, message: `unknown action: ${action}` })
    },
  }
  deps.toolRegistry.register(createMtBotTool(systemPromptTool, ctx))

  const speechGenerateTool: MtBotToolConfig = {
    ...speechGenerateToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { text?: string; speaker?: string; speed?: number }
      const text = String(p.text ?? '').trim()
      if (!text) {
        return jsonToolResult({ status: 'error', message: 'text 参数不能为空' })
      }
      if (!deps.config.generateVoiceFile) {
        return jsonToolResult({ status: 'error', message: 'TTS 功能未初始化，请确保语音模型已就绪' })
      }
      try {
        const speed =
          typeof p.speed === 'number' ? Math.max(0.8, Math.min(1.3, p.speed)) : undefined
        const filePath = await deps.config.generateVoiceFile(text, {
          speaker: p.speaker?.trim() || undefined,
          speed,
        })
        // 与 image_generate 同风格：防止路径编造
        const result = {
          status: 'ok' as const,
          filePath,
          note:
            `语音文件已生成。文件的唯一有效路径是 "${filePath}"。` +
            `引用、预览、发送或写入文档时，必须原样使用这个路径——` +
            `严禁根据语义自行编造文件名。`,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: { filePath },
        }
      } catch (e) {
        return jsonToolResult({ status: 'error', message: `语音合成失败: ${(e as Error).message}` })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(speechGenerateTool, ctx))

  const imageGenerateTool: MtBotToolConfig = {
    ...imageGenerateToolConfig,
    execute: async (_id, rawParams, _ctx, signal) => {
      const params = rawParams as {
        prompt?: string
        modelId?: string
        width?: number
        height?: number
        filename?: string
        referenceImagePaths?: string[]
      }
      if (!params.prompt || typeof params.prompt !== 'string') {
        return jsonToolResult({ status: 'error', message: 'prompt 参数不能为空' })
      }
      try {
        // 未显式指定模型时交给 bridge 按 image 槽配置决定（槽内可能是 rightapi 等自有命名空间的模型）；
        // 显式指定但不在已知白名单内的，同样原样透传，避免把自定义模型强行改写成 gpt-image-2。
        const requestedModelId = params.modelId?.trim()
        const resolvedModelId = requestedModelId
          ? isKnownImageGenerationModel(requestedModelId)
            ? normalizeImageModelId(requestedModelId)
            : requestedModelId
          : undefined
        const result = await deps.generateImage({
          prompt: params.prompt,
          modelId: resolvedModelId,
          width: params.width,
          height: params.height,
          filename: params.filename,
          referenceImagePaths: Array.isArray(params.referenceImagePaths)
            ? params.referenceImagePaths
            : undefined,
          signal,
        })
        // 在返回给模型的文本里强制回显真实路径并禁止编造文件名——
        // 弱模型常无视工具返回的 hash 文件名，自行编造 k8s-01-cover.png 之类语义路径写进文档。
        const echo = {
          status: 'ok' as const,
          ...result,
          note:
            `图片已生成并保存。文件的唯一有效路径是 "${result.filePath}"。` +
            `引用、预览、发送或写入文档时，必须原样使用这个路径——` +
            `严禁根据语义自行编造文件名（如 cover.png / img-01.png）。` +
            `如需迭代修改，请把上面的 revisedPrompt 与用户修改指令合并后再次调用本工具。`,
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(echo) }],
          details: result,
        }
      } catch (e) {
        const code = (e as { code?: string }).code ?? 'PROVIDER_ERROR'
        const message = (e as Error).message
        const aborted = code === 'ABORTED' || signal?.aborted || (e as Error).name === 'AbortError'
        if (aborted) {
          throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
        }
        // 必须 throw：pi-agent-core 只有异常才标记 isError，否则 UI 不报错且 LLM 可能再次调用本工具
        throw Object.assign(
          new Error(`图片生成失败（请勿自动重试）：${message}`),
          { code },
        )
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(imageGenerateTool, ctx))

  log.info('[registerToolOverrides] integration tools registered: message/memory/scene_memory/profile/system_prompt/speech_generate/image_generate')
}
