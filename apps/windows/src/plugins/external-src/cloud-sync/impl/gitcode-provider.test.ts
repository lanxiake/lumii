/**
 * gitcode-provider 单元测试：validateUrl 接受/拒绝样例。
 */
import { describe, expect, it } from 'vitest'
import { gitcodeProvider } from './gitcode-provider'
import { getProvider } from './git-provider'

describe('gitcodeProvider.validateUrl', () => {
  it('接受合法 GitCode 仓库地址', () => {
    expect(gitcodeProvider.validateUrl('https://gitcode.com/alice/notes.git').ok).toBe(true)
    expect(gitcodeProvider.validateUrl('https://gitcode.com/alice/notes').ok).toBe(true)
    expect(gitcodeProvider.validateUrl('  https://gitcode.com/alice/notes.git  ').ok).toBe(true)
  })

  it('拒绝其他平台或非法地址', () => {
    expect(gitcodeProvider.validateUrl('https://github.com/a/b.git').ok).toBe(false)
    expect(gitcodeProvider.validateUrl('https://gitee.com/a/b.git').ok).toBe(false)
    expect(gitcodeProvider.validateUrl('git@gitcode.com:a/b.git').ok).toBe(false)
    expect(gitcodeProvider.validateUrl('not-a-url').ok).toBe(false)
    expect(gitcodeProvider.validateUrl('').ok).toBe(false)
    expect(gitcodeProvider.validateUrl('https://gitcode.com/onlyuser').ok).toBe(false)
  })
})

describe('gitcodeProvider.auth', () => {
  it('使用 GitLab 风格 OAuth2 认证（用户名 oauth2 + 密码为令牌）', () => {
    expect(gitcodeProvider.auth('secret-token')).toEqual({
      username: 'oauth2',
      password: 'secret-token',
    })
  })
})

describe('getProvider', () => {
  it('gitcode 已注册', () => {
    expect(getProvider('gitcode')).toBe(gitcodeProvider)
  })

  it('未实现提供商抛错', () => {
    expect(() => getProvider('github' as never)).toThrow('未实现的 Git 提供商')
  })
})
