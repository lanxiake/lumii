import { describe, it, expect } from 'vitest'
import {
  inboxStatusLabel,
  runStatusLabel,
  outcomeLabel,
  extractLabel,
  formatRelativeTime,
} from '../../renderer/pages/MemoriesPage/components/wikiStatusLabels'

describe('wikiStatusLabels', () => {
  it('maps inbox statuses to Chinese', () => {
    expect(inboxStatusLabel('pending')).toBe('待处理')
    expect(inboxStatusLabel('processing')).toBe('处理中')
    expect(inboxStatusLabel('failed')).toBe('失败')
    expect(inboxStatusLabel('unknown_x')).toBe('unknown_x')
  })

  it('maps run/outcome/extract labels', () => {
    expect(runStatusLabel('succeeded')).toBe('已完成')
    expect(outcomeLabel('archived')).toBe('已归档')
    expect(extractLabel('preview')).toBe('已有预览')
  })

  it('formats relative time in zh', () => {
    const now = Date.parse('2026-08-27T12:00:00+08:00')
    expect(formatRelativeTime(now - 2 * 3600_000, now)).toBe('2 小时前')
    expect(formatRelativeTime(null, now)).toBe('')
  })
})
