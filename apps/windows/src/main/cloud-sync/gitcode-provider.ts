/**
 * GitCode 提供商实现。
 *
 * 认证走 OAuth token + x-oauth-basic（与 GitHub 一致）。GitCode 是本期唯一实现，
 * GitHub / Gitee 后续各加一个实现并在 git-provider.ts 注册。
 */
import type { GitProvider } from './git-provider'

export const gitcodeProvider: GitProvider = {
  type: 'gitcode',
  auth: (token) => ({ username: token, password: 'x-oauth-basic' }),
  validateUrl: (url) =>
    /^https:\/\/gitcode\.com\/[^/]+\/[^/]+?(\.git)?$/.test(url.trim())
      ? { ok: true }
      : { ok: false, error: '仓库地址应形如 https://gitcode.com/用户名/仓库名.git' },
}
