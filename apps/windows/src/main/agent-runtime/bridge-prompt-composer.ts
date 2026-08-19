/**
 * 系统提示词动态部分：用户记忆、活跃任务、项目上下文文件、客户端诊断信息
 */

import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  CACHE_BOUNDARY_MARKER,
  formatUserMemoryForPrompt,
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
  /** Per-instance 聚合状态存储（提供 memoryGuideInjected / skipTaskInjection） */
  instanceStates: InstanceStateStore
}

/** 诊断采样结果（单进程共享缓存） */
interface ClientDiagnostics {
  sampledAt: number
  logsDir: string
  cliHelp: string | null
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
  "- 当上方的 Active Tasks 中存在 pending/in_progress 项时，**禁止**在回复中使用「全部完成」「已完成」「都做好了」等绝对完成表述。",
  "- 工具调用返回错误时，**必须** (a) 将对应任务保留 in_progress (b) 在回复中显式说明「X 任务未完成，原因：Y」，不得静默跳过。",
  "- 准备向用户宣告任务完成前，**必须先调用** todo_write 核对：所有项的 status 均为 completed 才可宣告，否则继续执行未完成项。",
].join("\n")

/** 模块级诊断缓存（所有 Composer 实例共享，保证 prompt 连续轮次间命中缓存） */
let diagCache: { value: ClientDiagnostics; expiresAt: number } | null = null

/** CPU 异步采样：上一次 user+nice+sys+idle+iowait+irq 的快照（按 CPU 核心聚合） */
let cpuPrev: { total: number; idle: number } | null = null

/**
 * 执行一次系统诊断采样（CPU 100ms 间隔取增量、内存 os.totalmem/freemem、
 * 磁盘按 data-root 所在卷用 fs.statfsSync；日志目录与 CLI help 不经常变，
 * 但也走缓存避免同步 shell 反复执行）。
 */
function sampleClientDiagnostics(): ClientDiagnostics {
  // 日志目录：与 client-data-root 保持一致（~/.lumii/logs）
  const dataRoot = resolveWindowsClientDataRoot()
  const logsDir = path.join(dataRoot, 'logs')

  // CLI help：用 `lumii --help` 或 `node lumii.js --help`；找不到命令或失败返回 null
  let cliHelp: string | null = null
  try {
    const nodeBin = process.execPath
    // 优先尝试 Electron app.asar 所在路径下的 CLI 入口脚本（Windows 打包通常放 resources/）
    const candidates: string[] = []
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'cli', 'lumii.cjs'))
      candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'cli', 'lumii.cjs'))
    }
    // dev 模式：<repo>/apps/windows/scripts/lumii-cli-stub.js
    candidates.push(path.join(process.cwd(), 'apps', 'windows', 'scripts', 'lumii-cli-stub.js'))
    candidates.push(path.join(process.cwd(), 'scripts', 'lumii-cli-stub.js'))

    let cliScript: string | null = null
    for (const p of candidates) {
      try {
        fs.accessSync(p, fs.constants.X_OK)
        cliScript = p
        break
      } catch {
        try {
          fs.accessSync(p, fs.constants.R_OK)
          cliScript = p
          break
        } catch {
          /* 继续下一个 */
        }
      }
    }

    if (cliScript) {
      const stdout = execFileSync(nodeBin, [cliScript, '--help'], {
        timeout: 800,
        windowsHide: true,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 200 * 1024,
      }).trim()
      if (stdout) {
        cliHelp = stdout.length > 3000 ? stdout.slice(0, 3000) + '\n…(已截断，完整帮助请本地运行)' : stdout
      }
    } else {
      cliHelp = '（未找到 lumii CLI 可执行脚本；如已安装请在 shell 中执行 lumii --help 查看完整帮助）'
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    cliHelp = `（lumii CLI help 拉取失败：${msg.slice(0, 200)}；可直接在 bash 工具中执行 'lumii --help' 或 'node <lumii-cli-script> --help'）`
  }

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
    cliHelp,
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

