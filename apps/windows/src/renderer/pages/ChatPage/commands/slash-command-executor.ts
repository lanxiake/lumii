/**
 * 客户端斜杠命令执行器
 *
 * 拦截以 "/" 开头的用户输入，在前端本地执行对应操作，
 * 通过 addSystemMessage 将执行结果注入到 UI 消息流（不发给 LLM）。
 */

import { runtimeStore, updateSessionState } from '../../../hooks/business/useAgentRuntime/agent-runtime-store'
import { getSlashCommands, CATEGORY_LABELS, findCommand, type CommandCategory } from './slash-commands'

const logger = {
  info: (...args: unknown[]) => console.log('[SlashCommandExecutor]', ...args),
  error: (...args: unknown[]) => console.error('[SlashCommandExecutor]', ...args),
}

/** 命令执行上下文 */
export interface CommandContext {
  /** 当前会话 key */
  sessionKey: string
  /** 当前 Agent ID */
  agentId?: string
  /** 向会话 UI 注入一条系统消息（不持久化、不发给 LLM） */
  addSystemMessage: (text: string) => void
  /** 向 ChatPage 触发 Toast 通知 */
  showToast?: (message: string, type: 'success' | 'error' | 'info') => void
  /** 压缩上下文的回调（已有逻辑） */
  compactContext?: () => Promise<void>
  /** 新建会话回调 */
  createSession?: () => Promise<void>
  /** 切换到指定会话 */
  switchSession?: (sessionKey: string) => Promise<void>
  /** 列出最近会话（含标题、时间） */
  listSessions?: () => Promise<readonly { sessionKey: string; title: string; updatedAt: string; lastMessagePreview?: string }[]>
}

// ── 命令处理器 ────────────────────────────────────────────────────

async function handleHelp(ctx: CommandContext): Promise<void> {
  const commands = getSlashCommands()
  const grouped = new Map<CommandCategory, typeof commands>()
  for (const cmd of commands) {
    const list = grouped.get(cmd.category) ?? []
    list.push(cmd)
    grouped.set(cmd.category, list)
  }

  const lines: string[] = ['**可用命令列表**\n']
  for (const [cat, cmds] of grouped) {
    lines.push(`**${CATEGORY_LABELS[cat]}**`)
    for (const cmd of cmds) {
      const aliases = cmd.aliases ? ` (${cmd.aliases.join(', ')})` : ''
      lines.push(`• \`${cmd.name}\`${aliases} — ${cmd.description}`)
      if (cmd.usage && cmd.usage !== cmd.name) {
        lines.push(`  用法: \`${cmd.usage}\``)
      }
    }
    lines.push('')
  }
  lines.push('> 输入 `/` 可触发命令补全面板')

  ctx.addSystemMessage(lines.join('\n'))
}

async function handleStatus(ctx: CommandContext): Promise<void> {
  const globalState = runtimeStore.getState()
  const sessionState = globalState.sessions.get(ctx.sessionKey)
  const msgCount = sessionState?.messages.length ?? 0
  const isStreaming = sessionState?.isStreaming ?? false
  const model = sessionState?.currentLlmModelId ?? '（默认）'
  const usage = sessionState?.contextUsage

  const lines: string[] = ['**当前状态**\n']
  lines.push(`• 会话 ID: \`${ctx.sessionKey}\``)
  lines.push(`• 消息数: ${msgCount}`)
  lines.push(`• 运行中: ${isStreaming ? '是' : '否'}`)
  lines.push(`• 当前模型: ${model}`)
  if (usage && usage.contextWindow > 0) {
    const pct = Math.round((usage.usedTokens / usage.contextWindow) * 100)
    lines.push(`• 上下文用量: ${usage.usedTokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${pct}%)`)
  }
  if (ctx.agentId) {
    lines.push(`• Agent: \`${ctx.agentId}\``)
  }

  ctx.addSystemMessage(lines.join('\n'))
}

