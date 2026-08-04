/**
 * useAuth.ts - 认证管理 Hook（灵栖/Lumii 开源独立版）
 *
 * 独立版无服务端、无登录：本 Hook 返回恒定的本地用户，`isAuthenticated` 始终为 true。
 * 保留原有返回字段与方法签名，使所有消费者无需改动即可编译；
 * login/register/logout/refresh 均为空操作，不再调用 window.electronAPI.auth/api。
 */

import { useCallback, useState } from 'react'
import { useLocalStorage } from '../../common/useLocalStorage'
import type { User, RegisterParams, LoginParams, AuthResult } from './useAuth.types'

const STORAGE_KEY_USER = 'mtbot_user'

/** 独立版本地用户（无服务端账号体系，仅用于 UI 展示与本地 userId 归属） */
const LOCAL_USER: User = {
  id: 'local-user',
  displayName: '本地用户',
  createdAt: new Date(0).toISOString(),
}

export function useAuth() {
  // 允许用户在设置里改 displayName，持久化到 localStorage
  const [storedUser, setStoredUser] = useLocalStorage<User | null>(STORAGE_KEY_USER, LOCAL_USER)
  const user = storedUser ?? LOCAL_USER

  const [error, setError] = useState<string | null>(null)

  const setUser = useCallback(
    (next: User | null) => setStoredUser(next ?? LOCAL_USER),
    [setStoredUser],
  )

  const noopLogin = useCallback(
    async (_params: LoginParams): Promise<AuthResult> => ({ success: true }),
    [],
  )
  const noopRegister = useCallback(
    async (_params: RegisterParams): Promise<AuthResult> => ({ success: true }),
    [],
  )
  const logout = useCallback(async (): Promise<void> => {}, [])
  const refreshAccessToken = useCallback(async (): Promise<boolean> => true, [])
  const clearError = useCallback(() => setError(null), [])

  return {
    user,
    setUser,
    // 独立版无 token 体系，固定为本地占位值以满足消费者的非空判断
    accessToken: 'local' as string | null,
    refreshToken: null as string | null,
    isAuthenticated: true,
    isTokenSynced: true,
    isLoading: false,
    error,
    register: noopRegister,
    login: noopLogin,
    logout,
    refreshAccessToken,
    clearError,
  }
}

export type UseAuthReturn = ReturnType<typeof useAuth>
