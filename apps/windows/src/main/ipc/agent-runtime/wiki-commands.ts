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
  parseSynthesisProgress,
  WikiGraphBuilder,
  WikiPageStatusScanner,
  WikiEroRepo,
  bootstrapEroFromWikilinks,
  WikiVectorIndex,
  mergeHybridRanks,
  WikiAutoSynthesisRunner,
  WikiEroExtractor,
  PARKING_CATEGORY,
  resolveAgentFilePath,
  sanitizeFilenameSegment,
  validateTopicAssignment,
  WikiSourceVectorIndex,
  mergeSourceHybridRanks,
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
} from '@mtbot/agent-runtime'
import {
  SYNTHESIS_CONFIRM_REQUIRED_CODE,
  type AgentRuntimeCommand,
} from '../../../shared/agent-runtime-commands'
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

/** 超过这个数量的资料合成需要用户二次确认（不自动截断） */
export const SYNTHESIS_SOURCE_CONFIRM_LIMIT = 40

export class WikiSynthesisConfirmRequiredError extends Error {
  readonly code = SYNTHESIS_CONFIRM_REQUIRED_CODE
  constructor(readonly count: number) {
    super(`${SYNTHESIS_CONFIRM_REQUIRED_CODE}: 本次将合成 ${count} 个文件，数量较多、耗时较长，请确认后继续`)
  }
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
  return items.map((i) => ({
    id: i.id,
    itemType: i.item_type,
    title: i.title,
    sourcePath: i.source_path,
    sourceUrl: i.source_url,
    contentPreview: i.content_preview,
    mediaType: i.media_type,
    status: i.status,
    attemptCount: i.attempt_count,
    lastError: i.last_error,
    lastOutcome: i.last_outcome,
    createdAt: new Date(i.created_at).getTime(),
  }))
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

  if (command.dryRun || !autoClassify || importResult.inboxIds.length === 0) {
    return importResult
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

export function handleWikiPageList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:list' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID, command.category as never)
  return pages.map((p) => ({
    id: p.id,
    path: p.path,
    category: p.category,
    title: p.title,
    version: p.version,
    updatedAt: new Date(p.updated_at).getTime(),
  }))
}

export function handleWikiPageGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:get' }>,
): unknown {
  const page = bridge.wikiRepo.findPageById(command.pageId)
  // 抛错而非返回 null：null 在 CLI 里是 exit 0，调用方分不清「页面不存在」和「读到空页」
  if (!page) throw new Error(`页面不存在: ${command.pageId}`)
  return {
    id: page.id,
    path: page.path,
    category: page.category,
    title: page.title,
    contentMd: page.content_md,
    version: page.version,
    updatedAt: new Date(page.updated_at).getTime(),
  }
}

export function handleWikiPageUpdate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:update' }>,
): { pageId: string; version: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const page = bridge.wikiRepo.savePage({
    agentId,
    userId: LOCAL_USER_ID,
    path: command.path,
    title: command.title,
    contentMd: command.contentMd,
    editor: 'user',
  })
  return { pageId: page.id, version: page.version }
}

export function handleWikiPageDelete(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:delete' }>,
): { success: boolean } {
  bridge.wikiRepo.deletePage(command.pageId)
  return { success: true }
}

/** 主搜索改为资料层：命中原始文件而非旧汇总页。历史页面搜索见 wiki:search:hybrid。 */
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
        const sources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID).slice(0, 200)
        for (const s of sources) await index.upsertSource(s)
      }
      const vecHits = await index.searchSimilar(agentId, LOCAL_USER_ID, command.keyword, limit)
      vectorIds = vecHits.map((v) => v.sourceId)
      // 向量命中的资料可能没进 FTS top-N，补进 sourceById 供映射
      for (const s of bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)) {
        if (vectorIds.includes(s.id) && !sourceById.has(s.id)) sourceById.set(s.id, s)
      }
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
  const synced = syncWikiSourceToVault(repo, repo.findSourceById(source.id, command.agentId, userId)!)

  return { sourceId: synced.id, sourcePath: synced.source_path ?? filePath, title }
}

