/**
 * @vitest-environment node
 */
/**
 * security-utils 的现行行为规格。
 *
 * 为什么先写：`DEFAULT_CONFIG.allowedCommands` 是**纯 Windows 命令表**
 * （powershell / cmd / tasklist / taskkill / systeminfo / wmic），且
 * `forbiddenPatterns` 里混着 `/etc`、`/var` 这类 POSIX 路径。T3 要把这块
 * 按平台拆分（`main/platform/security-policy.ts`），按 D20「先补单测再重构」，
 * 这里先把**当前行为**钉住——尤其是 Windows 语义，改动后必须仍然成立。
 *
 * 注意 `isCommandAllowed` 的匹配方式：取命令首段做**精确**匹配，不做前缀/子串
 * 匹配。所以 `powershell.exe`、`C:\Windows\System32\taskkill.exe` 这类带路径或
 * 后缀的写法**会被拒**。这是现状（未必是设计意图），但重构前必须先固定下来，
 * 否则「顺手修好」会让 Windows 行为悄悄变化。
 */
import { describe, it, expect } from 'vitest'
import { SecurityUtils, validatePid, sanitizeFileName, sanitizeCommandArg, escapeRegExp } from './security-utils'

const utils = new SecurityUtils()

describe('SecurityUtils.isCommandAllowed — Windows 白名单', () => {
  it('放行白名单里的 6 个 Windows 命令', () => {
    for (const cmd of ['powershell', 'cmd', 'tasklist', 'taskkill', 'systeminfo', 'wmic']) {
      expect(utils.isCommandAllowed(cmd), cmd).toBe(true)
    }
  })

  it('大小写不敏感', () => {
    expect(utils.isCommandAllowed('PowerShell')).toBe(true)
    expect(utils.isCommandAllowed('TASKKILL')).toBe(true)
  })

  it('带参数时取命令名判断，参数不影响结果', () => {
    expect(utils.isCommandAllowed('taskkill /pid 1234 /T /F')).toBe(true)
  })

  it('首尾空白不影响判断', () => {
    expect(utils.isCommandAllowed('  tasklist  ')).toBe(true)
  })

  it('拒绝不在白名单里的命令', () => {
    for (const cmd of ['rm', 'curl', 'node', 'python', 'bash', 'sh', 'ls']) {
      expect(utils.isCommandAllowed(cmd), cmd).toBe(false)
    }
  })

  it('带路径的写法被拒——匹配是命令名精确相等，不做 basename 提取', () => {
    // 现状如此：`C:\Windows\System32\taskkill.exe` 的首段是 `c:`，对不上任何白名单项
    expect(utils.isCommandAllowed('C:\\Windows\\System32\\taskkill.exe')).toBe(false)
    expect(utils.isCommandAllowed('/usr/bin/ls')).toBe(false)
  })

  it('带 .exe 后缀的写法被拒——白名单里存的是不带后缀的名字', () => {
    expect(utils.isCommandAllowed('taskkill.exe')).toBe(false)
    expect(utils.isCommandAllowed('powershell.exe')).toBe(false)
  })

  it('空串与纯空白被拒', () => {
    expect(utils.isCommandAllowed('')).toBe(false)
    expect(utils.isCommandAllowed('   ')).toBe(false)
  })

  it('构造时可覆盖白名单（Linux 端接入点就在这里）', () => {
    const posix = new SecurityUtils({ allowedCommands: ['bash', 'sh', 'ls', 'pkill'] })

    expect(posix.isCommandAllowed('bash')).toBe(true)
    expect(posix.isCommandAllowed('powershell')).toBe(false)
  })
})

describe('SecurityUtils.validatePid', () => {
  it('接受正整数', () => {
    expect(validatePid(1)).toBe(1)
    expect(validatePid(4194304)).toBe(4194304)
  })

  it('拒绝非整数、零、负数', () => {
    expect(() => validatePid(0)).toThrow()
    expect(() => validatePid(-1)).toThrow()
    expect(() => validatePid(1.5)).toThrow()
  })

  it('拒绝非数字类型', () => {
    expect(() => validatePid('123')).toThrow()
    expect(() => validatePid(null)).toThrow()
    expect(() => validatePid(undefined)).toThrow()
  })

  it('拒绝超出上限的 PID', () => {
    expect(() => validatePid(4194305)).toThrow()
  })
})

describe('SecurityUtils.validatePath — 路径遍历与系统目录', () => {
  it('放行家目录下的普通路径', () => {
    const home = require('node:os').homedir()
    expect(() => utils.validatePath(`${home}/documents/note.txt`)).not.toThrow()
  })

  it('拒绝路径遍历（.. 作为路径组件）', () => {
    expect(() => utils.validatePath('/tmp/../../etc/passwd')).toThrow()
  })

  it('不误伤文件名里含 .. 的正常路径', () => {
    // 正则用 (?:^|[\\/])\.\.(?:[\\/]|$) 限定路径组件，`a..b` 这类不该被拦
    const home = require('node:os').homedir()
    expect(() => utils.validatePath(`${home}/a..b.txt`)).not.toThrow()
  })

  it('拒绝 /etc 与 /var 下的路径', () => {
    expect(() => utils.validatePath('/etc/passwd')).toThrow()
    expect(() => utils.validatePath('/var/log/syslog')).toThrow()
  })

  it('拒绝 SSH / 云凭证目录', () => {
    expect(() => utils.validatePath('/home/x/.ssh/id_rsa')).toThrow()
    expect(() => utils.validatePath('/home/x/.aws/credentials')).toThrow()
  })
})

describe('SecurityUtils 清洗函数', () => {
  it('sanitizeFileName 去掉路径分隔符', () => {
    const out = sanitizeFileName('../../etc/passwd')

    expect(out).not.toContain('/')
    expect(out).not.toContain('\\')
  })

  it('sanitizeCommandArg 去掉 shell 元字符', () => {
    const out = sanitizeCommandArg('a; rm -rf /')

    expect(out).not.toContain(';')
  })

  it('sanitizeCommandArg 去掉换行（防止参数注入第二条命令）', () => {
    const out = sanitizeCommandArg('a\nb')

    expect(out).not.toContain('\n')
  })

  it('escapeRegExp 让用户输入可以安全拼进正则', () => {
    const re = new RegExp(escapeRegExp('a.b*c'))

    expect(re.test('a.b*c')).toBe(true)
    expect(re.test('axbxc')).toBe(false)
  })
})
