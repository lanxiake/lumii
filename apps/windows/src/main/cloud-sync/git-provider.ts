/**
 * Git 提供商抽象。
 *
 * 三家平台在 isomorphic-git 视角只差认证头拼法与 URL 校验，接口按此收窄，
 * 不做泛化的平台 SDK 层。扩展 GitHub / Gitee 时各加一个 ~10 行实现并注册。
 */
import type { GitProviderType } from './types'
import { gitcodeProvider } from './gitcode-provider'

export interface GitProvider {
  readonly type: GitProviderType
  /** isomorphic-git onAuth 回调返回值 */
  auth(token: string): { username: string; password: string }
  /** 校验 repoUrl 是否属于本平台，返回人话错误 */
  validateUrl(repoUrl: string): { ok: true } | { ok: false; error: string }
}

const providers: Partial<Record<GitProviderType, GitProvider>> = {
  gitcode: gitcodeProvider,
}

export function getProvider(type: GitProviderType): GitProvider {
  const p = providers[type]
  if (!p) throw new Error(`未实现的 Git 提供商: ${type}`)
  return p
}