/**
 * 重命名资料 = 只改 title。磁盘文件名保持不动，避免已有引用/链接失效。
 */
export function handleWikiSourceRename(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:rename' }>,
): { id: string; title: string } {
  const title = command.title?.trim()
  if (!title) throw new Error('标题不能为空')
  const updated = bridge.wikiRepo.renameSource(
    command.agentId,
    command.userId ?? LOCAL_USER_ID,
    command.sourceId,
    title,
  )
  return { id: updated.id, title: updated.title }
}

/** 把 IPC 的扁平 scope 参数收敘成 runtime 的联合类型，缺参直接中文报错 */
function toReclassifyScope(
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:run' }>,
): { kind: 'source'; sourceId: string } | { kind: 'subtopic'; category: string; subtopic: string } | { kind: 'all' } {
  if (command.scope === 'source') {
    if (!command.sourceId) throw new Error('重新编目单个文件需要 sourceId')
    return { kind: 'source', sourceId: command.sourceId }
  }
  if (command.scope === 'subtopic') {
    if (!command.category || !command.subtopic) throw new Error('重新编目某个小类需要大类与小类')
    return { kind: 'subtopic', category: command.category, subtopic: command.subtopic }
  }
  if (command.scope === 'all') return { kind: 'all' }
  throw new Error(`未知的重新编目范围：${String(command.scope)}`)
}

/**
 * 启动重新编目。异步跑（不阻塞 IPC 返回），进度由 renderer 轮询 wiki:reclassify:get。
 * 启动前的状态冲突（已有 running / 待审阅批次）是同步抛出的，需要先 await 那一步。
 */
