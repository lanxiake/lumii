/**
 * browser 工具回归测试（2026-09-20 修复）
 *
 * 三处真实故障：
 *  1. browser_eval 打 `/browser/eval` → 归一化后是 `/eval`，服务端根本没有该路由 → 恒定 404 "Not Found"
 *  2. Windows 配置 evaluateEnabled=false → `/act` 的 evaluate 分支 403（scroll / back / forward 同罪）
 *  3. media store 未注入 → `/screenshot`、`/pdf` 恒定 "media store not available"（落盘侧单测见 browser-media-store.test.ts）
 *
 * 这里用假 BrowserRouteContext 把第 1 条锁死：只要错误不是 "Not Found" 且带着假 context 的标记，
 * 就说明请求真的走进了 /act 处理器。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry, type ToolExecutionContext } from '@mtbot/agent-runtime'
import type { BrowserRouteContext } from '@mtbot/browser-control'
import { registerBrowserTools } from './bridge-browser-tools'
import { parseJsonToolResultPayload } from './bridge-utils'
import { buildWindowsBrowserConfig } from '../browser-service'

/** 假 context 的标记：走到 ensureTabAvailable 即证明路由命中 */
const ROUTE_REACHED = 'browser-route-reached'

/** 最小 ToolExecutionContext stub（与 bridge-app-ui-tools.test.ts 同形） */
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

/** 假浏览器 context：profile 解析成功，一碰 tab 就抛标记错误 */
function stubBrowserContext(): BrowserRouteContext {
  const profile = {
    name: 'mtbot',
    cdpUrl: 'http://127.0.0.1:18791',
    cdpPort: 18791,
    cdpIsLoopback: true,
    driver: 'direct' as const,
    color: '#4285F4',
  }
  return {
    state: () => ({
      resolved: { evaluateEnabled: true, defaultProfile: 'mtbot', profiles: {} },
      profiles: new Map(),
    }),
    forProfile: () => ({
      profile,
      ensureTabAvailable: async (): Promise<never> => {
        throw new Error(ROUTE_REACHED)
      },
    }),
    mapTabError: () => null,
    listProfiles: async () => [],
  } as unknown as BrowserRouteContext
}

/** 注册全部浏览器工具并取指定工具的 execute */
function registerAndGetExecute(toolName: string) {
  const registry = new ToolRegistry()
  registerBrowserTools(registry, stubContext(), () => stubBrowserContext())
  const tool = registry.get(toolName)
  expect(tool).toBeDefined()
  return tool!.execute.bind(tool)
}

describe('registerBrowserTools', () => {
  it('注册 10 个浏览器工具', () => {
    const registry = new ToolRegistry()
    registerBrowserTools(registry, stubContext(), () => stubBrowserContext())
    for (const name of [
      'browser_navigate',
      'browser_snapshot',
      'browser_screenshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_wait',
      'browser_eval',
      'browser_back',
      'browser_forward',
    ]) {
      expect(registry.get(name), `${name} 未注册`).toBeDefined()
    }
  })

  it.each([
    'browser_eval',
    'browser_scroll',
    'browser_back',
    'browser_forward',
    'browser_screenshot',
    'browser_snapshot',
  ])(
    '%s 命中真实路由，而不是 404 Not Found',
    async (toolName) => {
      const execute = registerAndGetExecute(toolName)
      const params =
        toolName === 'browser_eval'
          ? { script: 'document.title' }
          : toolName === 'browser_scroll'
            ? { direction: 'down' }
            : undefined
      const result = await execute('tc1', params)
      const payload = parseJsonToolResultPayload(result)
      expect(payload?.ok).toBe(false)
      expect(String(payload?.error)).toContain(ROUTE_REACHED)
      expect(String(payload?.error)).not.toContain('Not Found')
    },
  )

  it('browser_eval 无需 path 前缀（走 /act 的 evaluate 分支）', async () => {
    const execute = registerAndGetExecute('browser_eval')
    const result = await execute('tc1', { script: '1+1' })
    const payload = parseJsonToolResultPayload(result)
    // 报错来自假 profile 的 tab 阶段，说明 /act 处理器已命中且未在 kind 校验处被拦
    expect(String(payload?.error)).toContain(ROUTE_REACHED)
  })
})

describe('buildWindowsBrowserConfig', () => {
  it('evaluateEnabled=true：否则 browser_eval 与 scroll/back/forward 全被 403 挡住', () => {
    expect(buildWindowsBrowserConfig().evaluateEnabled).toBe(true)
  })
})
