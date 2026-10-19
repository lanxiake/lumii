/**
 * 变更台账纯函数测试
 * 验证：轮次分组与倒序、全会话去重统计、产物分批与最新优先、筛选与搜索。
 */

import { describe, it, expect } from 'vitest'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import {
  buildChangeLedger,
  extOf,
  filterArtifacts,
  filterTurns,
  isImagePath,
  isMediaPath,
  mediaUrl,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceChangesPanel/ledger'

function message(
  id: string,
  timestamp: number,
  fileChanges: FileChangeEntry[],
  overrides: Partial<LedgerMessageLike> = {},
): LedgerMessageLike {
  return { id, role: 'assistant', timestamp, fileChanges, ...overrides }
}

describe('buildChangeLedger', () => {
  it('只收 assistant 且有变更的轮次，按时间倒序', () => {
    const ledger = buildChangeLedger([
      message('a', 100, [{ path: 'a.txt', status: 'added' }]),
      { id: 'u', role: 'user', timestamp: 150, fileChanges: [{ path: 'u.txt', status: 'added' }] },
      message('empty', 160, []),
      message('b', 200, [{ path: 'b.txt', status: 'modified' }], {
        sourceAgent: { label: '短剧助手' },
      }),
    ])
    expect(ledger.turns.map((turn) => turn.messageId)).toEqual(['b', 'a'])
    expect(ledger.turns[0]?.sourceLabel).toBe('短剧助手')
    expect(ledger.turns[1]?.sourceLabel).toBeUndefined()
  })

  it('全会话按路径去重，同一文件取最新一轮的状态', () => {
    const ledger = buildChangeLedger([
      message('old', 100, [
        { path: 'src/a.ts', status: 'added' },
        { path: 'src/b.ts', status: 'modified' },
      ]),
      message('new', 200, [
        { path: 'src/a.ts', status: 'modified' },
        { path: 'src/b.ts', status: 'deleted', confidence: 'unattributed' },
        { path: 'src/c.ts', status: 'added', confidence: 'unattributed' },
      ]),
    ])
    expect(ledger.counts).toEqual({
      files: 2,
      added: 0,
      modified: 2,
      deleted: 0,
    })
    // 未归属条目在最底层就被过滤，不参与轮次与统计
    expect(ledger.turns[0]?.changes.map((entry) => entry.path)).toEqual(['src/a.ts'])
  })

  it('只有未归属条目的轮次整轮不显示（旧数据兼容）', () => {
    const ledger = buildChangeLedger([
      message('noise', 200, [
        { path: 'outputs/其他会话.png', status: 'modified', confidence: 'unattributed' },
      ]),
    ])
    expect(ledger.turns).toEqual([])
    expect(ledger.counts.files).toBe(0)
    expect(ledger.artifactCount).toBe(0)
  })

  it('媒体按目录分批，排除删除与非媒体，同一路径只保留最新一次', () => {
    const ledger = buildChangeLedger([
      message('t1', 100, [
        { path: 'uploads/short/01.png', status: 'added' },
        { path: 'uploads/short/02.mp4', status: 'added' },
        { path: 'uploads/short/notes.txt', status: 'added' },
        { path: 'uploads/other/03.jpg', status: 'added' },
      ]),
      message('t2', 200, [
        { path: 'uploads/short/01.png', status: 'modified' },
        { path: 'uploads/short/04.png', status: 'deleted' },
      ]),
    ])
    expect(ledger.artifactCount).toBe(3)
    const dirs = ledger.artifacts.map((batch) => batch.dir)
    expect(dirs).toContain('uploads/short')
    expect(dirs).toContain('uploads/other')
    const short = ledger.artifacts.find((batch) => batch.dir === 'uploads/short')
    expect(short?.items.map((item) => item.path)).toEqual([
      'uploads/short/01.png',
      'uploads/short/02.mp4',
    ])
    expect(short?.items[0]?.status).toBe('modified')
    expect(short?.items[0]?.timestamp).toBe(200)
  })
})

describe('filterTurns / filterArtifacts', () => {
  const entries: FileChangeEntry[] = [
    { path: 'uploads/a.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/b.bin', status: 'modified', confidence: 'unattributed' },
    { path: 'src/c.ts', status: 'deleted' },
  ]

  it('按状态筛选并丢掉空轮次', () => {
    const ledger = buildChangeLedger([
      message('t1', 100, entries),
      message('t2', 200, [{ path: 'src/d.ts', status: 'added' }]),
    ])
    const added = filterTurns(ledger.turns, 'added', '')
    expect(added.map((turn) => turn.messageId)).toEqual(['t2', 't1'])
    expect(added[1]?.changes.map((entry) => entry.path)).toEqual(['uploads/a.png'])

    const deleted = filterTurns(ledger.turns, 'deleted', '')
    expect(deleted).toHaveLength(1)
    expect(deleted[0]?.changes[0]?.path).toBe('src/c.ts')
  })

  it('未归属条目不会出现在筛选结果里', () => {
    const ledger = buildChangeLedger([message('t1', 100, entries)])
    const paths = filterTurns(ledger.turns, 'all', '')
      .flatMap((turn) => turn.changes.map((entry) => entry.path))
    expect(paths).not.toContain('outputs/b.bin')
  })

  it('路径搜索不区分大小写，并对产物生效', () => {
    const ledger = buildChangeLedger([message('t1', 100, entries)])
    expect(filterTurns(ledger.turns, 'all', 'UPLOADS')[0]?.changes).toHaveLength(1)
    const batches = filterArtifacts(ledger.artifacts, 'all', 'a.png')
    expect(batches).toHaveLength(1)
    expect(batches[0]?.items).toHaveLength(1)
  })
})

describe('path helpers', () => {
  it('识别媒体与图片扩展名', () => {
    expect(extOf('a/b/Clip.MP4')).toBe('mp4')
    expect(extOf('没有扩展名')).toBe('')
    expect(isMediaPath('a/b/voice.mp3')).toBe(true)
    expect(isMediaPath('a/b/readme.md')).toBe(false)
    expect(isImagePath('a/b/cover.WEBP')).toBe(true)
    expect(isImagePath('a/b/clip.mp4')).toBe(false)
  })

  it('媒体 URL 对绝对路径编码', () => {
    expect(mediaUrl('C:\\工作区\\a b.png')).toBe(
      'lumii-local://media/?path=C%3A%5C%E5%B7%A5%E4%BD%9C%E5%8C%BA%5Ca%20b.png',
    )
  })
})
