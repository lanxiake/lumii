/**
 * browser-service 单元测试
 *
 * 锁两件事：浏览器可执行文件的**覆盖通道**与其**沙箱开关**。
 *
 * 背景：`resolveBrowserExecutableForPlatform()` 只认系统级安装路径（`/usr/bin/*`、`/snap/bin/*`），
 * 而 Ubuntu 24.04 桌面默认只装 Firefox，Firefox 不支持 CDP——于是 Linux 上浏览器控制
 * 开箱即坏（实测 `No supported browser found`）。两个环境变量是给用户的逃生口：
 * 让任意一份自己下载的 Chromium 可用，不必写进系统目录。
 *
 * 判据要点：
 * - 未设置 / 空白串都必须是 `undefined`——否则会把 `""` 当路径传给下游，
 *   `resolveBrowserExecutableForPlatform()` 会因「路径不存在」抛错，而用户根本没配过
 * - `LUMII_BROWSER_NO_SANDBOX` 只认 `1` / `true`，其余（含 `0`/`false`/拼错）一律为假：
 *   它关掉的是渲染进程沙箱，**宁可误判为「不开」也不能误判为「开」**
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildWindowsBrowserConfig } from './browser-service'

const ENV_PATH = 'LUMII_BROWSER_EXECUTABLE'
const ENV_NO_SANDBOX = 'LUMII_BROWSER_NO_SANDBOX'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('buildWindowsBrowserConfig —— 浏览器可执行文件覆盖', () => {
  it('未设置环境变量时 executablePath 为 undefined，交由原生探测', () => {
    vi.stubEnv(ENV_PATH, undefined)
    expect(buildWindowsBrowserConfig().executablePath).toBeUndefined()
  })

  it('设置为空串时按未设置处理', () => {
    vi.stubEnv(ENV_PATH, '')
    expect(buildWindowsBrowserConfig().executablePath).toBeUndefined()
  })

  it('纯空白按未设置处理，不能当成路径传下去', () => {
    vi.stubEnv(ENV_PATH, '   ')
    expect(buildWindowsBrowserConfig().executablePath).toBeUndefined()
  })

  it('设置了环境变量时用它', () => {
    vi.stubEnv(ENV_PATH, '/opt/chrome-for-testing/chrome-linux64/chrome')
    expect(buildWindowsBrowserConfig().executablePath).toBe(
      '/opt/chrome-for-testing/chrome-linux64/chrome',
    )
  })

  it('两端空白被裁掉', () => {
    vi.stubEnv(ENV_PATH, '  /usr/bin/chromium  ')
    expect(buildWindowsBrowserConfig().executablePath).toBe('/usr/bin/chromium')
  })
})

describe('buildWindowsBrowserConfig —— 沙箱开关', () => {
  it('默认（未设置）为 false：不替用户做安全降级', () => {
    vi.stubEnv(ENV_NO_SANDBOX, undefined)
    expect(buildWindowsBrowserConfig().noSandbox).toBe(false)
  })

  it.each(['1', 'true', 'TRUE', 'True', ' true '])('取值 %s 时为 true', (raw) => {
    vi.stubEnv(ENV_NO_SANDBOX, raw)
    expect(buildWindowsBrowserConfig().noSandbox).toBe(true)
  })

  it.each(['0', 'false', 'FALSE', '', '   ', 'yes', 'on', 'no-sandbox'])(
    '取值 %j 时为 false（只认 1/true）',
    (raw) => {
      vi.stubEnv(ENV_NO_SANDBOX, raw)
      expect(buildWindowsBrowserConfig().noSandbox).toBe(false)
    },
  )
})
