/**
 * useAuth.types.ts - 认证管理类型定义
 */

/** 用户信息 */
export interface User {
  id: string
  phone?: string
  email?: string
  displayName?: string
  avatarUrl?: string
  createdAt: string
}

/** 认证状态 */
export interface AuthState {
  user: User | null
  accessToken: string | null
  refreshToken: string | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

/** 注册参数 */
export interface RegisterParams {
  phone?: string
  email?: string
  password: string
  displayName: string
  captchaToken?: string
}

/** 登录参数 */
export interface LoginParams {
  identifier: string
  password: string
  /** 验证码 token */
  captchaToken?: string
}

/** 认证响应 */
export interface AuthResponse {
  success: boolean
  data?: {
    user: User
    accessToken: string
    refreshToken?: string
    expiresIn?: number
  }
  error?: string
  code?: string
}

/** 认证操作结果 */
export interface AuthResult {
  success: boolean
  error?: string
}
