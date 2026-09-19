/**
 * @vitest-environment node
 */
/**
 * platform/autostart 的行为规格。
 *
 * 重点是两件事：
 * 1. **AppImage 必须用 `process.env.APPIMAGE`**（设计点名）。AppImage 运行时
 *    `process.execPath` 指向 `/tmp/.mount_xxx/` 的临时挂载点，进程退出即消失；
 *    写进 .desktop 会导致下次开机指向不存在的路径——**这个 bug 只在重启后才显形**，
 *    是那种「测不出来但一定会踩」的类型。
 * 2. `.desktop` 的 `Exec` 路径**必须加引号**：家目录含空格时（`/home/john doe/`）
 *    不加引号会被按空格切成多个参数。
 *
 * 这些用例直接调 `setLinuxAutostart` 等函数（不经过 `getOpenAtLogin` 的平台分派），
 * 因此**在 Windows 上也能跑**——它们验证的是 Linux 侧实现本身的正确性。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// electron 的 app 在测试环境不可用；autostart 只在非 Linux 分支才碰它
vi.mock('electron', () => ({
  app: {
    getLoginItemSettings: () => ({ openAtLogin: false }),
    setLoginItemSettings: vi.fn(),
  },
}))

import {
  resolveAutostartExecPath,
  STARTUP_ARG,
  isLinuxAutostartEnabled,
  setLinuxAutostart,
} from './autostart'

const originalAppImage = process.env.APPIMAGE
const originalExecPath = process.execPath

afterEach(() => {
  if (originalAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = originalAppImage
  Object.defineProperty(process, 'execPath', { value: originalExecPath, configurable: true })
})

describe('resolveAutostartExecPath', () => {
  it('AppImage 环境下用 APPIMAGE 而非 execPath（execPath 指向临时挂载点）', () => {
    process.env.APPIMAGE = '/home/x/Applications/Lumii-0.1.4-x86_64.AppImage'
    Object.defineProperty(process, 'execPath', {
      value: '/tmp/.mount_LumiiAbCdEf/lumii',
      configurable: true,
    })

    const resolved = resolveAutostartExecPath()

    expect(resolved).toBe('/home/x/Applications/Lumii-0.1.4-x86_64.AppImage')
    expect(resolved).not.toContain('/tmp/.mount_')
  })

  it('非 AppImage（deb 安装 / 开发态）用 execPath', () => {
    delete process.env.APPIMAGE
    Object.defineProperty(process, 'execPath', {
      value: '/opt/Lumii/lumii',
      configurable: true,
    })

    expect(resolveAutostartExecPath()).toBe('/opt/Lumii/lumii')
  })

  it('APPIMAGE 为空串时退回 execPath（视为未设置）', () => {
    process.env.APPIMAGE = ''
    Object.defineProperty(process, 'execPath', { value: '/opt/Lumii/lumii', configurable: true })

    expect(resolveAutostartExecPath()).toBe('/opt/Lumii/lumii')
  })
})

/**
 * 写文件那部分**不改 `os.homedir()`**（那会波及同进程的其他测试），
 * 而是直接对真实路径读写作断言、结束前清干净。
 * `~/.config/autostart` 本就是用户目录，写一个测试文件进去再删掉是可接受的。
 */
describe('setLinuxAutostart — 真实读写 .desktop', () => {
  const file = path.join(os.homedir(), '.config', 'autostart', 'lumii.desktop')

  afterEach(() => {
    fs.rmSync(file, { force: true })
  })

  it('开启后文件存在，关闭后文件被删除', () => {
    setLinuxAutostart(true)
    expect(fs.existsSync(file)).toBe(true)
    expect(isLinuxAutostartEnabled()).toBe(true)

    setLinuxAutostart(false)
    expect(fs.existsSync(file)).toBe(false)
    expect(isLinuxAutostartEnabled()).toBe(false)
  })

  it('关闭一个本来就没开的自启不报错（幂等）', () => {
    fs.rmSync(file, { force: true })

    expect(() => setLinuxAutostart(false)).not.toThrow()
  })

  it('.desktop 内容含必需字段与启动参数', () => {
    Object.defineProperty(process, 'execPath', { value: '/opt/Lumii/lumii', configurable: true })
    delete process.env.APPIMAGE

    setLinuxAutostart(true)
    const content = fs.readFileSync(file, 'utf8')

    expect(content).toContain('[Desktop Entry]')
    expect(content).toContain('Type=Application')
    expect(content).toContain('X-GNOME-Autostart-enabled=true')
    expect(content).toContain(STARTUP_ARG)
  })

  it('Exec 里的路径带引号（家目录含空格时不被切成多个参数）', () => {
    process.env.APPIMAGE = '/home/john doe/Apps/Lumii.AppImage'

    setLinuxAutostart(true)
    const execLine = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('Exec='))!

    expect(execLine).toContain('"/home/john doe/Apps/Lumii.AppImage"')
  })

  it('AppImage 场景下写入的是 APPIMAGE 路径而非临时挂载点', () => {
    process.env.APPIMAGE = '/home/x/Apps/Lumii.AppImage'
    Object.defineProperty(process, 'execPath', {
      value: '/tmp/.mount_LumiiXyz/lumii',
      configurable: true,
    })

    setLinuxAutostart(true)
    const content = fs.readFileSync(file, 'utf8')

    expect(content).toContain('/home/x/Apps/Lumii.AppImage')
    expect(content).not.toContain('/tmp/.mount_')
  })
})
