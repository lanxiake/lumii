/**
 * Wiki 知识库命令处理器（P0）
 *
 * 复用 agent-commands.ts 的 sessionKey/agentId 解析惯例：显式 agentId 优先，
 * 否则从会话参与者解析，兜底 'assistant'。userId 固定 LOCAL_USER_ID（单机应用）。
 */
import path from 'node:path'
import fs from 'node:fs'
import { shell } from 'electron'
import {
  WikiGraphBuilder,
  WikiEroRepo,
  WikiSourceVectorIndex,
  mergeSourceHybridRanks,
  WikiSummarizer,
  PARKING_CATEGORY,
  resolveAgentFilePath,
  sanitizeFilenameSegment,
  validateTopicAssignment,
  WikiEroExtractor,
  WikiFolderImporter,
  type WikiFolderImporterFs,
  type WikiInboxItemType,
  buildDirectoryTreeText,
  buildFolderImportClassifyContext,
  buildTopicOccupancySummary,
  buildNavSectionGuide,
  WikiClipSaver,
  vaultDirSegmentsForSource,
  resolveOriginalFilePath,
  buildLibraryInventory,
  STRUCTURE_BATCH_SIZE,
  CONTENT_BATCH_SIZE,
  resolveUniqueFilename,
  type WikiSource,
} from '@mtbot/agent-runtime'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import {
  createWikiVaultSyncDeps,
  ensureAndBackfillWikiVault,
  ensureWikiVaultLayoutOnDisk,
  syncWikiSourceById,
  syncWikiSourceToVault,
} from '../../agent-runtime/wiki-vault-host'
import { resolveWikiDir } from '../../workspace-paths'
import { securityUtils } from '../../security-utils'
import { titleWithOriginalExt } from './wiki-display-title'

const LOCAL_USER_ID = 'local-user'

/**
 * 资料变更后同步 workspace/wiki/ 目录（失败不阻断主流程）。
 */
function vaultSyncSource(bridge: AgentRuntimeBridge, sourceId: string, agentId?: string): void {
  try {
    const resolvedAgent = resolveAgentIdForWiki(bridge, undefined, agentId)
    syncWikiSourceById(bridge.wikiRepo, resolvedAgent, LOCAL_USER_ID, sourceId)
  } catch (err) {
    console.warn('[wiki-vault] sync failed:', (err as Error).message)
  }
}

/**
 * 解析 http(s) URL；非法时抛中文错误。
 */
function parseHttpUrl(raw: string): URL {
  const trimmed = raw.trim()
  if (!trimmed) throw new Error('链接不能为空')
  try {
    const url = new URL(trimmed)
    if (!url.protocol.startsWith('http')) throw new Error('仅支持 http/https 链接')
    return url
  } catch (err) {
    if (err instanceof Error && err.message.includes('http')) throw err
    throw new Error('链接格式无效')
  }
}

/** Node fs 适配器，供 WikiFolderImporter 扫描目录 */
const wikiFolderNodeFs: WikiFolderImporterFs = {
  statSync(p) {
    try {
      const s = fs.statSync(p)
      return { isFile: s.isFile(), isDirectory: s.isDirectory(), size: s.size }
    } catch {
      return null
    }
  },
  readdirSync(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      isFile: d.isFile(),
      isDirectory: d.isDirectory(),
    }))
  },
}

function resolveAgentIdForWiki(
  bridge: AgentRuntimeBridge,
  sessionKey?: string,
  explicitAgentId?: string,
): string {
  if (explicitAgentId) return explicitAgentId
  if (sessionKey) {
    const fromConv = bridge.conversationRepo.getAgentParticipantId(sessionKey)
    if (fromConv) return fromConv
  }
  return 'assistant'
}

export function handleWikiInboxList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:list' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const items = bridge.wikiRepo.listInbox(agentId, LOCAL_USER_ID, command.status)
  const deps = createWikiVaultSyncDeps()
  return items.map((i) => {
    const original =
      resolveOriginalFilePath(deps, { source_path: i.source_path } as WikiSource) ?? i.source_path
    return {
      id: i.id,
      itemType: i.item_type,
      title: titleWithOriginalExt(i.title, original),
      sourcePath: i.source_path,
      sourceUrl: i.source_url,
      contentPreview: i.content_preview,
      mediaType: i.media_type,
      status: i.status,
      attemptCount: i.attempt_count,
      lastError: i.last_error,
      lastOutcome: i.last_outcome,
      createdAt: new Date(i.created_at).getTime(),
    }
  })
}

/**
 * 返回收件箱角标数：pending 收件箱条数 + 待整理（两列皆空）资料数。
 * `status` 显式传参时只统计该状态收件箱条目，`unfiled` 计 0（兼容旧调用方只读 total）。
 */
export function handleWikiInboxCount(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:count' }>,
): { total: number; pending: number; unfiled: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const pending = bridge.wikiRepo.countInbox(agentId, LOCAL_USER_ID, command.status)
  const unfiled = command.status
    ? 0
    : bridge.wikiRepo.listSourcesByTopic(agentId, LOCAL_USER_ID, { unfiled: true }).length
  return { total: pending + unfiled, pending, unfiled }
}

/**
 * 重试收件箱条目。只对 pending 生效——不存在的 id 或已归档/已丢弃的条目
 * 直接抛错，避免返回 success:true 让调用方以为改动生效了。
 */
