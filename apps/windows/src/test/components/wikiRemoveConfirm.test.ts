import { describe, expect, it } from 'vitest'
import { buildWikiRemoveConfirmContent } from '../../renderer/pages/MemoriesPage/components/wikiRemoveConfirm'

describe('buildWikiRemoveConfirmContent', () => {
  it('混合删除文案', () => {
    expect(buildWikiRemoveConfirmContent(2, 3)).toContain('2 条收件箱')
    expect(buildWikiRemoveConfirmContent(2, 3)).toContain('删除 3 条')
  })

  it('单条资料删除文案', () => {
    expect(buildWikiRemoveConfirmContent(0, 1)).toBe('将永久删除这条资料，不可恢复。')
  })
})
