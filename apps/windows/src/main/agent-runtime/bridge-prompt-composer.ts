/**
 * 系统提示词动态部分：用户记忆、活跃任务、项目上下文文件、客户端诊断信息
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import {
  CACHE_BOUNDARY_MARKER,
  formatUserMemoryForPrompt,
  stripMemoryPlaceholder,
  type ActiveTaskInfo,
  type ContextFile,
  type SystemPromptResult,
  type TaskRepo,
} from '@mtbot/agent-runtime'
import type { InstanceStateStore } from './bridge-instance-state'
import { agentRuntimeLog as log } from './bridge-utils'
import { getVirtualHumanContext } from '../pet/virtual-human-activation'
import { renderVirtualHumanPromptSection } from '../pet/virtual-human-context'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import { getLocalDateString } from '../local-time'
import { resolveSceneHits } from './scene-resolver'
import { readSceneMemory } from './scene-memory-store'

/** 记忆注入开关（个人记忆 / 工作记忆） */
export interface MemoryInjectionSettings {
  readonly injectPersonalMemory: boolean
  readonly injectWorkMemory: boolean
}

export interface BridgePromptComposerDeps {
  getCwd: () => string
  /** 返回配置中的 getUserMemory 调用结果（未配置时跳过） */
  loadUserMemory: () => Promise<{ content: string; updatedAt?: string } | undefined>
  /** 读取记忆注入开关（未配置且调用方未传入时使用，默认全部开启） */
  getMemoryInjectionSettings?: () => Promise<MemoryInjectionSettings>
  getTaskRepo: () => TaskRepo | null
  instanceToConversation: Map<string, string>
  /**
   * 读会话归属渠道（`conversations.channel_type`，10-S2）。
   * 未注入时渠道偏好按 id 前缀回退推断（裁剪宿主 / 测试桩）。
   */
  getConversationOwnership?: (conversationId: string) => string | null
  /** Per-instance 聚合状态存储（提供 memoryGuideInjected / skipTaskInjection） */
  instanceStates: InstanceStateStore
  /** 取一条可提起的牵挂并标记已提起（返回牵挂描述或 null 表示无可提） */
  consumeConcernToRaise?: (conversationId: string) => string | null
  /**
   * 工作记忆填充：把 prompt 中的 {{LUMII_MEMORY_BLOCK}} 占位符替换为与当前消息相关的热记忆块。
   * instanceId 决定记忆归属（宿主按实例 definitionId 注入对应 Agent 的 agent_memories）。
   * 返回 null 表示未配置（调用方清除占位符兜底）。
   */
  fillWorkMemoryPlaceholder?: (
    prompt: string,
    query: string | undefined,
    instanceId: string,
  ) => { prompt: string; injected: number } | null
}

/** 诊断采样结果（单进程共享缓存） */
interface ClientDiagnostics {
  sampledAt: number
  logsDir: string
  /** 磁盘采样所在卷（如 `C:`），随数值一起展示，避免读者误以为是日志目录 */
  diskRoot: string
  cpuPct: number
  cpuLogicalCores: number
  memTotalGB: number
  memUsedGB: number
  memPct: number
  diskTotalGB: number
  diskUsedGB: number
  diskPct: number
}

/** 诊断注入的健康阈值（与文案建议一致） */
const DIAG_HEALTH = {
  CPU_PCT_WARN: 85,
  MEM_PCT_WARN: 85,
  DISK_PCT_WARN: 90,
  DISK_GB_MIN_FREE: 5,
} as const

/** 诊断缓存 TTL（ms）：5 秒，避免每轮 build prompt 都走一遍采样 */
const DIAG_CACHE_TTL_MS = 5_000

/** 任务完成契约：注入 Active Tasks 段落后强制 LLM 自检，降低长任务幻觉率 */
const TASK_COMPLETION_CONTRACT = [
  "## Task Integrity Rules (硬约束)",
  "- Active Tasks 里还有 pending/in_progress 时，禁止说「全部完成」「已完成」「都做好了」。",
  "- 工具报错：对应任务保持 in_progress，并在回复中说明「X 未完成，原因：Y」，不得静默跳过。",
  "- 宣告完成前必须先 todo_write 核对，所有项 status 均为 completed 才可宣告。",
].join("\n")

