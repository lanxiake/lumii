import { describe, expect, it } from 'vitest'
import { BASE_SLASH_COMMANDS } from './slash-command-metadata'

describe('BASE_SLASH_COMMANDS', () => {
  // 回归护栏：这份列表一旦缺项，渲染层会用 IPC 返回值整体覆盖内置兜底表，
  // 该命令就从补全面板消失、输入后被放行给 LLM（历史上 /new、/resume 就这样丢过）。
  it('列出客户端全部基础命令', () => {
    expect(BASE_SLASH_COMMANDS.map((c) => c.name)).toEqual([
      '/help',
      '/status',
      '/clear',
      '/new',
      '/resume',
      '/compact',
      '/memory',
      '/think',
    ])
  })

  it('key 与 name 对应（name = "/" + key）', () => {
    for (const cmd of BASE_SLASH_COMMANDS) {
      expect(cmd.name).toBe(`/${cmd.key}`)
    }
  })

  it('每条命令都有描述与用法示例', () => {
    for (const cmd of BASE_SLASH_COMMANDS) {
      expect(cmd.description.trim().length).toBeGreaterThan(0)
      expect(cmd.usage?.trim().length ?? 0).toBeGreaterThan(0)
    }
  })

  it('别名不与任何主命令或其它别名冲突', () => {
    const seen = new Set(BASE_SLASH_COMMANDS.map((c) => c.name))
    for (const cmd of BASE_SLASH_COMMANDS) {
      for (const alias of cmd.aliases) {
        expect(alias.startsWith('/')).toBe(true)
        expect(seen.has(alias)).toBe(false)
        seen.add(alias)
      }
    }
  })
})