export function handleWikiInboxRetry(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:retry' }>,
): { success: boolean } {
  const item = bridge.wikiRepo.findInboxById(command.inboxId)
  if (!item) throw new Error(`收件箱条目不存在: ${command.inboxId}`)
  if (!bridge.wikiRepo.retryInbox(command.inboxId)) {
    throw new Error(`条目状态为 ${item.status}，只有 pending 条目可重试: ${command.inboxId}`)
  }
  return { success: true }
}

export function handleWikiInboxDiscard(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:discard' }>,
): { success: boolean } {
  if (!bridge.wikiRepo.discardInbox(command.inboxId)) {
    throw new Error(`收件箱条目不存在: ${command.inboxId}`)
  }
  return { success: true }
}

/**
 * 手动指定用途分类立即归档：绕开 AI 分类，直接写入资料层用途两列。不新建 wiki_pages。
 * 不允许手动归到「临时存放」——那是用户在文件列表里显式操作，不是整理入口。
 */
export function handleWikiInboxOrganize(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:organize' }>,
): { sourceId: string; category: string; subtopic: string } {
  const repo = bridge.wikiRepo
  const item = repo.findInboxById(command.inboxId)
  if (!item) throw new Error(`收件箱条目不存在: ${command.inboxId}`)
  if (command.category === PARKING_CATEGORY) {
    throw new Error('整理入口不允许归到临时存放，请在文件列表中操作')
  }

  const updated = repo.archiveInboxItem(item, command.category, command.subtopic, command.title)
  vaultSyncSource(bridge, updated.id, command.agentId)
  return { sourceId: updated.id, category: updated.topic_category!, subtopic: updated.topic_subtopic! }
}

/**
 * 解析并校验文件夹路径（须在 Security 允许的基础路径内）。
 */
function resolveWikiFolderDir(bridge: AgentRuntimeBridge, dir: string): string {
  const trimmed = dir.trim()
  if (!trimmed) throw new Error('目录路径不能为空')
  const abs = path.isAbsolute(trimmed) ? trimmed : path.resolve(bridge.getCwd(), trimmed)
  securityUtils.addAllowedBasePath(abs)
  const normalized = securityUtils.validatePath(abs)
  const stat = fs.statSync(normalized)
  if (!stat.isDirectory()) throw new Error(`不是目录: ${normalized}`)
  return normalized
}

/**
 * 创建 WikiFolderImporter 实例（共用 Node fs 适配器）。
 */
function createWikiFolderImporter(bridge: AgentRuntimeBridge): WikiFolderImporter {
  return new WikiFolderImporter(bridge.wikiRepo, bridge.wikiIngestHook, wikiFolderNodeFs)
}

/**
 * 预览目录内可导入 Wiki 的文件列表（不写库）。
 */
export function handleWikiFolderScan(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:folder:scan' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const dir = resolveWikiFolderDir(bridge, command.dir)
  const importer = createWikiFolderImporter(bridge)
  const workspaceRoot = bridge.getCwd()
  const result = importer.scan({
    agentId,
    userId: LOCAL_USER_ID,
    dir,
    recursive: command.recursive,
    itemType: command.itemType,
    workspaceRoot,
  })
  const importablePaths = result.candidates
    .filter((c) => !c.skipReason && !c.alreadyInWiki)
    .map((c) => c.path)
  const topicTree = bridge.wikiRepo.getOrCreateTopicTree()
  return {
    ...result,
    directoryTree: buildDirectoryTreeText(importablePaths, dir, workspaceRoot),
    topicOccupancy: buildTopicOccupancySummary(bridge.wikiRepo, agentId, LOCAL_USER_ID, topicTree),
    navSectionGuide: buildNavSectionGuide(),
  }
}

/**
 * 批量将目录内文件摄入 Wiki 收件箱；可选导入后立即 AI 分类归档。
 */
export async function handleWikiFolderImport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:folder:import' }>,
): Promise<unknown> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const dir = resolveWikiFolderDir(bridge, command.dir)
  const importer = createWikiFolderImporter(bridge)
  const workspaceRoot = bridge.getCwd()
  const autoClassify = command.autoClassify !== false

  const importResult = importer.import({
    agentId,
    userId: LOCAL_USER_ID,
    dir,
    recursive: command.recursive,
    itemType: command.itemType,
    dryRun: command.dryRun,
    workspaceRoot,
  })

  if (command.dryRun || importResult.inboxIds.length === 0) {
    return importResult
  }

  if (!autoClassify) {
    const intakeRun = await bridge.wikiOrganizer.intakeInboxIds(
      agentId,
      LOCAL_USER_ID,
      importResult.inboxIds,
    )
    return {
      ...importResult,
      autoClassify: false,
      organizeRun: intakeRun
        ? {
            runId: intakeRun.id,
            status: intakeRun.status,
            summary: intakeRun.result_summary ?? null,
          }
        : null,
    }
  }

  const inboxItems = importResult.inboxIds
    .map((id) => bridge.wikiRepo.findInboxById(id))
    .filter((item): item is NonNullable<typeof item> => item !== null)

  const topicTree = bridge.wikiRepo.getOrCreateTopicTree()
  const classifyContext = buildFolderImportClassifyContext({
    importRoot: dir,
    workspaceRoot,
    inboxItems,
    repo: bridge.wikiRepo,
    agentId,
    userId: LOCAL_USER_ID,
    topicTree,
  })

  const batchSize = command.classifyBatchSize ?? 10
  const organizeRun = await bridge.wikiOrganizer.organizeInboxIds(
    agentId,
    LOCAL_USER_ID,
    importResult.inboxIds,
    classifyContext,
    batchSize,
  )

  return {
    ...importResult,
    autoClassify: true,
    organizeRun: organizeRun
      ? {
          runId: organizeRun.id,
          status: organizeRun.status,
          summary: organizeRun.result_summary ?? null,
        }
      : null,
  }
}

