/**
 * 解析用户粘贴的 MCP 配置 JSON
 *
 * 兼容社区里常见的几种写法，用户从任何 MCP 文档复制过来都能直接用：
 *   1. { "mcpServers": { "name": { "command": "npx", "args": [...] } } }   ← 标准
 *   2. { "name": { "command": "npx" } }                                    ← 裸对象
 *   3. { "name": "x", "command": "npx" }                                   ← 单条带 name
 *   4. [ { "name": "x", "command": "npx" }, ... ]                          ← 数组
 */

import type { McpServerConfigInput } from '@shared/agent-runtime-commands'

export type ParseResult =
  | { readonly ok: true; readonly entries: readonly McpServerConfigInput[] }
  | { readonly ok: false; readonly error: string }

type RawRecord = Record<string, unknown>

/** 从一个对象读出 command/args/env/cwd/enabled，name 由外层给定 */
function toEntry(name: string, raw: RawRecord): McpServerConfigInput | string {
  const command = raw.command
  if (typeof command !== 'string' || !command.trim()) {
    return `「${name}」缺少 command 字段`
  }

  const args = raw.args
  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== 'string'))) {
    return `「${name}」的 args 必须是字符串数组`
  }

  const env = raw.env
  if (env !== undefined && (typeof env !== 'object' || env === null || Array.isArray(env))) {
    return `「${name}」的 env 必须是对象`
  }

  return {
    name,
    command: command.trim(),
    ...(args ? { args: args as string[] } : {}),
    ...(env ? { env: env as Record<string, string> } : {}),
    ...(typeof raw.cwd === 'string' ? { cwd: raw.cwd } : {}),
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
  }
}

/** 把 { name: {...} } 形状的对象展开成条目数组 */
function fromMap(map: RawRecord): ParseResult {
  const entries: McpServerConfigInput[] = []
  for (const [name, value] of Object.entries(map)) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return { ok: false, error: `「${name}」的值必须是对象` }
    }
    const entry = toEntry(name, value as RawRecord)
    if (typeof entry === 'string') return { ok: false, error: entry }
    entries.push(entry)
  }
  return { ok: true, entries }
}

export function parseMcpJson(text: string): ParseResult {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: '内容为空' }

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (e) {
    return { ok: false, error: `JSON 格式错误：${(e as Error).message}` }
  }

  // 形式 4：数组
  if (Array.isArray(parsed)) {
    const entries: McpServerConfigInput[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) return { ok: false, error: '数组元素必须是对象' }
      const raw = item as RawRecord
      if (typeof raw.name !== 'string' || !raw.name.trim()) return { ok: false, error: '数组元素缺少 name 字段' }
      const entry = toEntry(raw.name.trim(), raw)
      if (typeof entry === 'string') return { ok: false, error: entry }
      entries.push(entry)
    }
    return entries.length ? { ok: true, entries } : { ok: false, error: '没有可导入的配置' }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: '顶层必须是对象或数组' }
  }

  const root = parsed as RawRecord

  // 形式 1：标准 mcpServers 包裹
  const wrapped = root.mcpServers ?? root.servers
  if (wrapped !== undefined) {
    if (Array.isArray(wrapped)) return parseMcpJson(JSON.stringify(wrapped))
    if (typeof wrapped !== 'object' || wrapped === null) {
      return { ok: false, error: 'mcpServers 必须是对象或数组' }
    }
    const result = fromMap(wrapped as RawRecord)
    return result.ok && result.entries.length === 0 ? { ok: false, error: '没有可导入的配置' } : result
  }

  // 形式 3：单条带 name（有 command 说明这层就是配置本体）
  if (typeof root.command === 'string') {
    const name = typeof root.name === 'string' ? root.name.trim() : ''
    if (!name) return { ok: false, error: '缺少 name 字段' }
    const entry = toEntry(name, root)
    return typeof entry === 'string' ? { ok: false, error: entry } : { ok: true, entries: [entry] }
  }

  // 形式 2：裸 { name: {...} }
  const result = fromMap(root)
  return result.ok && result.entries.length === 0 ? { ok: false, error: '没有可导入的配置' } : result
}