/** 牵挂注入段：轻量提示，LLM 自行判断是否顺带提起，绝不强制追问 */
function buildConcernSection(description: string): string {
  return [
    "## Open Concerns",
    "你还在意、但尚未有结论的事。若对话自然合适可顺带提起一句，不要专门追问或打断当前话题：",
    `- ${description}`,
    "",
  ].join("\n")
}

/** User Presence 注入段（P0：仅在用户不在客户端时调用） */
function buildUserPresenceSection(presence: { userAtClient: boolean; channelLabel?: string }): string {
  const label = presence.channelLabel ?? '消息渠道'
  return [
    "## User Presence（本轮回复载体）",
    `用户不在桌面客户端前，只能收到纯文本（渠道：${label}）；Markdown 记号、表格、代码块都会原样显示成噪声，也看不到工具卡片与文件树。`,
    "- 结论前置（开头 1-2 句摘要），口语化短句；分点用「1. 2. 3.」，不用列表与表格。",
    "- 默认 ≤200 字；用户明确要「详细」时再展开，但仍不分层标题。",
    "- 不写「见左侧文件树」「点击下方按钮」这类依赖界面的表述。",
    "- 产出文件时告知文件名与保存位置；报告/笔记等长内容写成 HTML 文件发送，聊天里只留 3 行摘要。",
    "",
  ].join("\n")
}

/** 模块级诊断缓存（所有 Composer 实例共享，保证 prompt 连续轮次间命中缓存） */
let diagCache: { value: ClientDiagnostics; expiresAt: number } | null = null

/** CPU 异步采样：上一次 user+nice+sys+idle+iowait+irq 的快照（按 CPU 核心聚合） */
let cpuPrev: { total: number; idle: number } | null = null

/**
 * 执行一次系统诊断采样（CPU 100ms 间隔取增量、内存 os.totalmem/freemem、
 * 磁盘按 data-root 所在卷用 fs.statfsSync）。
 *
 * 不探测 CLI：`lumii --help` 的全文曾内联进 prompt（最长 3k 字符、每轮注入），
 * 篇幅不划算——改为在诊断段里提示模型按需自己执行。
 */
function sampleClientDiagnostics(): ClientDiagnostics {
  // 日志目录：与 client-data-root 保持一致（~/.lumii/logs）
  const dataRoot = resolveWindowsClientDataRoot()
  const logsDir = path.join(dataRoot, 'logs')
  // 磁盘采样卷（与下方 statfsSync 的目标一致），展示时带上以免被误读成日志目录
  const diskRoot = path.parse(dataRoot).root.replace(/[\\/]+$/, '')

  // CPU：100ms 间隔两次快照差值计算使用率（百分比，0~100）
  const cpuLogicalCores = os.cpus().length
  let cpuPct = 0
  try {
    const snap = (): { total: number; idle: number } => {
      const cpus = os.cpus()
      let total = 0
      let idle = 0
      for (const c of cpus) {
        const { user, nice, sys, idle: i, irq } = c.times
        const t = user + nice + sys + i + irq
        total += t
        idle += i
      }
      return { total, idle }
    }
    const a = cpuPrev ?? snap()
    // 小睡 80~120ms 取差；采样在缓存周期内仅首次触发，不阻塞多数轮次
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    const b = snap()
    cpuPrev = b
    const dt = b.total - a.total
    const di = b.idle - a.idle
    cpuPct = dt > 0 ? Math.max(0, Math.min(100, Math.round(((dt - di) / dt) * 1000) / 10)) : 0
  } catch {
    // Atomics.wait 在某些环境不可用，退化到 0
    cpuPct = 0
  }

  // 内存
  const totalMem = os.totalmem()
  const freeMem = os.freemem()
  const usedMem = Math.max(0, totalMem - freeMem)
  const memTotalGB = +(totalMem / 1024 / 1024 / 1024).toFixed(2)
  const memUsedGB = +(usedMem / 1024 / 1024 / 1024).toFixed(2)
  const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 1000) / 10 : 0

  // 磁盘：取 data-root 所在卷
  let diskTotalGB = 0
  let diskUsedGB = 0
  let diskPct = 0
  try {
    const st = fs.statfsSync(dataRoot)
    // block size 乘 blocks：避免溢出，先用 BigInt
    const bavail = typeof st.bavail === 'bigint' ? st.bavail : BigInt(st.bavail | 0)
    const btotal = typeof st.blocks === 'bigint' ? st.blocks : BigInt(st.blocks | 0)
    const bsize = typeof st.bsize === 'bigint' ? st.bsize : BigInt(st.bsize | 0)
    const availBytes = bavail * bsize
    const totalBytes = btotal * bsize
    const usedBytes = totalBytes - availBytes
    const GB = 1024n * 1024n * 1024n
    diskTotalGB = Number(totalBytes / GB) + Number(totalBytes % GB) / 1024 / 1024 / 1024
    diskUsedGB = Number(usedBytes / GB) + Number(usedBytes % GB) / 1024 / 1024 / 1024
    diskTotalGB = +diskTotalGB.toFixed(2)
    diskUsedGB = +diskUsedGB.toFixed(2)
    diskPct = totalBytes > 0n ? Math.round((Number(usedBytes * 1000n / totalBytes)) / 10) : 0
  } catch {
    /* statfs 失败保持 0 */
  }

  return {
    sampledAt: Date.now(),
    logsDir,
    diskRoot,
    cpuPct,
    cpuLogicalCores,
    memTotalGB,
    memUsedGB,
    memPct,
    diskTotalGB,
    diskUsedGB,
    diskPct,
  }
}

