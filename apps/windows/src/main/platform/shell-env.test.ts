/**
 * @vitest-environment node
 */
/**
 * platform/shell-env 的行为规格。
 *
 * 这块是**安全边界**：技能脚本可能来自技能市场，是不可信代码，而主进程环境里
 * 躺着模型 API key、数据库凭证。所以测试要同时盯住两件事：
 * 1. **该给的必须给**（缺 LANG 会让 Linux 上中文变 `?`，缺 DISPLAY 会让通知静默失败）
 * 2. **不该给的一个都不能漏**（任何看起来像密钥/凭证的变量都不能进去）
 *
 * 第 2 条用「往 process.env 里塞诱饵」的方式验证，而不是逐个列举已知密钥名——
 * 列举法挡不住将来新增的变量名。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildSafeChildEnv } from './shell-env'

const ORIGINAL_PLATFORM = process.platform

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('buildSafeChildEnv', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
    // 还原被诱饵污染的变量
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key]
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (process.env[key] !== value) process.env[key] = value
    }
  })

  describe('两平台通用', () => {
    it('一定包含 PATH / HOME / TEMP / SKILL_PARAMS', () => {
      const env = buildSafeChildEnv({ a: 1 })

      expect(env.PATH).toBeDefined()
      expect(env.HOME).toBeDefined()
      expect(env.TEMP).toBeDefined()
      expect(env.SKILL_PARAMS).toBe('{"a":1}')
    })

    it('SKILL_PARAMS 不被 extra 覆盖（它是参数唯一真源）', () => {
      const env = buildSafeChildEnv({ real: true }, { SKILL_PARAMS: '{"fake":true}' })

      expect(env.SKILL_PARAMS).toBe('{"real":true}')
    })

    it('extra 里的其它变量正常合入', () => {
      const env = buildSafeChildEnv({}, { NODE_OPTIONS: '--max-old-space-size=256' })

      expect(env.NODE_OPTIONS).toBe('--max-old-space-size=256')
    })

    it('进程里没有的键不产生空字符串（避免子进程读到「存在但为空」）', () => {
      delete process.env.SYSTEMROOT
      withPlatform('win32')
      const env = buildSafeChildEnv({})

      expect('SYSTEMROOT' in env).toBe(false)
    })
  })

  describe('POSIX 分支', () => {
    beforeEach(() => {
      withPlatform('linux')
    })

    it('带上 LANG——缺了会让中文输出变 ?（POSIX 靠 locale 决定编码）', () => {
      process.env.LANG = 'zh_CN.UTF-8'
      const env = buildSafeChildEnv({})

      expect(env.LANG).toBe('zh_CN.UTF-8')
    })

    it('LC_* 按前缀收全（逐个列举会漏）', () => {
      process.env.LC_ALL = 'zh_CN.UTF-8'
      process.env.LC_MESSAGES = 'C'
      const env = buildSafeChildEnv({})

      expect(env.LC_ALL).toBe('zh_CN.UTF-8')
      expect(env.LC_MESSAGES).toBe('C')
    })

    it('带上桌面会话变量——技能里的 notify-send / GUI 拉起靠它们', () => {
      process.env.DISPLAY = ':0'
      process.env.WAYLAND_DISPLAY = 'wayland-0'
      process.env.XAUTHORITY = '/run/user/1000/xauth'
      process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/run/user/1000/bus'
      const env = buildSafeChildEnv({})

      expect(env.DISPLAY).toBe(':0')
      expect(env.WAYLAND_DISPLAY).toBe('wayland-0')
      expect(env.XAUTHORITY).toBe('/run/user/1000/xauth')
      expect(env.DBUS_SESSION_BUS_ADDRESS).toBe('unix:path=/run/user/1000/bus')
    })

    it('XDG_* 按前缀收全（XDG_RUNTIME_DIR 是 D-Bus 的必需项）', () => {
      process.env.XDG_RUNTIME_DIR = '/run/user/1000'
      process.env.XDG_CONFIG_HOME = '/home/x/.config'
      const env = buildSafeChildEnv({})

      expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000')
      expect(env.XDG_CONFIG_HOME).toBe('/home/x/.config')
    })

    it('带上 SHELL / USER / TMPDIR', () => {
      process.env.SHELL = '/bin/bash'
      process.env.USER = 'x'
      process.env.TMPDIR = '/tmp'
      const env = buildSafeChildEnv({})

      expect(env.SHELL).toBe('/bin/bash')
      expect(env.USER).toBe('x')
      expect(env.TMPDIR).toBe('/tmp')
    })

    it('不把 Windows 变量带过去', () => {
      process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
      process.env.SYSTEMROOT = 'C:\\Windows'
      const env = buildSafeChildEnv({})

      expect(env.APPDATA).toBeUndefined()
      expect(env.SYSTEMROOT).toBeUndefined()
    })
  })

  describe('Windows 分支', () => {
    beforeEach(() => {
      withPlatform('win32')
    })

    it('带上 cmd.exe / powershell 正常启动所需的项', () => {
      process.env.SYSTEMROOT = 'C:\\Windows'
      process.env.COMSPEC = 'C:\\Windows\\system32\\cmd.exe'
      process.env.PATHEXT = '.COM;.EXE;.BAT'
      process.env.APPDATA = 'C:\\Users\\x\\AppData\\Roaming'
      const env = buildSafeChildEnv({})

      expect(env.SYSTEMROOT).toBe('C:\\Windows')
      expect(env.COMSPEC).toBe('C:\\Windows\\system32\\cmd.exe')
      expect(env.PATHEXT).toBe('.COM;.EXE;.BAT')
      expect(env.APPDATA).toBe('C:\\Users\\x\\AppData\\Roaming')
    })

    it('Program Files 这类带空格的键名原样保留', () => {
      process.env['ProgramFiles'] = 'C:\\Program Files'
      process.env['ProgramFiles(x86)'] = 'C:\\Program Files (x86)'
      const env = buildSafeChildEnv({})

      expect(env['ProgramFiles']).toBe('C:\\Program Files')
      expect(env['ProgramFiles(x86)']).toBe('C:\\Program Files (x86)')
    })

    it('不带 POSIX 桌面变量过去', () => {
      process.env.DISPLAY = ':0'
      process.env.XDG_RUNTIME_DIR = '/run/user/1000'
      const env = buildSafeChildEnv({})

      expect(env.DISPLAY).toBeUndefined()
      expect(env.XDG_RUNTIME_DIR).toBeUndefined()
    })
  })

  describe('安全边界：诱饵变量一个都不能漏', () => {
    beforeEach(() => {
      withPlatform('linux')
      // 塞一批「名字一看就是秘密」的变量，白名单必须全部挡住
      process.env.OPENAI_API_KEY = 'sk-secret'
      process.env.ANTHROPIC_API_KEY = 'sk-ant-secret'
      process.env.DATABASE_URL = 'postgres://user:pw@host/db'
      process.env.LUMII_TOKEN = 'token'
      process.env.AWS_SECRET_ACCESS_KEY = 'aws-secret'
      process.env.MY_CUSTOM_CREDENTIAL = 'cred'
      process.env.SECRET_KEY = 'secret'
    })

    afterEach(() => {
      for (const k of [
        'OPENAI_API_KEY',
        'ANTHROPIC_API_KEY',
        'DATABASE_URL',
        'LUMII_TOKEN',
        'AWS_SECRET_ACCESS_KEY',
        'MY_CUSTOM_CREDENTIAL',
        'SECRET_KEY',
      ]) {
        delete process.env[k]
      }
    })

    it('只放行白名单，密钥类变量全部挡在外面', () => {
      const env = buildSafeChildEnv({})
      const keys = Object.keys(env)

      // 用「键名含敏感词」的通用规则查，而不是逐个断言已知名字——
      // 列举法挡不住将来新增的变量名
      const suspicious = keys.filter((k) =>
        /KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|DATABASE_URL/i.test(k),
      )

      expect(suspicious).toEqual([])
    })

    it('不是process.env 的浅拷贝（否则白名单形同虚设）', () => {
      const env = buildSafeChildEnv({})

      expect(Object.keys(env).length).toBeLessThan(Object.keys(process.env).length)
      expect(env.OPENAI_API_KEY).toBeUndefined()
    })
  })
})
