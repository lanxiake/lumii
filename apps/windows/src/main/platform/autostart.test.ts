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
import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
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

  /** 用户**真实的**初始状态，全部用例跑完后按它还原 */
  const TRUE_ORIGINAL = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  /** 模拟「用户本来就用设置页开着自启」时该文件长什么样 */
  const USER_OWNED = '[Desktop Entry]\nName=Lumii\nExec="/opt/Lumii/lumii" --startup-launched\n'

  // 在**收集期**就放一份用户文件，因而先于所有 beforeEach 执行。
  // 这样整组用例都跑在「用户本来就开着自启」的前提下——
  // 本机恰好没有这个文件，不造出这个前提就永远测不到下面那条断言。
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, USER_OWNED, 'utf8')

  /**
   * 全部用例（含 afterEach）跑完后断言：用户那份文件必须**原样还在**。
   *
   * 这是对 afterEach **接线**的唯一有效断言——用例内部直接调 restoreSnapshot()
   * 只能证明那个函数对；把 afterEach 改成不调它（或改回无条件 rmSync），
   * 只有这里会红。先前用「照抄一遍还原逻辑」的写法验证过一版，
   * 变异测试显示它抓不到，故改为在 describe 末尾收口。
   */
  afterAll(() => {
    const stillThere = fs.existsSync(file)
    const content = stillThere ? fs.readFileSync(file, 'utf8') : null
    // 先还原真实状态再断言：断言失败时也不该把用户的目录留在半路
    if (TRUE_ORIGINAL === null) fs.rmSync(file, { force: true })
    else fs.writeFileSync(file, TRUE_ORIGINAL, 'utf8')

    expect(stillThere, '用户原有的 autostart 文件被测试用例删掉了').toBe(true)
    expect(content).toBe(USER_OWNED)
  })

  let savedContent: string | null = null

  /**
   * 把 `~/.config/autostart/lumii.desktop` 还原成快照状态。
   *
   * 抽成具名函数是为了让 `afterEach` 与用例共用同一份实现——但**仅靠共用还不够**：
   * 用例直接调用它，只能证明这个函数对；把 afterEach 改成不调它，用例照样绿。
   * 真正管住那条接线的是下面 describe 末尾的 `afterAll`。
   */
  function restoreSnapshot(): void {
    if (savedContent === null) {
      fs.rmSync(file, { force: true })
      return
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, savedContent, 'utf8')
  }

  beforeEach(() => {
    savedContent = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
    fs.rmSync(file, { force: true })
  })

  afterEach(restoreSnapshot)

  it('开启后文件存在，关闭后文件被删除', () => {
    setLinuxAutostart(true)
    expect(fs.existsSync(file)).toBe(true)
    expect(isLinuxAutostartEnabled()).toBe(true)

    setLinuxAutostart(false)
    expect(fs.existsSync(file)).toBe(false)
    expect(isLinuxAutostartEnabled()).toBe(false)
  })

  it('跑完这组用例不会改动用户原有的自启状态', () => {
    // 回归本体：先写入一份「用户已有的」内容，模拟「本来就开着自启」的机器，
    // 再用例跑一遍——afterEach 必须把它原样放回去，而不是删掉
    const userOwned = '[Desktop Entry]\nName=Lumii\nExec="/opt/Lumii/lumii" --startup-launched\n'
    // 用「存旧值再还原」而不是直接置 null：真实快照未必是 null
    // （describe 收集期已经放了一份 USER_OWNED 来模拟用户开着自启），
    // 置 null 会让**后续**每条用例的 afterEach 都去删文件，本用例却照样绿
    const prevSnapshot = savedContent
    savedContent = userOwned

    setLinuxAutostart(true)
    expect(fs.readFileSync(file, 'utf8')).not.toBe(userOwned) // 用例确实覆盖过它

    // 调用 afterEach **同一个函数**（不是照抄一份逻辑）
    restoreSnapshot()
    expect(fs.readFileSync(file, 'utf8')).toBe(userOwned)

    savedContent = prevSnapshot
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