/** 获取（或缓存内命中）诊断快照 */
function getOrSampleDiagnostics(): ClientDiagnostics {
  const now = Date.now()
  if (diagCache && now < diagCache.expiresAt) {
    return diagCache.value
  }
  const d = sampleClientDiagnostics()
  diagCache = { value: d, expiresAt: now + DIAG_CACHE_TTL_MS }
  return d
}

/**
 * 把诊断快照格式化为 Prompt 段。
 *
 * 篇幅纪律：该段每轮都注入，只留模型能直接行动的信息（路径 / 取证入口 / 异常），
 * 不写采样实现、刷新周期与阈值口径——模型据此做不了任何事。
 */
function buildClientDiagnosticsSection(d: ClientDiagnostics): string {
  const today = getLocalDateString(new Date(d.sampledAt))
  const alerts: string[] = []
  if (d.cpuPct >= DIAG_HEALTH.CPU_PCT_WARN) {
    alerts.push(`CPU 偏高：建议用户关掉吃 CPU 的后台程序，或减少并发工具调用。`)
  }
  if (d.memPct >= DIAG_HEALTH.MEM_PCT_WARN) {
    alerts.push(`内存偏高：建议用户关掉占内存的其他软件；自己跑重活时拆子任务、及时释放上下文。`)
  }
  if (d.diskPct >= DIAG_HEALTH.DISK_PCT_WARN || (d.diskTotalGB > 0 && d.diskTotalGB - d.diskUsedGB < DIAG_HEALTH.DISK_GB_MIN_FREE)) {
    alerts.push(`磁盘紧张：让用户清理磁盘，否则日志/SQLite/上传文件会写失败；可删 7 天前的旧日志。`)
  }

  return [
    '## Client Diagnostics（本机快照 · 只读）',
    '用于自查运行/配置异常，数值本身不必念给用户；改动用户数据或设置前必须先 ask_user_question 取得同意。',
    `- 日志：\`${d.logsDir}\` —— \`app/mtbot-${today}.log\` 是全量（WARN 级故障只在这里），\`app/mtbot-error-${today}.log\` 只有 ERROR；排查先看全量。`,
    '- CLI：自愈命令以 `lumii --help` 的实际输出为准（本机没有该命令就改为引导用户到设置页操作）；配置改动先 ask_user_question，`lumii app restart` 会中断当前对话。',
    `- 资源：CPU ${d.cpuPct}%（${d.cpuLogicalCores} 核）· 内存 ${d.memPct}%（${d.memUsedGB}/${d.memTotalGB}GB）· 磁盘 ${d.diskRoot} ${d.diskPct}%（${d.diskUsedGB}/${d.diskTotalGB}GB）`,
    ...alerts.map((a) => `- ⚠️ ${a}`),
    '',
  ].join('\n')
}

