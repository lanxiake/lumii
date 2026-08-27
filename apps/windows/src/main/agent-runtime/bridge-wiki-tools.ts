/**
 * Wiki 知识库 Agent 工具接线（P0）
 *
 * wiki_overview / wiki_search / wiki_read 只读；wiki_capture 写入 inbox/。
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
  wikiCaptureToolConfig,
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
      const counts = repo.countByCategory(agentId, LOCAL_USER_ID)
      const recent = repo.listPages(agentId, LOCAL_USER_ID).slice(0, 10)
      return jsonToolResult({
        ok: true,
        countsByCategory: counts,
        recentPages: recent.map((p) => ({ path: p.path, title: p.title })),
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
      const page = repo.findPageByPath(agentId, LOCAL_USER_ID, path)
      if (!page) return jsonToolResult({ ok: false, message: `page not found: ${path}` })
      repo.touchPage(page.id)
      return jsonToolResult({
        ok: true,
        path: page.path,
        title: page.title,
        category: page.category,
        content: page.content_md,
      })
    },
  }
  toolRegistry.register(createMtBotTool(readConfig, ctx))

  const captureConfig: MtBotToolConfig = {
    ...wikiCaptureToolConfig,
    execute: async () =>
      jsonToolResult({
        ok: false,
        message: 'Wiki 只收录文件与文档，不再收录对话消息。请上传会议纪要等文件。',
      }),
  }
  toolRegistry.register(createMtBotTool(captureConfig, ctx))
}
