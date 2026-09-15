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
 *
 * 2026-09-15：转交改为**自动执行**（不再等用户点确认卡片）——入口见 `runHandoffFromProposal`。
 * 之所以放在主进程而不是让卡片自动点击：用户切走会话后卡片不渲染，转交就永远不会发生。
 */

import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import { setDevContext } from '../../coding-dev-dev-context'
import { isAcpRunFailureText } from '../../coding-dev-acp-messages'
import { getCodingDevConfig, resolveDevContext } from '../../coding-dev-env'
import { DEFAULT_CODING_DEV_BACKEND_ID } from '../../coding-dev-backends-stub/contracts'
import { handleConversationCreate, handleConversationList } from './conversation-commands'
import { handleUserSend } from './user-commands'
import { getAcpBackendManager } from './coding-dev-commands'

const LOCAL_USER_ID = 'local-user'

/**
 * 未绑定编码工具时的统一提示（桌面与渠道共用口径）。
 *
 * 为什么必须在这里拦住：`backendId === 'lumii'` 时 `handleUserSend` 会静默走 pi 内核兜底，
 * 而 pi 路径**不消费** `devContext.projectPath`——cwd 仍是全局 workspace，
 * 任务就在错误目录里跑，用户却以为转交成功了（静默假成功，比失败更坏）。
 */
export const NO_CLI_BINDING_HINT =
  '⚠️ 灵栖开发还没有绑定编码工具，无法执行本次转交。请在「设置 → 开发 → 项目管理」为「灵栖开发」配置 Agent 绑定（选择编码 CLI 与项目目录），或在本会话用 /claude 切换编码工具后重试。'

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

  // 1. 目标开发会话：recent=先找最近一个（命中即可读到它的会话级上下文）；否则待建
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

  // 2. 绑定预检——**在建会话之前**：未绑定编码工具时明确失败，不静默降级为 pi 内核。
  // 解析链与 handleUserSend 一致（会话级 dev-context > code-dev Agent 绑定 > user-global），
  // 所以这里判定的 backendId 就是实际执行时会用的那个。
  const preview = resolveDevContext({
    appConfig: getCodingDevConfig(),
    accountId: LOCAL_USER_ID,
    // new 模式会话尚未创建：空键必然无会话级记录，不会误命中其它会话
    sessionKey: devSessionKey ?? '',
    agentId: CODE_DEV_AGENT_ID,
    fallbackBackendId: getAcpBackendManager().getBackend(LOCAL_USER_ID),
  })
  if (preview.backendId === DEFAULT_CODING_DEV_BACKEND_ID) {
    log.warn(
      `[runDevHandoff] 拒绝执行：未绑定编码工具（backendId=${preview.backendId} session=${devSessionKey ?? '(待建)'}）`,
    )
    await params.report({
      ok: false,
      devSessionKey: devSessionKey ?? '',
      devSessionTitle: title,
      text: NO_CLI_BINDING_HINT,
    })
    return { devSessionKey: devSessionKey ?? '', title }
  }

  // 3. 建会话（recent 未命中时；出现在「灵栖开发」分组）
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

  // 3.5 写入会话级开发上下文——项目名是「cwd 落在项目目录」的唯一通道：
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
        // ACP 失败/中止的消息同样落库（09-P3b），据此把「完成」判成「失败」——
        // 否则只能白等到 90 分钟超时才汇报，而用户在会话里早已看到错误。
        const failed = isAcpRunFailureText(last.text)
        log.info(
          `[runDevHandoff] 开发任务${failed ? '失败' : '完成'} devSessionKey=${devSessionKey} textLen=${last.text.length}`,
        )
        void Promise.resolve(
          report({
            ok: !failed,
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

/**
 * 完成后把结果写回原会话（主助手会话），保证「原会话知道任务结果」。
 *
 * 从 `handoff-commands` 移入此处：它是执行链的收尾动作，且自动转交（见下）也要用。
 */
export function reportToOriginSession(
  bridge: AgentRuntimeBridge,
  originSessionKey: string,
  summary: string,
  payload: DevHandoffReport,
): void {
  if (!originSessionKey) return
  const text = formatHandoffReport(summary, payload)
  try {
    const id = bridge.conversationRepo.saveMessage({
      conversationId: originSessionKey,
      role: 'assistant',
      contentJson: { type: 'text', text },
    })
    bridge.forwardIpcEvent({
      type: 'conversation:message:new',
      sessionKey: originSessionKey,
      message: {
        id: String(id),
        role: 'assistant',
        content: [{ type: 'text', text }],
        timestamp: Date.now(),
      },
    })
    log.info(`[handoff] 已向原会话汇报结果 sessionKey=${originSessionKey}`)

    // 用户不在原会话时补桌面通知（点击直达）；在原会话则消息已实时可见，不打扰
    if (bridge.getLastActiveConversationId() !== originSessionKey) {
      const label = summary.length > 40 ? `${summary.slice(0, 40)}…` : summary
      bridge.triggerCronNotification(
        `Lumii · 转交${payload.ok ? '完成' : '失败'}`,
        payload.ok ? `「${label}」已完成，点击查看结果` : `「${label}」执行失败：${payload.text.slice(0, 80)}`,
        originSessionKey,
      )
    }
  } catch (err) {
    log.error(`[handoff] 原会话汇报失败: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * 提案即执行（2026-09-15）：转交不再需要用户点确认卡片。
 *
 * 由 `propose_dev_handoff` 工具在生成提案后直接调用（主进程内），覆盖桌面与渠道——
 * 用户切走会话、或客户端不在前台时，任务照常发起。
 *
 * 与「渲染层自动点击卡片」的区别：后者依赖卡片被渲染，切走会话就永远不会触发。
 */
export async function runHandoffFromProposal(params: {
  bridge: AgentRuntimeBridge
  originSessionKey: string
  task: string
  summary: string
  sessionMode: 'new' | 'recent'
  projectName?: string
}): Promise<{ ok: boolean; devSessionKey?: string; title?: string; error?: string }> {
  try {
    const { devSessionKey, title } = await runDevHandoff({
      bridge: params.bridge,
      task: params.task,
      sessionMode: params.sessionMode,
      title: params.summary,
      ...(params.projectName ? { projectName: params.projectName } : {}),
      report: (payload) =>
        reportToOriginSession(params.bridge, params.originSessionKey, params.summary, payload),
    })
    return { ok: true, devSessionKey, title }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`[runHandoffFromProposal] 执行失败: ${message}`)
    // 失败也要让原会话知道，否则用户以为转交生效了
    reportToOriginSession(params.bridge, params.originSessionKey, params.summary, {
      ok: false,
      devSessionKey: '',
      text: `转交发起失败：${message}`,
    })
    return { ok: false, error: message }
  }
}
