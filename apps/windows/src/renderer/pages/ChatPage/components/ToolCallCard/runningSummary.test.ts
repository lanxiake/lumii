/**
 * 同步工具运行中摘要单元测试。
 */

import { describe, expect, it } from 'vitest'
import {
  extractRunningTarget,
  formatRunningElapsedLabel,
  resolveRunningSummary,
} from './runningSummary'

describe('runningSummary', () => {
  it('优先用 progressText，否则用命令/路径目标', () => {
    expect(resolveRunningSummary({
      status: 'running',
      name: 'bash',
      progressText: '编译中 40%',
      input: { command: 'pnpm build' },
    })).toBe('编译中 40%')

    expect(resolveRunningSummary({
      status: 'running',
      name: 'bash',
      input: { command: 'pnpm test --filter windows' },
    })).toBe('pnpm test --filter windows')

    expect(resolveRunningSummary({
      status: 'completed',
      name: 'bash',
      progressText: 'done',
    })).toBeUndefined()
  })

  it('从常见 input 字段提取目标', () => {
    expect(extractRunningTarget({ path: 'a/b/c.ts' }, 'file_read')).toBe('c.ts')
    expect(extractRunningTarget({ url: 'https://example.test/x' }, 'browser_navigate')).toBe(
      'https://example.test/x',
    )
  })

  it('格式化已用时前缀', () => {
    expect(formatRunningElapsedLabel('12.3s')).toBe('已用 12.3s')
  })
})
