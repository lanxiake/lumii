/**
 * 客户端注册工具的提示词分组守卫
 *
 * runtime 侧的 tooling-section.test.ts 只能枚举 built-in 工具；
 * apps/windows 通过 bridge 注册的工具（guide / browser / app / screen）
 * 必须在这一侧校验，否则新增客户端工具会静默掉进 Other Tools。
 *
 * 计划依据：docs/plans/AGENT优化/2026-08-28-tooling-prompt-refactor-implementation.md P0-T8
 *
 * 实现方式：直接从 bridge 源码提取 `name: 'xxx'` 字面量，避免为了拿工具名
 * 而拉起 Electron / ToolRegistry 依赖。
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { categorizeTools } from '@mtbot/agent-runtime'

const HERE = join(__dirname)

/** 从 bridge 源码里抓工具名字面量 */
function extractToolNames(file: string): string[] {
  const src = readFileSync(join(HERE, file), 'utf8')
  const names = [...src.matchAll(/name:\s*'([a-z_0-9]+)'/g)].map((m) => m[1]!)
  return [...new Set(names)]
}

const BRIDGE_SOURCES = [
  'bridge-tool-registrar-guide.ts',
  'bridge-browser-tools.ts',
  'bridge-app-ui-tools.ts',
  'bridge-screen-record-tools.ts',
] as const

describe('bridge 注册工具的提示词分组', () => {
  it('每个 bridge 源文件都能抓到工具名（正则未失效）', () => {
    for (const file of BRIDGE_SOURCES) {
      const names = extractToolNames(file)
      expect(names.length, `${file} 未抓到任何工具名，正则可能已失效`).toBeGreaterThan(0)
    }
  })

  it('bridge 注册的全部工具都不落进 Other Tools', () => {
    const all = BRIDGE_SOURCES.flatMap(extractToolNames)
    expect(all.length).toBeGreaterThanOrEqual(20)

    const lines = categorizeTools(all)
    const otherIdx = lines.indexOf('### Other Tools')
    const orphans: string[] = []
    if (otherIdx !== -1) {
      for (let i = otherIdx + 1; i < lines.length; i++) {
        const line = lines[i]!
        if (line.startsWith('### ')) break
        const m = line.match(/^- `([a-z_0-9]+)`/)
        if (m) orphans.push(m[1]!)
      }
    }
    expect(orphans, `以下客户端工具未归入正式分组: ${orphans.join(', ')}`).toEqual([])
  })

  it('app_* 与 screen_* 归入 Desktop Control，不再声称有 guide 工具', () => {
    const desktop = [
      ...extractToolNames('bridge-app-ui-tools.ts'),
      ...extractToolNames('bridge-screen-record-tools.ts'),
    ]
    const lines = categorizeTools(desktop)
    expect(lines).toContain('### Desktop Control')
    expect(lines.join('\n')).not.toMatch(/guide tool before calling/i)
  })
})