export async function handleWikiReclassifyRun(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:reclassify:run' }>,
): Promise<{ runId: string }> {
  const scope = toReclassifyScope(command)
  const userId = command.userId ?? LOCAL_USER_ID
  const runId = await bridge.wikiReclassifier.run(command.agentId, userId, scope, {
    force: command.force === true,
  })
  return { runId }
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
  return bridge.wikiReclassifier.apply(
    command.agentId,
    command.userId ?? LOCAL_USER_ID,
    command.candidateIds ?? [],
  )
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

function mapSourceListItem(source: NonNullable<ReturnType<AgentRuntimeBridge['wikiRepo']['findSourceById']>>) {
  const extracted = source.extracted_text ?? ''
  return {
    id: source.id,
    title: source.title,
    sourcePath: source.source_path,
    mediaType: source.media_type,
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
    textLength: extracted.length,
    updatedAt: new Date(source.last_used ?? source.created_at).getTime(),
    useCount: source.use_count,
  }
}

export function handleWikiSourceList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:list' }>,
): { sources: unknown[] } {
  const sources = bridge.wikiRepo.listSourcesByTopic(command.agentId, command.userId ?? LOCAL_USER_ID, {
    category: command.category,
    subtopic: command.subtopic,
    parking: command.parking,
    unfiled: command.unfiled,
    archived: command.archived,
    mediaType: command.mediaType as never,
  })
  return { sources: sources.map(mapSourceListItem) }
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

// ============================================================
// Wiki 知识库命令（P1）
// ============================================================

/** 反链/修订/回滚都以 pageId 为入口，从页面反查归属，不要求调用方额外传 agentId/userId */
function requirePage(bridge: AgentRuntimeBridge, pageId: string) {
  const page = bridge.wikiRepo.findPageById(pageId)
  if (!page) throw new Error(`页面不存在: ${pageId}`)
  return page
}

export function handleWikiLinkBacklinks(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:link:backlinks' }>,
): unknown {
  const page = requirePage(bridge, command.pageId)
  const backlinks = bridge.wikiRepo.listBacklinks(page.agent_id, page.user_id, page.id)
  return backlinks.map((b) => ({
    linkId: b.linkId,
    sourcePageId: b.sourcePageId,
    sourceTitle: b.sourceTitle,
    sourcePath: b.sourcePath,
    anchorText: b.anchorText,
    isResolved: b.isResolved,
  }))
}

export function handleWikiLinkUnresolved(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:link:unresolved' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const links = bridge.wikiRepo.listUnresolvedLinks(agentId, LOCAL_USER_ID)
  return links.map((l) => ({
    id: l.id,
    sourcePageId: l.source_page_id,
    anchorText: l.anchor_text,
    createdAt: new Date(l.created_at).getTime(),
  }))
}

export function handleWikiPageRevisions(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:revisions' }>,
): unknown {
  requirePage(bridge, command.pageId)
  const revisions = bridge.wikiRepo.listRevisions(command.pageId)
  return revisions.map((r) => ({
    id: r.id,
    version: r.version,
    title: r.title,
    editor: r.editor,
    sourceRef: r.source_ref,
    createdAt: new Date(r.created_at).getTime(),
    contentMd: r.content_md,
  }))
}

export function handleWikiPageRollback(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:page:rollback' }>,
): { pageId: string; version: number } {
  const page = requirePage(bridge, command.pageId)
  const rolledBack = bridge.wikiRepo.rollbackPage(page.agent_id, page.user_id, page.id, command.targetVersion)
  return { pageId: rolledBack.id, version: rolledBack.version }
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

export function handleWikiAttachList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:attach:list' }>,
): unknown {
  requirePage(bridge, command.pageId)
  const attachments = bridge.wikiRepo.listAttachments(command.pageId)
  return attachments.map((a) => ({
    id: a.id,
    pageId: a.page_id,
    sourceId: a.source_id,
    filePath: a.file_path,
    mediaType: a.media_type,
    displayName: a.display_name,
    createdAt: new Date(a.created_at).getTime(),
  }))
}

export function handleWikiAttachAdd(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:attach:add' }>,
): unknown {
  requirePage(bridge, command.pageId)
  // 附件路径来自调用方，必须校验落在工作区内：现在没有命令能打开附件，
  // 但存进库的路径迟早会被某个入口拿去用，那时校验就来不及了。
  const filePath = resolveAgentFilePath(command.filePath, bridge.getCwd())
  const attachment = bridge.wikiRepo.attachFile({
    pageId: command.pageId,
    filePath,
    mediaType: command.mediaType,
    displayName: command.displayName,
    sourceId: command.sourceId,
  })
  return {
    id: attachment.id,
    pageId: attachment.page_id,
    sourceId: attachment.source_id,
    filePath: attachment.file_path,
    mediaType: attachment.media_type,
    displayName: attachment.display_name,
    createdAt: new Date(attachment.created_at).getTime(),
  }
}

export function handleWikiAttachRemove(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:attach:remove' }>,
): { success: boolean } {
  return { success: bridge.wikiRepo.detachFile(command.attachmentId) }
}

export async function handleWikiExport(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:export' }>,
): Promise<{ exported: number; failed: readonly { path: string; error: string }[] }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID)
  const exporter = bridge.createWikiExporter()

  const context: { sources?: readonly ReturnType<typeof bridge.wikiRepo.listSources>[number][] } = {}
  if (command.includeSources) {
    context.sources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)
  }

  const result = await exporter.exportPages(
    command.targetDir,
    pages,
    { includeSources: command.includeSources, includeAttachments: command.includeAttachments },
    context,
  )
  return result
}

export async function handleWikiConceptScan(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:concept:scan' }>,
): Promise<unknown> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const allSources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)
  const sources = allSources.slice(0, command.limit ?? 30)
  const candidates = await bridge.wikiConceptCandidateScanner.scan(agentId, LOCAL_USER_ID, sources, (prompt) =>
    bridge.callLLM(prompt, undefined, 'memory_extract'),
  )
  return candidates.map((c) => ({
    name: c.name,
    type: c.type,
    evidenceSourceIds: c.evidenceSourceIds,
    suggestedContentMd: c.suggestedContentMd,
  }))
}