/**
 * 显式触发一批 Wiki intake/organize（不等 30s 轮询）。
 */
export async function handleWikiOrganizeRun(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:organize:run' }>,
): Promise<{ runId: string | null; status: string; summary: string | null }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const itemType: WikiInboxItemType = command.itemType ?? 'output'
  const mode = command.mode ?? 'intake'
  const batchSize = command.batchSize ?? 10

  if (mode === 'organize' && !bridge.wikiRepo.getAutoClassifyEnabled(agentId, LOCAL_USER_ID)) {
    throw new Error('自动分类未开启，请使用 --mode intake 或先在 Wiki 设置中开启自动分类')
  }

  const organizer = bridge.wikiOrganizer
  const run =
    mode === 'organize'
      ? await organizer.organizeBatch(agentId, LOCAL_USER_ID, itemType, batchSize)
      : await organizer.intakeBatch(agentId, LOCAL_USER_ID, itemType, batchSize)

  if (!run) {
    return { runId: null, status: 'empty', summary: '没有待处理的收件箱条目' }
  }
  return { runId: run.id, status: run.status, summary: run.result_summary ?? null }
}

/** 主搜索改为资料层：命中原始文件而非旧汇总页。历史页面搜索已随 P3 删除。 */
export async function handleWikiSearch(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:search' }>,
): Promise<{ hits: unknown[]; mode: string; degradeReason: string | null }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const limit = command.limit ?? 10
  const ftsHits = bridge.wikiRepo.searchSources(agentId, LOCAL_USER_ID, command.keyword, limit)
  const ftsIds = ftsHits.map((h) => h.source.id)
  const sourceById = new Map(ftsHits.map((h) => [h.source.id, h.source]))

  let vectorIds: string[] = []
  let degradeReason: string | null = null
  let mode: 'fts' | 'vector' | 'hybrid' = 'fts'

  if (command.enableVector === false) {
    degradeReason = '向量检索已关闭，仅全文检索'
  } else {
    try {
      const host = await bridge.resolveWikiEmbedder()
      if (host.notice && host.backend === 'bigram-hash') {
        degradeReason = host.notice
      }
      const index = new WikiSourceVectorIndex(bridge.wikiRepo.database, host.embedder)
      for (const hit of ftsHits) {
        await index.upsertSource(hit.source)
      }
      if (ftsHits.length === 0) {
        const sources = bridge.wikiRepo
          .listSources(agentId, LOCAL_USER_ID)
          .filter((s) => !s.archived_at)
          .slice(0, 200)
        for (const s of sources) await index.upsertSource(s)
      }
      const vecHits = await index.searchSimilar(agentId, LOCAL_USER_ID, command.keyword, limit)
      vectorIds = vecHits.map((v) => v.sourceId)
      // 向量命中的资料可能没进 FTS top-N，补进 sourceById 供映射；已归档的排除，避免绕过 FTS 的归档过滤
      for (const s of bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)) {
        if (s.archived_at) continue
        if (vectorIds.includes(s.id) && !sourceById.has(s.id)) sourceById.set(s.id, s)
      }
      vectorIds = vectorIds.filter((id) => sourceById.has(id))
    } catch {
      degradeReason = '向量模型不可用，已退回全文检索'
    }
  }

  const merged = mergeSourceHybridRanks({ ftsIds, vectorIds, sourceById })
  mode = merged.mode

  const hits = merged.ids
    .map((id) => {
      const source = sourceById.get(id)
      if (!source) return null
      const hit = ftsHits.find((h) => h.source.id === id)
      return {
        sourceId: source.id,
        title: source.title,
        category: source.topic_category,
        subtopic: source.topic_subtopic,
        snippet: hit?.snippet ?? '',
        mediaType: source.media_type,
        sourcePath: source.source_path,
        updatedAt: new Date(source.last_used ?? source.created_at).getTime(),
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return { hits, mode, degradeReason }
}

/** 解析资料对应的原文 URL（网页检索归档或 source_path 即 URL） */
export function resolveWikiSourceUrl(source: {
  source_path: string | null
  origin_context: string | null
}): string | null {
  const path = source.source_path?.trim()
  if (path && /^https?:\/\//i.test(path)) return path
  const ctx = source.origin_context
  if (!ctx) return null
  const match = ctx.match(/原文链接:\s*(https?:\/\/\S+)/i)
  return match?.[1] ?? null
}

export function handleWikiSourceGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:get' }>,
): unknown {
  const source = bridge.wikiRepo.findSourceById(command.sourceId)
  if (!source) return null
  const sourceUrl = resolveWikiSourceUrl(source)
  return {
    id: source.id,
    title: source.title,
    sourcePath: sourceUrl ? null : source.source_path,
    sourceUrl,
    mediaType: source.media_type,
    mimeType: source.mime_type,
    extractedText: source.extracted_text,
    originContext: source.origin_context,
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
    createdAt: new Date(source.created_at).getTime(),
  }
}

export function handleWikiRunsList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:runs:list' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const runs = bridge.wikiRepo.listRuns(agentId, LOCAL_USER_ID, command.limit)
  return runs.map((r) => ({
    id: r.id,
    inboxIds: r.inbox_ids,
    status: r.status,
    resultSummary: r.result_summary,
    error: r.error,
    resultDetail: parseRunResultDetail(r.result_detail),
    createdAt: new Date(r.created_at).getTime(),
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
  }))
}

/**
 * 解析运行明细 JSON；仅当解析结果为对象且 items 为数组时返回，否则 null，避免整列表失败。
 */
function parseRunResultDetail(raw: string | null): { items: unknown[] } | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const items = (parsed as { items?: unknown }).items
    if (!Array.isArray(items)) return null
    return { items }
  } catch {
    return null
  }
}

