import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@mtbot/agent-runtime'
import type { ToolExecutionContext } from '@mtbot/agent-runtime'
import type { AppUiController } from '../app-ui-control'
import { registerAppUiTools, resetAppUiToolTurnQuotas } from './bridge-app-ui-tools'
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

/** 最小 AppUiController stub（含 goto/click/type/key/scroll） */
function stubController(overrides: Partial<AppUiController> = {}): AppUiController {
  return {
    screenshot: vi.fn(),
    getSnapshotCache: vi.fn(),
    goto: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    key: vi.fn(),
    scroll: vi.fn(),
    ...overrides,
  }
}

/** 注册工具并返回指定工具的 execute */
function registerAndGetExecute(
  toolName: string,
  controller: AppUiController,
  deps: Partial<Parameters<typeof registerAppUiTools>[2]> = {},
) {
  resetAppUiToolTurnQuotas()
  const registry = new ToolRegistry()
  const ctx = stubContext()
  registerAppUiTools(registry, ctx, {
    getMainWindow: () => null,
    resizeImageIfNeeded: vi.fn(),
    controller,
    ...deps,
  })
  const tool = registry.get(toolName)
  expect(tool).toBeDefined()
  return tool!.execute.bind(tool)
}

describe('registerAppUiTools', () => {
  beforeEach(() => {
    resetAppUiToolTurnQuotas()
  })
  it('注册 app_screenshot：只读、无需权限、描述含「只截图，不操作」', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getMainWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_screenshot')
    expect(tool?.name).toBe('app_screenshot')
    expect(tool?.isReadOnly).toBe(true)
    expect(tool?.needsPermission).toBe(false)
    expect(tool?.description).toContain('只截图，不操作')
  })

  it('成功时返回 text JSON（含 view/hub）+ image 块，previewPath 在 details', async () => {
    const execute = registerAndGetExecute('app_screenshot', stubController({
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
    }))

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
    const execute = registerAndGetExecute('app_screenshot', stubController({
      screenshot: vi.fn(async () => ({ ok: false as const, error: 'app_not_running' })),
    }))

    const result = await execute('call-2', {})
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'app_not_running' })
    expect(result.content?.some((c) => c.type === 'image')).toBe(false)
    expect(result.details).toBeUndefined()
  })

  it('screenshot 抛错时映射为 capture_failed', async () => {
    const execute = registerAndGetExecute('app_screenshot', stubController({
      screenshot: vi.fn(async () => {
        throw new Error('capturePage failed')
      }),
    }))

    const result = await execute('call-3', {})
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'capture_failed' })
  })

  it('注册 app_goto：非只读、无需权限、描述含「不要点侧栏」', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getMainWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_goto')
    expect(tool?.name).toBe('app_goto')
    expect(tool?.isReadOnly).toBe(false)
    expect(tool?.needsPermission).toBe(false)
    expect(tool?.description).toContain('不要点侧栏')
  })

  it('app_goto 成功时返回 view/hub JSON', async () => {
    const goto = vi.fn(async () => ({
      ok: true as const,
      view: 'settings',
      hub: { open: true, tab: 'settings', category: 'voice' },
    }))
    const execute = registerAndGetExecute('app_goto', stubController({ goto }))

    const result = await execute('call-g1', { view: 'settings', category: 'voice' })
    expect(parseJsonToolResultPayload(result)).toEqual({
      ok: true,
      view: 'settings',
      hub: { open: true, tab: 'settings', category: 'voice' },
    })
    expect(goto).toHaveBeenCalledWith({ view: 'settings', category: 'voice' })
  })

  it('app_goto 失败时透传 controller 错误', async () => {
    const execute = registerAndGetExecute('app_goto', stubController({
      goto: vi.fn(async () => ({ ok: false as const, error: 'usage' })),
    }))

    const result = await execute('call-g2', { view: 'invalid' })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'usage' })
  })

  it('注册 app_act：非只读、需权限、描述含始终允许提示', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getMainWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_act')
    expect(tool?.name).toBe('app_act')
    expect(tool?.isReadOnly).toBe(false)
    expect(tool?.needsPermission).toBe(true)
    expect(tool?.description).toContain('始终允许')
    expect(tool?.description).toContain('禁止点聊天输入框和发送键')
  })

  it('app_act click 成功时返回 ok: true', async () => {
    const click = vi.fn(async () => ({ ok: true as const }))
    const execute = registerAndGetExecute('app_act', stubController({ click }))

    const result = await execute('call-a1', {
      action: 'click',
      ref: 'e3',
      snapshotId: 'snap-001',
    })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: true })
    expect(click).toHaveBeenCalledWith({
      action: 'click',
      ref: 'e3',
      snapshotId: 'snap-001',
    })
  })

  it('app_act 非 click action 返回 usage', async () => {
    const click = vi.fn()
    const execute = registerAndGetExecute('app_act', stubController({ click }))

    const result = await execute('call-a2', { action: 'invalid', ref: 'e1' })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'usage' })
    expect(click).not.toHaveBeenCalled()
  })

  it('app_act type 成功时调用 controller.type', async () => {
    const type = vi.fn(async () => ({ ok: true as const }))
    const execute = registerAndGetExecute('app_act', stubController({ type }))

    const result = await execute('call-a-type', {
      action: 'type',
      ref: 'e2',
      text: '你好',
      snapshotId: 'snap-001',
    })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: true })
    expect(type).toHaveBeenCalledWith({
      action: 'type',
      ref: 'e2',
      text: '你好',
      snapshotId: 'snap-001',
    })
  })

  it('app_act key 成功时调用 controller.key', async () => {
    const key = vi.fn(async () => ({ ok: true as const }))
    const execute = registerAndGetExecute('app_act', stubController({ key }))

    const result = await execute('call-a-key', { action: 'key', key: 'Tab' })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: true })
    expect(key).toHaveBeenCalledWith({ action: 'key', key: 'Tab' })
  })

  it('app_act scroll 成功时调用 controller.scroll', async () => {
    const scroll = vi.fn(async () => ({ ok: true as const }))
    const execute = registerAndGetExecute('app_act', stubController({ scroll }))

    const result = await execute('call-a-scroll', {
      action: 'scroll',
      ref: 'e5',
      dy: 200,
      snapshotId: 'snap-001',
    })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: true })
    expect(scroll).toHaveBeenCalledWith({
      action: 'scroll',
      ref: 'e5',
      dy: 200,
      snapshotId: 'snap-001',
    })
  })

  it('app_act 描述含 type/key/scroll 说明', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getMainWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_act')
    expect(tool?.description).toContain('app_act type')
    expect(tool?.description).toContain('app_act key')
    expect(tool?.description).toContain('app_act scroll')
  })

  it('app_act click 失败时透传 controller 错误', async () => {
    const execute = registerAndGetExecute('app_act', stubController({
      click: vi.fn(async () => ({ ok: false as const, error: 'stale_snapshot' })),
    }))

    const result = await execute('call-a3', {
      action: 'click',
      ref: 'e1',
      snapshotId: 'snap-old',
    })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'stale_snapshot' })
  })

  it('总开关关闭时三工具均返回 disabled', async () => {
    const disabledDeps = {
      readSettingsJson: async () =>
        JSON.stringify({ privacy: { allowAgentAppUiControl: false } }),
    }
    const screenshot = vi.fn(async () => ({ ok: true as const, snapshotId: 's', imageBase64: 'x', mimeType: 'image/jpeg', width: 1, height: 1, viewState: { view: 'chat', hub: null }, refs: [], truncated: false, previewPath: '', windowVisible: true }))
    const goto = vi.fn(async () => ({ ok: true as const, view: 'chat', hub: null }))
    const click = vi.fn(async () => ({ ok: true as const }))
    const ctrl = stubController({ screenshot, goto, click })

    for (const name of ['app_screenshot', 'app_goto', 'app_act'] as const) {
      const execute = registerAndGetExecute(name, ctrl, disabledDeps)
      const params = name === 'app_act' ? { action: 'click', ref: 'e1' } : name === 'app_goto' ? { view: 'chat' } : {}
      const result = await execute(`call-${name}`, params)
      expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'disabled' })
    }
    expect(screenshot).not.toHaveBeenCalled()
    expect(goto).not.toHaveBeenCalled()
    expect(click).not.toHaveBeenCalled()
  })

  it('screenshot 超出单轮配额 8 次后返回 quota_exceeded', async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap',
      imageBase64: 'abc',
      mimeType: 'image/jpeg',
      width: 100,
      height: 100,
      viewState: { view: 'chat', hub: null },
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap.jpg',
      windowVisible: true,
    }))
    const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))

    for (let i = 0; i < 8; i++) {
      const result = await execute(`call-q${i}`, {})
      expect(parseJsonToolResultPayload(result)).toMatchObject({ ok: true })
    }
    const over = await execute('call-q9', {})
    expect(parseJsonToolResultPayload(over)).toEqual({ ok: false, error: 'quota_exceeded' })
    expect(screenshot).toHaveBeenCalledTimes(8)
  })

  it('resetAppUiToolTurnQuotas 后配额计数清零', async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap',
      imageBase64: 'abc',
      mimeType: 'image/jpeg',
      width: 100,
      height: 100,
      viewState: { view: 'chat', hub: null },
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap.jpg',
      windowVisible: true,
    }))
    const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))

    for (let i = 0; i < 8; i++) {
      await execute(`call-r${i}`, {})
    }
    expect(parseJsonToolResultPayload(await execute('call-r-over', {}))).toEqual({
      ok: false,
      error: 'quota_exceeded',
    })

    resetAppUiToolTurnQuotas()
    expect(parseJsonToolResultPayload(await execute('call-r-after', {}))).toMatchObject({ ok: true })
    expect(screenshot).toHaveBeenCalledTimes(9)
  })
})