export class BridgePromptComposer {
  private readonly TASK_SECTION_REGEX = /## Active Tasks[\s\S]*?(?=\n## |$)/
  private readonly MEMORY_SUMMARY_REGEX = /## Memory\n持久化记忆系统[\s\S]*?(?=\n## |$)/
  private readonly HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
  private readonly TRIPLE_NEWLINE_REGEX = /\n{3,}/g
  private readonly EMPTY_SECTION_REGEX = /^##\s+[^\n]*\n(?=\s*(?:##\s|$))/gm

  constructor(private readonly deps: BridgePromptComposerDeps) {}

  /**
   * 将最新用户记忆注入到动态部分，同时刷新活跃任务，返回完整系统提示词。
   *
   * @param memoryInjection 可选：由调用方预取的注入开关，避免与 dispatcher 重复读 localStorage
   * @param userMessage 可选：本轮用户消息，用于项目场景匹配（创建实例时无消息，只可能命中渠道）
   */
  async buildPromptWithMemory(
    instanceId: string,
    result: SystemPromptResult,
    memoryInjection?: MemoryInjectionSettings,
    userMessage?: string,
  ): Promise<string> {
    const { staticPrompt } = result

    const convId = this.deps.instanceToConversation.get(instanceId)
    // 外部通道（微信等）实例跳过 Session Tasks 注入，避免旧任务干扰新消息
    const skipTasks = this.deps.instanceStates.get(instanceId)?.skipTaskInjection ?? false
    const activeTasks = skipTasks ? [] : this.getActiveTasks(convId)
    const taskSection =
      activeTasks.length > 0
        ? [
            '## Active Tasks',
            'These tasks are currently tracked. Stay focused on completing them.',
            '',
            ...activeTasks.map((t) => {
              const owner = t.owner ? ` (assigned: ${t.owner})` : ''
              return `- [${t.status}] ${t.subject}${owner}`
            }),
            '',
          ].join('\n')
        : ''

    // 个人记忆/场景记忆/工作记忆注入开关（未显式传入时读设置，默认开启）
    let injPersonal = memoryInjection?.injectPersonalMemory
    let injWork = memoryInjection?.injectWorkMemory
    if (injPersonal === undefined || injWork === undefined) {
      try {
        const s = await this.deps.getMemoryInjectionSettings?.()
        if (injPersonal === undefined) injPersonal = s?.injectPersonalMemory ?? true
        if (injWork === undefined) injWork = s?.injectWorkMemory ?? true
      } catch (err) {
        log.warn('[buildPromptWithMemory] 读取记忆注入设置失败，按开启处理:', err)
        if (injPersonal === undefined) injPersonal = true
        if (injWork === undefined) injWork = true
      }
    }

    let memorySection = ''
    try {
      // 个人记忆在此注入；工作记忆由 fillWorkMemoryPlaceholder 回调在构建期就地填充（见方法尾部）
      if (injPersonal !== false) {
        const userMemory = await this.deps.loadUserMemory()
        const userMemoryContent = this.cleanMarkdown(userMemory?.content ?? '')
        if (userMemoryContent) {
          memorySection = formatUserMemoryForPrompt(
            this.budgetMarkdown(
              userMemoryContent,
              this.USER_MEMORY_MAX_CHARS,
              '（个人记忆较长，此处仅注入核心部分；需要更多用户画像/偏好时用 `profile_memory` 的 `read_memory` 读取完整文档）',
            ),
          )
        }
      }
    } catch (err) {
      log.error('[buildPromptWithMemory] 加载用户记忆失败:', err)
    }

    const needsFullMemoryGuide = this.deps.instanceStates.get(instanceId)?.memoryGuideInjected ?? false
    let fullMemoryGuideSection = ''
    if (needsFullMemoryGuide) {
      const { MEMORY_GUIDE_CONTENT } = await import('@mtbot/agent-runtime')
      fullMemoryGuideSection = '\n' + MEMORY_GUIDE_CONTENT + '\n'
    }

    const dynamicParts = [result.dynamicPrompt]
    if (taskSection) {
      if (this.TASK_SECTION_REGEX.test(dynamicParts[0])) {
        dynamicParts[0] = dynamicParts[0].replace(this.TASK_SECTION_REGEX, taskSection)
      }
      // 有活跃任务时注入完成契约，硬约束 LLM 不得在任务未完成时宣称"全部完成"
      dynamicParts.push(TASK_COMPLETION_CONTRACT)
    }
    if (fullMemoryGuideSection) {
      if (this.MEMORY_SUMMARY_REGEX.test(dynamicParts[0])) {
        dynamicParts[0] = dynamicParts[0].replace(this.MEMORY_SUMMARY_REGEX, fullMemoryGuideSection)
      } else {
        dynamicParts.push(fullMemoryGuideSection)
      }
    }
    if (memorySection) {
      dynamicParts.push(memorySection)
    }

    // 场景记忆段（项目/渠道）：命中才注入、不常驻
    // 设计：docs/design/记忆与Wiki/2026-09-12-场景记忆设计.md
    if (injPersonal !== false) {
      const sceneSections = await this.buildSceneMemorySections(instanceId, userMessage)
      for (const section of sceneSections) {
        dynamicParts.push(section)
      }
    }

    // 宠物模式：按 sessionKey 注入表情/动作/persona 段（ADR-14，主进程单一数据源）
    const sessionKey = this.deps.instanceToConversation.get(instanceId)
    const vhContext = getVirtualHumanContext(sessionKey)
    if (vhContext) {
      const vhSection = renderVirtualHumanPromptSection(vhContext)
      if (vhSection) {
        dynamicParts.push(vhSection)
        log.info(
          `[vh] prompt:inject modelId=${vhContext.modelId} emotions=${vhContext.emotionKeys.length} motions=${vhContext.motionActions.length} expr=${vhContext.enableExpressionPrompt} think=${vhContext.enableThinkTagPrompt}`,
        )
      }
    }

    // 牵挂：用户主动对话时顺带注入可提起的牵挂（内部会话排除在 bridge 侧）
    if (this.deps.consumeConcernToRaise && sessionKey) {
      try {
        const concern = this.deps.consumeConcernToRaise(sessionKey)
        if (concern) {
          dynamicParts.push(buildConcernSection(concern))
        }
      } catch (err) {
        log.warn(
          '[buildPromptWithMemory] 注入牵挂失败:',
          err instanceof Error ? err.message : String(err),
        )
      }
    }

    // 客户端诊断段：日志目录 / CLI help / CPU 内存磁盘 + 阈值建议（5s 缓存）
    try {
      const diag = getOrSampleDiagnostics()
      dynamicParts.push(buildClientDiagnosticsSection(diag))
    } catch (err) {
      // 诊断采样挂了绝不影响对话主流程，只记录日志
      log.warn('[buildPromptWithMemory] 客户端诊断采样失败，跳过注入:', err instanceof Error ? err.message : String(err))
    }

    // User Presence 段：本轮回复载体（P0：二元在场信号）。仅在用户不在客户端时注入。
    try {
      const presence = this.deps.instanceStates.get(instanceId)?.presence
      if (presence && !presence.userAtClient) {
        dynamicParts.push(buildUserPresenceSection(presence))
      }
    } catch (err) {
      log.warn('[buildPromptWithMemory] User Presence 注入失败，跳过:', err instanceof Error ? err.message : String(err))
    }

    // 段间统一补空行：各段自带的换行风格不一（有的带前导 \n、有的不带），
    // 直接 join('') 会让 Task Integrity / Open Concerns 这类段粘在上一段末行，标题被读成正文。
    const dynamicPrompt = dynamicParts
      .map((part) => part.replace(/\s+$/, ''))
      .filter((part) => part.length > 0)
      .map((part, i) => (i === 0 ? part : '\n\n' + part.replace(/^\s+/, '')))
      .join('')
    let finalPrompt = dynamicPrompt ? `${staticPrompt}${CACHE_BOUNDARY_MARKER}${dynamicPrompt}` : staticPrompt

    // 工作记忆：构建期就地填充 dynamic 段占位符（2026-09-13 由 agent_start 迁移——pi-agent-core
    // 在 run 开始时快照 systemPrompt，agent_start 注入晚一拍、进不了本轮模型；构建期填充保证当轮必达）
    if (injWork !== false) {
      let filled: { prompt: string; injected: number } | null = null
      try {
        filled = this.deps.fillWorkMemoryPlaceholder?.(finalPrompt, userMessage, instanceId) ?? null
        if (filled) {
          log.info(
            `[buildPromptWithMemory] 工作记忆注入 ${filled.injected} 条 instanceId=${instanceId}`,
          )
        }
      } catch (err) {
        log.error('[buildPromptWithMemory] 工作记忆注入失败:', err)
      }
      // 未配置回调或失败：占位符必须出清，防字面量泄漏进模型输入
      finalPrompt = filled ? filled.prompt : stripMemoryPlaceholder(finalPrompt)
    } else {
      // 开关关闭：占位符出清
      finalPrompt = stripMemoryPlaceholder(finalPrompt)
    }
    return finalPrompt
  }

