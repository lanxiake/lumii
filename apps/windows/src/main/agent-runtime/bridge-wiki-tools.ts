/**
 * Wiki 知识库 Agent 工具接线（P0）
 *
 * wiki_overview / wiki_search / wiki_read 只读。wiki_capture 已下线。
 * agentId 解析范式同 memory_manage（bridge-tool-registrar-client-cmd.ts:129）：
 * toolCallId → instanceId → definitionId，取不到则退到 'default'。
 *
 * 设计：docs/design/记忆设计/2026-08-25-wiki-design-p0p1p2.md §3.9
 */

import {
  createMtBotTool,
  wikiOverviewToolConfig,
  wikiSearchToolConfig,
  wikiReadToolConfig,
  type MtBotToolConfig,
  type ToolExecutionContext,
  type WikiRepo,
  type WikiIngestHook,
} from '@mtbot/agent-runtime'
import { jsonToolResult } from './bridge-utils'

const LOCAL_USER_ID = 'local-user'

export interface WikiToolsDeps {
  toolCallInstanceMap: Map<string, string>
  getCurrentToolExecutorInstanceId: () => string | undefined
  getDefinitionIdByInstanceId: (instanceId: string) => string | undefined
  getWikiRepo: () => WikiRepo | null
  getWikiIngestHook: () => WikiIngestHook | null
}

export function registerWikiTools(
  toolRegistry: { register: (tool: ReturnType<typeof createMtBotTool>) => void },
  ctx: ToolExecutionContext,
  deps: WikiToolsDeps,
): void {
  const resolveAgentId = (toolCallId: string): string => {
    const instanceId =
      deps.toolCallInstanceMap.get(toolCallId) ?? deps.getCurrentToolExecutorInstanceId()
    return (instanceId && deps.getDefinitionIdByInstanceId(instanceId)) ?? 'default'
  }

  const overviewConfig: MtBotToolConfig = {
    ...wikiOverviewToolConfig,
    execute: async (toolCallId) => {
      const repo = deps.getWikiRepo()
      if (!repo) return jsonToolResult({ ok: false, message: 'wiki repo not initialized' })
      const agentId = resolveAgentId(toolCallId)
      const sources = repo.listSources(agentId, LOCAL_USER_ID)
      const counts: Record<string, number> = {}
      for (const s of sources) {
        if (!s.topic_category) continue
        counts[s.topic_category] = (counts[s.topic_category] ?? 0) + 1
      }
      const recent = [...sources]
        .sort((a, b) => (b.last_used ?? b.created_at).localeCompare(a.last_used ?? a.created_at))
        .slice(0, 10)
      return jsonToolResult({
        ok: true,
        countsByCategory: counts,
        recentSources: recent.map((s) => ({ title: s.title, category: s.topic_category, subtopic: s.topic_subtopic })),
      })
    },
  }
  toolRegistry.register(createMtBotTool(overviewConfig, ctx))

  const searchConfig: MtBotToolConfig = {
    ...wikiSearchToolConfig,
    execute: async (toolCallId, rawParams) => {
      const repo = deps.getWikiRepo()
      if (!repo) return jsonToolResult({ ok: false, message: 'wiki repo not initialized' })
      const p = rawParams as { query?: string; limit?: number }
      const query = (p.query ?? '').trim()
      if (!query) return jsonToolResult({ ok: false, message: 'query is required' })
      const agentId = resolveAgentId(toolCallId)
      const limit = Math.max(1, Math.min(p.limit ?? 10, 50))
      const hits = repo.searchSources(agentId, LOCAL_USER_ID, query, limit)
      return jsonToolResult({
        ok: true,
        results: hits.map((h) => ({
          sourcePath: h.source.source_path,
          title: h.source.title,
          category: h.source.topic_category,
          subtopic: h.source.topic_subtopic,
          content: h.snippet,
        })),
      })
    },
  }
  toolRegistry.register(createMtBotTool(searchConfig, ctx))

  const readConfig: MtBotToolConfig = {
    ...wikiReadToolConfig,
    execute: async (toolCallId, rawParams) => {
      const repo = deps.getWikiRepo()
      if (!repo) return jsonToolResult({ ok: false, message: 'wiki repo not initialized' })
      const path = String((rawParams as { path?: string }).path ?? '').trim()
      if (!path) return jsonToolResult({ ok: false, message: 'path is required' })
      const agentId = resolveAgentId(toolCallId)
      const source = repo.findSourceBySourcePath(agentId, LOCAL_USER_ID, path)
      if (!source) return jsonToolResult({ ok: false, message: `page not found: ${path}` })
      repo.touchSource(agentId, LOCAL_USER_ID, source.id)
      return jsonToolResult({
        ok: true,
        path: source.source_path,
        title: source.title,
        category: source.topic_category,
        content: source.extracted_text ?? source.content_md ?? '',
      })
    },
  }
  toolRegistry.register(createMtBotTool(readConfig, ctx))

  // wiki_capture 已下线：Wiki 只收录文件与文档，不再收录对话消息。
  // 之前注册一个「永远拒绝」的工具，只是在浪费提示词与 schema token。
}
