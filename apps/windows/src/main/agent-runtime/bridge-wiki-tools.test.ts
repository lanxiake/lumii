/**
 * Wiki Agent 工具接线测试：真实内存 WikiRepo/WikiIngestHook + registerWikiTools，
 * 验证 4 个工具正确注册、agentId 解析、execute 结果结构。
 *
 * node:sqlite 内存库同 wiki-commands.test.ts 手法（createRequire 绕过 vite-node 解析）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import {
  WikiRepo,
  WikiIngestHook,
  type DatabaseAdapter,
  type PreparedStatement,
  type StatementResult,
  type ToolExecutionContext,
} from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../packages/agent-runtime/src/storage/schema'
import { registerWikiTools, type WikiToolsDeps } from './bridge-wiki-tools'

const nodeRequire = createRequire(import.meta.url)

interface DatabaseSyncLike {
  exec(sql: string): void
  prepare(sql: string): {
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint }
    get(...p: unknown[]): unknown
    all(...p: unknown[]): unknown[]
  }
  close(): void
}

function createMigratedDb(): DatabaseAdapter {
  const { DatabaseSync } = nodeRequire('node:sqlite') as {
    DatabaseSync: new (path: string) => DatabaseSyncLike
  }
  const sq = new DatabaseSync(':memory:')
  const db: DatabaseAdapter = {
    exec: (sql) => sq.exec(sql),
    prepare: <T = Record<string, unknown>>(sql: string): PreparedStatement<T> => {
      const stmt = sq.prepare(sql)
      return {
        run: (...p: unknown[]) => stmt.run(...p) as unknown as StatementResult,
        get: (...p: unknown[]) => stmt.get(...p) as T | undefined,
        all: (...p: unknown[]) => stmt.all(...p) as T[],
      }
    },
    close: () => sq.close(),
  }
  for (const [, sql] of MIGRATIONS) db.exec(sql)
  return db
}

function setup() {
  const repo = new WikiRepo(createMigratedDb())
  const hook = new WikiIngestHook(repo)
  const registry: { register: ReturnType<typeof mockRegister> } = { register: mockRegister() }
  const deps: WikiToolsDeps = {
    toolCallInstanceMap: new Map(),
    getCurrentToolExecutorInstanceId: () => 'instance-1',
    getDefinitionIdByInstanceId: () => 'assistant',
    getWikiRepo: () => repo,
    getWikiIngestHook: () => hook,
  }
  registerWikiTools(registry, {} as ToolExecutionContext, deps)
  return { repo, hook, registry }
}

function mockRegister() {
  const tools = new Map<string, ReturnType<typeof createTool>>()
  const fn = (tool: ReturnType<typeof createTool>) => tools.set(tool.name, tool)
  fn.tools = tools
  return fn
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createTool(): any { return {} }

async function callTool(registry: { register: ReturnType<typeof mockRegister> }, name: string, params: unknown) {
  const tool = registry.register.tools.get(name)
  if (!tool) throw new Error(`tool not registered: ${name}`)
  const result = await tool.execute('call-1', params)
  const text = result.content?.[0]?.text
  return text ? JSON.parse(text) : result
}

describe('registerWikiTools', () => {
  it('只注册 3 个只读工具（wiki_capture 已下线）', () => {
    const { registry } = setup()
    expect([...registry.register.tools.keys()].sort()).toEqual([
      'wiki_overview',
      'wiki_read',
      'wiki_search',
    ])
  })

  it('wiki_overview 返回分类统计与最近页面', async () => {
    const { repo, registry } = setup()
    repo.savePage({ agentId: 'assistant', userId: 'local-user', path: 'sources/a', title: 'A', contentMd: 'x', editor: 'ai' })

    const result = await callTool(registry, 'wiki_overview', {})
    expect(result.ok).toBe(true)
    expect(result.countsByCategory.sources).toBe(1)
    expect(result.recentPages).toEqual([{ path: 'sources/a', title: 'A' }])
  })

  it('wiki_search 返回命中全文', async () => {
    const { repo, registry } = setup()
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '架构设计文档', extractedText: '正文内容' })
    repo.indexSource(source.id)

    const result = await callTool(registry, 'wiki_search', { query: '架构设计' })
    expect(result.ok).toBe(true)
    expect(result.results).toHaveLength(1)
    expect(result.results[0].content).toBe('正文内容')
  })

  it('wiki_search 空查询报错', async () => {
    const { registry } = setup()
    const result = await callTool(registry, 'wiki_search', { query: '' })
    expect(result.ok).toBe(false)
  })

  it('wiki_read 读取存在的页面并更新 use_count', async () => {
    const { repo, registry } = setup()
    repo.savePage({ agentId: 'assistant', userId: 'local-user', path: 'sources/x', title: 'X', contentMd: '内容X', editor: 'ai' })

    const result = await callTool(registry, 'wiki_read', { path: 'sources/x' })
    expect(result.ok).toBe(true)
    expect(result.content).toBe('内容X')
    expect(repo.findPageByPath('assistant', 'local-user', 'sources/x')!.use_count).toBe(1)
  })

  it('wiki_read 页面不存在返回错误而非抛异常', async () => {
    const { registry } = setup()
    const result = await callTool(registry, 'wiki_read', { path: 'sources/missing' })
    expect(result.ok).toBe(false)
  })

  it('wiki_capture 不再注册，Agent 无法调用', () => {
    const { registry } = setup()
    expect(registry.register.tools.has('wiki_capture')).toBe(false)
  })
})
