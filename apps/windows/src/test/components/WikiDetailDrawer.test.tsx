/**
 * WikiDetailDrawer：验证异步附件上传不会覆盖上传期间继续产生的草稿。
 */
import React, { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WikiDetailDrawer } from '../../renderer/pages/MemoriesPage/components/WikiDetailDrawer'

const uploadFilesMock = vi.hoisted(() => vi.fn())

vi.mock(
  '../../renderer/pages/MemoriesPage/components/wikiAttachmentUpload',
  () => ({ uploadFilesForWikiAttachment: uploadFilesMock }),
)

const page = {
  id: 'p1',
  path: 'sources/a',
  category: 'sources',
  title: '架构',
  contentMd: '# 初始',
  version: 1,
  updatedAt: Date.now(),
}

/**
 * 提供可在附件上传期间模拟其他草稿更新的状态容器。
 */
const DrawerHarness: React.FC = () => {
  const [draft, setDraft] = useState('# 初始')

  return (
    <>
      <button type="button" onClick={() => setDraft((current) => `${current}\n用户继续输入`)}>
        模拟继续编辑
      </button>
      <output aria-label="当前草稿">{draft}</output>
      <WikiDetailDrawer
        open
        page={page}
        pages={[page]}
        isEditing
        editTitle={page.title}
        editDraft={draft}
        onEditTitleChange={() => undefined}
        onEditDraftChange={setDraft}
        onStartEdit={() => undefined}
        onCancelEdit={() => undefined}
        onSaveEdit={() => undefined}
        onRequestDelete={() => undefined}
        onClose={() => undefined}
        listBacklinks={async () => []}
        listRevisions={async () => []}
        rollbackPage={async () => undefined}
        onOpenPage={() => undefined}
        onRolledBack={() => undefined}
      />
    </>
  )
}

describe('WikiDetailDrawer', () => {
  beforeEach(() => {
    uploadFilesMock.mockReset()
  })

  it('附件上传完成时追加到最新草稿而不覆盖期间输入', async () => {
    let resolveUpload: ((attachments: readonly {
      filePath: string
      mediaType: 'image'
      displayName: string
      referenceLine: string
    }[]) => void) | undefined
    uploadFilesMock.mockReturnValue(new Promise((resolve) => {
      resolveUpload = resolve
    }))
    const { container } = render(<DrawerHarness />)
    const editor = container.querySelector('.wiki-page-view-editor')
    expect(editor).not.toBeNull()

    fireEvent.drop(editor!, {
      dataTransfer: { files: [new File(['image'], 'image.png', { type: 'image/png' })] },
    })
    await waitFor(() => expect(uploadFilesMock).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: '模拟继续编辑' }))

    await act(async () => {
      resolveUpload?.([{
        filePath: 'C:\\attachments\\image.png',
        mediaType: 'image',
        displayName: 'image.png',
        referenceLine: '![image.png](attachment://image.png)',
      }])
    })

    expect(screen.getByLabelText('当前草稿').textContent).toBe(
      '# 初始\n用户继续输入\n![image.png](attachment://image.png)',
    )
  })
})