export function handleWikiIndexRebuild(bridge: AgentRuntimeBridge): { rebuiltCount: number } {
  const rebuiltCount = bridge.wikiRepo.rebuildIndex()
  return { rebuiltCount }
}

// ============================================================
// Wiki 用途主题树 / 资料层命令（记忆重构一期）
// ============================================================

/**
 * 读取主题树。getOrCreateTopicTree 会把仍停在 v1 的库当场迁到 v2，
 * 打开 Wiki 左栏就会显示工作/学习/生活/收藏，而不是旧六大类。
 */
export function handleWikiTopicTreeGet(
  bridge: AgentRuntimeBridge,
  _command: Extract<AgentRuntimeCommand, { type: 'wiki:topic:tree:get' }>,
): { tree: ReturnType<AgentRuntimeBridge['wikiRepo']['getOrCreateTopicTree']> } {
  return { tree: bridge.wikiRepo.getOrCreateTopicTree() }
}

export function handleWikiTopicTreeSet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:topic:tree:set' }>,
): { success: true } {
  bridge.wikiRepo.setTopicTree(command.tree)
  return { success: true }
}

/**
 * V26 一次性迁移：主题树 JSON v1→v2，返回统计报告并落盘到 reports/wiki-topic-tree-migration-*.json。
 * 幂等调用——已是 v2 时返回 alreadyMigrated: true，不覆盖用户在 v2 下的编辑。
 */
export function handleWikiTopicTreeMigrate(
  bridge: AgentRuntimeBridge,
  _command: Extract<AgentRuntimeCommand, { type: 'wiki:topic:tree:migrate' }>,
): ReturnType<AgentRuntimeBridge['wikiRepo']['migrateTopicTreeToV2']> & { reportPath?: string } {
  const report = bridge.wikiRepo.migrateTopicTreeToV2()

  // 只在真正迁移时写报告文件（alreadyMigrated 时跳过，避免重复写）
  if (!report.alreadyMigrated) {
    const vaultRoot = resolveWikiDir()
    const reportsDir = path.join(vaultRoot, 'reports')
    fs.mkdirSync(reportsDir, { recursive: true })

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `wiki-topic-tree-migration-${timestamp}.json`
    const reportPath = path.join(reportsDir, filename)
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8')

    return { ...report, reportPath }
  }

  return report
}

/**
 * 应用一次主题树变更。删除仍有文件的节点时 repo 会抛中文错误（带文件数），
 * 由 IPC 层原样上抛给 UI 提示「请先选择去向」。
 */
export function handleWikiTopicMutate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:topic:mutate' }>,
): { tree: unknown; movedCount: number } {
  if (!command.mutation || typeof command.mutation !== 'object') {
    throw new Error('缺少 mutation 参数')
  }
  return bridge.wikiRepo.applyTopicMutation(command.mutation as never)
}

/** 笔记落盘根目录；测试可注入替代实现，避免依赖 Electron 的 app */
export type WikiNotesDirResolver = () => string

const defaultNotesDir: WikiNotesDirResolver = () => resolveWikiDir()

