import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@mtbot/agent-runtime'
import type { ToolExecutionContext } from '@mtbot/agent-runtime'
import { registerAppPanelTools } from './bridge-app-panel-tools'
import { parseJsonToolResultPayload } from './bridge-utils'

function stubContext(): ToolExecutionContext {
  return {
    executeCommand: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    readFile: async () => '',
    writeFile: async () => {},
    glob: async () => [],
    grep: async () => [],
    fetch: async () => ({ status: 200, body: '' }),
    getCwd: () => '/',
  }
}

const WORKSPACE = 'E:/ws'

/** 注册并返回 execute；默认文件存在、开关打开 */
function setup(overrides: {
  panel?: ReturnType<typeof vi.fn>
  settingsJson?: string | null
  fileExists?: (p: string) => boolean
} = {}) {
  const panel = overrides.panel ?? vi.fn(() => ({ ok: true as const }))
  const registry = new ToolRegistry()
  registerAppPanelTools(registry, stubContext(), {
    controller: { panel },
    readSettingsJson: async () => overrides.settingsJson ?? null,
    resolveWorkspaceDir: () => WORKSPACE,
    fileExists: overrides.fileExists ?? (() => true),
  })
  const tool = registry.get('app_panel')
  expect(tool).toBeDefined()
  return { execute: tool!.execute.bind(tool), panel }
}

async function run(
  execute: ReturnType<typeof setup>['execute'],
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await execute('call-1', params)
  const payload = parseJsonToolResultPayload(result)
  if (!payload) throw new Error('工具没有返回 JSON 载荷')
  return payload
}

describe('app_panel', () => {
  it('注册为 channel 类、非只读、无需权限（跟随 allowAgentAppUiControl）', () => {
    const registry = new ToolRegistry()
    registerAppPanelTools(registry, stubContext(), {
      controller: { panel: vi.fn() },
      resolveWorkspaceDir: () => WORKSPACE,
      fileExists: () => true,
    })
    const tool = registry.get('app_panel')
    expect(tool?.category).toBe('channel')
    expect(tool?.isReadOnly).toBe(false)
    expect(tool?.needsPermission).toBe(false)
    expect(tool?.description).toContain('a2ui')
  })

  it('合法 doc + 相对路径：解析成工作区绝对路径后送面板', async () => {
    const { execute, panel } = setup()
    const payload = await run(execute, { mode: 'doc', path: '卷二/第二章.md' })

    expect(payload).toMatchObject({ ok: true, mode: 'doc' })
    expect(panel).toHaveBeenCalledWith({
      mode: 'doc',
      path: path.resolve(WORKSPACE, '卷二/第二章.md').replace(/\\/g, '/'),
    })
  })

  it('绝对路径原样使用', async () => {
    const { execute, panel } = setup()
    const abs = 'D:/other/稿子.md'
    const payload = await run(execute, { mode: 'doc', path: abs })
    expect(payload.ok).toBe(true)
    expect(panel).toHaveBeenCalledWith({ mode: 'doc', path: abs })
  })

  it('未知模式：显式 unknown_mode + available，且不送面板', async () => {
    const { execute, panel } = setup()
    const payload = await run(execute, { mode: 'auto', path: 'a.md' })
    expect(payload).toEqual({
      ok: false,
      error: 'unknown_mode',
      available: ['doc'],
    })
    expect(panel).not.toHaveBeenCalled()
  })

  it('缺 path：file_not_found，且不送面板', async () => {
    const { execute, panel } = setup()
    const payload = await run(execute, { mode: 'doc' })
    expect(payload.ok).toBe(false)
    expect(payload.error).toBe('file_not_found')
    expect(panel).not.toHaveBeenCalled()
  })

  it('文件不存在：file_not_found，且不送面板', async () => {
    const { execute, panel } = setup({ fileExists: () => false })
    const payload = await run(execute, { mode: 'doc', path: 'missing.md' })
    expect(payload.ok).toBe(false)
    expect(payload.error).toBe('file_not_found')
    expect(panel).not.toHaveBeenCalled()
  })

  it('总开关关闭：disabled，且不送面板', async () => {
    const { execute, panel } = setup({
      settingsJson: JSON.stringify({ privacy: { allowAgentAppUiControl: false } }),
    })
    const payload = await run(execute, { mode: 'doc', path: 'a.md' })
    expect(payload).toEqual({ ok: false, error: 'disabled' })
    expect(panel).not.toHaveBeenCalled()
  })

  it('窗口不在：app_not_running', async () => {
    const { execute } = setup({ panel: vi.fn(() => ({ ok: false as const, error: 'app_not_running' })) })
    const payload = await run(execute, { mode: 'doc', path: 'a.md' })
    expect(payload).toEqual({ ok: false, error: 'app_not_running' })
  })
})
