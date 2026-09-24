/**
 * @vitest-environment node
 */
/**
 * security-utils 的行为规格。
 *
 * 这块原本是「纯 Windows 命令表 + 混合路径黑名单」，T3.4 已按平台拆分
 * （`platform/security-policy.ts`）。因此**断言按平台分叉**：两个平台的语义
 * 都必须保住，不能为了让 Linux 变绿而删掉 Windows 侧的覆盖。
 *
 * 两处收敛后的**有意行为变化**（均在下面用测试固定）：
 * 1. **允许根优先于禁止模式**：家目录里名字碰巧撞上 `/secrets/i` 的正常文件
 *    不再被误拦（`~/secrets/notes.txt`）。但仍拦「路径遍历」这种结构性问题。
 * 2. **`/^\/var/i` 收窄**为 `/var/lib` + `/var/spool`（POSIX 侧），
 *    因此 `/var/tmp` 不再被黑名单命中——它是否可访问由允许根决定。
 */
import { describe, it, expect } from 'vitest'
import * as os from 'node:os'
import {
  SecurityUtils,
  sanitizeFileName,
  sanitizeCommandArg,
  escapeRegExp,
} from './security-utils'

const utils = new SecurityUtils()
const isWin = process.platform === 'win32'
const home = os.homedir()

describe('SecurityUtils.isCommandAllowed — 白名单按平台', () => {
  if (isWin) {
    it('放行白名单里的 6 个 Windows 命令', () => {
      for (const cmd of ['powershell', 'cmd', 'tasklist', 'taskkill', 'systeminfo', 'wmic']) {
        expect(utils.isCommandAllowed(cmd), cmd).toBe(true)
      }
    })

    it('拒绝 POSIX 命令（Windows 上不该放行）', () => {
      for (const cmd of ['bash', 'sh', 'ls', 'rm']) {
        expect(utils.isCommandAllowed(cmd), cmd).toBe(false)
      }
    })
  } else {
    it('放行 POSIX 侧的只读查询与进程管理命令', () => {
      for (const cmd of ['bash', 'sh', 'ps', 'kill', 'df', 'ls', 'cat', 'pgrep']) {
        expect(utils.isCommandAllowed(cmd), cmd).toBe(true)
      }
    })

    it('拒绝 Windows 命令（Linux 上它们根本不存在）', () => {
      for (const cmd of ['powershell', 'cmd', 'tasklist', 'taskkill', 'wmic']) {
        expect(utils.isCommandAllowed(cmd), cmd).toBe(false)
      }
    })

    it('拒绝会改状态或拉外部内容的命令', () => {
      // 技能有自己的执行通道（executeLocalCommand），这条白名单只服务
      // 系统信息类探测，所以不需要任意执行能力
      for (const cmd of ['rm', 'curl', 'wget', 'chmod', 'sudo', 'dd']) {
        expect(utils.isCommandAllowed(cmd), cmd).toBe(false)
      }
    })
  }

  it('大小写不敏感', () => {
    const anyAllowed = isWin ? 'PowerShell' : 'BASH'
    expect(utils.isCommandAllowed(anyAllowed)).toBe(true)
  })

  it('带参数时取命令名判断，参数不影响结果', () => {
    const cmdWithArgs = isWin ? 'taskkill /pid 1234 /T /F' : 'ps -eo pid,comm'
    expect(utils.isCommandAllowed(cmdWithArgs)).toBe(true)
  })

  it('首尾空白不影响判断', () => {
    const cmd = isWin ? '  tasklist  ' : '  df  '
    expect(utils.isCommandAllowed(cmd)).toBe(true)
  })

  it('带路径的写法被拒——匹配是命令名精确相等，不做 basename 提取', () => {
    // 现状如此（未必是设计意图），但重构前先固定住，避免「顺手修好」改变行为
    expect(utils.isCommandAllowed(isWin ? 'C:\\Windows\\System32\\taskkill.exe' : '/usr/bin/ls')).toBe(false)
  })

  it('带 .exe 后缀的写法被拒——白名单里存的是不带后缀的名字', () => {
    expect(utils.isCommandAllowed('taskkill.exe')).toBe(false)
    expect(utils.isCommandAllowed('powershell.exe')).toBe(false)
  })

  it('空串与纯空白被拒', () => {
    expect(utils.isCommandAllowed('')).toBe(false)
    expect(utils.isCommandAllowed('   ')).toBe(false)
  })

  it('构造时可覆盖白名单（自定义策略的接入点）', () => {
    const custom = new SecurityUtils({ allowedCommands: ['my-tool'] })

    expect(custom.isCommandAllowed('my-tool')).toBe(true)
    expect(custom.isCommandAllowed(isWin ? 'powershell' : 'bash')).toBe(false)
  })
})

