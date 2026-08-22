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
  systemPromptToolConfig,
  speechGenerateToolConfig,
  imageGenerateToolConfig,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log, jsonToolResult, removeMarkdownSection } from './bridge-utils'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

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
    execute: async (_id, rawParams) => {
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
      const channel = String(p.channel ?? '').trim() as 'feishu' | 'weixin' | 'wecom'
      if (channel !== 'feishu' && channel !== 'weixin' && channel !== 'wecom') {
        return jsonToolResult({
          ok: false,
          errorCode: 'PEER_NOT_FOUND',
          message: "channel 必须是 'feishu' | 'weixin' | 'wecom'",
        })
      }
      const result = await router.send({
        channel,
        to: String(p.to ?? ''),
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

  const memorySearchTool: MtBotToolConfig = {
    ...memorySearchToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { query?: string; maxResults?: number; sessionKey?: string }
      const query = (p.query ?? '').trim()
      if (!query) {
        return jsonToolResult({ status: 'error', message: 'query is required' })
      }
      const limit = Math.max(1, Math.min(p.maxResults ?? 10, 50))
      const sessionKey = (p.sessionKey ?? '').trim()

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

      // 优先使用 MemPalace 语义搜索
      if (deps.config.searchMempalace) {
        try {
          let items = await deps.config.searchMempalace(query, limit)
          if (items !== null) {
            if (sessionKey) {
              const allowed = drawerIdsForSession(sessionKey)
              if (allowed.size > 0) {
                items = items.filter((item) => allowed.has(item.drawer_id))
              }
            }
            const results = items.map((item) => ({
              content: item.text,
              score: item.similarity,
              source: `${item.wing}/${item.room}`,
              drawer_id: item.drawer_id,
            }))
            return jsonToolResult({
              results,
              provider: 'mempalace',
              query,
              ...(sessionKey ? { sessionKey, sessionScoped: true } : {}),
            })
          }
        } catch {
          // MemPalace 不可用，降级到 user_memory
        }
      }

      // 降级：从 user_memory 文本文档做关键词搜索
      const memory = await deps.config.getUserMemory?.()
      const content = memory?.content ?? ''
      if (!content.trim()) {
        return jsonToolResult({ results: [], provider: 'user-memory', note: 'empty memory document' })
      }
      const lines = content.split(/\r?\n/)
      const q = query.toLowerCase()
      const matched = lines
        .map((line, idx) => ({ line, idx }))
        .filter((row) => row.line.toLowerCase().includes(q))
        .slice(0, limit)
        .map((row) => ({
          content: row.line.trim(),
          line: row.idx + 1,
          score: 0.8,
          source: 'user_memory',
        }))
      return jsonToolResult({ results: matched, provider: 'user-memory', updatedAt: memory?.updatedAt })
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
      // MemPalace drawer_id 为内容寻址 16 位 hex（见 content-address.ts）
      if (!/^[a-f0-9]{16}$/i.test(drawerId)) {
        return jsonToolResult({ ok: false, message: 'drawerId 格式无效（应为 16 位十六进制）' })
      }
      const readDrawer = deps.config.readMempalaceDrawer
      if (!readDrawer) {
        return jsonToolResult({
          ok: false,
          message: 'MemPalace 未配置或不可用，无法读取归档原文',
        })
      }
      try {
        const detail = await readDrawer(drawerId)
        if (!detail) {
          return jsonToolResult({
            ok: false,
            drawerId,
            message: '未找到该 drawer，或 MemPalace 未安装/未运行',
          })
        }
        return jsonToolResult({
          ok: true,
          drawerId: detail.drawer_id,
          wing: detail.wing,
          room: detail.room,
          content: detail.content,
          metadata: detail.metadata,
          provider: 'mempalace',
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

  log.info('[registerToolOverrides] integration tools registered: message/memory/profile/system_prompt/tts_generate/image_generate')
}