/** `20260827-103000` 形式的时间戳，用于笔记文件名 */
function noteTimestamp(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return [
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`,
    `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`,
  ].join('-')
}

/**
 * 在某个正式目录下新建 markdown 笔记：落盘 md + 插入 wiki_sources + 写主题两列 + 建索引。
 * 不写 wiki_pages（页面只是历史遗留视图）。
 *
 * 目录名要 sanitize：小类名允许含 `/` 与 `&`（如「项目/任务资料」），直接拿来当路径段会
 * 造出意外的嵌套目录。因此只用大类做子目录，小类只存库不落到路径上。
 */
export function handleWikiSourceCreateNote(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:create-note' }>,
  deps?: { readonly notesDir?: WikiNotesDirResolver; readonly now?: () => Date },
): { sourceId: string; sourcePath: string; title: string } {
  const repo = bridge.wikiRepo
  const tree = repo.getOrCreateTopicTree()
  // 笔记必须落正式目录：临时存放是「主动搁置」语义，新建就搁置没有意义
  const check = validateTopicAssignment(tree, command.category, command.subtopic)
  if (!check.ok) throw new Error(check.reason)

  const title = command.title?.trim() || '未命名笔记'
  const vaultRoot = (deps?.notesDir ?? defaultNotesDir)()
  const segments = vaultDirSegmentsForSource({
    topicCategory: command.category,
    topicSubtopic: command.subtopic,
    archivedAt: null,
  }).map(sanitizeFilenameSegment)
  const dir = path.join(vaultRoot, ...segments)
  fs.mkdirSync(dir, { recursive: true })

  const stamp = noteTimestamp(deps?.now?.() ?? new Date())
  let filePath = path.join(dir, `${stamp}-${sanitizeFilenameSegment(title)}.md`)
  for (let i = 2; fs.existsSync(filePath); i++) {
    filePath = path.join(dir, `${stamp}-${sanitizeFilenameSegment(title)}-${i}.md`)
  }
  const content = `# ${title}\n\n`
  fs.writeFileSync(filePath, content, 'utf8')

  const userId = command.userId ?? LOCAL_USER_ID
  const source = repo.createSource({
    agentId: command.agentId,
    userId,
    title,
    sourcePath: filePath,
    mediaType: 'document',
    mimeType: 'text/markdown',
    contentMd: content,
    extractedText: title,
    originContext: '用户在 Wiki 目录中新建',
    storageMode: 'native',
  })
  repo.updateSourceTopic(command.agentId, userId, source.id, command.category, command.subtopic)
  repo.indexSource(source.id)
  // 笔记文件已写在 vaultRoot 下：vault 同步必须用同一个根，否则测试注入的 notesDir
  // 会被忽略，同步阶段改用生产环境的真实 workspace/wiki 目录，把临时文件错当成正式落点。
  const synced = syncWikiSourceToVault(
    repo,
    repo.findSourceById(source.id, command.agentId, userId)!,
    undefined,
    vaultRoot,
  )
  return { sourceId: synced.id, sourcePath: synced.source_path ?? filePath, title }
}

/**
 * 重命名资料：改 title；materialized/native 的实体文件同目录内跟随改名，
 * ref 存储绝不触碰用户原文件（只改库内标题，侧车文件名跟随改）。
 */
export function handleWikiSourceRename(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:rename' }>,
  deps?: { readonly workspaceRoot?: string },
): { id: string; title: string } {
  const title = command.title?.trim()
  if (!title) throw new Error('标题不能为空')
  const agentId = resolveAgentIdForWiki(bridge, undefined, command.agentId)
  const userId = command.userId ?? LOCAL_USER_ID
  const before = bridge.wikiRepo.findSourceById(command.sourceId, agentId, userId)
  if (!before) throw new Error(`资料不存在: ${command.sourceId}`)

  const updated = bridge.wikiRepo.renameSource(agentId, userId, command.sourceId, title)
  renameSourceFileOnDisk(bridge, agentId, userId, before, updated, deps?.workspaceRoot)
  return { id: updated.id, title: updated.title }
}

/**
 * 改名落盘边界（P6 Task 4）：只改文件名，不改目录（目录归属由 update-topic 流程单独处理）。
 * - ref：绝不触碰 source_path 指向的用户原文件；已生成的 `.lumii-ref` 侧车文件名跟随改
 *   （同目录内改名），源文件不跟随。
 * - materialized/native：实体文件在 vault 内，同目录内改磁盘文件名。
 */
function renameSourceFileOnDisk(
  bridge: AgentRuntimeBridge,
  agentId: string,
  userId: string,
  before: { readonly source_path: string | null; readonly storage_mode: string },
  after: { readonly id: string; readonly title: string },
  workspaceRoot?: string,
): void {
  if (!before.source_path) return
  const isRefSidecar = /\.lumii-ref$/i.test(before.source_path)
  // ref 存储但没有侧车文件（尚未落盘）：没有文件名可改，跳过。
  if (before.storage_mode === 'ref' && !isRefSidecar) return

  const deps = createWikiVaultSyncDeps(workspaceRoot)
  const currentAbs = path.isAbsolute(before.source_path)
    ? before.source_path
    : path.resolve(deps.workspaceRoot, before.source_path.replace(/\//g, path.sep))
  if (!fs.existsSync(currentAbs)) return

  const ext = isRefSidecar
    ? currentAbs.toLowerCase().endsWith('.url.lumii-ref')
      ? '.url.lumii-ref'
      : '.lumii-ref'
    : path.extname(currentAbs)
  const dirAbs = path.dirname(currentAbs)
  const newBaseName = resolveUniqueFilename({
    dirAbs,
    baseName: after.title,
    ext,
    joinPath: (...segments) => path.join(...segments),
    exists: (p) => fs.existsSync(p),
    skip: currentAbs,
  })
  const newAbs = path.join(dirAbs, newBaseName)
  if (newAbs === currentAbs) return

  fs.renameSync(currentAbs, newAbs)
  bridge.wikiRepo.updateSourcePath(agentId, userId, after.id, newAbs)
}



/** 把 IPC 的扁平 scope 参数收敘成 runtime 的联合类型，缺参直接中文报错 */
function toReclassifyScope(
  command:
    | Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:run' }>
    | Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:estimate' }>,
): { kind: 'source'; sourceId: string } | { kind: 'subtopic'; category: string; subtopic: string | null } | { kind: 'all' } {
  if (command.scope === 'source') {
    if (!command.sourceId) throw new Error('重新编目单个文件需要 sourceId')
    return { kind: 'source', sourceId: command.sourceId }
  }
  if (command.scope === 'subtopic') {
    if (!command.category) throw new Error('重新编目某个小类需要大类')
    return { kind: 'subtopic', category: command.category, subtopic: command.subtopic ?? null }
  }
  if (command.scope === 'all') return { kind: 'all' }
  throw new Error(`未知的重新编目范围：${String(command.scope)}`)
}

/**
 * 启动重新编目。异步跑（不阻塞 IPC 返回），进度由 renderer 轮询 wiki:reclassify:get。
 * 启动前的状态冲突（已有 running / 待审阅批次）是同步抛出的，需要先 await 那一步。
 * vaultRoot 由 handler 从 workspace-paths 计算后注入（agent-runtime 不依赖 Electron）。
 */
export async function handleWikiReclassifyRun(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:run' }>,
): Promise<{ runId: string }> {
  const scope = toReclassifyScope(command)
  const userId = command.userId ?? LOCAL_USER_ID
  const vaultRoot = resolveWikiDir()
  const runId = await bridge.wikiReclassifier.run(command.agentId, userId, scope, {
    force: command.force === true,
    vaultRoot,
    enableRename: command.enableRename === true,
  })
  return { runId }
}

/**
 * 编目预估：结构轮 = ceil(文件数/50)，内容轮按经验 20% 需正文估算，供 UI 确认弹窗展示。
 */
export function handleWikiReclassifyEstimate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:estimate' }>,
): { fileCount: number; structureCalls: number; estimatedContentCalls: number; note: string } {
  const scope = toReclassifyScope(command)
  const userId = command.userId ?? LOCAL_USER_ID
  const vaultRoot = resolveWikiDir()
  const inv = buildLibraryInventory(bridge.wikiRepo, command.agentId, userId, scope, vaultRoot)
  const fileCount = inv.files.length
  const structureCalls = Math.ceil(fileCount / STRUCTURE_BATCH_SIZE)
  const estimatedContentCalls = Math.ceil((fileCount * 0.2) / CONTENT_BATCH_SIZE)
  return {
    fileCount,
    structureCalls,
    estimatedContentCalls,
    note: `将对 ${fileCount} 份资料编目，预计 ${structureCalls + estimatedContentCalls} 次模型调用`,
  }
}

export function handleWikiReclassifyGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:get' }>,
): { run: unknown | null } {
  return { run: bridge.wikiReclassifier.get(command.agentId, command.userId ?? LOCAL_USER_ID) }
}

export function handleWikiReclassifyApply(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:apply' }>,
): { applied: number; failed: number } {
  const result = bridge.wikiReclassifier.apply(
    command.agentId,
    command.userId ?? LOCAL_USER_ID,
    command.candidateIds ?? [],
  )
  for (const sourceId of result.appliedSourceIds) {
    vaultSyncSource(bridge, sourceId, command.agentId)
  }
  return { applied: result.applied, failed: result.failed }
}

export function handleWikiReclassifyIgnore(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:ignore' }>,
): { success: true } {
  bridge.wikiReclassifier.ignore(command.agentId, command.userId ?? LOCAL_USER_ID, command.candidateId)
  return { success: true }
}

export function handleWikiReclassifyDiscard(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:discard' }>,
): { success: true } {
  bridge.wikiReclassifier.discard(command.agentId, command.userId ?? LOCAL_USER_ID)
  return { success: true }
}

/**
 * 列表展示：标题带上原文件后缀。
 */
function mapSourceListItem(
  source: NonNullable<ReturnType<AgentRuntimeBridge['wikiRepo']['findSourceById']>>,
  vaultDeps: ReturnType<typeof createWikiVaultSyncDeps>,
) {
  const extracted = source.extracted_text ?? ''
  const original = resolveOriginalFilePath(vaultDeps, source) ?? source.source_path
  return {
    id: source.id,
    title: titleWithOriginalExt(source.title, original),
    sourcePath: source.source_path,
    mediaType: source.media_type,
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
    textLength: extracted.length,
    updatedAt: new Date(source.last_used ?? source.created_at).getTime(),
    useCount: source.use_count,
    summary: source.summary,
    extractedTextPreview: extracted.slice(0, 60),
  }
}

export function handleWikiSourceList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:list' }>,
): { sources: unknown[] } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const sources = bridge.wikiRepo.listSourcesByTopic(agentId, LOCAL_USER_ID, {
    category: command.category,
    subtopic: command.subtopic,
    subtopicUnfiled: command.subtopicUnfiled,
    parking: command.parking,
    unfiled: command.unfiled,
    archived: command.archived,
    mediaType: command.mediaType as never,
  })
  const vaultDeps = createWikiVaultSyncDeps()
  return { sources: sources.map((s) => mapSourceListItem(s, vaultDeps)) }
}

