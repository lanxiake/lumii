/**
 * 独立预览窗的左右翻页（2026-11-05）。
 *
 * 翻页逻辑在**主进程**（清单归它所有），所以能单测：不需要开真窗口。
 * 这里钉住三件容易错的事——循环、越界不炸、切文件时清掉上一份的行号范围。
 */
import { describe, expect, it, vi } from 'vitest'

const sent: Array<{ channel: string; payload: unknown }> = []

vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({
      workAreaSize: { width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
    getDisplayMatching: () => ({
      workAreaSize: { width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    }),
  },
}))

vi.mock('../../../main/window/preview-zoom-guard', () => ({
  installPreviewZoomGuard: vi.fn(),
}))

import { PreviewWindowManager } from './preview-window-manager'
import type { FilePreviewWindowPayload } from '../../../shared/file-preview-window'

const LIST = ['C:/ws/a.png', 'C:/ws/b.mp4', 'C:/ws/c.png']

/** 造一个只填了载荷的管理器（不开窗，靠 messa 记录推送） */
function managerWith(payload: FilePreviewWindowPayload): PreviewWindowManager {
  const deps = {
    getMainWindow: () => null,
    preloadPath: '',
    indexHtmlPath: '',
  }
  const manager = new PreviewWindowManager(deps)
  // @ts-expect-error 测试直接写私有载荷，避免为了造数据真的开一个 BrowserWindow
  manager.payload = payload
  // 没有真窗口时 send 无处可去，这里替换掉
  vi.spyOn(manager, 'getWindow').mockReturnValue({
    webContents: { send: (channel: string, p: unknown) => sent.push({ channel, payload: p }) },
  } as never)
  return manager
}

const base: FilePreviewWindowPayload = {
  fileName: 'b.mp4',
  filePath: 'C:/ws/b.mp4',
  navigateList: LIST,
  navigateIndex: 1,
}

describe('PreviewWindowManager · 左右翻页', () => {
  it('下一个：索引与文件名一起前进，并推给渲染层', () => {
    sent.length = 0
    const manager = managerWith(base)
    const result = manager.navigate(1)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.filePath).toBe('C:/ws/c.png')
      expect(result.payload.fileName).toBe('c.png')
      expect(result.payload.navigateIndex).toBe(2)
    }
    expect(sent).toHaveLength(1)
    expect(sent[0]!.channel).toBe('file-preview:payload-updated')
  })

  it('末尾再「下一个」回到第一张（循环，与主区预览一致）', () => {
    sent.length = 0
    const manager = managerWith({ ...base, navigateIndex: 2, filePath: 'C:/ws/c.png' })
    const result = manager.navigate(1)
    expect(result.ok && result.payload.filePath).toBe('C:/ws/a.png')
  })

  it('开头「上一个」绕到最后一张', () => {
    sent.length = 0
    const manager = managerWith({ ...base, navigateIndex: 0, filePath: 'C:/ws/a.png' })
    const result = manager.navigate(-1)
    expect(result.ok && result.payload.filePath).toBe('C:/ws/c.png')
  })

  it('切成另一个文件时清掉行号范围（否则新文件会被截成一段）', () => {
    sent.length = 0
    const manager = managerWith({ ...base, startLine: 10, endLine: 20 })
    const result = manager.navigate(1)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.payload.startLine).toBeUndefined()
      expect(result.payload.endLine).toBeUndefined()
    }
  })

  it('没有清单 / 只有一个文件 / 下标未知 → 不翻（返回 ok:false，不炸）', () => {
    sent.length = 0
    const noList = managerWith({ fileName: 'x.png', filePath: 'C:/ws/x.png' })
    expect(noList.navigate(1).ok).toBe(false)

    const single = managerWith({
      fileName: 'x.png',
      filePath: 'C:/ws/x.png',
      navigateList: ['C:/ws/x.png'],
      navigateIndex: 0,
    })
    expect(single.navigate(1).ok).toBe(false)

    const noIndex = managerWith({ ...base, navigateIndex: undefined })
    expect(noIndex.navigate(1).ok).toBe(false)
    expect(sent).toHaveLength(0)
  })
})
