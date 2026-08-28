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
} from '@mtbot/agent-runtime'
import type { AgentRuntimeCommand } from '../../../shared/agent-runtime-commands'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'

const LOCAL_USER_ID = 'local-user'

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
  return { sourceId: updated.id, category: updated.topic_category!, subtopic: updated.topic_subtopic! }
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
export function handleWikiSearch(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:search' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const hits = bridge.wikiRepo.searchSources(agentId, LOCAL_USER_ID, command.keyword, command.limit)
  return hits.map((h) => ({
    sourceId: h.source.id,
    title: h.source.title,
    category: h.source.topic_category,
    subtopic: h.source.topic_subtopic,
    snippet: h.snippet,
    mediaType: h.source.media_type,
    sourcePath: h.source.source_path,
    updatedAt: new Date(h.source.last_used ?? h.source.created_at).getTime(),
  }))
}

export function handleWikiSourceGet(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:get' }>,
): unknown {
  const source = bridge.wikiRepo.findSourceById(command.sourceId)
  if (!source) return null
  return {
    id: source.id,
    title: source.title,
    sourcePath: source.source_path,
    mediaType: source.media_type,
    extractedText: source.extracted_text,
    originContext: source.origin_context,
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

function mapSourceListItem(source: ReturnType<AgentRuntimeBridge['wikiRepo']['findSourceById']> & object) {
  return {
    id: source.id,
    title: source.title,
    sourcePath: source.source_path,
    mediaType: source.media_type,
    topicCategory: source.topic_category,
    topicSubtopic: source.topic_subtopic,
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

  const absPath = path.isAbsolute(source.source_path)
    ? source.source_path
    : path.resolve(bridge.getCwd(), source.source_path)
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

export function handleWikiCleanupScan(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:cleanup:scan' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const suggestions = bridge.wikiCleanupScanner.scan(agentId, LOCAL_USER_ID, {
    staleDays: command.staleDays,
    fileExists: (p) => bridge.fileExistsForWiki(p),
  })
  // 一期只把两列主题带给 UI 只读展示，不在清理里提供改主题的动作
  return suggestions.map((s) => ({
    sourceId: s.source.id,
    title: s.source.title,
    reason: s.reason,
    topicCategory: s.source.topic_category,
    topicSubtopic: s.source.topic_subtopic,
    ...(s.duplicateOfSourceId ? { duplicateOfSourceId: s.duplicateOfSourceId } : {}),
  }))
}

export function handleWikiSourceArchive(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:archive' }>,
): { archived: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const archived = bridge.wikiRepo.archiveSources(agentId, LOCAL_USER_ID, command.sourceIds)
  return { archived }
}

export function handleWikiSourceRestore(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:source:restore' }>,
): { restored: number } {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const restored = bridge.wikiRepo.restoreSources(agentId, LOCAL_USER_ID, command.sourceIds)
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
  let pageIds = [...(command.pageIds ?? [])]
  if (command.category) {
    const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID, command.category as never)
    pageIds = pages.map((p) => p.id)
  }
  if (pageIds.length === 0) {
    throw new Error('合成至少需要一个页面（提供 pageIds 或非空 category）')
  }
  const synthesizer = bridge.createWikiSynthesizer()
  const synthesisId = await synthesizer.synthesize(agentId, LOCAL_USER_ID, pageIds, {
    title: command.title,
  })
  return { synthesisId }
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
 * 返回混合知识子图；ERO 为空时先从双链冷启动实体/关系，再构建图谱。
 */
export function handleWikiGraphData(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:graph:data' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  let entities = ero.listEntities(agentId, LOCAL_USER_ID)
  let relations = ero.listRelations(agentId, LOCAL_USER_ID)
  if (entities.length === 0) {
    bootstrapEroFromWikilinks(bridge.wikiRepo.database, bridge.wikiRepo, ero, agentId, LOCAL_USER_ID)
    entities = ero.listEntities(agentId, LOCAL_USER_ID)
    relations = ero.listRelations(agentId, LOCAL_USER_ID)
  }
  const builder = new WikiGraphBuilder(bridge.wikiRepo)
  return builder.buildSubgraph(agentId, LOCAL_USER_ID, {
    centerPageId: command.centerPageId,
    category: command.category as never,
    radius: command.radius,
    limit: command.limit,
    includeEntities: true,
    eroEntities: entities,
    eroRelations: relations,
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
 * AI 抽取最近更新页的实体关系观察并 upsert 到 ERO 仓储。
 */
export async function handleWikiEroExtract(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:ero:extract' }>,
): Promise<{
  pagesProcessed: number
  entitiesUpserted: number
  relationsUpserted: number
  observationsAdded: number
  errors: readonly string[]
}> {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const ero = new WikiEroRepo(bridge.wikiRepo.database)
  const extractor = new WikiEroExtractor(
    bridge.wikiRepo,
    ero,
    (prompt) => bridge.callLLM(prompt, undefined, 'wiki_ero_extract'),
  )
  return extractor.extractRecent(agentId, LOCAL_USER_ID, {
    maxPages: command.maxPages,
    maxCharsPerPage: command.maxCharsPerPage,
  })
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
  const pages = bridge.wikiRepo.listPages(agentId, LOCAL_USER_ID)
  const host = await bridge.resolveWikiEmbedder(true)
  const index = new WikiVectorIndex(bridge.wikiRepo.database, host.embedder)
  const rebuiltCount = await index.rebuild(pages)
  return { rebuiltCount, backend: host.backend, notice: host.notice }
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