export function handleWikiConceptConfirm(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:concept:confirm' }>,
): { pageId: string; path: string } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const page = bridge.wikiConceptCandidateScanner.confirm(agentId, LOCAL_USER_ID, command.name, command.conceptType)
  return { pageId: page.id, path: page.path }
}

export function handleWikiConceptReject(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:concept:reject' }>,
): { success: boolean } {
  bridge.wikiConceptCandidateScanner.reject(command.name, command.conceptType)
  return { success: true }
}

/** 将合成行映射为 IPC 列表项 */
function mapSynthesisListItem(row: {
  id: string
  title: string
  status: string
  source_page_ids: readonly string[]
  output_path: string | null
  error: string | null
  page_id: string | null
  created_at: string
  finished_at: string | null
}) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    sourcePageIds: row.source_page_ids,
    outputPath: row.output_path,
    error: row.error,
    progress: parseSynthesisProgress(row.error),
    pageId: row.page_id,
    createdAt: new Date(row.created_at).getTime(),
    finishedAt: row.finished_at ? new Date(row.finished_at).getTime() : null,
  }
}

/**
 * 发起综述合成。pageIds 与 category 至少其一；category 展开为该分类全部页面。
 */
export async function handleWikiSynthesisCreate(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:create' }>,
): Promise<{ synthesisId: string }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const synthesizer = bridge.createWikiSynthesizer()

  // 二期主路径：以资料为输入。给 sourceIds，或给 topicCategory（可选 topicSubtopic）都走这条。
  if ((command.sourceIds && command.sourceIds.length > 0) || command.topicCategory) {
    let sourceIds = [...(command.sourceIds ?? [])]
    if (sourceIds.length === 0 && command.topicCategory) {
      sourceIds = bridge.wikiRepo
        .listSourcesByTopic(agentId, LOCAL_USER_ID, {
          category: command.topicCategory,
          subtopic: command.topicSubtopic,
        })
        .map((s) => s.id)
    }
    if (sourceIds.length === 0) {
      throw new Error('这个目录下没有可合成的文件')
    }
    // 不静默截断：超量时抛带 code 的错误，UI 二次确认后带 confirmed 再来。
    // 用 code 而非匹配中文文案，避免改文案就破坏 UI 判断。
    if (sourceIds.length > SYNTHESIS_SOURCE_CONFIRM_LIMIT && command.confirmed !== true) {
      throw new WikiSynthesisConfirmRequiredError(sourceIds.length)
    }
    const synthesisId = await synthesizer.synthesizeSources(agentId, LOCAL_USER_ID, sourceIds, {
      title: command.title,
      mode: command.mode,
    })
    return { synthesisId }
  }

  // 历史页面路径：保留给存量摘要页记录
  let pageIds = [...(command.pageIds ?? [])]
  if (command.category) {
    const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID, command.category as never)
    pageIds = pages.map((p) => p.id)
  }
  if (pageIds.length === 0) {
    throw new Error('合成至少需要一个文件（提供 sourceIds / topicCategory / pageIds）')
  }
  const synthesisId = await synthesizer.synthesize(agentId, LOCAL_USER_ID, pageIds, {
    title: command.title,
  })
  return { synthesisId }
}

/** 以资料形式接受综述：产物成为目录里的一份普通文件 */
export function handleWikiSynthesisAcceptAsSource(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:accept-as-source' }>,
): { sourceId: string; category: string; subtopic: string } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const source = bridge
    .createWikiSynthesizer()
    .acceptAsSource(agentId, LOCAL_USER_ID, command.synthesisId, {
      category: command.category,
      subtopic: command.subtopic,
    }, { archiveSources: command.archiveSources === true })
  return {
    sourceId: source.id,
    category: source.topic_category ?? command.category,
    subtopic: source.topic_subtopic ?? command.subtopic,
  }
}

