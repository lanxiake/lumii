/**
 * 转交执行器（F2/F3 共用）
 *
 * 把开发任务发到「灵栖开发」的开发会话（新建或复用最近一个），完成后异步汇报回原会话：
 * - 执行空间 = 开发会话（灵栖开发分组；任务消息、工具过程与产出都落在那里，客户端可见）；
 * - 汇报 = 完成/失败后经调用方提供的 report 回调写回原会话
 *   （桌面 → 原会话追加汇报消息；渠道 → 发回渠道）。
 *
 * 发起复用 handleUserSend 的完整路径（任务消息落库 + 开发上下文解析 + ACP 直达 / pi 兜底），
 * 完成监听使用轮询（会话无流式消息且出现新的助手回复即为完成），不依赖额外事件基建。
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { setDevContext } from '../../coding-dev-dev-context'
import { handleConversationCreate, handleConversationList } from './conversation-commands'
import { handleUserSend } from './user-commands'

const LOCAL_USER_ID = 'local-user'

const log = {
  info: (...args: unknown[]) => console.log('[AgentRuntime:IPC]', ...args),
  warn: (...args: unknown[]) => console.warn('[AgentRuntime:IPC]', ...args),
  error: (...args: unknown[]) => console.error('[AgentRuntime:IPC]', ...args),
}

const CODE_DEV_AGENT_ID = 'code-dev'
/** 完成监听轮询间隔与超时（开发任务可能跑很久；超时后按失败汇报） */
const WATCH_POLL_MS = 5000
const WATCH_TIMEOUT_MS = 90 * 60 * 1000

export interface DevHandoffReport {
  ok: boolean
  devSessionKey: string
  devSessionTitle?: string
  /** 成功 = 开发会话最终回复文本；失败 = 失败原因 */
  text: string
}

export interface RunDevHandoffParams {
  bridge: AgentRuntimeBridge
  /** 完整任务描述（背景包），作为开发任务原文发出 */
  task: string
  /** new=新建开发会话；recent=复用最近的开发会话（延续任务） */
  sessionMode: 'new' | 'recent'
  /** 新建会话时的标题（一般传提案摘要） */
  title?: string
  /** 目标项目名（来自提案）。给出时写入开发会话的 dev-context，决定 cwd 落在哪个项目目录 */
  projectName?: string
  /** 完成后异步汇报（不阻塞调用方；异常自行捕获） */
  report: (payload: DevHandoffReport) => void | Promise<void>
}

/** 由摘要生成会话标题（单行、截断） */
function titleFromSummary(summary: string): string {
  const one = summary.replace(/\s+/g, ' ').trim()
  if (!one) return '开发任务'
  return one.length > 24 ? `${one.slice(0, 24)}…` : one
}

