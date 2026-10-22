/**
 * 资讯偏好 Agent 工具接线（news_preference）
 *
 * 落在 user-memory.md 的 `## 资讯偏好` 章节：它本来就是用户偏好，用户在记忆页能直接看到、
 * 直接改，`.bak` 备份与注入预算一并继承。读写只碰这一个章节，章节外的内容原样保留。
 */

import { createMtBotTool, newsPreferenceToolConfig, type MtBotToolConfig } from '@mtbot/agent-runtime'
import { jsonToolResult } from './bridge-utils'
import { readUserMemoryFile, writeUserMemoryFile } from '../ipc/plugin-ipc'
import {
  NEWS_PREF_FIELDS,
  applyNewsPreference,
  describeNewsPreferences,
  readNewsPreferences,
  type NewsPrefField,
} from '../news-preferences'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

export function registerNewsPreferenceTool(deps: BridgeToolRegistrarDeps): void {
  const ctx = deps.toolContext
  if (!ctx) return

  const prefTool: MtBotToolConfig = {
    ...newsPreferenceToolConfig,
    execute: async (_id, rawParams) => {
      const p = rawParams as { action?: string; field?: string; value?: string }
      try {
        const file = await readUserMemoryFile()
        const markdown = file?.content ?? ''
        if (p.action === 'read' || !p.action) {
          const prefs = readNewsPreferences(markdown)
          return jsonToolResult({
            status: 'ok',
            preferences: prefs,
            description: describeNewsPreferences(prefs),
          })
        }
        if (p.action !== 'add' && p.action !== 'remove') {
          return jsonToolResult({ status: 'error', message: `unsupported action: ${p.action}` })
        }
        if (!p.field || !NEWS_PREF_FIELDS.includes(p.field as NewsPrefField)) {
          return jsonToolResult({
            status: 'error',
            message: `field 必须是以下之一：${NEWS_PREF_FIELDS.join(' / ')}`,
          })
        }
        if (!p.value?.trim()) {
          return jsonToolResult({ status: 'error', message: 'value is required' })
        }
        const next = applyNewsPreference(markdown, {
          field: p.field as NewsPrefField,
          op: p.action,
          value: p.value,
        })
        const written = await writeUserMemoryFile(next)
        if (!written) return jsonToolResult({ status: 'error', message: '写入个人记忆失败' })
        const prefs = readNewsPreferences(next)
        return jsonToolResult({
          status: 'ok',
          action: p.action,
          preferences: prefs,
          description: describeNewsPreferences(prefs),
        })
      } catch (err) {
        return jsonToolResult({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
  deps.toolRegistry.register(createMtBotTool(prefTool, ctx))

  console.log('[registerNewsPreferenceTool] news_preference registered')
}
