/**
 * GitCode 提供商实现。
 *
 * GitCode 基于 GitLab，HTTPS 认证用 OAuth2 风格（用户名 oauth2 + 密码填令牌），
 * 与 GitHub 的 x-oauth-basic 不同——后者会被 GitCode 判 401。GitCode 是本期唯一
 * 实现，GitHub / Gitee 后续各加一个实现并在 git-provider.ts 注册。
 */
import type { GitProvider } from './git-provider'

export const gitcodeProvider: GitProvider = {
  type: 'gitcode',
  auth: (token) => ({ username: 'oauth2', password: token }),
  validateUrl: (url) =>
    /^https:\/\/gitcode\.com\/[^/]+\/[^/]+?(\.git)?$/.test(url.trim())
      ? { ok: true }
      : { ok: false, error: '仓库地址应形如 https://gitcode.com/用户名/仓库名.git' },
}
