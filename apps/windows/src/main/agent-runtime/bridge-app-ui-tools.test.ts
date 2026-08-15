import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRegistry } from '@mtbot/agent-runtime'
import type { ToolExecutionContext } from '@mtbot/agent-runtime'
import type { AppUiController } from '../app-ui-control'
import { APP_UI_QUOTA, registerAppUiTools, resetAppUiToolTurnQuotas } from './bridge-app-ui-tools'
import { parseJsonToolResultPayload } from './bridge-utils'

/** Hub 未打开时的视图状态，多处 mock 复用 */
const CLOSED_HUB_VIEW_STATE = {
  view: 'chat',
  hub: { open: false, tab: null, category: null },
}

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

/** 最小 AppUiController stub（含 goto/click/type/select/key/scroll） */
function stubController(overrides: Partial<AppUiController> = {}): AppUiController {
  return {
    screenshot: vi.fn(),
    getSnapshotCache: vi.fn(),
    goto: vi.fn(),
    click: vi.fn(),
    type: vi.fn(),
    select: vi.fn(),
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
    getWindow: () => null,
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
      getWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_screenshot')
    expect(tool?.name).toBe('app_screenshot')
    expect(tool?.isReadOnly).toBe(true)
    expect(tool?.needsPermission).toBe(false)
    expect(tool?.description).toContain('只截图，不操作')
  })

  it('成功时只返回 text JSON（含 view/hub 与 imagePath），不内联 image 块，previewPath 在 details', async () => {
    const execute = registerAndGetExecute('app_screenshot', stubController({
      screenshot: vi.fn(async () => ({
        ok: true as const,
        snapshotId: 'snap-001',
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
      imagePath: '/tmp/snap-001.jpg',
    })
    expect(payload).not.toHaveProperty('previewPath')
    expect((payload as { imageBase64?: unknown }).imageBase64).toBeUndefined()

    // 不再把 JPEG base64 内联进上下文
    expect(result.content?.some((c) => c.type === 'image')).toBe(false)
    expect(result.details).toEqual({ previewPath: '/tmp/snap-001.jpg' })
  })

  it('app_screenshot 透传 annotate 与 target 参数', async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap',
      width: 100,
      height: 100,
      viewState: { view: 'chat', hub: { open: false, tab: null, category: null } },
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap.jpg',
      windowVisible: true,
    }))
    const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))

    await execute('call-annotate', { annotate: true, target: 'pet' })
    expect(screenshot).toHaveBeenCalledWith({ annotate: true, target: 'pet' })
  })

  it('app_not_running 时仅返回 text JSON 失败', async () => {
    const execute = registerAndGetExecute('app_screenshot', stubController({
      screenshot: vi.fn(async () => ({ ok: false as const, error: 'app_not_running' as const })),
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
      getWindow: () => null,
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
      goto: vi.fn(async () => ({ ok: false as const, error: 'usage' as const })),
    }))

    const result = await execute('call-g2', { view: 'invalid' })
    expect(parseJsonToolResultPayload(result)).toEqual({ ok: false, error: 'usage' })
  })

  it('注册 app_act：非只读、需权限、描述含始终允许提示', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getWindow: () => null,
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

  it('app_act scroll 成功时调用 controller.scroll 并回传滚动位置', async () => {
    const scrollResult = {
      ok: true as const,
      moved: true,
      container: 'div.settings-body',
      scrollTop: 200,
      scrollHeight: 900,
      clientHeight: 400,
      atTop: false,
      atBottom: false,
    }
    const scroll = vi.fn(async () => scrollResult)
    const execute = registerAndGetExecute('app_act', stubController({ scroll }))

    const result = await execute('call-a-scroll', {
      action: 'scroll',
      ref: 'e5',
      dy: 200,
      snapshotId: 'snap-001',
    })
    expect(parseJsonToolResultPayload(result)).toEqual(scrollResult)
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
      getWindow: () => null,
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
      click: vi.fn(async () => ({ ok: false as const, error: 'stale_snapshot' as const })),
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
    const screenshot = vi.fn(async () => ({ ok: true as const, snapshotId: 's', width: 1, height: 1, viewState: CLOSED_HUB_VIEW_STATE, refs: [], truncated: false, previewPath: '', windowVisible: true }))
    const goto = vi.fn(async () => ({ ok: true as const, ...CLOSED_HUB_VIEW_STATE }))
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

  it('app_act select 成功时调用 controller.select', async () => {
    const select = vi.fn(async () => ({
      ok: true as const,
      value: 'anthropic',
      label: 'Anthropic',
      options: [{ value: 'anthropic', label: 'Anthropic' }],
    }))
    const execute = registerAndGetExecute('app_act', stubController({ select }))

    const result = await execute('call-a-select', {
      action: 'select',
      ref: 'e3',
      value: 'anthropic',
      snapshotId: 'snap-001',
    })
    expect(parseJsonToolResultPayload(result)).toMatchObject({ ok: true, value: 'anthropic' })
    expect(select).toHaveBeenCalledWith({
      action: 'select',
      ref: 'e3',
      value: 'anthropic',
      snapshotId: 'snap-001',
    })
  })

  it('app_act 描述提示原生下拉框必须用 select', () => {
    const registry = new ToolRegistry()
    registerAppUiTools(registry, stubContext(), {
      getWindow: () => null,
      resizeImageIfNeeded: vi.fn(),
      controller: stubController(),
    })

    const tool = registry.get('app_act')
    expect(tool?.description).toContain('app_act select')
    expect(tool?.description).toContain('系统菜单')
  })

  it(`screenshot 超出单轮基础配额 ${APP_UI_QUOTA.screenshot.base} 次后返回 quota_exceeded 与等待秒数`, async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap',
      width: 100,
      height: 100,
      viewState: CLOSED_HUB_VIEW_STATE,
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap.jpg',
      windowVisible: true,
    }))
    const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))

    for (let i = 0; i < APP_UI_QUOTA.screenshot.base; i++) {
      const result = await execute(`call-q${i}`, {})
      expect(parseJsonToolResultPayload(result)).toMatchObject({ ok: true })
    }
    const over = await execute('call-q-over', {})
    const payload = parseJsonToolResultPayload(over) as Record<string, unknown>
    expect(payload).toMatchObject({
      ok: false,
      error: 'quota_exceeded',
      tool: 'screenshot',
      limit: APP_UI_QUOTA.screenshot.base,
      used: APP_UI_QUOTA.screenshot.base,
    })
    expect(typeof payload.retryAfterSec).toBe('number')
    expect(screenshot).toHaveBeenCalledTimes(APP_UI_QUOTA.screenshot.base)
  })

  it('长轮次每满一分钟自动续杯，录屏这类长任务不会卡死', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-15T12:00:00Z'))
    try {
      const screenshot = vi.fn(async () => ({
        ok: true as const,
        snapshotId: 'snap',
        width: 100,
        height: 100,
        viewState: CLOSED_HUB_VIEW_STATE,
        refs: [],
        truncated: false,
        previewPath: '/tmp/snap.jpg',
        windowVisible: true,
      }))
      const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))

      for (let i = 0; i < APP_UI_QUOTA.screenshot.base; i++) {
        await execute(`call-t${i}`, {})
      }
      expect(parseJsonToolResultPayload(await execute('call-t-over', {}))).toMatchObject({
        ok: false,
        error: 'quota_exceeded',
      })

      vi.setSystemTime(new Date('2026-08-15T12:01:00Z'))
      expect(parseJsonToolResultPayload(await execute('call-t-refill', {}))).toMatchObject({
        ok: true,
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('resetAppUiToolTurnQuotas 后配额计数清零', async () => {
    const screenshot = vi.fn(async () => ({
      ok: true as const,
      snapshotId: 'snap',
      width: 100,
      height: 100,
      viewState: CLOSED_HUB_VIEW_STATE,
      refs: [],
      truncated: false,
      previewPath: '/tmp/snap.jpg',
      windowVisible: true,
    }))
    const execute = registerAndGetExecute('app_screenshot', stubController({ screenshot }))
    const limit = APP_UI_QUOTA.screenshot.base

    for (let i = 0; i < limit; i++) {
      await execute(`call-r${i}`, {})
    }
    expect(parseJsonToolResultPayload(await execute('call-r-over', {}))).toMatchObject({
      ok: false,
      error: 'quota_exceeded',
    })

    resetAppUiToolTurnQuotas()
    expect(parseJsonToolResultPayload(await execute('call-r-after', {}))).toMatchObject({ ok: true })
    expect(screenshot).toHaveBeenCalledTimes(limit + 1)
  })
})
