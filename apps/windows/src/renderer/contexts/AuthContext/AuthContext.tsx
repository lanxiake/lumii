/**
 * AuthContext - 认证状态上下文
 *
 * 提供全局的认证状态管理
 * 基于 hooks/business/useAuth 实现
 */

import React, { createContext, useContext, ReactNode } from 'react'
import { useAuth as useAuthHook } from '../../hooks/business/useAuth'

type AuthContextType = ReturnType<typeof useAuthHook>

// 创建上下文
const AuthContext = createContext<AuthContextType | undefined>(undefined)

/**
 * AuthProvider Props
 */
interface AuthProviderProps {
  children: ReactNode
}

/**
 * AuthProvider - 认证状态提供者
 */
export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const auth = useAuthHook()

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  )
}

/**
 * useAuth Hook - 获取认证上下文
 */
export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export default AuthContext