export function handleWikiSourceUpdateTopic(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:update-topic' }>,
): { id: string; topicCategory: string | null; topicSubtopic: string | null } {
  const agentId = resolveAgentIdForWiki(bridge, undefined, command.agentId)
  const updated = bridge.wikiRepo.updateSourceTopic(
    agentId,
    LOCAL_USER_ID,
    command.sourceId,
    command.category,
    command.subtopic,
  )
  vaultSyncSource(bridge, updated.id, command.agentId)
  return { id: updated.id, topicCategory: updated.topic_category, topicSubtopic: updated.topic_subtopic }
}

export function handleWikiSourceMoveToParking(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:move-to-parking' }>,
): { id: string; topicCategory: string | null; topicSubtopic: string | null } {
  const agentId = resolveAgentIdForWiki(bridge, undefined, command.agentId)
  const updated = bridge.wikiRepo.updateSourceTopic(
    agentId,
    LOCAL_USER_ID,
    command.sourceId,
    PARKING_CATEGORY,
    null,
  )
  vaultSyncSource(bridge, updated.id, command.agentId)
  return { id: updated.id, topicCategory: updated.topic_category, topicSubtopic: updated.topic_subtopic }
}

/** 打开资料原文件；缺失或系统层打开失败均抛错中文提示，不静默返回 success */
export async function handleWikiSourceOpen(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:open' }>,
): Promise<{ success: true }> {
  const agentId = resolveAgentIdForWiki(bridge, undefined, command.agentId)
  const source = bridge.wikiRepo.findSourceById(command.sourceId, agentId, LOCAL_USER_ID)
  if (!source) throw new Error(`资料不存在: ${command.sourceId}`)
  if (!source.source_path) throw new Error('无法打开原文件：该资料没有关联的原始文件路径')

  const deps = createWikiVaultSyncDeps()
  let openPath = source.source_path
  const original = resolveOriginalFilePath(deps, source)
  if (original) openPath = original

  const absPath = path.isAbsolute(openPath)
    ? openPath
    : path.resolve(deps.workspaceRoot, openPath.replace(/\//g, path.sep))
  if (!fs.existsSync(absPath)) {
    throw new Error(`无法打开原文件：文件已丢失或被移动（${source.source_path}）`)
  }
  const result = await shell.openPath(absPath)
  if (result) {
    throw new Error(`无法打开原文件：${result}`)
  }
  bridge.wikiRepo.touchSource(agentId, LOCAL_USER_ID, source.id)
  return { success: true }
}

/**
 * 添加链接引用：只建 url-ref，不抓取正文。
 */
export function handleWikiLinkAdd(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:link:add' }>,
): { sourceId: string; title: string } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const url = parseHttpUrl(command.url)
  const title = command.title?.trim() || url.hostname
  const source = bridge.wikiRepo.createSource({
    agentId,
    userId: LOCAL_USER_ID,
    title,
    originUrl: url.toString(),
    storageMode: 'ref',
    mediaType: 'document',
    originContext: `原文链接: ${url.toString()}`,
  })
  bridge.wikiRepo.indexSource(source.id)
  const synced = syncWikiSourceToVault(bridge.wikiRepo, source)
  return { sourceId: synced.id, title: synced.title }
}

/**
 * 用户主动保存网页：抓取 URL 并写入 vault native md。
 */
export async function handleWikiLinkSave(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:link:save' }>,
): Promise<{ sourceId: string; savedPath: string; title: string }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const source = bridge.wikiRepo.findSourceById(command.sourceId, agentId, LOCAL_USER_ID)
  if (!source) throw new Error(`资料不存在: ${command.sourceId}`)
  if (!source.origin_url) throw new Error('这条资料没有网址，无法保存网页内容')

  const deps = createWikiVaultSyncDeps()
  const { resolveVaultDirAbs } = await import('@mtbot/agent-runtime')
  const destDir = resolveVaultDirAbs(deps, source)
  fs.mkdirSync(destDir, { recursive: true })

  const saver = new WikiClipSaver({
    writeFile: async (_rel, content) => {
      const slug = sanitizeFilenameSegment(source.title).slice(0, 80) || 'web-clip'
      let abs = path.join(destDir, `${slug}.md`)
      for (let i = 2; fs.existsSync(abs); i++) {
        abs = path.join(destDir, `${slug}-${i}.md`)
      }
      fs.writeFileSync(abs, content, 'utf8')
      return deps.toRelPath(abs)
    },
  })

  const clip = await saver.save(source.origin_url, source.title)
  bridge.wikiRepo.setSourceStorage(agentId, LOCAL_USER_ID, source.id, {
    storageMode: 'native',
    sourcePath: clip.savedPath,
    contentMd: clip.markdown,
    extractedText: clip.markdown,
    mimeType: 'text/markdown',
  })
  const updated = bridge.wikiRepo.findSourceById(source.id, agentId, LOCAL_USER_ID)!
  bridge.wikiRepo.indexSource(updated.id)

  return { sourceId: updated.id, savedPath: clip.savedPath, title: clip.title }
}