/** 把诊断快照格式化为 Prompt 段（Markdown H2 标题 + 三小节） */
function buildClientDiagnosticsSection(d: ClientDiagnostics): string {
  const warnings: string[] = []
  if (d.cpuPct >= DIAG_HEALTH.CPU_PCT_WARN) {
    warnings.push(`- CPU 占用偏高：建议让用户关闭不必要的后台进程，或降低并发工具调用数。`)
  }
  if (d.memPct >= DIAG_HEALTH.MEM_PCT_WARN) {
    warnings.push(`- 内存占用偏高：建议让用户关闭占用大的其他软件，或减少长上下文会话数。若 Agent 自身跑重任务，可拆分子任务 + 及时释放上下文。`)
  }
  if (d.diskPct >= DIAG_HEALTH.DISK_PCT_WARN || (d.diskTotalGB > 0 && d.diskTotalGB - d.diskUsedGB < DIAG_HEALTH.DISK_GB_MIN_FREE)) {
    warnings.push(`- 磁盘空间紧张：建议让用户清理磁盘，否则日志/SQLite/上传文件会写入失败。Agent 可考虑清理旧日志目录（仅删除 >7 天的老文件）。`)
  }

  const cliBlock = d.cliHelp
    ? `\`\`\`\n${d.cliHelp}\n\`\`\``
    : '（CLI help 获取失败；可在 bash 工具中执行 `lumii --help` 查看）'

  return `
## Client Diagnostics（客户端运行时诊断 · 只读参考）
- 信息来源：本机 Electron 主进程系统采样（每 ${(DIAG_CACHE_TTL_MS / 1000).toFixed(0)}s 刷新，注入时刻：${new Date(d.sampledAt).toISOString()}）。
- 用途：用于 Agent **自我诊断**配置/运行异常，给出用户可执行的操作建议，而非向用户披露原始数值本身。
- 修改原则：禁止让 Agent 自行修改用户数据/系统设置；如需修改必须先通过 ask_user_question 征得用户显式同意。

### 1) 客户端日志目录
- 绝对路径：\`${d.logsDir}\`
- 说明：主进程 / 渲染进程 / Agent Runtime / 渠道适配器 / 工具 hook 的错误与运行日志都在该目录下。文件按日期滚动（如 \`main-YYYY-MM-DD.log\`、\`agent-runtime-YYYY-MM-DD.log\`）。
- 使用建议：
  - 若用户反馈"消息没响应 / 工具调用卡死 / 渠道没消息"，先用 \`file_tools.list_directory\` 浏览日志目录、再用 \`grep -i 'error|fatal|unhandled|warn'\` 或 \`read_file\` 读取最近 1~2 天的日志尾部。
  - 日志可读、可解析；禁止直接删除正在写入的当日日志文件（会触发写入失败）。

### 2) lumii CLI（客户端配置命令行）
- 执行方式：在 \`bash\` 工具中运行 \`lumii <command>\`（开发期通常是 \`node scripts/lumii-cli-stub.js <command>\`）。
- 命令清单（来自 \`lumii --help\`）：
${cliBlock}
- 常见自愈场景（必须先 ask_user_question 确认再执行）：
  - 切换模型提供商默认模型、修改 API 密钥、开关 provider → \`lumii provider set ...\`
  - 列出 / 清理日志 → \`lumii logs list\` / \`lumii logs clean\`
  - 查看应用状态 / 健康检查 → \`lumii doctor\`
  - 重启桌面端（谨慎，需告知用户会中断当前对话）→ \`lumii app restart\`

### 3) 系统资源使用情况
- CPU：${d.cpuPct}%（${d.cpuLogicalCores} 逻辑核）${d.cpuPct >= DIAG_HEALTH.CPU_PCT_WARN ? ' ⚠️ 偏高' : ''}
- 内存：${d.memPct}%（${d.memUsedGB}GB / ${d.memTotalGB}GB）${d.memPct >= DIAG_HEALTH.MEM_PCT_WARN ? ' ⚠️ 偏高' : ''}
- 磁盘（${d.logsDir} 所在卷）：${d.diskPct}%（${d.diskUsedGB}GB / ${d.diskTotalGB}GB）${d.diskPct >= DIAG_HEALTH.DISK_PCT_WARN ? ' ⚠️ 紧张' : ''}
${warnings.length > 0
    ? `
### 4) 健康建议（基于阈值自动生成）
${warnings.join('\n')}
`
    : ''}`
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
   */
  async buildPromptWithMemory(
    instanceId: string,
    result: SystemPromptResult,
    memoryInjection?: MemoryInjectionSettings,
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

    let memorySection = ''
    try {
      // 个人记忆在此注入；工作记忆由 AgentInstance.loadAndInjectMemories 单独控制
      const injPersonal =
        memoryInjection?.injectPersonalMemory ??
        (await this.deps.getMemoryInjectionSettings?.())?.injectPersonalMemory ??
        true
      if (injPersonal !== false) {
        const userMemory = await this.deps.loadUserMemory()
        let userMemoryContent = userMemory?.content ?? ''
        this.HTML_COMMENT_REGEX.lastIndex = 0
        this.TRIPLE_NEWLINE_REGEX.lastIndex = 0
        this.EMPTY_SECTION_REGEX.lastIndex = 0
        userMemoryContent = userMemoryContent
          .replace(this.HTML_COMMENT_REGEX, '')
          .replace(this.TRIPLE_NEWLINE_REGEX, '\n\n')
          .trim()
        this.EMPTY_SECTION_REGEX.lastIndex = 0
        this.TRIPLE_NEWLINE_REGEX.lastIndex = 0
        userMemoryContent = userMemoryContent
          .replace(this.EMPTY_SECTION_REGEX, '')
          .replace(this.TRIPLE_NEWLINE_REGEX, '\n\n')
          .trim()
        if (userMemoryContent) {
          userMemoryContent = this.budgetUserMemory(userMemoryContent)
          memorySection = formatUserMemoryForPrompt(userMemoryContent)
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

    // 客户端诊断段：日志目录 / CLI help / CPU 内存磁盘 + 阈值建议（5s 缓存）
    try {
      const diag = getOrSampleDiagnostics()
      dynamicParts.push(buildClientDiagnosticsSection(diag))
    } catch (err) {
      // 诊断采样挂了绝不影响对话主流程，只记录日志
      log.warn('[buildPromptWithMemory] 客户端诊断采样失败，跳过注入:', err instanceof Error ? err.message : String(err))
    }

    const dynamicPrompt = dynamicParts.join('')
    return dynamicPrompt ? `${staticPrompt}${CACHE_BOUNDARY_MARKER}${dynamicPrompt}` : staticPrompt
  }

  /**
   * 个人记忆注入预算：约 1200 token（中文约 2 字符/token ≈ 2400 字）。
   * 个人记忆文档可增长到数十 KB，整篇注入会淹没当前任务、诱发"口嗨已完成"的幻觉，
   * 故此处按章节（## ）边界做预算截断，超出部分用 profile_memory read_memory 按需读取。
   */
  private readonly USER_MEMORY_MAX_CHARS = 2400

  /**
   * 将个人记忆按 `## ` 章节边界截断到预算内（尽量保留完整章节）。
   * 未超预算时原样返回；截断时在末尾追加"按需读取完整记忆"的提示。
   */
  private budgetUserMemory(content: string): string {
    const max = this.USER_MEMORY_MAX_CHARS
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
    return (
      result.trimEnd() +
      '\n\n（个人记忆较长，此处仅注入核心部分；需要更多用户画像/偏好时用 `profile_memory` 的 `read_memory` 读取完整文档）'
    )
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
   * 根据模型 tier 选择提示词详度
   */
  resolvePromptDetail(tier: string): 'compact' | 'standard' | 'full' {
    switch (tier) {
      case 'basic':
        return 'compact'
      case 'balanced':
        return 'standard'
      case 'performance':
        return 'full'
      default:
        return 'standard'
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
