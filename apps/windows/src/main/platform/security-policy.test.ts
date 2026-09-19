/**
 * @vitest-environment node
 */
/**
 * platform/security-policy 的行为规格。
 *
 * 重点在三处**收敛后的语义**（都是设计 §5.4 的要求，且都踩过坑）：
 * 1. 命令白名单按平台分——Linux 上 `bash`/`ps` 必须放行，`powershell` 必须拒绝；
 * 2. `/^\/var/i` 收窄为 `/var/lib`+`/var/spool`，`/var/tmp` 不再被误伤；
 * 3. **凭证类**模式单独成组（`CREDENTIAL_FORBIDDEN`），因为「允许根优先」会
 *    顺手放行 `~/.ssh/id_rsa`——T3.4 实测踩到过，这里锁住。
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as os from 'node:os'
import { getSecurityPolicy, isUnderAllowedBase, CREDENTIAL_FORBIDDEN } from './security-policy'

const ORIGINAL_PLATFORM = process.platform

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
}

describe('getSecurityPolicy', () => {
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  })

  it('每次调用都读当前平台（不在模块顶层缓存——否则单测无法切平台）', () => {
    withPlatform('linux')
    const posix = getSecurityPolicy()
    withPlatform('win32')
    const win = getSecurityPolicy()

    expect(posix.allowedCommands).not.toEqual(win.allowedCommands)
    expect(posix.maxPathLength).not.toBe(win.maxPathLength)
  })

  it('允许根是家目录与临时目录（两平台一致）', () => {
    for (const platform of ['linux', 'win32'] as const) {
      withPlatform(platform)
      const policy = getSecurityPolicy()

      expect(policy.allowedBasePaths).toContain(os.homedir())
      expect(policy.allowedBasePaths).toContain(os.tmpdir())
    }
  })

  it('Windows：长度上限保持 260（这是越权防护，放宽会引入安全回归）', () => {
    withPlatform('win32')

    expect(getSecurityPolicy().maxPathLength).toBe(260)
  })

  it('POSIX：长度上限放宽到 PATH_MAX 量级', () => {
    withPlatform('linux')

    const len = getSecurityPolicy().maxPathLength
    expect(len).toBeGreaterThan(260)
    expect(len).toBeLessThanOrEqual(4096)
  })

  it('POSIX：命令白名单是 POSIX 命令，不含 Windows 命令', () => {
    withPlatform('linux')
    const policy = getSecurityPolicy()

    expect(policy.allowedCommands).toContain('bash')
    expect(policy.allowedCommands).toContain('ps')
    expect(policy.allowedCommands).not.toContain('powershell')
    expect(policy.allowedCommands).not.toContain('taskkill')
  })

  it('Windows：命令白名单保持收敛前的 6 个（不改变既有行为）', () => {
    withPlatform('win32')

    expect(getSecurityPolicy().allowedCommands).toEqual([
      'powershell',
      'cmd',
      'tasklist',
      'taskkill',
      'systeminfo',
      'wmic',
    ])
  })

  it('/var 已收窄：/var/lib 与 /var/spool 在列，/var/tmp 不再被黑名单命中', () => {
    withPlatform('linux')
    const { forbiddenPatterns } = getSecurityPolicy()

    const hits = (p: string): boolean => forbiddenPatterns.some((re) => re.test(p))
    expect(hits('/var/lib/mysql/data.bin')).toBe(true)
    expect(hits('/var/spool/cron/root')).toBe(true)
    expect(hits('/var/tmp/scratch.txt')).toBe(false)
  })

  it('POSIX 补上了 /usr /boot /proc /sys /dev /root', () => {
    withPlatform('linux')
    const { forbiddenPatterns } = getSecurityPolicy()

    for (const p of ['/usr/bin/ls', '/boot/vmlinuz', '/proc/1/environ', '/sys/kernel', '/dev/sda', '/root/.bashrc']) {
      expect(forbiddenPatterns.some((re) => re.test(p)), p).toBe(true)
    }
  })

  it('两平台都拦路径遍历（限定为路径组件，不误伤 a..b.txt）', () => {
    const check = (platform: NodeJS.Platform): void => {
      withPlatform(platform)
      const { forbiddenPatterns } = getSecurityPolicy()
      const hits = (p: string): boolean => forbiddenPatterns.some((re) => re.test(p))

      expect(hits('/tmp/../etc/passwd')).toBe(true)
      expect(hits('/home/x/a..b.txt')).toBe(false)
    }

    check('linux')
    check('win32')
  })

  it('凭证类模式两平台都有（且独立成组，供调用方优先判断）', () => {
    for (const re of CREDENTIAL_FORBIDDEN) {
      expect(re).toBeInstanceOf(RegExp)
    }

    const hits = (p: string): boolean => CREDENTIAL_FORBIDDEN.some((re) => re.test(p))
    expect(hits('/home/x/.ssh/id_rsa')).toBe(true)
    expect(hits('/home/x/.aws/credentials')).toBe(true)
    expect(hits('/home/x/.kube/config')).toBe(true)
    expect(hits('/home/x/project/.env')).toBe(true)
    // 看的是路径组件，不是子串
    expect(hits('/home/x/docs/.sshconfig.md')).toBe(false)
    expect(hits('/home/x/environment.md')).toBe(false)
  })
})

describe('isUnderAllowedBase', () => {
  it('完全相等算在内', () => {
    expect(isUnderAllowedBase('/home/x', ['/home/x'])).toBe(true)
  })

  it('子路径算在内', () => {
    expect(isUnderAllowedBase('/home/x/docs/a.txt', ['/home/x'])).toBe(true)
  })

  it('前缀相同但不是子路径的不算（/home/xy 不属于 /home/x）', () => {
    expect(isUnderAllowedBase('/home/xy/a.txt', ['/home/x'])).toBe(false)
  })

  it('Windows 上分隔符混用也能判对', () => {
    expect(isUnderAllowedBase('C:\\Users\\x\\docs', ['C:/Users/x'])).toBe(true)
  })

  it('允许根末尾的分隔符不影响判断', () => {
    expect(isUnderAllowedBase('/home/x/docs', ['/home/x/'])).toBe(true)
    expect(isUnderAllowedBase('C:\\Users\\x\\docs', ['C:\\Users\\x\\'])).toBe(true)
  })

  it('空值不崩', () => {
    expect(isUnderAllowedBase('/home/x', [])).toBe(false)
    expect(isUnderAllowedBase('/home/x', [''])).toBe(false)
  })
})
