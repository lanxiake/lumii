import { describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@mtbot/agent-runtime'
import type { ToolExecutionContext } from '@mtbot/agent-runtime'
import type { AppUiController } from '../app-ui-control'
import { registerAppUiTools } from './bridge-app-ui-tools'
import { parseJsonToolResultPayload } from './bridge-utils'

/** 最小 ToolExecutionContext stub */
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

/** 注册 app_screenshot 并返回工具 execute */
function registerAndGetExecute(controller: AppUiController) {
  const registry = new ToolRegistry()
  const ctx = stubContext()
  registerAppUiTools(registry, ctx, {
    getMainWindow: () => null,
    resizeImageIfNeeded: vi.fn(),
    controller,
  })
  const tool = registry.get('app_screenshot')
  expect(tool).toBeDefined()
  return tool!.execute.bind(tool)
}

describe('registerAppUiTools', () => {
  it('注册 app_screenshot：只读、无需权限、描述含「只截图，不操作」', () => {
    const registry = new ToolRegistry()
    const controller: AppUiController = {
      screenshot: vi.fn(),
      getSnapshotCache: vi.fn(),
    }
    registerAppUiTools(registry, stubContext(), {
      getMainWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller,
    })

    const tool = registry.get('app_screenshot')
    expect(tool?.name).toBe('app_screenshot')
    expect(tool?.isReadOnly).toBe(true)
    expect(tool?.needsPermission).toBe(false)
    expect(tool?.description).toContain('只截图，不操作')
  })

  it('成功时返回 text JSON（含 view/hub）+ image 块，previewPath 在 details', async () => {
    const execute = registerAndGetExecute({
      screenshot: vi.fn(async () => ({
        ok: true as const,
        snapshotId: 'snap-001',
        imageBase64: 'abc123',
        mimeType: 'image/jpeg',
        width: 800,
        height: 600,
        viewState: {
          view: 'chat',
          hub: { open: true, tab: 'general', category: 'models' },
        },
        refs: [{ ref: 'e1', role: 'button', name: '发送', x: 1, y: 2, w: 3, h: 4 }],
        truncated: false,
        previewPath: '/tmp/snap-001.jpg',
        windowVisible: true,
      })),
      getSnapshotCache: vi.fn(),
    })

    const result = await execute('call-1', {})
    const payload = parseJsonToolResultPayload(result)
    expect(payload).toMatchObject({
      ok: true,
      snapshotId: 'snap-001',
      view: 'chat',
      hub: { open: true, tab: 'general', category: 'models' },
      width: 800,
      height: 600,
      refs: [{ ref: 'e1', role: 'button', name: '发送', x: 1, y: 2, w: 3, h: 4 }],
      truncated: false,
    })
    expect(payload).not.toHaveProperty('previewPath')

    const imageBlock = result.content?.find((c) => c.type === 'image')
    expect(imageBlock).toMatchObject({ type: 'image', data: 'abc123', mimeType: 'image/jpeg' })
    expect(result.details).toEqual({ previewPath: '/tmp/snap-001.jpg' })
  })

  it('app_not_running 时仅返回 text JSON 失败', async () => {
    const execute = registerAndGetExecute({
      screenshot: vi.fn(async () => ({ ok: false as const, error: 'app_not_running' })),
      getSnapshotCache: vi.fn(),
    })

    const result = await execute('call-2', {})
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'app_not_running' })
    expect(result.content?.some((c) => c.type === 'image')).toBe(false)
    expect(result.details).toBeUndefined()
  })

  it('screenshot 抛错时映射为 capture_failed', async () => {
    const execute = registerAndGetExecute({
      screenshot: vi.fn(async () => {
        throw new Error('capturePage failed')
      }),
      getSnapshotCache: vi.fn(),
    })

    const result = await execute('call-3', {})
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'capture_failed' })
  })
})
