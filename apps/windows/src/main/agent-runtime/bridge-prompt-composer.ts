/**
 * 系统提示词动态部分：用户记忆、活跃任务、项目上下文文件
 */

import path from 'node:path'
import fs from 'node:fs'
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

/**
 * 构建带记忆与任务注入的完整系统提示词，及 BOOTSTRAP 上下文加载
 */
export class BridgePromptComposer {
  private readonly TASK_SECTION_REGEX = /## Active Tasks[\s\S]*?(?=\n## |$)/
  private readonly MEMORY_SUMMARY_REGEX = /## Memory\n持久化记忆系统[\s\S]*?(?=\n## |$)/
  private readonly HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g
  private readonly TRIPLE_NEWLINE_REGEX = /\n{3,}/g
  private readonly EMPTY_SECTION_REGEX = /^##\s+[^\n]*\n(?=\s*(?:##\s|$))/gm

  /** 任务完成契约：注入 Active Tasks 段落后强制 LLM 自检，降低长任务幻觉率 */
  private static readonly TASK_COMPLETION_CONTRACT = [
    "## Task Integrity Rules (硬约束)",
    "- 当上方的 Active Tasks 中存在 pending/in_progress 项时，**禁止**在回复中使用「全部完成」「已完成」「都做好了」等绝对完成表述。",
    "- 工具调用返回错误时，**必须** (a) 将对应任务保留 in_progress (b) 在回复中显式说明「X 任务未完成，原因：Y」，不得静默跳过。",
    "- 准备向用户宣告任务完成前，**必须先调用** todo_write 核对：所有项的 status 均为 completed 才可宣告，否则继续执行未完成项。",
  ].join("\n")

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
      dynamicParts.push(BridgePromptComposer.TASK_COMPLETION_CONTRACT)
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