/**
 * 初始化 workspace/wiki/ 目录；可选回填已有资料。
 */
export function handleWikiVaultEnsureLayout(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:vault:ensure-layout' }>,
): { vaultRoot: string; synced: number; createdDirs?: readonly string[] } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const layout = ensureWikiVaultLayoutOnDisk()
  if (command.backfill === false) {
    return { vaultRoot: layout.vaultRoot, synced: 0, createdDirs: layout.createdDirs }
  }
  const backfill = ensureAndBackfillWikiVault(bridge.wikiRepo, agentId, LOCAL_USER_ID)
  return {
    vaultRoot: backfill.vaultRoot,
    synced: backfill.synced,
    createdDirs: layout.createdDirs,
  }
}

/** 把资料退回未分类。撤销误分类用，不做主题树校验（清空不是一次归属） */
export function handleWikiSourceClearTopic(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:clear-topic' }>,
): void {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const cleared = bridge.wikiRepo.clearSourceTopic(agentId, LOCAL_USER_ID, command.sourceId)
  vaultSyncSource(bridge, cleared.id, command.agentId)
}

export function handleWikiAutoClassifyGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:auto-classify:get' }>,
): { enabled: boolean } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  return { enabled: bridge.wikiRepo.getAutoClassifyEnabled(agentId, LOCAL_USER_ID) }
}

export function handleWikiAutoClassifySet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:auto-classify:set' }>,
): void {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  bridge.wikiRepo.setAutoClassifyEnabled(agentId, LOCAL_USER_ID, command.enabled)
}

export function handleWikiCleanupScan(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:cleanup:scan' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const suggestions = bridge.wikiCleanupScanner.scan(agentId, LOCAL_USER_ID, {
    staleDays: command.staleDays,
    fileExists: (p) => bridge.fileExistsForWiki(p),
  })
  // 主题两列只读展示；suggestedAction 是默认动作建议，用户仍可改
  return suggestions.map((s) => ({
    sourceId: s.source.id,
    title: s.source.title,
    reason: s.reason,
    topicCategory: s.source.topic_category,
    topicSubtopic: s.source.topic_subtopic,
    ...(s.suggestedAction ? { suggestedAction: s.suggestedAction } : {}),
    ...(s.duplicateOfSourceId ? { duplicateOfSourceId: s.duplicateOfSourceId } : {}),
  }))
}