describe('SecurityUtils.validatePath', () => {
  it('放行家目录下的普通路径', () => {
    expect(() => utils.validatePath(`${home}/documents/note.txt`)).not.toThrow()
  })

  it('拒绝路径遍历（.. 作为路径组件）', () => {
    expect(() => utils.validatePath('/tmp/../../etc/passwd')).toThrow()
  })

  it('不误伤文件名里含 .. 的正常路径', () => {
    // 正则用 (?:^|[\\/])\.\.(?:[\\/]|$) 限定路径组件，`a..b` 这类不该被拦
    expect(() => utils.validatePath(`${home}/a..b.txt`)).not.toThrow()
  })

  it('拒绝系统目录', () => {
    for (const p of isWin ? ['C:\\Windows\\System32\\x.dll'] : ['/etc/passwd', '/usr/bin/ls', '/boot/vmlinuz']) {
      expect(() => utils.validatePath(p), p).toThrow()
    }
  })

  it('拒绝 SSH / 云凭证目录', () => {
    expect(() => utils.validatePath(`${home}/.ssh/id_rsa`)).toThrow()
    expect(() => utils.validatePath(`${home}/.aws/credentials`)).toThrow()
  })

  it('允许根优先：家目录下名字撞黑名单的正常文件不再被误拦', () => {
    // 这条是 T3.4 的**有意放宽**：`/secrets/i` 是模糊匹配，会误伤正常文件名；
    // 允许根（家目录）是明确的白名单意图，压过黑名单的模糊匹配
    expect(() => utils.validatePath(`${home}/secrets/notes.txt`)).not.toThrow()
  })

  it('凭证类路径即使在家目录内也必须拦（允许根不能短路凭证保护）', () => {
    // 回归：T3.4 实行「允许根优先」时曾顺手放行 `~/.ssh/id_rsa`——
    // 它同样在家目录内。凭证属于「不可放行」，与「名字碰巧撞黑名单」是两回事，
    // 故 `CREDENTIAL_FORBIDDEN` 单独一组、优先于允许根判断。
    for (const p of [
      `${home}/.ssh/id_rsa`,
      `${home}/.aws/credentials`,
      `${home}/.gnupg/secring.gpg`,
      `${home}/.kube/config`,
      `${home}/.docker/config.json`,
    ]) {
      expect(() => utils.validatePath(p), p).toThrow()
    }
  })

  it('凭证类判断看的是**路径组件**，不是子串（不误伤 .sshrc 这类文件名）', () => {
    expect(() => utils.validatePath(`${home}/docs/.sshconfig.md`)).not.toThrow()
  })

  it('但允许根内的「路径遍历」仍被拦（结构性规则不放宽）', () => {
    expect(() => utils.validatePath(`${home}/../../etc/passwd`)).toThrow()
  })

  it('相对路径必须给 basePath', () => {
    expect(() => utils.validatePath('relative/file.txt')).toThrow()
    expect(() => utils.validatePath('relative/file.txt', home)).not.toThrow()
  })

  it('basePath 之外的路径被拦（遍历防护）', () => {
    expect(() => utils.validatePath('../outside.txt', `${home}/inside`)).toThrow()
  })

  if (!isWin) {
    it('POSIX：/var/tmp 不再被黑名单误伤（/^\\/var/i 已收窄）', () => {
      // 收窄后 /var/tmp 不属于禁止模式；是否可写由允许根决定——
      // 这里显式把它加进允许根，验证拦截确实来自「不在允许根」而非黑名单
      const custom = new SecurityUtils({ allowedBasePaths: ['/var/tmp'] })
      expect(() => custom.validatePath('/var/tmp/x.txt')).not.toThrow()
    })

    it('POSIX：/var/lib 与 /var/spool 仍被拦（收窄后的应有行为）', () => {
      expect(() => utils.validatePath('/var/lib/mysql/data.bin')).toThrow()
      expect(() => utils.validatePath('/var/spool/cron/root')).toThrow()
    })

    it('POSIX：路径长度上限不再是 Windows 的 260', () => {
      const longPath = `/tmp/${'a'.repeat(300)}.txt`
      expect(() => utils.validatePath(longPath)).not.toThrow()
    })

    it('POSIX：仍拦超长路径（放宽不等于取消）', () => {
      const tooLong = `/tmp/${'a'.repeat(1100)}.txt`
      expect(() => utils.validatePath(tooLong)).toThrow()
    })
  }
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
