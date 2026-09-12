/**
 * 自主进化产出沉淀：学习目标产出 → 工作记忆 + Wiki；主动操作 → 工作记忆。
 * 失败仅记日志，不影响目标 finalize 状态。
 */
import {
  contentAddressId,
  type ApprovedGoalSignal,
  type MemoryManager,
  type WikiRepo,
} from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

const AGENT_ID = 'assistant'
const LOCAL_USER_ID = 'local-user'
const LEARNING_OUTPUT_MAX_CHARS = 2000

export interface EvolutionPersistDeps {
  readonly memoryManager: MemoryManager
  readonly wikiRepo: WikiRepo
}

function truncate(text: string, max = LEARNING_OUTPUT_MAX_CHARS): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function stripMarkdown(text: string): string {
  return text
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildTitle(goal: ApprovedGoalSignal): string {
  const desc = goal.description.trim()
  const base = desc.length > 36 ? `${desc.slice(0, 36)}…` : desc
  return `学习成果 · ${base}`
}

/** 学习目标完成后，产出沉淀进工作记忆 + Wiki 知识页（两者都留存）。agentId 为产出归属（缺省 assistant）。 */
export function persistLearningOutcome(
  deps: EvolutionPersistDeps,
  goal: ApprovedGoalSignal,
  output: string,
  agentId: string = AGENT_ID,
): void {
  const body = output.trim()
  if (!body) return

  // 1) 工作记忆（可 FTS 检索、后续注入 prompt 复用）
  try {
    deps.memoryManager.addMemory({
      agentId,
      userId: LOCAL_USER_ID,
      category: 'reference',
      content: truncate(body),
      importance: 0.6,
      tags: ['autonomous', 'learning', goal.type],
    })
  } catch (err) {
    log.warn('[persistLearningOutcome] 工作记忆沉淀失败:', err)
  }

  // 2) Wiki 知识页（native：AI 产出正文在库内，无需写磁盘文件）
  try {
    const title = buildTitle(goal)
    const markdown = `# ${title}\n\n> 来源：自主进化 · 学习目标（${goal.type}）\n\n${body}\n`
    const source = deps.wikiRepo.createSource({
      agentId,
      userId: LOCAL_USER_ID,
      title,
      mediaType: 'document',
      mimeType: 'text/markdown',
      contentMd: markdown,
      extractedText: stripMarkdown(markdown),
      contentHash: contentAddressId([goal.id, body]),
      originContext: '自主进化 · 学习目标',
      storageMode: 'native',
    })
    deps.wikiRepo.indexSource(source.id)
    try {
      deps.wikiRepo.updateSourceTopic(agentId, LOCAL_USER_ID, source.id, '学习', '成果')
    } catch (err) {
      // 用户自定义分类树可能不含「学习/成果」，分类失败不阻断已留存的资料
      log.warn('[persistLearningOutcome] Wiki 分类失败（资料已留存为未分类）:', err)
    }
  } catch (err) {
    log.warn('[persistLearningOutcome] Wiki 沉淀失败:', err)
  }
}

/** 主动操作（主动消息）完成后，记录一条「我主动做了什么」的工作记忆（agentId 缺省 assistant） */
export function recordProactiveAction(
  memoryManager: MemoryManager,
  goal: ApprovedGoalSignal,
  outcome: string,
  agentId: string = AGENT_ID,
): void {
  try {
    memoryManager.addMemory({
      agentId,
      userId: LOCAL_USER_ID,
      category: 'reference',
      content: `主动联系用户：${goal.description}（${outcome}）`,
      importance: 0.5,
      tags: ['autonomous', 'proactive'],
    })
  } catch (err) {
    log.warn('[recordProactiveAction] 工作记忆沉淀失败:', err)
  }
}
