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

export function handleWikiInboxRetry(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:retry' }>,
): { success: boolean } {
  bridge.wikiRepo.retryInbox(command.inboxId)
  return { success: true }
}

export function handleWikiInboxDiscard(
  bridge: AgentRuntimeBridge,
  command: Extract<AgentRuntimeCommand, { type: 'wiki:inbox:discard' }>,
): { success: boolean } {
  bridge.wikiRepo.discardInbox(command.inboxId)
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
  if (!page) return null
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