  /**
   * 个人记忆注入预算：约 1200 token（中文约 2 字符/token ≈ 2400 字）。
   * 个人记忆文档可增长到数十 KB，整篇注入会淹没当前任务、诱发"口嗨已完成"的幻觉，
   * 故此处按章节（## ）边界做预算截断，超出部分用 profile_memory read_memory 按需读取。
   */
  private readonly USER_MEMORY_MAX_CHARS = 2400

  /** 项目记忆注入预算：项目约定可以比用户画像更长 */
  private readonly PROJECT_MEMORY_MAX_CHARS = 4000

  /** 渠道偏好注入预算：渠道偏好天然短 */
  private readonly CHANNEL_MEMORY_MAX_CHARS = 1200

  /**
   * 构建场景记忆注入段（项目/渠道）。
   * 渠道由 sessionKey 解析；项目由当前用户消息匹配注册表别名——未命中不注入。
   * 创建实例时无消息传入，此时只可能命中渠道。
   */
  private async buildSceneMemorySections(instanceId: string, userMessage?: string): Promise<string[]> {
    const sessionKey = this.deps.instanceToConversation.get(instanceId)
    if (!sessionKey && !userMessage) return []

    try {
      const hits = await resolveSceneHits({
        baseDir: resolveWindowsClientDataRoot(),
        sessionKey,
        userMessage,
        ...(this.deps.getConversationOwnership
          ? { lookupOwnership: this.deps.getConversationOwnership }
          : {}),
      })
      const sections: string[] = []
      for (const hit of hits) {
        const file = await readSceneMemory(hit.filePath)
        const content = this.cleanMarkdown(file?.content ?? '')
        if (!content) continue

        if (hit.scene === 'project') {
          const budgeted = this.budgetMarkdown(
            content,
            this.PROJECT_MEMORY_MAX_CHARS,
            '（项目记忆较长，此处仅注入核心部分；完整内容用 `scene_memory` 工具 read 读取）',
          )
          sections.push(
            [
              '',
              `## 项目记忆：${hit.name}（仅适用于本项目）`,
              '',
              '以下内容仅在与该项目相关的任务中生效，其他场景不要套用；与用户当前陈述冲突时以当前为准。',
              '',
              budgeted,
              '',
            ].join('\n'),
          )
        } else {
          const budgeted = this.budgetMarkdown(
            content,
            this.CHANNEL_MEMORY_MAX_CHARS,
            '（渠道偏好较长，已截断）',
          )
          sections.push(
            [
              '',
              `## 渠道偏好：${hit.name}（仅在${hit.name}渠道生效）`,
              '',
              `以下内容仅在通过${hit.name}交流时生效，其他渠道不要套用。`,
              '',
              budgeted,
              '',
            ].join('\n'),
          )
        }
        log.info(
          `[buildSceneMemorySections] 注入场景记忆 scene=${hit.scene} key=${hit.key} chars=${content.length}`,
        )
      }
      return sections
    } catch (err) {
      log.warn(
        `[buildSceneMemorySections] 场景记忆加载失败（跳过注入）: ${err instanceof Error ? err.message : String(err)}`,
      )
      return []
    }
  }

