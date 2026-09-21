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
import { registerBrowserTools, browserErrorText, browserEvalPayload } from './bridge-browser-tools'
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
  return stubBrowserContextThrowing(ROUTE_REACHED)
}

/** 同上，但可指定抛出什么——用来喂各条真实报错文案，验接线 */
function stubBrowserContextThrowing(message: string): BrowserRouteContext {
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
        throw new Error(message)
      },
    }),
    mapTabError: () => null,
    listProfiles: async () => [],
  } as unknown as BrowserRouteContext
}

/** 注册全部浏览器工具并取指定工具的 execute */
function registerAndGetExecute(toolName: string, thrown?: string) {
  const registry = new ToolRegistry()
  registerBrowserTools(
    registry,
    stubContext(),
    () => (thrown ? stubBrowserContextThrowing(thrown) : stubBrowserContext()),
  )
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

/**
 * browser_eval 的返回载荷（2026-09-21 修复）。
 *
 * 真实故障：某轮对话全程 0 次 `browser_navigate`，标签一直是启动时的 `about:blank`，
 * 模型却拿 `player is not defined` 去当「作用域问题」排查。`/act` 的 evaluate 分支
 * 本就回了 `url`，但 `pick` 只透出 `result`，模型无从知道自己不在目标页上。
 */
describe('browserEvalPayload —— 让模型看得见「我在哪个页面」', () => {
  it('普通页面：透出 result，并带上 url / targetId', () => {
    const payload = browserEvalPayload({
      result: { hp: 7 },
      url: 'file:///C:/ws/outputs/demo/demo2-canvas.html',
      targetId: 'ABC123',
    })
    expect(payload.result).toEqual({ hp: 7 })
    expect(payload.url).toBe('file:///C:/ws/outputs/demo/demo2-canvas.html')
    expect(payload.targetId).toBe('ABC123')
    // 非空白页不该多嘴
    expect(payload.note).toBeUndefined()
  })

  it.each(['about:blank', 'about:blank/', 'chrome://newtab', 'chrome://newtab/'])(
    '空白页 %s：额外给出「先导航」的可照做提示',
    (url) => {
      const payload = browserEvalPayload({ result: undefined, url })
      expect(payload.url).toBe(url)
      expect(String(payload.note)).toContain('browser_navigate')
      expect(String(payload.note)).toContain('空白页')
    },
  )

  it('旧服务端不回 url 时不报错、也不误报空白页', () => {
    const payload = browserEvalPayload({ result: 42 })
    expect(payload.result).toBe(42)
    expect(payload.url).toBeUndefined()
    expect(payload.note).toBeUndefined()
  })

  it('url 为空串（取不到页面）按「没有 url」处理，不触发空白页提示', () => {
    const payload = browserEvalPayload({ result: 1, url: '' })
    expect(payload.url).toBeUndefined()
    expect(payload.note).toBeUndefined()
  })
})

/**
 * 报错中文化。
 *
 * 两个方向都要锁，而且**透传那个方向更危险**：匹配写得太宽会把无关报错也吞掉，
 * 而这里流过的正是「路由到底命中没有」这类靠原文断言的信息（上面 `ROUTE_REACHED` 那几条）。
 */
describe('browserErrorText —— 报错中文化', () => {
  /**
   * 生产形态带 `Error: ` 前缀：dispatcher 用 `String(err)` 写进 body.error，
   * 客户端再 `new Error(该字符串)` 抛出，于是 message 里就带着它（真机实测确认）。
   * 匹配必须对这个前缀免疫，所以两种形态都跑。
   */
  const errorPrefix = (msg: string) => [msg, `Error: ${msg}`] as const

  it.each(errorPrefix('No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).'))(
    '没装浏览器：给中文说明 + 两条可照做的出路（原始形态：%s）',
    (raw) => {
      const zh = browserErrorText(new Error(raw))
      expect(zh).toContain('没有可用于浏览器控制的浏览器')
      expect(zh).toContain('Firefox 不支持')
      expect(zh).toContain('sudo snap install chromium')
      expect(zh).toContain('LUMII_BROWSER_EXECUTABLE')
    },
  )

  it.each(errorPrefix('browser.executablePath not found: /home/me/cft'))(
    'executablePath 指错：带上用户写的那条路径，并说明要指向文件本身（原始形态：%s）',
    (raw) => {
      const zh = browserErrorText(new Error(raw))
      expect(zh).toContain('/home/me/cft')
      expect(zh).toContain('不是它所在的目录')
    },
  )

  it.each(errorPrefix('Failed to start Chrome CDP on port 18791 for profile "mtbot".'))(
    'CDP 等不到：点出 AppArmor 沙箱这个最常见成因（原始形态：%s）',
    (raw) => {
      const zh = browserErrorText(new Error(raw))
      expect(zh).toContain('18791')
      expect(zh).toContain('AppArmor')
      expect(zh).toContain('LUMII_BROWSER_NO_SANDBOX=1')
    },
  )

  it.each(
    errorPrefix(
      'Failed to spawn browser executable at "/x/chrome": spawn EACCES. ' +
        'Please ensure the browser is installed correctly or configure browser.executablePath.',
    ),
  )('spawn 失败：翻出路径与底层原因（原始形态：%s）', (raw) => {
    const zh = browserErrorText(new Error(raw))
    // 只看中文段：`原始报错：` 之后是刻意保留的英文原文，不该拿它做断言
    const chinesePart = zh.split('原始报错：')[0]
    expect(chinesePart).toContain('/x/chrome')
    expect(chinesePart).toContain('EACCES')
    expect(chinesePart).not.toContain('Please ensure')
    expect(chinesePart).not.toContain('Failed to spawn')
  })

  it('认不出的报错原样透传（方向性风险：宁可漏翻，不可错翻）', () => {
    for (const raw of [
      'browser-route-reached',
      'url is required',
      'Unknown device "iPhone 15".',
      'HTTP 500',
      'Error: url is required',
    ]) {
      expect(browserErrorText(new Error(raw)), raw).toBe(raw)
    }
  })

  it('非 Error 值也能处理（catch 到的是 unknown）', () => {
    expect(browserErrorText('some string failure')).toBe('some string failure')
  })

  it('中文化后仍保留英文原文，便于搜索与按英文 grep 日志', () => {
    const raw = 'No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).'
    const zh = browserErrorText(new Error(`Error: ${raw}`))
    expect(zh).toContain(raw)
    // `Error: ` 是 String(err) 的产物，展示时剥掉
    expect(zh).toContain(`原始报错：${raw}`)
    expect(zh).not.toContain('原始报错：Error:')
  })

  it('透传时不动原文，连 Error: 前缀也照旧（只有翻译过的才剥）', () => {
    expect(browserErrorText(new Error('Error: some unknown failure'))).toBe(
      'Error: some unknown failure',
    )
  })
})

describe('browserErrorText —— 接线（两处 catch 是否真的走了它）', () => {
  const NO_BROWSER = 'No supported browser found (Chrome/Brave/Edge/Chromium on macOS, Linux, or Windows).'

  it('browser_navigate（wrapExecute 的 catch）返回中文', async () => {
    const execute = registerAndGetExecute('browser_navigate', NO_BROWSER)
    const payload = parseJsonToolResultPayload(await execute('tc1', { url: 'https://example.com' }))
    expect(payload?.ok).toBe(false)
    expect(String(payload?.error)).toContain('sudo snap install chromium')
  })

  it('browser_snapshot（自带 catch，不是 wrapExecute）同样返回中文', async () => {
    const execute = registerAndGetExecute('browser_snapshot', NO_BROWSER)
    const payload = parseJsonToolResultPayload(await execute('tc1', { full: true }))
    expect(payload?.ok).toBe(false)
    expect(String(payload?.error)).toContain('sudo snap install chromium')
  })
})

describe('buildWindowsBrowserConfig', () => {
  it('evaluateEnabled=true：否则 browser_eval 与 scroll/back/forward 全被 403 挡住', () => {
    expect(buildWindowsBrowserConfig().evaluateEnabled).toBe(true)
  })
})
