import { describe, expect, it } from 'vitest'

import {
  formatBytes,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatPercent,
  formatRelative,
  pluginFormat,
} from './format'

describe('format', () => {
  it('数字与百分比', () => {
    expect(formatNumber(1234.5)).toBe('1,234.5')
    expect(formatPercent(0.426)).toBe('43%')
    expect(formatPercent(0.426, 1)).toBe('42.6%')
    expect(formatPercent(Number.NaN)).toBe('—')
  })

  it('货币固定两位小数', () => {
    expect(formatCurrency(1234)).toBe('¥1,234.00')
    expect(formatCurrency(1234, 'USD')).toBe('US$1,234.00')
  })

  it('字节：1024 进位，非负数', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB')
    expect(formatBytes(-1)).toBe('—')
  })

  it('日期与时间', () => {
    expect(formatDate('2026-10-21T10:08:00')).toBe('2026/10/21')
    expect(formatDateTime('2026-10-21T10:08:00')).toMatch(/^2026\/10\/21 10:08$/)
    expect(formatDate('不是日期')).toBe('不是日期')
  })

  it('插件契约名与文档一致（api.format.bytes 而不是 formatBytes）', () => {
    expect(pluginFormat.bytes(1536)).toBe('1.5 KB')
    expect(pluginFormat.currency(1234)).toBe('¥1,234.00')
    expect(pluginFormat.relative(Date.now() - 30_000)).toBe('刚刚')
    expect(Object.keys(pluginFormat).sort()).toEqual(
      ['bytes', 'currency', 'date', 'dateTime', 'number', 'percent', 'relative'].sort(),
    )
  })

  it('相对时间：过去、未来、超过 7 天回落日期', () => {
    const now = new Date('2026-10-21T12:00:00').getTime()
    expect(formatRelative(now - 30_000, now)).toBe('刚刚')
    expect(formatRelative(now - 3 * 60_000, now)).toBe('3 分钟前')
    expect(formatRelative(now - 5 * 3_600_000, now)).toBe('5 小时前')
    expect(formatRelative(now - 2 * 86_400_000, now)).toBe('2 天前')
    expect(formatRelative(now + 2 * 3_600_000, now)).toBe('2 小时后')
    expect(formatRelative(now - 30 * 86_400_000, now)).toBe('2026/09/21')
  })
})