async function handleClear(ctx: CommandContext): Promise<void> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) {
    ctx.addSystemMessage('❌ 无法执行清空：Agent Runtime 未就绪')
    return
  }

  // 获取当前会话所有消息 ID，逐一删除
  const globalState = runtimeStore.getState()
  const sessionState = globalState.sessions.get(ctx.sessionKey)
  const messages = sessionState?.messages ?? []

  if (messages.length === 0) {
    ctx.addSystemMessage('当前会话没有消息')
    return
  }

  try {
    for (const msg of messages) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        await api.sendCommand({
          type: 'message:delete',
          messageId: msg.id,
          sessionKey: ctx.sessionKey,
        })
      }
    }
    // 本地清空 UI 消息
    updateSessionState(ctx.sessionKey, (prev) => ({
      ...prev,
      messages: [],
    }))
    ctx.showToast?.('会话消息已清空', 'info')
  } catch (err) {
    logger.error('[handleClear] 清空失败:', err)
    ctx.addSystemMessage(`❌ 清空失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function handleNew(ctx: CommandContext): Promise<void> {
  if (!ctx.createSession) {
    ctx.addSystemMessage('❌ 无法新建会话：功能未就绪')
    return
  }
  try {
    await ctx.createSession()
    ctx.showToast?.('已新建会话', 'success')
  } catch (err) {
    logger.error('[handleNew] 新建会话失败:', err)
    ctx.addSystemMessage(`❌ 新建会话失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function handleResume(ctx: CommandContext): Promise<void> {
  if (!ctx.listSessions) {
    ctx.addSystemMessage('❌ 无法获取会话列表：功能未就绪')
    return
  }

  try {
    const sessions = await ctx.listSessions()
    const recent = sessions.slice(0, 10)

    if (recent.length === 0) {
      ctx.addSystemMessage('暂无历史会话。')
      return
    }

    const lines: string[] = ['**最近 10 个会话**（点击编号可恢复对话）\n']
    recent.forEach((s, i) => {
      const date = new Date(s.updatedAt).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
      const preview = s.lastMessagePreview
        ? `  — ${s.lastMessagePreview.slice(0, 40)}${s.lastMessagePreview.length > 40 ? '…' : ''}`
        : ''
      lines.push(`${i + 1}. **${s.title}** \`${date}\`${preview}`)
      lines.push(`   会话 ID: \`${s.sessionKey}\``)
    })
    lines.push('\n> 使用 `/resume <编号>` 直接切换，或点击侧边栏会话名称恢复对话')

    ctx.addSystemMessage(lines.join('\n'))
  } catch (err) {
    logger.error('[handleResume] 获取会话列表失败:', err)
    ctx.addSystemMessage(`❌ 获取会话列表失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function handleResumeByIndex(indexStr: string, ctx: CommandContext): Promise<void> {
  if (!ctx.listSessions || !ctx.switchSession) {
    ctx.addSystemMessage('❌ 无法切换会话：功能未就绪')
    return
  }
  const idx = parseInt(indexStr.trim(), 10)
  if (isNaN(idx) || idx < 1 || idx > 10) {
    ctx.addSystemMessage('用法: `/resume <1-10>`，编号来自 `/resume` 列表')
    return
  }
  try {
    const sessions = await ctx.listSessions()
    const target = sessions[idx - 1]
    if (!target) {
      ctx.addSystemMessage(`❌ 编号 ${idx} 超出会话列表范围（共 ${sessions.slice(0, 10).length} 个）`)
      return
    }
    await ctx.switchSession(target.sessionKey)
    ctx.showToast?.(`已切换到：${target.title}`, 'success')
  } catch (err) {
    logger.error('[handleResumeByIndex] 切换会话失败:', err)
    ctx.addSystemMessage(`❌ 切换失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function handleCompact(args: string, ctx: CommandContext): Promise<void> {
  if (ctx.compactContext) {
    await ctx.compactContext()
    return
  }

  // 直接调用 IPC
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) {
    ctx.addSystemMessage('❌ 无法执行压缩：Agent Runtime 未就绪')
    return
  }

  try {
    ctx.addSystemMessage('🔄 正在压缩上下文...')
    const result = await api.sendCommand({
      type: 'user:compact-context',
      sessionKey: ctx.sessionKey,
      keepRecentTurns: 6,
    }) as { success: boolean; messagesRemoved: number }

    if (result.success) {
      ctx.showToast?.(`上下文已压缩，删除 ${result.messagesRemoved} 条旧消息`, 'success')
      // 重新加载当前会话消息
      await api.sendCommand({ type: 'conversation:switch', sessionKey: ctx.sessionKey })
    } else {
      ctx.addSystemMessage('压缩完成，无需删除消息')
    }
  } catch (err) {
    logger.error('[handleCompact] 压缩失败:', err)
    ctx.addSystemMessage(`❌ 压缩失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

async function handleMemory(args: string, ctx: CommandContext): Promise<void> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) {
    ctx.addSystemMessage('❌ 无法访问记忆：Agent Runtime 未就绪')
    return
  }

  const subCmd = args.trim().toLowerCase()

  if (subCmd === 'clear') {
    try {
      await api.sendCommand({
        type: 'agent:memories:clear',
        agentId: ctx.agentId ?? 'assistant',
        userId: 'local-user',
      })
      ctx.addSystemMessage('✅ Agent 记忆已全部清除')
      ctx.showToast?.('记忆已清空', 'info')
    } catch (err) {
      logger.error('[handleMemory] 清空记忆失败:', err)
      ctx.addSystemMessage(`❌ 清空失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
    return
  }

  // 查看记忆列表
  try {
    const result = await api.sendCommand({
      type: 'agent:memories:list',
      agentId: ctx.agentId ?? 'assistant',
      userId: 'local-user',
    }) as { memories: Array<{ id: string; content: string; type?: string; importance?: number }> }

    const memories = result?.memories ?? []
    if (memories.length === 0) {
      ctx.addSystemMessage('当前 Agent 没有存储任何记忆。')
      return
    }

    const lines: string[] = [`**Agent 记忆列表**（共 ${memories.length} 条）\n`]
    memories.forEach((m, i) => {
      const typeTag = m.type ? ` [${m.type}]` : ''
      const importanceTag = m.importance !== undefined ? ` ★${m.importance}` : ''
      lines.push(`${i + 1}. ${m.content}${typeTag}${importanceTag}`)
    })
    lines.push('\n> 使用 `/memory clear` 清除所有记忆')

    ctx.addSystemMessage(lines.join('\n'))
  } catch (err) {
    logger.error('[handleMemory] 查看记忆失败:', err)
    ctx.addSystemMessage(`❌ 获取记忆失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }
}

/** ACP 后端配置表 */
export const BACKEND_INFO: Record<string, { label: string; desc: string; acpBackendId: string }> = {
  claude:   { label: 'Claude Code',      acpBackendId: 'claude',   desc: 'Anthropic Claude Code CLI，擅长代码理解和生成' },
  'claude-code': { label: 'Claude Code', acpBackendId: 'claude',   desc: 'Anthropic Claude Code CLI，擅长代码理解和生成' },
  codex:    { label: 'Codex',            acpBackendId: 'codex',    desc: 'OpenAI Codex，代码补全和生成模型' },
  opencode: { label: 'OpenCode',         acpBackendId: 'opencode', desc: 'OpenCode 开源编码助手' },
  gemini:   { label: 'Gemini CLI',       acpBackendId: 'gemini',   desc: 'Google Gemini CLI，多模态编程助手' },
  qoder:    { label: 'Qoder',            acpBackendId: 'qoder',    desc: 'Qoder 编程助手' },
  qwen:     { label: 'Qwen Code',        acpBackendId: 'qwen',     desc: '通义千问代码模型' },
  kimi:     { label: 'Kimi K1.5',        acpBackendId: 'kimi',     desc: 'Moonshot Kimi 长上下文编程助手' },
  copilot:  { label: 'GitHub Copilot',   acpBackendId: 'copilot',  desc: 'GitHub Copilot，代码补全与对话' },
  auggie:   { label: 'Augment Code',     acpBackendId: 'auggie',   desc: 'Augment Code，企业级编程助手' },
  cursor:   { label: 'Cursor',           acpBackendId: 'cursor',   desc: 'Cursor AI 编辑器后端' },
  mtbot:    { label: 'MtBot 主 Agent',   acpBackendId: 'openclaw', desc: '默认 MtBot Agent（OpenClaw），支持全功能对话' },
  openclaw: { label: 'MtBot 主 Agent',   acpBackendId: 'openclaw', desc: '默认 MtBot Agent（OpenClaw），支持全功能对话' },
}

/** localStorage key，与 node 端 `CODING_DEV_USER_GLOBAL_ACCOUNT` 选择策略对应 */
const ACP_BACKEND_STORAGE_KEY = 'mtbot:acp-backend'

/** 读取当前已选 ACP 后端 ID（默认 openclaw） */
export function getSelectedAcpBackendId(): string {
  try {
    return localStorage.getItem(ACP_BACKEND_STORAGE_KEY) ?? 'openclaw'
  } catch {
    return 'openclaw'
  }
}

function handleBackend(backend: string, ctx: CommandContext): void {
  const info = BACKEND_INFO[backend]
  if (!info) {
    ctx.addSystemMessage(`❌ 未知后端: \`${backend}\`\n\n可用: /claude /codex /opencode /gemini /qoder /qwen /kimi /copilot /auggie /cursor /mtbot`)
    return
  }

  // 持久化到 localStorage（渲染进程 sessionStorage 不跨刷新；localStorage 更稳定）
  try {
    localStorage.setItem(ACP_BACKEND_STORAGE_KEY, info.acpBackendId)
    logger.info(`[handleBackend] 已将 ACP 后端设置为 ${info.acpBackendId}`)
    // 通知同页面其他组件（如 ChatInput）后端已更改
    window.dispatchEvent(new CustomEvent('mtbot:backend-changed', { detail: { backendId: info.acpBackendId } }))
  } catch (err) {
    logger.error('[handleBackend] 无法写入 localStorage:', err)
  }

  // 通知主进程（如果 agentRuntime.sendCommand 可用）
  const api = window.electronAPI?.agentRuntime
  if (api?.sendCommand) {
    api.sendCommand({
      type: 'codingDev:setBackend',
      backendId: info.acpBackendId,
    }).catch((err: unknown) => {
      logger.info('[handleBackend] codingDev:setBackend 未实现或失败，仅本地生效')
    })
  }

  ctx.addSystemMessage(
    `**已切换后端：${info.label}**\n\n${info.desc}\n\n后端偏好已保存，下次使用 ACP 工具（如 \`/claude\` 对话）时生效。`,
  )
  ctx.showToast?.(`已切换到 ${info.label}`, 'success')
}

async function handleThink(args: string, ctx: CommandContext): Promise<void> {
  const level = args.trim().toLowerCase()
  const validLevels = ['off', 'low', 'medium', 'high']
  if (!validLevels.includes(level)) {
    ctx.addSystemMessage(
      `用法: \`/think <off|low|medium|high>\`\n\n当前设置将在下次发送时生效。`,
    )
    return
  }
  // 保存到 localStorage，由 ChatInput 发送时读取附加到请求
  try {
    localStorage.setItem('mtbot:think-level', level)
  } catch { /* ignore */ }
  ctx.addSystemMessage(`✅ 思考级别已设置为 **${level}**，将在下次发送消息时生效。`)
  ctx.showToast?.(`思考级别: ${level}`, 'info')
}

// ── 主执行入口 ────────────────────────────────────────────────────

/**
 * 执行斜杠命令
 *
 * @param rawInput - 用户原始输入（如 "/compact"、"/memory clear"）
 * @param ctx - 命令上下文
 * @returns 是否已处理（true = 不发给 LLM）
 */
export async function executeSlashCommand(
  rawInput: string,
  ctx: CommandContext,
): Promise<boolean> {
  const trimmed = rawInput.trim()
  if (!trimmed.startsWith('/')) return false

  // 解析命令名和参数
  const spaceIdx = trimmed.indexOf(' ')
  const cmdName = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx) : trimmed
  const args = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1) : ''

  const cmd = findCommand(cmdName)
  if (!cmd) {
    // 未知命令：让 LLM 处理（不拦截）
    logger.info(`[executeSlashCommand] 未知命令: ${cmdName}，放行给 LLM`)
    return false
  }

  logger.info(`[executeSlashCommand] 执行命令: ${cmd.name}, args="${args}"`)

  // 将用户输入的命令文本也显示在 UI 中（作为行内引用）
  ctx.addSystemMessage(`> ${trimmed}`)

  try {
    switch (cmd.name) {
      case '/help':
        await handleHelp(ctx)
        break
      case '/status':
        await handleStatus(ctx)
        break
      case '/clear':
        await handleClear(ctx)
        break
      case '/new':
        await handleNew(ctx)
        break
      case '/resume':
        if (args.trim()) {
          await handleResumeByIndex(args, ctx)
        } else {
          await handleResume(ctx)
        }
        break
      case '/compact':
        await handleCompact(args, ctx)
        break
      case '/memory':
        await handleMemory(args, ctx)
        break
      case '/claude':
        handleBackend('claude', ctx)
        break
      case '/codex':
        handleBackend('codex', ctx)
        break
      case '/opencode':
        handleBackend('opencode', ctx)
        break
      case '/gemini':
        handleBackend('gemini', ctx)
        break
      case '/qoder':
        handleBackend('qoder', ctx)
        break
      case '/qwen':
        handleBackend('qwen', ctx)
        break
      case '/kimi':
        handleBackend('kimi', ctx)
        break
      case '/copilot':
        handleBackend('copilot', ctx)
        break
      case '/auggie':
        handleBackend('auggie', ctx)
        break
      case '/cursor':
        handleBackend('cursor', ctx)
        break
      case '/mtbot':
        handleBackend('mtbot', ctx)
        break
      case '/think':
        await handleThink(args, ctx)
        break
      default:
        // 有注册但无 handler 的命令，fallthrough 给 LLM
        return false
    }
  } catch (err) {
    logger.error(`[executeSlashCommand] 命令 ${cmd.name} 执行出错:`, err)
    ctx.addSystemMessage(`❌ 命令执行失败: ${err instanceof Error ? err.message : '未知错误'}`)
  }

  return true
}