  /** 清洗 Markdown：去 HTML 注释、压空行、去空章节 */
  private cleanMarkdown(content: string): string {
    this.HTML_COMMENT_REGEX.lastIndex = 0
    this.TRIPLE_NEWLINE_REGEX.lastIndex = 0
    this.EMPTY_SECTION_REGEX.lastIndex = 0
    let out = content
      .replace(this.HTML_COMMENT_REGEX, '')
      .replace(this.TRIPLE_NEWLINE_REGEX, '\n\n')
      .trim()
    this.EMPTY_SECTION_REGEX.lastIndex = 0
    this.TRIPLE_NEWLINE_REGEX.lastIndex = 0
    out = out
      .replace(this.EMPTY_SECTION_REGEX, '')
      .replace(this.TRIPLE_NEWLINE_REGEX, '\n\n')
      .trim()
    return out
  }

  /**
   * 按 `## ` 章节边界把 Markdown 截断到预算内（尽量保留完整章节）。
   * 未超预算时原样返回；截断时在末尾追加按需读取提示 hint。
   */
  private budgetMarkdown(content: string, max: number, hint: string): string {
    if (content.length <= max) return content

    const lines = content.split(/\r?\n/)
    const kept: string[] = []
    let used = 0
    let truncated = false

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const isHeading = /^##\s+/.test(line)
      // 已超预算且遇到新章节标题：停止（保证按章节边界截断）
      if (isHeading && used >= max && kept.length > 0) {
        truncated = true
        break
      }
      kept.push(line)
      used += line.length + 1
    }