/** 找「灵栖开发」最近的用户会话（排除自主/定时系统会话） */
function findRecentCodeDevSession(bridge: AgentRuntimeBridge): { sessionKey: string; title?: string } | null {
  try {
    const recent = handleConversationList(bridge)
      .filter(
        (c) =>
          c.agentId === CODE_DEV_AGENT_ID &&
          !c.id.startsWith('evolution:') &&
          !c.id.startsWith('cron:'),
      )
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0]
    return recent ? { sessionKey: recent.sessionKey, title: recent.title } : null
  } catch (err) {
    log.warn(`[runDevHandoff] 查找最近开发会话失败，回退新建: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/** 取会话最后一条助手消息的文本与 id（用于完成判定与汇报内容） */
function lastAssistantSnapshot(
  bridge: AgentRuntimeBridge,
  sessionKey: string,
): { id: string; text: string; streaming: boolean } | null {
  try {
    const rows = bridge.conversationRepo.loadRecentMessages(sessionKey, 20)
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i]
      if (!row || row.role !== 'assistant') continue
      let text = ''
      try {
        const cj = typeof row.content_json === 'string' ? JSON.parse(row.content_json) : row.content_json
        if (cj && typeof cj === 'object') {
          if (Array.isArray(cj.parts)) {
            text = cj.parts
              .filter((p: { type?: string; text?: string }) => p?.type === 'text' && p.text)
              .map((p: { text?: string }) => p.text ?? '')
              .join('')
          } else if (typeof cj.text === 'string') {
            text = cj.text
          }
        }
      } catch {
        text = ''
      }
      return { id: String(row.id), text, streaming: row.is_streaming === 1 }
    }
  } catch (err) {
    log.warn(`[runDevHandoff] 读取开发会话消息失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

/** 统一的完成汇报文案（桌面写入原会话 / 渠道发回消息共用） */
export function formatHandoffReport(summary: string, r: DevHandoffReport): string {
  const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
  return r.ok
    ? `✅ 转交完成：「${summary}」\n灵栖开发已在《${r.devSessionTitle ?? '开发会话'}》中完成，结果：\n\n${truncate(r.text.trim() || '（无文本输出）', 800)}`
    : `❌ 转交执行失败：「${summary}」\n${truncate(r.text, 400)}`
}

/**
 * 发起转交并挂完成监听。
 * @returns 目标开发会话（供调用方回执/跳转）
 */
export async function runDevHandoff(
  params: RunDevHandoffParams,
): Promise<{ devSessionKey: string; title?: string }> {
  const { bridge, task, sessionMode } = params

  // 1. 目标开发会话：recent=最近一个开发会话；否则新建（出现在「灵栖开发」分组）
  let devSessionKey: string | undefined
  let title = params.title
  if (sessionMode === 'recent') {
    const recent = findRecentCodeDevSession(bridge)
    if (recent) {
      devSessionKey = recent.sessionKey
      title = recent.title
      log.info(`[runDevHandoff] 复用最近开发会话 ${devSessionKey}（${title ?? '无标题'}）`)
    }
  }
  if (!devSessionKey) {
    const created = await handleConversationCreate(bridge, {
      type: 'conversation:create',
      title: params.title ? titleFromSummary(params.title) : '开发任务',
      agentId: CODE_DEV_AGENT_ID,
    })
    devSessionKey = created.sessionKey
    title = bridge.conversationRepo.getConversation(devSessionKey)?.title ?? title
    log.info(`[runDevHandoff] 新建开发会话 ${devSessionKey}（${title ?? '无标题'}）`)
  }

  // 1.5 写入会话级开发上下文——项目名是「cwd 落在项目目录」的唯一通道：
  // resolveDevContext 只认 dev-context 与 Agent 绑定（codingDevProjects 本身不参与解析），
  // 不写这一步，即使项目已注册，开发会话也会退化成全局 workspace。
  // 仅在提案指定了项目时写入；未指定则保持会话原状（recent 模式不覆盖用户既有选择）。
  if (params.projectName) {
    setDevContext(LOCAL_USER_ID, devSessionKey, { projectName: params.projectName })
    log.info(
      `[runDevHandoff] 写入开发上下文 projectName=${params.projectName} session=${devSessionKey}`,
    )
  }

  const base = lastAssistantSnapshot(bridge, devSessionKey)

  // 2. 发起：任务消息落库 + 开发上下文解析 + ACP 直达 / pi 兜底
  await handleUserSend(bridge, {
    type: 'user:send',
    sessionKey: devSessionKey,
    content: task,
    agentId: CODE_DEV_AGENT_ID,
  })
  log.info(`[runDevHandoff] 开发任务已发起 devSessionKey=${devSessionKey} mode=${sessionMode}`)

  // 3. 完成监听（后台；完成/失败后经 report 汇报回原会话）
  startWatchCompletion(bridge, devSessionKey, title, base?.id ?? null, params.report)

  return { devSessionKey, title }
}

function startWatchCompletion(
  bridge: AgentRuntimeBridge,
  devSessionKey: string,
  title: string | undefined,
  baseMsgId: string | null,
  report: (payload: DevHandoffReport) => void | Promise<void>,
): void {
  const startedAt = Date.now()
  const timer = setInterval(() => {
    try {
      if (Date.now() - startedAt > WATCH_TIMEOUT_MS) {
        clearInterval(timer)
        void Promise.resolve(
          report({
            ok: false,
            devSessionKey,
            devSessionTitle: title,
            text: '等待开发任务完成超时（90 分钟），请到开发会话查看实际状态。',
          }),
        ).catch((err) => log.error(`[runDevHandoff] 超时汇报失败: ${err}`))
        return
      }

      const last = lastAssistantSnapshot(bridge, devSessionKey)
      if (!last || last.id === baseMsgId || last.streaming) return
      if (!bridge.hasStreamingMessages(devSessionKey)) {
        clearInterval(timer)
        log.info(`[runDevHandoff] 开发任务完成 devSessionKey=${devSessionKey} textLen=${last.text.length}`)
        void Promise.resolve(
          report({
            ok: true,
            devSessionKey,
            devSessionTitle: title,
            text: last.text,
          }),
        ).catch((err) => log.error(`[runDevHandoff] 完成汇报失败: ${err}`))
      }
    } catch (err) {
      clearInterval(timer)
      log.error(`[runDevHandoff] 完成监听异常: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, WATCH_POLL_MS)
  // 不阻止进程退出
  if (typeof timer.unref === 'function') timer.unref()
}
