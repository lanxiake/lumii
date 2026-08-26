/**
 * Wiki 知识库命令处理器（P0）
 *
 * 复用 agent-commands.ts 的 sessionKey/agentId 解析惯例：显式 agentId 优先，
 * 否则从会话参与者解析，兜底 'assistant'。userId 固定 LOCAL_USER_ID（单机应用）。
 */
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
    createdAt: new Date(i.created_at).getTime(),
  }))
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

/** 手动指定分类立即归档：绕开 AI 分类，直接落库；路径非法时 savePage 会抛错，向上层报告 */
export function handleWikiInboxOrganize(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:organize' }>,
): { pageId: string; path: string } {
  const repo = bridge.wikiRepo
  const item = repo.findInboxById(command.inboxId)
  if (!item) throw new Error(`收件箱条目不存在: ${command.inboxId}`)

  const source = repo.createSource({
    agentId: item.agent_id,
    userId: item.user_id,
    title: command.title ?? item.title,
    sourcePath: item.source_path ?? undefined,
    contentMd: command.contentMd ?? item.content_preview ?? undefined,
    contentHash: item.content_hash ?? undefined,
    mediaType: item.media_type,
    extractedText: item.content_preview ?? undefined,
  })
  const page = repo.savePage({
    agentId: item.agent_id,
    userId: item.user_id,
    path: command.path,
    title: command.title ?? item.title,
    contentMd: command.contentMd ?? item.content_preview ?? '',
    editor: 'user',
    sourceRef: source.id,
  })
  repo.markInboxOrganized(item.id, source.id)
  return { pageId: page.id, path: page.path }
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

export function handleWikiSearch(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:search' }>,
): unknown {
  const agentId = resolveAgentIdForWiki(bridge, command.sessionKey, command.agentId)
  const hits = bridge.wikiRepo.search(agentId, LOCAL_USER_ID, command.keyword, command.limit)
  return hits.map((h) => ({
    pageId: h.page.id,
    path: h.page.path,
    category: h.page.category,
    title: h.page.title,
    snippet: h.snippet,
    updatedAt: new Date(h.page.updated_at).getTime(),
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
    createdAt: new Date(r.created_at).getTime(),
    finishedAt: r.finished_at ? new Date(r.finished_at).getTime() : null,
  }))
}

export function handleWikiIndexRebuild(bridge: AgentRuntimeBridge): { rebuiltCount: number } {
  const rebuiltCount = bridge.wikiRepo.rebuildIndex()
  return { rebuiltCount }
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
  return suggestions.map((s) => ({
    sourceId: s.source.id,
    title: s.source.title,
    reason: s.reason,
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
  const attachment = bridge.wikiRepo.attachFile({
    pageId: command.pageId,
    filePath: command.filePath,
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