    if (!truncated && used <= max) return content

    // 极端情况：首个章节本身就超预算 → 硬截到 max 字符
    let result = kept.join('\n')
    if (result.length > max * 1.5) {
      result = result.slice(0, max)
    }
    return result.trimEnd() + '\n\n' + hint
  }

  /**
   * 获取当前活跃任务列表（用于注入系统提示词动态部分）
   */
  getActiveTasks(conversationId?: string): readonly ActiveTaskInfo[] {
    const taskRepo = this.deps.getTaskRepo()
    if (!taskRepo) return []
    try {
      const tasks: ActiveTaskInfo[] = []
      // 仅注入"正在做/待做"的任务；过滤 blocked/review 等陈旧态，
      // 避免旧任务堆积让模型误以为"任务已追踪=已完成"而产生幻觉。
      const activeStatuses: readonly string[] = ['in_progress', 'pending', 'todo']

      if (conversationId) {
        const sessionTasks = taskRepo.list(conversationId)
        for (const row of sessionTasks) {
          if (activeStatuses.includes(row.status)) {
            tasks.push({
              id: row.id,
              subject: row.subject,
              status: row.status,
              owner: row.owner,
              scope: 'session',
            })
          }
        }
      }

      return tasks.slice(0, 8)
    } catch (err) {
      log.error('[getActiveTasks] 读取活跃任务失败:', err)
      return []
    }
  }

  /**
   * 加载项目上下文文件（BOOTSTRAP.md 等）
   */
  loadContextFiles(): ContextFile[] {
    const cwd = this.deps.getCwd()
    const candidates = ['BOOTSTRAP.md', '.mtbot/BOOTSTRAP.md', 'CONTEXT.md']
    const files: ContextFile[] = []

    for (const candidate of candidates) {
      const fullPath = path.join(cwd, candidate)
      try {
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8')
          if (content.trim()) {
            files.push({ path: candidate, content: content.trim() })
            log.info(`[loadContextFiles] 已加载项目上下文: ${candidate} (${content.length} bytes)`)
          }
        }
      } catch {
        // 忽略读取失败
      }
    }

    if (files.length === 0) {
      log.info(`[loadContextFiles] 未找到项目上下文文件`)
    }

    return files
  }
}
