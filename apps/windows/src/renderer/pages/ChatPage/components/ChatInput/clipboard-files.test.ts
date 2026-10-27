import { describe, expect, it } from 'vitest'
import { collectClipboardFiles } from './clipboard-files'

describe('collectClipboardFiles', () => {
  it('files 为空时回退到 items（微信/QQ 截图）', () => {
    const img = new File(['x'], 'image.png', { type: 'image/png' })
    const files = collectClipboardFiles({
      files: [],
      items: [{ kind: 'file', getAsFile: () => img }],
    })
    expect(files).toEqual([img])
  })

  it('files 非空时优先返回 files', () => {
    const fromFiles = new File(['a'], 'a.txt')
    const fromItem = new File(['b'], 'b.txt')
    const files = collectClipboardFiles({
      files: [fromFiles],
      items: [{ kind: 'file', getAsFile: () => fromItem }],
    })
    expect(files).toEqual([fromFiles])
  })

  it('没有文件时返回空数组', () => {
    expect(collectClipboardFiles(null)).toEqual([])
    expect(collectClipboardFiles({ files: [], items: [{ kind: 'string', getAsFile: () => null }] })).toEqual([])
  })
})
