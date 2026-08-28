/**
 * Wiki 命令处理器契约测试：真实内存 WikiRepo + mock bridge，验证字段映射与状态流转。
 *
 * node:sqlite 内存库 + 全量 MIGRATIONS（同 cron-e2e.test.ts 手法，用 createRequire
 * 绕过 vite-node 对 "node:sqlite" 的静态解析；better-sqlite3 原生绑定在本环境编译
 * 版本不匹配，不可用作回退）。
 */
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
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
  handleWikiSourceList,
  handleWikiSourceUpdateTopic,
  handleWikiSourceMoveToParking,
  handleWikiSourceOpen,
  handleWikiCleanupScan,
} from './wiki-commands'
import { DEFAULT_TOPIC_TREE, PARKING_CATEGORY } from '@mtbot/agent-runtime'

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

function buildBridge(repo: WikiRepo): AgentRuntimeBridge {
  return {
    wikiRepo: repo,
    conversationRepo: { getAgentParticipantId: () => null },
    getCwd: () => process.cwd(),
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

  it('search 命中资料层（原文件）而非旧汇总页', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
    const source = repo.createSource({
      agentId: 'assistant',
      userId: 'local-user',
      title: '架构设计文档',
      extractedText: '这是一份关于系统架构设计的说明',
    })
    repo.indexSource(source.id)

    const hits = handleWikiSearch(bridge, { type: 'wiki:search', agentId: 'assistant', keyword: '架构设计' }) as {
      sourceId: string
      title: string
    }[]
    expect(hits).toHaveLength(1)
    expect(hits[0]!.sourceId).toBe(source.id)
    expect(hits[0]!.title).toBe('架构设计文档')
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

  it('graph:data 在空 ERO 时自动冷启动并返回含 kind 的混合节点', () => {
    const repo = createWikiRepo()
    const bridge = buildBridge(repo)
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
    expect(graph.nodes.some((n) => n.kind === 'entity')).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'wikilink')).toBe(true)
    expect(graph.edges.some((e) => e.kind === 'relation')).toBe(true)
    expect(typeof graph.truncated).toBe('boolean')
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