/**
 * 一键自动综述：串行生成各分类的稳定 overview 页（不经 candidate 接受态）。
 */
export async function handleWikiSynthesisAutoRun(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:auto-run' }>,
): Promise<{
  results: readonly {
    category: string
    pageId: string
    path: string
    skipped?: boolean
    error?: string
  }[]
}> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const runner = new WikiAutoSynthesisRunner(bridge.createWikiSynthesizer(), bridge.wikiRepo)
  return runner.autoSynthesizeAll(agentId, LOCAL_USER_ID)
}

export function handleWikiSynthesisList(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:list' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const rows = bridge.wikiRepo.listSyntheses(agentId, LOCAL_USER_ID, command.status)
  return rows.map(mapSynthesisListItem)
}

export function handleWikiSynthesisGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:get' }>,
): unknown {
  const row = bridge.wikiRepo.findSynthesisById(command.synthesisId)
  if (!row) throw new Error(`合成记录不存在: ${command.synthesisId}`)
  const sourcePages = row.source_page_ids
    .map((id) => bridge.wikiRepo.findPageById(id))
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .map((p) => ({ id: p.id, title: p.title, path: p.path }))
  return {
    ...mapSynthesisListItem(row),
    candidateMd: row.candidate_md,
    sourceIds: row.source_ids,
    sourcePages,
  }
}

export function handleWikiSynthesisAccept(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:accept' }>,
): { pageId: string; path: string } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const page = bridge.createWikiSynthesizer().accept(agentId, LOCAL_USER_ID, command.synthesisId)
  return { pageId: page.id, path: page.path }
}

export function handleWikiSynthesisReject(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:synthesis:reject' }>,
): { success: boolean } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  bridge.createWikiSynthesizer().reject(agentId, LOCAL_USER_ID, command.synthesisId)
  return { success: true }
}

/**
 * 三期混合知识子图：结构层（category/subtopic/source + belongs_to/sibling）+
 * 实体层（entity + relation/mentioned_in）+ 历史层（page + wikilink）。
 * 参数 centerPageId、category、subtopic 全空时缺省到主题树第一个大类。
 */
export function handleWikiGraphData(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:graph:data' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)

  let centerPageId = command.centerPageId
  let category = command.category
  const subtopic = command.subtopic

  if (!centerPageId && !category) {
    const tree = bridge.wikiRepo.getOrCreateTopicTree()
    category = tree.categories[0]?.name ?? '做事记录'
  }

  const builder = new WikiGraphBuilder(bridge.wikiRepo)
  return builder.buildSubgraph(agentId, LOCAL_USER_ID, {
    centerPageId,
    category,
    subtopic,
    radius: command.radius,
    limit: command.limit,
    layers: command.layers,
    eroRepo: ero,
  })
}

