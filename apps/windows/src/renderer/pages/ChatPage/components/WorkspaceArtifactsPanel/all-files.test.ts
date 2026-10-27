/**
 * 「全部」作用域映射：绝对路径相对化、工作区外丢弃、去重、按时间倒序。
 */
import { describe, expect, it } from 'vitest'
import { mapAllFiles, relativeToWorkspace } from './all-files'

const WS = 'C:/Users/me/.lumii/workspace'

describe('relativeToWorkspace', () => {
  it('工作区内 → 相对路径；大小写与反斜杠都归一', () => {
    expect(relativeToWorkspace('C:\\Users\\me\\.lumii\\workspace\\outputs\\a.png', WS)).toBe(
      'outputs/a.png',
    )
    expect(relativeToWorkspace('c:/users/me/.lumii/workspace/outputs/a.png', WS)).toBe('outputs/a.png')
  })

  it('工作区外 / 工作区本身 → null', () => {
    expect(relativeToWorkspace('C:/Users/me/Downloads/a.png', WS)).toBeNull()
    expect(relativeToWorkspace(WS, WS)).toBeNull()
    // 前缀相似但不是同一棵树
    expect(relativeToWorkspace('C:/Users/me/.lumii/workspace2/a.png', WS)).toBeNull()
  })

  it('登记本来就是相对路径时直接可用（两种口径都支持）', () => {
    // 有工作区信息也接受相对路径：client_files 的老记录是相对路径
    expect(relativeToWorkspace('outputs/a.png', WS)).toBe('outputs/a.png')
    expect(relativeToWorkspace('outputs/a.png', undefined)).toBe('outputs/a.png')
    // 绝对路径但没给工作区 → 无法判断是否在工作区内
    expect(relativeToWorkspace('C:/x/a.png', undefined)).toBeNull()
  })
})

describe('mapAllFiles', () => {
  it('映射 kind/大小/时间，并过滤工作区外与重复项', () => {
    const items = mapAllFiles(
      [
        {
          localPath: `${WS}/outputs/x/a.md`,
          fileName: 'a.md',
          fileSize: 10,
          createdAt: '2026-10-20T10:00:00.000Z',
          conversationId: 'c1',
          category: 'output',
        },
        // 同一路径重复登记：只保留一条
        { localPath: `${WS}/outputs/x/a.md`, fileName: 'a.md', createdAt: '2026-10-20T10:00:00.000Z' },
        // 工作区外：丢弃
        { localPath: 'C:/Windows/win.ini', fileName: 'win.ini' },
        // 更早的一条
        { localPath: `${WS}/outputs/y/b.png`, createdAt: '2026-10-19T10:00:00.000Z' },
      ],
      WS,
    )
    expect(items.map((item) => item.path)).toEqual(['outputs/x/a.md', 'outputs/y/b.png'])
    expect(items[0]).toMatchObject({
      kind: 'doc',
      size: 10,
      conversationId: 'c1',
      category: 'output',
    })
    expect(items[1]!.kind).toBe('image')
  })

  it('缺 createdAt 时按 0 处理但仍保留（排序落在最后）', () => {
    const items = mapAllFiles(
      [
        { localPath: `${WS}/outputs/x/a.md`, createdAt: '2026-10-20T10:00:00.000Z' },
        { localPath: `${WS}/outputs/x/b.md` },
      ],
      WS,
    )
    expect(items.map((item) => item.path)).toEqual(['outputs/x/a.md', 'outputs/x/b.md'])
  })
})
