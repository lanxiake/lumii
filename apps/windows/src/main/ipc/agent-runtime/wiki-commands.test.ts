/**
 * Wiki 命令处理器契约测试：真实内存 WikiRepo + mock bridge，验证字段映射与状态流转。
 *
 * node:sqlite 内存库 + 全量 MIGRATIONS（同 cron-e2e.test.ts 手法，用 createRequire
 * 绕过 vite-node 对 "node:sqlite" 的静态解析；better-sqlite3 原生绑定在本环境编译
 * 版本不匹配，不可用作回退）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WikiRepo, type DatabaseAdapter, type PreparedStatement, type StatementResult, WikiIngestHook, WikiOrganizer, WikiContentExtractor } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../../packages/agent-runtime/src/storage/schema'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import {
  handleWikiInboxList,
  handleWikiInboxCount,
  handleWikiInboxRetry,
  handleWikiInboxDiscard,
  handleWikiInboxOrganize,
  handleWikiFolderScan,
  handleWikiFolderImport,
  handleWikiSearch,
  handleWikiSourceGet,
  handleWikiRunsList,
  handleWikiIndexRebuild,
  handleWikiGraphData,
  handleWikiTopicTreeGet,
  handleWikiTopicTreeSet,
  handleWikiTopicMutate,
  handleWikiReclassifyRun,
  handleWikiReclassifyEstimate,
  handleWikiReclassifyGet,
  handleWikiReclassifyApply,
  handleWikiReclassifyDiscard,
  handleWikiSourceCreateNote,
  handleWikiSourceRename,
  handleWikiSourceList,
  handleWikiSourceUpdateTopic,
  handleWikiSourceMoveToParking,
  handleWikiSourceOpen,
  handleWikiCleanupScan,
  handleWikiEroExtract,
  handleWikiEroEntitySources,
  handleWikiVectorRebuild,
  handleWikiSourceSummary,
} from './wiki-commands'
import { DEFAULT_TOPIC_TREE, PARKING_CATEGORY, WikiReclassifier, WikiEroRepo } from '@mtbot/agent-runtime'
import { securityUtils } from '../../security-utils'

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

/** 内存库 + 全量迁移，等价于用户首启后的真实 schema */
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

function buildBridge(repo: WikiRepo, callLLM?: (prompt: string) => Promise<string>, cwd?: string): AgentRuntimeBridge {
  const hook = new WikiIngestHook(repo)
  const organizer = new WikiOrganizer(repo, callLLM ?? (async () => '{}'), new WikiContentExtractor())
  return {
    wikiRepo: repo,
    wikiIngestHook: hook,
    wikiOrganizer: organizer,
    // 重编目器的 LLM 用固定桩：不产候选，测的是命令编排而非模型行为
    wikiReclassifier: new WikiReclassifier(repo, async () => '[]'),
    conversationRepo: { getAgentParticipantId: () => null },
    getCwd: () => cwd ?? process.cwd(),
    callLLM: callLLM ?? (async () => '{}'),
    // 向量重建/摘要相关命令用：桩掉真实嵌入模型加载，embedder=null 走禁用路径
    resolveWikiEmbedder: async () => ({ embedder: null, backend: 'disabled', notice: null }),
  } as unknown as AgentRuntimeBridge
}

function createWikiRepo(): WikiRepo {
  return new WikiRepo(createMigratedDb())
}