export function handleWikiSourceArchive(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:archive' }>,
): { archived: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const archived = bridge.wikiRepo.archiveSources(agentId, LOCAL_USER_ID, command.sourceIds)
  for (const id of command.sourceIds) vaultSyncSource(bridge, id, command.agentId)
  return { archived }
}

export function handleWikiSourceRestore(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:restore' }>,
): { restored: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const restored = bridge.wikiRepo.restoreSources(agentId, LOCAL_USER_ID, command.sourceIds)
  for (const id of command.sourceIds) vaultSyncSource(bridge, id, command.agentId)
  return { restored }
}

export function handleWikiSourceDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:delete' }>,
): { deleted: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const deleted = bridge.wikiRepo.deleteSources(agentId, LOCAL_USER_ID, command.sourceIds)
  return { deleted }
}

/**
 * 导出资料清单：每条资料一个 md 文件（标题 + 摘要 + 原文/引用链接）。
 * 历史页面导出已随 P3 删除，导出维度统一切到资料层。
 */
export async function handleWikiExport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:export' }>,
): Promise<{ exported: number; failed: readonly { path: string; error: string }[] }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const sources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)
  const exporter = bridge.createWikiExporter()

  const result = await exporter.exportSources(command.targetDir, sources)
  return result
}

/**
 * 三期混合知识子图：结构层（category/subtopic/source + belongs_to/sibling）+
 * 实体层（entity + relation/mentioned_in）。centerPageId/历史层已随 P3 删除，
 * category 缺省到主题树第一个大类。
 */
export function handleWikiGraphData(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:graph:data' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)

  let category = command.category
  const subtopic = command.subtopic

  if (!category) {
    const tree = bridge.wikiRepo.getOrCreateTopicTree()
    category = tree.categories[0]?.name ?? '工作'
  }

  const builder = new WikiGraphBuilder(bridge.wikiRepo)
  return builder.buildSubgraph(agentId, LOCAL_USER_ID, {
    category,
    subtopic,
    limit: command.limit,
    layers: command.layers,
    eroRepo: ero,
  })
}

export function handleWikiEroList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:ero:list' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  const base = {
    entities: ero.listEntities(agentId, LOCAL_USER_ID),
    relations: ero.listRelations(agentId, LOCAL_USER_ID),
  }
  if (!command.entityId) {
    return base
  }
  return {
    ...base,
    observations: ero.listActiveObservations(command.entityId).map((o) => ({
      id: o.id,
      entity_id: o.entity_id,
      content: o.content,
      source_page_id: o.source_page_id,
      created_at: o.created_at,
    })),
  }
}

/**
 * AI 抽取知识图谱三元组：按目录/id 抽取资料，写 source_id，
 * 用 content_hash 游标增量跳过未变正文。旧的 target='pages'（历史页面图层）
 * 已随 P3 删除。
 */
export async function handleWikiEroExtract(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:ero:extract' }>,
): Promise<unknown> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  const extractor = new WikiEroExtractor(
    bridge.wikiRepo,
    ero,
    (prompt) => bridge.callLLM(prompt, undefined, 'wiki_ero_extract'),
  )

  return extractor.extractFromSources(agentId, LOCAL_USER_ID, {
    category: command.category,
    subtopic: command.subtopic,
    sourceIds: command.sourceIds,
  })
}

/** 三期：实体出现于哪些资料（实体侧栏） */
export function handleWikiEroEntitySources(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:ero:entity-sources' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  const sourceIds = ero.listSourceIdsForEntity(agentId, LOCAL_USER_ID, command.entityId)
  const sources = sourceIds
    .map((id) => bridge.wikiRepo.findSourceById(id, agentId, LOCAL_USER_ID))
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .map((s) => ({
      id: s.id,
      title: s.title,
      sourcePath: s.source_path,
      topicCategory: s.topic_category,
      topicSubtopic: s.topic_subtopic,
      mediaType: s.media_type,
    }))
  return { sources }
}

/**
 * 全量重建资料层向量派生表：先补零成本摘要（不调 LLM），再按最新摘要重建向量语料。
 * 页面向量重建已随 P3 删除。
 */
export async function handleWikiVectorRebuild(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:vector:rebuild' }>,
): Promise<{ rebuiltCount: number; summarized: number; backend: string; notice: string | null }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const host = await bridge.resolveWikiEmbedder(true)

  const summarizer = new WikiSummarizer(bridge.wikiRepo, null)
  let summarized = 0
  for (const s of bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)) {
    const result = await summarizer.getOrBuildSummary(s, { allowLlm: false })
    if (result) summarized += 1
  }

  const sources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)
  const sourceIndex = new WikiSourceVectorIndex(bridge.wikiRepo.database, host.embedder)
  const sourceCount = await sourceIndex.rebuild(sources)

  return { rebuiltCount: sourceCount, summarized, backend: host.backend, notice: host.notice }
}

/** 供 P5 编目/P7 重命名索取摘要；allowLlm=true 时长正文可能触发一次 LLM 调用 */
export async function handleWikiSourceSummary(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:summary' }>,
): Promise<{ summary: string | null; level: 'heuristic' | 'extractive' | 'llm' | null }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const source = bridge.wikiRepo.findSourceById(command.sourceId, agentId, LOCAL_USER_ID)
  if (!source) throw new Error(`资料不存在: ${command.sourceId}`)

  const summarizer = new WikiSummarizer(bridge.wikiRepo, (prompt) =>
    bridge.callLLM(prompt, undefined, 'memory_extract'),
  )
  const result = await summarizer.getOrBuildSummary(source, { allowLlm: command.allowLlm ?? false })
  return { summary: result?.summary ?? null, level: result?.level ?? null }
}