/** 从双链引导 ERO 实体与关系 */
export function handleWikiEroBootstrap(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:ero:bootstrap' }>,
): { entities: number; relations: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  return bootstrapEroFromWikilinks(bridge.wikiRepo.database, bridge.wikiRepo, ero, agentId, LOCAL_USER_ID)
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
 * AI 抽取知识图谱三元组。默认 target='sources'：按目录/id 抽取资料，写 source_id，
 * 用 content_hash 游标增量跳过未变正文。target='pages' 保持旧行为（服务历史页面图层）。
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

  if (command.target === 'pages') {
    return extractor.extractRecent(agentId, LOCAL_USER_ID, {
      maxPages: command.maxPages,
      maxCharsPerPage: command.maxCharsPerPage,
    })
  }

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
 * 混合检索：FTS + 可选向量 RRF；向量关闭/失败时 degradeReason 显式返回。
 */
export async function handleWikiSearchHybrid(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:search:hybrid' }>,
): Promise<unknown> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const limit = command.limit ?? 10
  const ftsHits = bridge.wikiRepo.search(agentId, LOCAL_USER_ID, command.keyword, limit)
  const ftsIds = ftsHits.map((h) => h.page.id)
  const pageById = new Map(ftsHits.map((h) => [h.page.id, h.page]))

  let vectorIds: string[] = []
  let degradeReason: string | null = null
  let backend = 'none'

  if (command.enableVector === false) {
    degradeReason = '向量检索已关闭，仅全文检索'
  } else {
    try {
      const host = await bridge.resolveWikiEmbedder()
      backend = host.backend
      if (host.notice && host.backend === 'bigram-hash') {
        degradeReason = host.notice
      }
      const index = new WikiVectorIndex(bridge.wikiRepo.database, host.embedder)
      for (const hit of ftsHits) {
        await index.upsertPage(hit.page)
      }
      if (ftsHits.length === 0) {
        const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID).slice(0, 200)
        for (const p of pages) {
          await index.upsertPage(p)
          pageById.set(p.id, p)
        }
      }
      const vecHits = await index.searchSimilar(agentId, LOCAL_USER_ID, command.keyword, limit)
      vectorIds = vecHits.map((h) => h.pageId)
      for (const id of vectorIds) {
        if (!pageById.has(id)) {
          const p = bridge.wikiRepo.findPageById(id)
          if (p) pageById.set(id, p)
        }
      }
    } catch (err) {
      degradeReason = `向量检索失败，已降级全文：${err instanceof Error ? err.message : String(err)}`
    }
  }

  const merged = mergeHybridRanks({ ftsIds, vectorIds, pageById })
  const hits = merged.ids.slice(0, limit).map((id) => {
    const page = pageById.get(id)!
    return {
      pageId: page.id,
      path: page.path,
      category: page.category,
      title: page.title,
      snippet: page.content_md.slice(0, 200),
      updatedAt: new Date(page.updated_at).getTime(),
      mode: merged.mode,
    }
  })

  return { hits, degradeReason, mode: merged.mode, backend }
}

export async function handleWikiVectorRebuild(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:vector:rebuild' }>,
): Promise<{ rebuiltCount: number; backend: string; notice: string | null }> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const host = await bridge.resolveWikiEmbedder(true)

  // 页面向量（历史页面的混合检索）
  const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID)
  const pageIndex = new WikiVectorIndex(bridge.wikiRepo.database, host.embedder)
  const pageCount = await pageIndex.rebuild(pages)

  // 资料向量（wiki:search 用）
  const sources = bridge.wikiRepo.listSources(agentId, LOCAL_USER_ID)
  const sourceIndex = new WikiSourceVectorIndex(bridge.wikiRepo.database, host.embedder)
  const sourceCount = await sourceIndex.rebuild(sources)

  return { rebuiltCount: pageCount + sourceCount, backend: host.backend, notice: host.notice }
}

export function handleWikiStatusScan(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:status:scan' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const scanner = new WikiPageStatusScanner(bridge.wikiRepo)
  const candidates = scanner.scan(agentId, LOCAL_USER_ID, {
    staleDays: command.staleDays,
    fileExists: (p) => bridge.fileExistsForWiki(p),
  })
  return candidates.map((c) => ({
    pageId: c.pageId,
    title: c.title,
    path: c.path,
    suggestedStatus: c.suggestedStatus,
    reason: c.reason,
  }))
}

export function handleWikiStatusConfirm(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:status:confirm' }>,
): { success: boolean } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const scanner = new WikiPageStatusScanner(bridge.wikiRepo)
  if (command.action === 'reject') {
    scanner.reject(agentId, LOCAL_USER_ID, command.pageId)
  } else {
    if (!command.status) throw new Error('confirm 需要 status')
    scanner.confirm(agentId, LOCAL_USER_ID, command.pageId, command.status)
  }
  return { success: true }
}
