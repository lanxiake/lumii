/**
 * 产物台账纯函数测试
 * 验证：按轮分组与倒序、路径去重、任务分组（目录合并）、成品/中间分层、
 * 版本索引、标签回退、internal/ephemeral 过滤。
 */

import { describe, it, expect } from 'vitest'
import type { FileChangeEntry } from '@mtbot/agent-runtime/browser'
import {
  artifactGroupKey,
  buildArtifactLedger,
  buildChangeLedger,
  extOf,
  isImagePath,
  isMediaPath,
  labelFromText,
  mediaUrl,
  type LedgerMessageLike,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

function message(
  id: string,
  timestamp: number,
  fileChanges: FileChangeEntry[],
  overrides: Partial<LedgerMessageLike> = {},
): LedgerMessageLike {
  return { id, role: 'assistant', timestamp, fileChanges, ...overrides }
}

function user(id: string, timestamp: number, text: string): LedgerMessageLike {
  return { id, role: 'user', timestamp, text }
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
    expect(ledger.counts).toEqual({ files: 2, added: 0, modified: 2, deleted: 0 })
    // 未归属条目在最底层就被过滤，不参与轮次与统计
    expect(ledger.turns[0]?.changes.map((entry) => entry.path)).toEqual(['src/a.ts'])
  })
})

describe('artifactGroupKey', () => {
  it('outputs 取前两段，其余取第一段', () => {
    expect(artifactGroupKey('outputs/pet-demo/parts/a.png')).toBe('outputs/pet-demo')
    expect(artifactGroupKey('uploads/2026-10-26/a.png')).toBe('uploads')
    expect(artifactGroupKey('notes.md')).toBe('')
  })
})

describe('labelFromText', () => {
  it('去 Markdown 标记并截断到 24 字', () => {
    expect(labelFromText('## 帮我做一组**表情包**\n第二行')).toBe('帮我做一组表情包')
    expect(labelFromText('   ')).toBeUndefined()
    expect(labelFromText(undefined)).toBeUndefined()
    const long = labelFromText('一'.repeat(40))
    expect(long).toHaveLength(25)
    expect(long?.endsWith('…')).toBe(true)
  })
})

describe('buildArtifactLedger · 1110 文件那一屏', () => {
  const intermediates: FileChangeEntry[] = [
    ...Array.from({ length: 500 }, (_, index) => ({
      path: `outputs/pet-demo/parts-10/frame-${index}.png`,
      status: 'added' as const,
      confidence: 'exact' as const,
    })),
    ...Array.from({ length: 500 }, (_, index) => ({
      path: `outputs/pet-demo/normalized/frame-${index}.png`,
      status: 'added' as const,
      confidence: 'exact' as const,
    })),
    ...Array.from({ length: 107 }, (_, index) => ({
      path: `outputs/pet-demo/cut-${index}.png`,
      status: 'added' as const,
      confidence: 'exact' as const,
    })),
  ]
  const deliverables: FileChangeEntry[] = [
    { path: 'outputs/pet-demo/sprite.png', status: 'added', confidence: 'exact' },
    { path: 'outputs/pet-demo/idle.json', status: 'added', confidence: 'exact' },
    { path: 'outputs/pet-demo/sheet.html', status: 'added', confidence: 'exact' },
  ]

  it('一组合成，成品 3 / 中间 1107', () => {
    const ledger = buildArtifactLedger([
      user('u1', 100, '## 帮我把这只兔子做成宠物精灵图\n还有别的'),
      message('t1', 200, [...deliverables, ...intermediates]),
    ])

    expect(ledger.groups).toHaveLength(1)
    const group = ledger.groups[0]!
    expect(group.label).toBe('帮我把这只兔子做成宠物精灵图')
    expect(group.deliverables).toHaveLength(3)
    expect(group.intermediates).toHaveLength(1107)
    expect(ledger.counts.deliverables).toBe(3)
    expect(ledger.counts.intermediates).toBe(1107)
    expect(ledger.counts.byKind.image).toBe(1108)
    expect(ledger.counts.byKind.code).toBe(1) // idle.json
    expect(ledger.counts.byKind.site).toBe(1) // sheet.html
  })
})

describe('buildArtifactLedger · 分组与版本', () => {
  it('同目录跨轮合并成一组，时间取最新', () => {
    const ledger = buildArtifactLedger([
      user('u1', 50, '做一张封面'),
      message('t1', 100, [{ path: 'outputs/poster/a.png', status: 'added' }]),
      message('t2', 200, [{ path: 'outputs/poster/b.png', status: 'added' }]),
    ])
    expect(ledger.groups).toHaveLength(1)
    expect(ledger.groups[0]?.timestamp).toBe(200)
    expect(ledger.groups[0]?.startedAt).toBe(100)
    expect(ledger.groups[0]?.label).toBe('做一张封面')
    expect(ledger.groups[0]?.deliverables.map((item) => item.path)).toEqual([
      'outputs/poster/a.png',
      'outputs/poster/b.png',
    ])
  })

  it('同一路径两轮出现 → versions 两条（时间正序）', () => {
    const ledger = buildArtifactLedger([
      message('t1', 100, [{ path: 'outputs/x/a.png', status: 'added' }]),
      message('t2', 200, [{ path: 'outputs/x/a.png', status: 'modified' }]),
    ])
    const versions = ledger.versions.get('outputs/x/a.png')
    expect(versions?.map((version) => version.status)).toEqual(['added', 'modified'])
    expect(versions?.map((version) => version.turnId)).toEqual(['t1', 't2'])
    // 组内仍是同一个文件（去重，取最新）
    expect(ledger.groups[0]?.deliverables).toHaveLength(1)
    expect(ledger.groups[0]?.deliverables[0]?.status).toBe('modified')
  })

  it('没有 user 消息时用 HH:mm 兜底', () => {
    const ledger = buildArtifactLedger([
      message('t1', new Date(2026, 9, 26, 14, 20).getTime(), [
        { path: 'outputs/x/a.png', status: 'added' },
      ]),
    ])
    expect(ledger.groups[0]?.label).toBe('14:20')
  })

  it('internal 与 ephemeral 不进 rail，deleted 不进成品但记版本', () => {
    const ledger = buildArtifactLedger([
      message('t1', 100, [
        { path: 'temp/github3/repo/a.md', status: 'added' },
        { path: 'wiki/a.md.lumii-ref', status: 'added' },
        { path: 'outputs/x/gone.png', status: 'deleted' },
        { path: 'outputs/x/kept.png', status: 'added' },
      ]),
    ])
    expect(ledger.groups).toHaveLength(1)
    expect(ledger.groups[0]?.deliverables.map((item) => item.path)).toEqual([
      'outputs/x/kept.png',
    ])
    expect(ledger.versions.has('wiki/a.md.lumii-ref')).toBe(false)
    expect(ledger.versions.has('outputs/x/gone.png')).toBe(true)
  })

  it('中间产物不足 20 个时按成品展示（不折叠）', () => {
    const entries: FileChangeEntry[] = Array.from({ length: 19 }, (_, index) => ({
      path: `outputs/x/cut-${index}.png`,
      status: 'added',
    }))
    const ledger = buildArtifactLedger([message('t1', 100, entries)])
    expect(ledger.groups[0]?.deliverables).toHaveLength(19)
    expect(ledger.groups[0]?.intermediates).toHaveLength(0)
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
