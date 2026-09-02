/**
 * 预置定时任务产出持久化到 Wiki vault（本地 Markdown + wiki_sources）。
 *
 * 资讯抓取、早间简报、工作日报、每周复盘跑完后写入对应分类目录，
 * 供记忆页 Wiki 检索与浏览；失败只记日志，不影响 cron 主流程。
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  contentAddressId,
  sanitizeFilenameSegment,
  validateTopicAssignment,
  vaultDirSegmentsForSource,
  type WikiRepo,
  type WikiSource,
} from '@mtbot/agent-runtime'
import {
  DEFAULT_DASHBOARD_FEED_ID,
  readDashboardFeedSnapshot,
  type DashboardFeedSnapshot,
} from '../dashboard-feed-store'
import { DEFAULT_AGENT_ID } from '../seed-cron-jobs'
import { ensureWikiVaultLayoutOnDisk, syncWikiSourceToVault } from './wiki-vault-host'

const LOCAL_USER_ID = 'local-user'

/** 需要将产出写入 Wiki 的预置定时任务 ID */
export const CRON_WIKI_PERSIST_JOB_IDS = new Set([
  'news-pipeline',
  'seed-morning-briefing',
  'seed-daily-report',
  'seed-weekly-review',
])

interface CronWikiPersistSpec {
  readonly titleBase: string
  readonly category: string
  readonly subtopic: string
  readonly originContext: string
}

const PERSIST_SPECS: Readonly<Record<string, CronWikiPersistSpec>> = {
  'news-pipeline': {
    titleBase: '最近资讯',
    category: '收藏',
    subtopic: '待读',
    originContext: '定时任务 · 资讯抓取与综述',
  },
  'seed-morning-briefing': {
    titleBase: '早间简报',
    category: '工作',
    subtopic: '例行',
    originContext: '定时任务 · 早间简报',
  },
  'seed-daily-report': {
    titleBase: '工作日报',
    category: '工作',
    subtopic: '例行',
    originContext: '定时任务 · 工作日报整理',
  },
  'seed-weekly-review': {
    titleBase: '每周复盘',
    category: '工作',
    subtopic: '例行',
    originContext: '定时任务 · 每周复盘',
  },
}

export interface PersistCronOutputToWikiParams {
  readonly jobId: string
  readonly jobName: string
  readonly output: string
  readonly finishedAt: number
}

/**
 * 判断该定时任务是否应持久化到 Wiki。
 */
export function shouldPersistCronOutputToWiki(jobId: string): boolean {
  return CRON_WIKI_PERSIST_JOB_IDS.has(jobId)
}

/**
 * 将定时任务产出写入 Wiki vault，并创建或更新 wiki_sources 记录。
 */
export async function persistCronOutputToWiki(
  repo: WikiRepo,
  params: PersistCronOutputToWikiParams,
): Promise<{ sourceId: string; sourcePath: string } | null> {
  if (!shouldPersistCronOutputToWiki(params.jobId)) return null

  const spec = PERSIST_SPECS[params.jobId]
  if (!spec) return null

  const tree = repo.getOrCreateTopicTree()
  const check = validateTopicAssignment(tree, spec.category, spec.subtopic)
  if (!check.ok) {
    console.warn(`[cron-wiki-persist] 分类无效 jobId=${params.jobId}: ${check.reason}`)
    return null
  }

  const finishedAt = new Date(params.finishedAt)
  const markdown = await buildCronWikiMarkdown(params, spec, finishedAt)
  if (!markdown?.trim()) {
    console.info(`[cron-wiki-persist] 跳过空产出 jobId=${params.jobId}`)
    return null
  }

  const { vaultRoot } = ensureWikiVaultLayoutOnDisk()
  const title = buildCronWikiTitle(spec.titleBase, params.jobId, finishedAt)
  const fileName = `${buildCronWikiFileStem(params.jobId, finishedAt)}-${sanitizeFilenameSegment(spec.titleBase)}.md`
  const segments = vaultDirSegmentsForSource({
    topicCategory: spec.category,
    topicSubtopic: spec.subtopic,
    archivedAt: null,
  }).map(sanitizeFilenameSegment)
  const dir = path.join(vaultRoot, ...segments)
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, fileName)

  const extractedText = stripMarkdownForIndex(markdown)
  const contentHash = contentAddressId([params.jobId, markdown])
  const existing = repo.findSourceBySourcePath(DEFAULT_AGENT_ID, LOCAL_USER_ID, filePath)

  fs.writeFileSync(filePath, markdown, 'utf8')

  const source = existing
    ? upsertExistingCronWikiSource(repo, existing, markdown, extractedText)
    : createCronWikiSource(repo, {
        title,
        filePath,
        markdown,
        extractedText,
        contentHash,
        spec,
      })

  repo.updateSourceTopic(DEFAULT_AGENT_ID, LOCAL_USER_ID, source.id, spec.category, spec.subtopic)
  const synced = syncWikiSourceToVault(repo, source, undefined, vaultRoot)
  repo.indexSource(synced.id)

  console.info(
    `[cron-wiki-persist] 已写入 Wiki jobId=${params.jobId} sourceId=${synced.id} path=${synced.source_path ?? filePath}`,
  )
  return { sourceId: synced.id, sourcePath: synced.source_path ?? filePath }
}

