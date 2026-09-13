/**
 * registerGuideTools — prompt_guide 工具测试（P1-T1）
 * 覆盖：工具注册 / 已知段 id 返回完整正文 / 未知 id 兜底 available_sections
 */

import { describe, it, expect } from 'vitest'
import { registerGuideTools } from './bridge-tool-registrar-guide'
import type { BridgeToolRegistrarDeps } from './bridge-tool-registrar-types'

interface RegisteredTool {
  name: string
  execute: (toolCallId: string, params: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>
}

function makeDeps() {
  const registered = new Map<string, RegisteredTool>()
  const deps = {
    toolContext: {},
    toolRegistry: {
      register: (tool: RegisteredTool) => {
        registered.set(tool.name, tool)
      },
    },
    toolCallInstanceMap: new Map<string, string>(),
    instanceStates: { get: () => undefined },
    getCurrentToolExecutorInstanceId: () => undefined,
  } as unknown as BridgeToolRegistrarDeps
  return { deps, registered }
}

function parseText(result: { content: Array<{ type: string; text: string }> }): Record<string, unknown> {
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>
}

describe('registerGuideTools — prompt_guide', () => {
  it('注册 prompt_guide 工具', () => {
    const { deps, registered } = makeDeps()
    registerGuideTools(deps)
    expect(registered.has('prompt_guide')).toBe(true)
  })

  it('已知段 id 返回完整正文（title 带 (full) 后缀）', async () => {
    const { deps, registered } = makeDeps()
    registerGuideTools(deps)
    const tool = registered.get('prompt_guide')!
    const payload = parseText(await tool.execute('call-1', { section: 'fileOutput' }))
    expect(payload.section).toBe('fileOutput')
    expect(String(payload.title)).toContain('(full)')
    expect(String(payload.body)).toContain('## File Output Standards')
  })

  it('未知段 id 返回 error + available_sections 兜底', async () => {
    const { deps, registered } = makeDeps()
    registerGuideTools(deps)
    const tool = registered.get('prompt_guide')!
    const payload = parseText(await tool.execute('call-2', { section: 'no-such-section' }))
    expect(String(payload.error)).toContain('no-such-section')
    expect(payload.available_sections).toContain('operatingPrinciples')
    expect(payload.available_sections).toContain('messaging')
  })
})