describe('wiki commands', () => {
  it('inbox list/retry/discard/organize 全流程', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const item = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'a', contentPreview: '内容' })

    const listed = handleWikiInboxList(bridge, { type: 'wiki:inbox:list', agentId: 'assistant' }) as { id: string }[]
    expect(listed).toHaveLength(1)
    expect(listed[0]!.id).toBe(item.id)

    const organized = handleWikiInboxOrganize(bridge, {
      type: 'wiki:inbox:organize',
      inboxId: item.id,
      category: '工作',
      subtopic: '项目',
      title: '标题A',
    })
    expect(organized.category).toBe('工作')
    expect(organized.subtopic).toBe('项目')
    expect(repo.findInboxById(item.id)!.status).toBe('organized')

    const item2 = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'b' })
    expect(handleWikiInboxDiscard(bridge, { type: 'wiki:inbox:discard', inboxId: item2.id })).toEqual({ success: true })
    expect(repo.findInboxById(item2.id)!.status).toBe('discarded')

    const item3 = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'c' })
    repo.markInboxAttemptFailed(item3.id, 'boom')
    expect(handleWikiInboxRetry(bridge, { type: 'wiki:inbox:retry', inboxId: item3.id })).toEqual({ success: true })
    expect(repo.findInboxById(item3.id)!.attempt_count).toBe(0)
  })

  it('inbox count 按 status 计数，pending 不含已归档条目', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'p1' })
    repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'p2' })
    const organized = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'o1' })
    repo.markInboxOrganized(organized.id, 'src1')

    expect(handleWikiInboxCount(bridge, { type: 'wiki:inbox:count', agentId: 'assistant', status: 'pending' }).total).toBe(2)
  })

  it('retry / discard 对不存在的 id 抛错，不静默返回 success', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    expect(() => handleWikiInboxRetry(bridge, { type: 'wiki:inbox:retry', inboxId: 'ghost' })).toThrow(
      /不存在/,
    )
    expect(() => handleWikiInboxDiscard(bridge, { type: 'wiki:inbox:discard', inboxId: 'ghost' })).toThrow(
      /不存在/,
    )
  })

  it('retry 已丢弃条目时抛错说明状态，不复活也不谎报成功', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const item = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'a' })
    handleWikiInboxDiscard(bridge, { type: 'wiki:inbox:discard', inboxId: item.id })

    expect(() => handleWikiInboxRetry(bridge, { type: 'wiki:inbox:retry', inboxId: item.id })).toThrow(
      /discarded/,
    )
    expect(repo.findInboxById(item.id)!.status).toBe('discarded')
  })

  it('越权分类（不在主题树内）在 organize 时抛错', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const item = repo.ingestToInbox({ agentId: 'assistant', userId: 'local-user', itemType: 'upload', title: 'a' })
    expect(() =>
      handleWikiInboxOrganize(bridge, {
        type: 'wiki:inbox:organize',
        inboxId: item.id,
        category: '不存在的大类',
        subtopic: 'x',
      }),
    ).toThrow()
  })

  it('search 命中资料层（原文件）而非旧汇总页', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '架构设计文档',
      extractedText: '这是一份关于系统架构设计的说明',
    })
    repo.indexSource(source.id)

    const r = (await handleWikiSearch(bridge, {
      type: 'wiki:search',
      agentId: 'assistant',
      keyword: '架构设计',
    })) as { hits: { sourceId: string; title: string }[]; mode: string }
    expect(r.hits).toHaveLength(1)
    expect(r.hits[0]!.sourceId).toBe(source.id)
    expect(r.hits[0]!.title).toBe('架构设计文档')
  })

  it('search 在无 FTS 命中触发向量兜底时不应召回已归档资料', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '架构设计文档',
      extractedText: '这是一份关于系统架构设计的说明',
    })
    repo.indexSource(source.id)
    repo.archiveSources('assistant', 'local-user', [source.id])

    const r = (await handleWikiSearch(bridge, {
      type: 'wiki:search',
      agentId: 'assistant',
      keyword: '架构设计',
    })) as { hits: { sourceId: string }[] }
    expect(r.hits.find((h) => h.sourceId === source.id)).toBeUndefined()
  })

  it('source:get 存在与不存在两种情况', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '资料A' })

    const got = handleWikiSourceGet(bridge, { type: 'wiki:source:get', sourceId: source.id }) as { title: string }
    expect(got.title).toBe('资料A')
    expect(handleWikiSourceGet(bridge, { type: 'wiki:source:get', sourceId: 'missing' })).toBeNull()
  })

  it('runs:list 与 index:rebuild', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const run = repo.createRun('assistant', 'local-user', ['i1'])
    const detail = JSON.stringify({
      items: [{ inboxId: 'i1', title: 'T', path: 'sources/t', mediaType: 'document', outcome: 'archived', extract: 'preview' }],
    })
    repo.finishRun(run.id, 'succeeded', '1 项已归档', undefined, detail)

    const runs = handleWikiRunsList(bridge, { type: 'wiki:runs:list', agentId: 'assistant' }) as {
      status: string
      resultDetail: { items: { path: string }[] } | null
    }[]
    expect(runs[0]!.status).toBe('succeeded')
    expect(runs[0]!.resultDetail?.items[0]!.path).toBe('sources/t')

    repo.createSource({ agentId: 'assistant', userId: 'local-user', title: 'y', extractedText: 'c' })
    expect(handleWikiIndexRebuild(bridge)).toEqual({ rebuiltCount: 1 })
  })

  it('graph:data 按小类返回结构子图', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    repo.getOrCreateTopicTree()
    const s1 = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '调研A.pdf' })
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习', '在学')

    const graph = handleWikiGraphData(bridge, {
      type: 'wiki:graph:data',
      agentId: 'assistant',
      category: '学习',
      subtopic: '在学',
      layers: ['structure'],
    }) as { nodes: { kind: string }[]; edges: unknown[]; truncated: boolean }

    expect(graph.nodes.some((n) => n.kind === 'category')).toBe(true)
    expect(graph.nodes.some((n) => n.kind === 'subtopic')).toBe(true)
    expect(graph.nodes.some((n) => n.kind === 'source')).toBe(true)
  })

  it('graph:data 无中心参数时缺省到主题树第一个大类', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const tree = repo.getOrCreateTopicTree()
    const firstCategory = tree.categories[0]!.name

    const graph = handleWikiGraphData(bridge, {
      type: 'wiki:graph:data',
      agentId: 'assistant',
    }) as { nodes: { kind: string; title: string; id: string }[] }

    expect(graph.nodes.some((n) => n.kind === 'category' && n.title === firstCategory)).toBe(true)
  })

  it('ero:extract 默认按小类抽取资料并返回统计', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(
      repo,
      async () =>
        JSON.stringify({
          entities: [{ name: 'Lumii', type: 'project' }],
          relations: [],
          observations: [],
        }),
    )
    const s1 = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '调研A.pdf',
      extractedText: 'Lumii 是本地优先应用',
      contentHash: 'hash-1',
    })
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习', '在学')

    const result = (await handleWikiEroExtract(bridge, {
      type: 'wiki:ero:extract',
      agentId: 'assistant',
      category: '学习',
      subtopic: '在学',
    })) as {
      sourcesScanned: number
      sourcesFailed: number
      entitiesUpserted: number
      errors: readonly unknown[]
    }

    expect(result.sourcesScanned).toBe(1)
    expect(result.sourcesFailed).toBe(0)
    expect(result.entitiesUpserted).toBeGreaterThan(0)
    expect(result.errors).toHaveLength(0)
  })

  it('ero:entity-sources 返回该实体出现的资料及其主题', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const ero = new WikiEroRepo(repo.database)
    const s1 = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '调研A.pdf' })
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习', '在学')
    const entity = ero.upsertEntity({
      agentId: 'assistant',
      userId: 'local-user',
      name: 'Lumii',
      entityType: 'project',
      sourceId: s1.id,
    })

    const result = handleWikiEroEntitySources(bridge, {
      type: 'wiki:ero:entity-sources',
      agentId: 'assistant',
      entityId: entity.id,
    }) as { sources: { id: string; topicCategory: string | null; topicSubtopic: string | null }[] }

    expect(result.sources).toHaveLength(1)
    expect(result.sources[0]!.id).toBe(s1.id)
    expect(result.sources[0]!.topicCategory).toBe('学习')
    expect(result.sources[0]!.topicSubtopic).toBe('在学')
  })

  it('runs:list 对无效 result_detail 形状返回 resultDetail null', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    const invalidCases = [
      'not-json',
      JSON.stringify(null),
      JSON.stringify({}),
      JSON.stringify({ items: 'not-array' }),
      JSON.stringify({ items: null }),
    ]

    for (const [i, detail] of invalidCases.entries()) {
      const run = repo.createRun('assistant', 'local-user', [`inv-${i}`])
      repo.finishRun(run.id, 'succeeded', 'ok', undefined, detail)
    }

    const runs = handleWikiRunsList(bridge, { type: 'wiki:runs:list', agentId: 'assistant' }) as {
      resultDetail: unknown
    }[]
    expect(runs).toHaveLength(invalidCases.length)
    for (const run of runs) {
      expect(run.resultDetail).toBeNull()
    }
  })

  it('topic:tree:get 首次读取时返回默认树，set 后可覆盖', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    const got = handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' })
    expect(got.tree).toEqual(DEFAULT_TOPIC_TREE)

    const customTree = { version: 2 as const, categories: [{ name: '自定义大类', subtopics: ['自定义小类'] }] }
    expect(
      handleWikiTopicTreeSet(bridge, { type: 'wiki:topic:tree:set', agentId: 'assistant', tree: customTree }),
    ).toEqual({ success: true })
    expect(handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' }).tree).toEqual(
      customTree,
    )
  })

  it('topic:tree:get 遇到 v1 树时自动迁到 v2，并保留用户自建大类', () => {
    const repo = createWikiRepo()
    repo.setIndexMeta(
      'topic_categories',
      JSON.stringify({
        version: 1,
        categories: [
          { name: '做事记录', subtopics: ['会议聊天记录'] },
          { name: '自定义大类', subtopics: ['自定义小类'] },
        ],
      }),
    )
    const bridge = buildBridge(repo)

    const got = handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' })
    expect(got.tree.version).toBe(2)
    expect(got.tree.categories.map((c) => c.name)).toEqual(['工作', '学习', '生活', '收藏', '自定义大类'])
    expect(got.tree.categories.find((c) => c.name === '自定义大类')?.subtopics).toEqual(['自定义小类'])
  })

  it('topic:mutate 加小类后 tree:get 能读到', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    const r = handleWikiTopicMutate(bridge, {
      type: 'wiki:topic:mutate',
      agentId: 'assistant',
      mutation: { op: 'addSubtopic', category: '学习', name: '行业报告归档' },
    })
    expect(r.movedCount).toBe(0)

    const got = handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' })
    const learning = got.tree.categories.find((c) => c.name === '学习')!
    expect(learning.subtopics).toContain('行业报告归档')
  })

  it('topic:mutate 删有文件的小类时返回中文错误', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '纪要.md' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '工作', '例行')

    expect(() =>
      handleWikiTopicMutate(bridge, {
        type: 'wiki:topic:mutate',
        agentId: 'assistant',
        mutation: { op: 'deleteSubtopic', category: '工作', name: '例行' },
      }),
    ).toThrow(/请先选择去向/)
  })

  it('topic:mutate 改名时文件跟着走', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '周报.docx' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '工作', '对外')

    const r = handleWikiTopicMutate(bridge, {
      type: 'wiki:topic:mutate',
      agentId: 'assistant',
      mutation: { op: 'renameCategory', from: '工作', to: '工作产出' },
    })
    expect(r.movedCount).toBe(1)
    expect(repo.findSourceById(source.id)!.topic_category).toBe('工作产出')
  })

  it('create-note 写磁盘 md 并插入带主题的 source', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))

    const r = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '生活', subtopic: '自留' } as never,
      { notesDir: () => notesDir },
    )

    // sourcePath 落库时是相对 vault 根的相对路径，落盘位置需要拼回 notesDir 才是绝对路径
    const absPath = path.resolve(notesDir, r.sourcePath)
    expect(fs.existsSync(absPath)).toBe(true)
    expect(fs.readFileSync(absPath, 'utf8')).toContain('# 未命名笔记')
    const s = repo.findSourceById(r.sourceId)!
    expect(s.topic_category).toBe('生活')
    expect(s.topic_subtopic).toBe('自留')
    expect(s.mime_type).toBe('text/markdown')
  })

  it('小类名含斜杠时不会落进路径，目录名被安全化', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))

    // v2 默认树的小类名不含斜杠；用户仍可自建含 `/` 的小类，这里显式建一个来验证 sanitize
    repo.setTopicTree({ version: 2, categories: [{ name: '工作', subtopics: ['项目/任务资料'] }] })

    const r = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '工作', subtopic: '项目/任务资料' } as never,
      { notesDir: () => notesDir },
    )
    expect(r.sourcePath).not.toContain('项目/任务资料')
    expect(r.sourcePath).not.toContain('项目\\任务资料')
    expect(fs.existsSync(path.resolve(notesDir, r.sourcePath))).toBe(true)
    expect(repo.findSourceById(r.sourceId)!.topic_subtopic).toBe('项目/任务资料')
  })

  it('拒绝在临时存放或不存在的目录建笔记', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))

    expect(() =>
      handleWikiSourceCreateNote(
        bridge,
        { type: 'wiki:source:create-note', agentId: 'assistant', category: PARKING_CATEGORY, subtopic: null } as never,
        { notesDir: () => notesDir },
      ),
    ).toThrow()

    expect(() =>
      handleWikiSourceCreateNote(
        bridge,
        { type: 'wiki:source:create-note', agentId: 'assistant', category: '学习', subtopic: '不存在的小类' } as never,
        { notesDir: () => notesDir },
      ),
    ).toThrow(/小类不存在/)
  })

  it('同名笔记连建两次不互相覆盖', () => {
    const bridge = buildBridge(createWikiRepo())
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))
    const cmd = {
      type: 'wiki:source:create-note',
      agentId: 'assistant',
      category: '生活',
      subtopic: '自留',
      title: '灵感',
    } as never
    const fixedNow = () => new Date('2026-08-27T10:30:00')

    const a = handleWikiSourceCreateNote(bridge, cmd, { notesDir: () => notesDir, now: fixedNow })
    const b = handleWikiSourceCreateNote(bridge, cmd, { notesDir: () => notesDir, now: fixedNow })
    expect(a.sourcePath).not.toBe(b.sourcePath)
    expect(fs.existsSync(path.resolve(notesDir, a.sourcePath))).toBe(true)
    expect(fs.existsSync(path.resolve(notesDir, b.sourcePath))).toBe(true)
  })

  it('rename native 资料时磁盘文件名跟随改，目录不变', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))
    const created = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '生活', subtopic: '自留' } as never,
      { notesDir: () => notesDir },
    )

    const renamed = handleWikiSourceRename(
      bridge,
      {
        type: 'wiki:source:rename',
        agentId: 'assistant',
        sourceId: created.sourceId,
        title: '周末灵感',
      } as never,
      { workspaceRoot: notesDir },
    )
    expect(renamed.title).toBe('周末灵感')
    const after = repo.findSourceById(created.sourceId)!
    expect(after.source_path).not.toBe(created.sourcePath)
    expect(path.basename(after.source_path!)).toBe('周末灵感.md')
    expect(path.dirname(after.source_path!)).toBe(path.dirname(path.resolve(notesDir, created.sourcePath)))
    expect(fs.existsSync(after.source_path!)).toBe(true)
  })

  it('rename ref 资料时不动用户原文件', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '合同',
      sourcePath: '/outside/合同.pdf',
      storageMode: 'ref',
    })

    const renamed = handleWikiSourceRename(bridge, {
      type: 'wiki:source:rename',
      agentId: 'assistant',
      sourceId: source.id,
      title: '2026年合同',
    } as never)
    expect(renamed.title).toBe('2026年合同')
    expect(repo.findSourceById(source.id)!.source_path).toBe('/outside/合同.pdf')
  })

  it('reclassify:run 的 scope 与参数不匹配时抛中文错误', async () => {
    const bridge = buildBridge(createWikiRepo())

    await expect(
      handleWikiReclassifyRun(bridge, {
        type: 'wiki:reclassify:run',
        agentId: 'assistant',
        scope: 'subtopic',
      } as never),
    ).rejects.toThrow(/大类/)

    await expect(
      handleWikiReclassifyRun(bridge, {
        type: 'wiki:reclassify:run',
        agentId: 'assistant',
        scope: 'source',
      } as never),
    ).rejects.toThrow(/sourceId/)
  })

  it('reclassify:run 后 get 返回批次，discard 后清空', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '白皮书' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '工作', '项目')

    const r = await handleWikiReclassifyRun(bridge, {
      type: 'wiki:reclassify:run',
      agentId: 'assistant',
      scope: 'all',
    } as never)
    expect(r.runId).toBeTruthy()

    const got = handleWikiReclassifyGet(bridge, {
      type: 'wiki:reclassify:get',
      agentId: 'assistant',
    } as never)
    expect((got.run as { status: string }).status).toBe('review')

    handleWikiReclassifyDiscard(bridge, { type: 'wiki:reclassify:discard', agentId: 'assistant' } as never)
    expect(
      handleWikiReclassifyGet(bridge, { type: 'wiki:reclassify:get', agentId: 'assistant' } as never).run,
    ).toBeNull()
  })

  it('reclassify:apply 空数组返回全 0', () => {
    const bridge = buildBridge(createWikiRepo())
    expect(
      handleWikiReclassifyApply(bridge, {
        type: 'wiki:reclassify:apply',
        agentId: 'assistant',
        candidateIds: [],
      } as never),
    ).toEqual({ applied: 0, failed: 0 })
  })

  it('reclassify:estimate 按批大小估算调用数', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    for (let i = 0; i < 3; i++) {
      const s = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: `文档${i}` })
      repo.updateSourceTopic('assistant', 'local-user', s.id, '工作', '项目')
    }

    const est = handleWikiReclassifyEstimate(bridge, {
      type: 'wiki:reclassify:estimate',
      agentId: 'assistant',
      scope: 'all',
    } as never)
    expect(est.fileCount).toBe(3)
    expect(est.structureCalls).toBe(1)
    expect(est.note).toContain('3')
  })

  it('source:list 按大类/小类过滤，update-topic 写入后可被列出', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '合同' })

    handleWikiSourceUpdateTopic(bridge, {
      type: 'wiki:source:update-topic',
      agentId: 'assistant',
      sourceId: source.id,
      category: '生活',
      subtopic: '凭据',
    })

    const list = handleWikiSourceList(bridge, {
      type: 'wiki:source:list',
      agentId: 'assistant',
      category: '生活',
      subtopic: '凭据',
    })
    expect(list.sources).toHaveLength(1)
    expect((list.sources[0] as { id: string }).id).toBe(source.id)
  })

  it('source:move-to-parking 写入临时存放，subtopic 为 null', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: 'x' })

    const moved = handleWikiSourceMoveToParking(bridge, {
      type: 'wiki:source:move-to-parking',
      agentId: 'assistant',
      sourceId: source.id,
    })
    expect(moved.topicCategory).toBe(PARKING_CATEGORY)
    expect(moved.topicSubtopic).toBeNull()
  })

  it('source:open 对缺失原文件路径的资料抛错，不静默返回 success', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: 'x' })

    await expect(
      handleWikiSourceOpen(bridge, { type: 'wiki:source:open', agentId: 'assistant', sourceId: source.id }),
    ).rejects.toThrow(/无法打开原文件/)
  })

  it('source:open 对不存在的资料抛错', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    await expect(
      handleWikiSourceOpen(bridge, { type: 'wiki:source:open', agentId: 'assistant', sourceId: 'missing' }),
    ).rejects.toThrow(/资料不存在/)
  })

  it('cleanup:scan 带出两列主题供只读展示', () => {
    const repo = createWikiRepo()
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '会议纪要' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '工作', '例行')
    const updated = repo.findSourceById(source.id)
    const bridge = {
      ...buildBridge(repo),
      wikiCleanupScanner: { scan: () => [{ source: updated, reason: 'stale' as const }] },
      fileExistsForWiki: () => true,
    } as unknown as AgentRuntimeBridge

    const rows = handleWikiCleanupScan(bridge, { type: 'wiki:cleanup:scan' }) as ReadonlyArray<{
      topicCategory: string | null
      topicSubtopic: string | null
    }>

    expect(rows[0]?.topicCategory).toBe('工作')
    expect(rows[0]?.topicSubtopic).toBe('例行')
  })

  it('folder scan/import 批量摄入收件箱', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-cmd-folder-'))
    const outputs = path.join(root, 'outputs')
    fs.mkdirSync(outputs, { recursive: true })
    fs.writeFileSync(path.join(outputs, 'note.md'), '# note', 'utf8')
    securityUtils.addAllowedBasePath(root)

    const repo = createWikiRepo()
    const bridge = buildBridge(repo, undefined, root)

    const scan = handleWikiFolderScan(bridge, {
      type: 'wiki:folder:scan',
      agentId: 'assistant',
      dir: outputs,
    }) as { summary: { importable: number } }
    expect(scan.summary.importable).toBe(1)

    const imported = await handleWikiFolderImport(bridge, {
      type: 'wiki:folder:import',
      agentId: 'assistant',
      dir: outputs,
      autoClassify: false,
    }) as { imported: number; inboxIds: string[]; organizeRun?: { summary: string | null } }
    expect(imported.imported).toBe(1)
    expect(imported.inboxIds).toHaveLength(1)
    expect(imported.organizeRun?.summary).toContain('未分类')
    expect(repo.listSourcesByTopic('assistant', 'local-user', { unfiled: true })).toHaveLength(1)

    fs.rmSync(root, { recursive: true, force: true })
  })

  it('vector:rebuild 先补零成本摘要再重建向量，返回 summarized 计数', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const s = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '周报',
      extractedText: '本周完成了登录改造。',
      contentHash: 'h1',
    })
    expect(repo.findSourceById(s.id)!.summary).toBeNull()

    const result = await handleWikiVectorRebuild(bridge, {
      type: 'wiki:vector:rebuild',
      agentId: 'assistant',
    })
    expect(result.summarized).toBe(1)
    expect(repo.findSourceById(s.id)!.summary).toBe('本周完成了登录改造。')
  })

  it('vector:rebuild 第二次跑摘要已缓存，summarized 计数不再增加内容变化', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '周报',
      extractedText: '本周完成了登录改造。',
      contentHash: 'h1',
    })

    const first = await handleWikiVectorRebuild(bridge, { type: 'wiki:vector:rebuild', agentId: 'assistant' })
    const second = await handleWikiVectorRebuild(bridge, { type: 'wiki:vector:rebuild', agentId: 'assistant' })
    expect(first.summarized).toBe(1)
    expect(second.summarized).toBe(1)
  })

  it('source:summary allowLlm=false 时只走零成本层，不调 LLM', async () => {
    const repo = createWikiRepo()
    const callLLM = async () => {
      throw new Error('不应调用 LLM')
    }
    const bridge = buildBridge(repo, callLLM)
    const s = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '周报',
      extractedText: '本周完成了登录改造。',
      contentHash: 'h1',
    })

    const result = await handleWikiSourceSummary(bridge, {
      type: 'wiki:source:summary',
      agentId: 'assistant',
      sourceId: s.id,
    })
    expect(result.level).toBe('heuristic')
    expect(result.summary).toBe('本周完成了登录改造。')
  })

  it('source:summary 资料不存在时抛错', async () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    await expect(
      handleWikiSourceSummary(bridge, { type: 'wiki:source:summary', agentId: 'assistant', sourceId: 'missing' }),
    ).rejects.toThrow(/资料不存在/)
  })
})