/**
 * 按任务类型生成 vault 文件名前缀（含日期/周次，资讯含小时）。
 */
function buildCronWikiFileStem(jobId: string, at: Date): string {
  const date = formatDateKey(at)
  if (jobId === 'news-pipeline') {
    const hour = String(at.getHours()).padStart(2, '0')
    return `${date}-${hour}`
  }
  if (jobId === 'seed-weekly-review') {
    return `${date.slice(0, 4)}-W${String(isoWeekNumber(at)).padStart(2, '0')}`
  }
  return date
}

/**
 * 生成展示用标题（含日期，便于列表区分）。
 */
function buildCronWikiTitle(titleBase: string, jobId: string, at: Date): string {
  const stem = buildCronWikiFileStem(jobId, at)
  return `${stem} ${titleBase}`
}

/**
 * 组装 Markdown 正文：资讯读 dashboard feed，其余用 Agent 回复。
 */
async function buildCronWikiMarkdown(
  params: PersistCronOutputToWikiParams,
  spec: CronWikiPersistSpec,
  finishedAt: Date,
): Promise<string | null> {
  if (params.jobId === 'news-pipeline') {
    return formatNewsFeedMarkdown(await readDashboardFeedSnapshot(DEFAULT_DASHBOARD_FEED_ID), finishedAt, spec)
  }
  const body = params.output.trim()
  if (!body) return null
  const stamp = formatTimestamp(finishedAt)
  const header = `# ${spec.titleBase}\n\n> 生成时间：${stamp} · 来源：${spec.originContext}\n\n`
  return `${header}${body}\n`
}

/**
 * 将概览页资讯 feed 格式化为 Wiki Markdown。
 */
function formatNewsFeedMarkdown(
  snapshot: DashboardFeedSnapshot | null,
  finishedAt: Date,
  spec: CronWikiPersistSpec,
): string | null {
  if (!snapshot || snapshot.items.length === 0) return null
  const lines: string[] = [
    `# ${snapshot.title || spec.titleBase}`,
    '',
    `> 抓取时间：${formatTimestamp(finishedAt)} · 来源：${spec.originContext}`,
    '',
  ]
  if (snapshot.summary?.trim()) {
    lines.push('## 综述', '', snapshot.summary.trim(), '')
  }
  lines.push('## 条目', '')
  for (const item of snapshot.items) {
    lines.push(`### ${item.title}`)
    if (item.summary?.trim()) lines.push('', item.summary.trim())
    const meta: string[] = []
    if (item.source?.trim()) meta.push(`来源：${item.source.trim()}`)
    if (item.href?.trim()) meta.push(`[原文](${item.href.trim()})`)
    if (meta.length > 0) lines.push('', meta.join(' · '))
    lines.push('')
  }
  return lines.join('\n').trimEnd() + '\n'
}

/**
 * 创建新的 native 资料记录。
 */
function createCronWikiSource(
  repo: WikiRepo,
  params: {
    readonly title: string
    readonly filePath: string
    readonly markdown: string
    readonly extractedText: string
    readonly contentHash: string
    readonly spec: CronWikiPersistSpec
  },
): WikiSource {
  return repo.createSource({
    agentId: DEFAULT_AGENT_ID,
    userId: LOCAL_USER_ID,
    title: params.title,
    sourcePath: params.filePath,
    mediaType: 'document',
    mimeType: 'text/markdown',
    contentMd: params.markdown,
    extractedText: params.extractedText,
    contentHash: params.contentHash,
    originContext: params.spec.originContext,
    storageMode: 'native',
  })
}

/**
 * 同路径再次执行时更新正文与哈希，避免重复建资料。
 */
function upsertExistingCronWikiSource(
  repo: WikiRepo,
  existing: WikiSource,
  markdown: string,
  extractedText: string,
): WikiSource {
  return repo.setSourceStorage(DEFAULT_AGENT_ID, LOCAL_USER_ID, existing.id, {
    contentMd: markdown,
    extractedText,
    storageMode: 'native',
    mimeType: 'text/markdown',
  })
}

/**
 * 去掉 Markdown 标记，供 FTS 索引。
 */
function stripMarkdownForIndex(markdown: string): string {
  return markdown
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>#-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** YYYY-MM-DD */
function formatDateKey(at: Date): string {
  const y = at.getFullYear()
  const m = String(at.getMonth() + 1).padStart(2, '0')
  const d = String(at.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 本地时间展示：YYYY-MM-DD HH:mm */
function formatTimestamp(at: Date): string {
  const date = formatDateKey(at)
  const h = String(at.getHours()).padStart(2, '0')
  const min = String(at.getMinutes()).padStart(2, '0')
  return `${date} ${h}:${min}`
}

/** ISO 8601 周序号（周一为一周起始）。 */
function isoWeekNumber(at: Date): number {
  const d = new Date(Date.UTC(at.getFullYear(), at.getMonth(), at.getDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7)
}

export const __testables = {
  buildCronWikiFileStem,
  buildCronWikiTitle,
  formatNewsFeedMarkdown,
  stripMarkdownForIndex,
  PERSIST_SPECS,
}
