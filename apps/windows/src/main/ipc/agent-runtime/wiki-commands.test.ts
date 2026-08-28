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
import { WikiRepo, type DatabaseAdapter, type PreparedStatement, type StatementResult } from '@mtbot/agent-runtime'
import { MIGRATIONS } from '../../../../../../packages/agent-runtime/src/storage/schema'
import type { AgentRuntimeBridge } from '../../agent-runtime/bridge'
import {
  handleWikiInboxList,
  handleWikiInboxCount,
  handleWikiInboxRetry,
  handleWikiInboxDiscard,
  handleWikiInboxOrganize,
  handleWikiPageList,
  handleWikiPageGet,
  handleWikiPageUpdate,
  handleWikiPageDelete,
  handleWikiSearch,
  handleWikiSourceGet,
  handleWikiRunsList,
  handleWikiIndexRebuild,
  handleWikiGraphData,
  handleWikiTopicTreeGet,
  handleWikiTopicTreeSet,
  handleWikiTopicMutate,
  handleWikiReclassifyRun,
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
} from './wiki-commands'
import { DEFAULT_TOPIC_TREE, PARKING_CATEGORY, WikiReclassifier, WikiEroRepo } from '@mtbot/agent-runtime'

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

function buildBridge(repo: WikiRepo, callLLM?: (prompt: string) => Promise<string>): AgentRuntimeBridge {
  return {
    wikiRepo: repo,
    // 重编目器的 LLM 用固定桩：不产候选，测的是命令编排而非模型行为
    wikiReclassifier: new WikiReclassifier(repo, async () => '[]'),
    conversationRepo: { getAgentParticipantId: () => null },
    getCwd: () => process.cwd(),
    callLLM: callLLM ?? (async () => '{}'),
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
      category: '做事记录',
      subtopic: '项目/任务资料',
      title: '标题A',
    })
    expect(organized.category).toBe('做事记录')
    expect(organized.subtopic).toBe('项目/任务资料')
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

  it('page list/get/update/delete 全流程', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    const updated = handleWikiPageUpdate(bridge, {
      type: 'wiki:page:update',
      agentId: 'assistant',
      path: 'sources/doc',
      title: '文档',
      contentMd: '正文',
    })
    expect(updated.version).toBe(1)

    const list = handleWikiPageList(bridge, { type: 'wiki:page:list', agentId: 'assistant' }) as { id: string }[]
    expect(list).toHaveLength(1)

    const got = handleWikiPageGet(bridge, { type: 'wiki:page:get', pageId: updated.pageId }) as { contentMd: string }
    expect(got.contentMd).toBe('正文')

    expect(handleWikiPageDelete(bridge, { type: 'wiki:page:delete', pageId: updated.pageId })).toEqual({ success: true })
    // 删除后读取要报错而非返回 null——null 在 CLI 里是 exit 0，分不清不存在与空页
    expect(() => handleWikiPageGet(bridge, { type: 'wiki:page:get', pageId: updated.pageId })).toThrow(
      /页面不存在/,
    )
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

    repo.savePage({ agentId: 'assistant', userId: 'local-user', path: 'sources/y', title: 'y', contentMd: 'c', editor: 'ai' })
    expect(handleWikiIndexRebuild(bridge)).toEqual({ rebuiltCount: 1 })
  })

  it('graph:data centerPageId 走历史层，不再自动 bootstrap ERO', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const ero = new WikiEroRepo(repo.database)

    const b = repo.savePage({
      agentId: 'assistant',
      userId: 'local-user',
      path: 'sources/b',
      title: 'B页',
      contentMd: '正文',
      editor: 'user',
    })
    const a = repo.savePage({
      agentId: 'assistant',
      userId: 'local-user',
      path: 'sources/a',
      title: 'A页',
      contentMd: '见 [[B页]]',
      editor: 'user',
    })

    const graph = handleWikiGraphData(bridge, {
      type: 'wiki:graph:data',
      agentId: 'assistant',
      centerPageId: a.id,
    }) as {
      nodes: { id: string; kind: string; title: string }[]
      edges: { id: string; kind: string; source: string; target: string; label: string }[]
      truncated: boolean
    }

    expect(graph.nodes.some((n) => n.kind === 'page' && n.id === a.id)).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'wikilink')).toBe(true)
    expect(typeof graph.truncated).toBe('boolean')
    expect(ero.listEntities('assistant', 'local-user').length).toBe(0)
  })

  it('graph:data 按小类返回结构子图', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    repo.getOrCreateTopicTree()
    const s1 = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '调研A.pdf' })
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习资料', '调研搜集材料')

    const graph = handleWikiGraphData(bridge, {
      type: 'wiki:graph:data',
      agentId: 'assistant',
      category: '学习资料',
      subtopic: '调研搜集材料',
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
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习资料', '调研搜集材料')

    const result = (await handleWikiEroExtract(bridge, {
      type: 'wiki:ero:extract',
      agentId: 'assistant',
      category: '学习资料',
      subtopic: '调研搜集材料',
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
    repo.updateSourceTopic('assistant', 'local-user', s1.id, '学习资料', '调研搜集材料')
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
    expect(result.sources[0]!.topicCategory).toBe('学习资料')
    expect(result.sources[0]!.topicSubtopic).toBe('调研搜集材料')
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

    const customTree = { version: 1 as const, categories: [{ name: '做事记录', subtopics: ['会议聊天记录'] }] }
    expect(
      handleWikiTopicTreeSet(bridge, { type: 'wiki:topic:tree:set', agentId: 'assistant', tree: customTree }),
    ).toEqual({ success: true })
    expect(handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' }).tree).toEqual(
      customTree,
    )
  })

  it('topic:mutate 加小类后 tree:get 能读到', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)

    const r = handleWikiTopicMutate(bridge, {
      type: 'wiki:topic:mutate',
      agentId: 'assistant',
      mutation: { op: 'addSubtopic', category: '学习资料', name: '行业报告归档' },
    })
    expect(r.movedCount).toBe(0)

    const got = handleWikiTopicTreeGet(bridge, { type: 'wiki:topic:tree:get', agentId: 'assistant' })
    const learning = got.tree.categories.find((c) => c.name === '学习资料')!
    expect(learning.subtopics).toContain('行业报告归档')
  })

  it('topic:mutate 删有文件的小类时返回中文错误', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '纪要.md' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '做事记录', '会议聊天记录')

    expect(() =>
      handleWikiTopicMutate(bridge, {
        type: 'wiki:topic:mutate',
        agentId: 'assistant',
        mutation: { op: 'deleteSubtopic', category: '做事记录', name: '会议聊天记录' },
      }),
    ).toThrow(/请先选择去向/)
  })

  it('topic:mutate 改名时文件跟着走', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '周报.docx' })
    repo.updateSourceTopic('assistant', 'local-user', source.id, '做事记录', '汇报总结文稿')

    const r = handleWikiTopicMutate(bridge, {
      type: 'wiki:topic:mutate',
      agentId: 'assistant',
      mutation: { op: 'renameCategory', from: '做事记录', to: '工作产出' },
    })
    expect(r.movedCount).toBe(1)
    expect(repo.findSourceById(source.id)!.topic_category).toBe('工作产出')
  })

  it('create-note 写磁盘 md 并插入带主题的 source，不新建 wiki_pages', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))
    const pagesBefore = repo.listPages('assistant', 'local-user').length

    const r = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '随笔创作', subtopic: '灵感随手记录' } as never,
      { notesDir: () => notesDir },
    )

    expect(fs.existsSync(r.sourcePath)).toBe(true)
    expect(fs.readFileSync(r.sourcePath, 'utf8')).toContain('# 未命名笔记')
    const s = repo.findSourceById(r.sourceId)!
    expect(s.topic_category).toBe('随笔创作')
    expect(s.topic_subtopic).toBe('灵感随手记录')
    expect(s.mime_type).toBe('text/markdown')
    expect(repo.listPages('assistant', 'local-user')).toHaveLength(pagesBefore)
  })

  it('小类名含斜杠时不会落进路径，目录名被安全化', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))

    const r = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '做事记录', subtopic: '项目/任务资料' } as never,
      { notesDir: () => notesDir },
    )
    expect(r.sourcePath).not.toContain('项目/任务资料')
    expect(r.sourcePath).not.toContain('项目\\任务资料')
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
        { type: 'wiki:source:create-note', agentId: 'assistant', category: '学习资料', subtopic: '不存在的小类' } as never,
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
      category: '随笔创作',
      subtopic: '灵感随手记录',
      title: '灵感',
    } as never
    const fixedNow = () => new Date('2026-08-27T10:30:00')

    const a = handleWikiSourceCreateNote(bridge, cmd, { notesDir: () => notesDir, now: fixedNow })
    const b = handleWikiSourceCreateNote(bridge, cmd, { notesDir: () => notesDir, now: fixedNow })
    expect(a.sourcePath).not.toBe(b.sourcePath)
    expect(fs.existsSync(a.sourcePath)).toBe(true)
    expect(fs.existsSync(b.sourcePath)).toBe(true)
  })

  it('rename 只改标题，磁盘路径不动', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const notesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wiki-notes-'))
    const created = handleWikiSourceCreateNote(
      bridge,
      { type: 'wiki:source:create-note', agentId: 'assistant', category: '随笔创作', subtopic: '灵感随手记录' } as never,
      { notesDir: () => notesDir },
    )

    const renamed = handleWikiSourceRename(bridge, {
      type: 'wiki:source:rename',
      agentId: 'assistant',
      sourceId: created.sourceId,
      title: '周末灵感',
    } as never)
    expect(renamed.title).toBe('周末灵感')
    expect(repo.findSourceById(created.sourceId)!.source_path).toBe(created.sourcePath)
  })

  it('reclassify:run 的 scope 与参数不匹配时抛中文错误', async () => {
    const bridge = buildBridge(createWikiRepo())

    await expect(
      handleWikiReclassifyRun(bridge, {
        type: 'wiki:reclassify:run',
        agentId: 'assistant',
        scope: 'subtopic',
      } as never),
    ).rejects.toThrow(/大类与小类/)

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
    repo.updateSourceTopic('assistant', 'local-user', source.id, '做事记录', '项目/任务资料')

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

  it('source:list 按大类/小类过滤，update-topic 写入后可被列出', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({ agentId: 'assistant', userId: 'local-user', title: '合同' })

    handleWikiSourceUpdateTopic(bridge, {
      type: 'wiki:source:update-topic',
      agentId: 'assistant',
      sourceId: source.id,
      category: '证件凭据',
      subtopic: '合同协议文件',
    })

    const list = handleWikiSourceList(bridge, {
      type: 'wiki:source:list',
      agentId: 'assistant',
      category: '证件凭据',
      subtopic: '合同协议文件',
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
    repo.updateSourceTopic('assistant', 'local-user', source.id, '做事记录', '会议聊天记录')
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

    expect(rows[0]?.topicCategory).toBe('做事记录')
    expect(rows[0]?.topicSubtopic).toBe('会议聊天记录')
  })
})
