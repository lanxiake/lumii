/**
 * 服务端滑动验证码 Hook (Windows 客户端)
 *
 * 通过 Electron IPC 与主进程 API 客户端交互
 */

import { useState, useCallback } from 'react'

interface CaptchaChallenge {
  captchaId: string
  backgroundImage: string
  sliderImage: string
  sliderY: number
}

interface UseServerCaptchaReturn {
  /** 验证码挑战数据 */
  challenge: CaptchaChallenge | null
  /** 验证成功后的 token */
  captchaToken: string | null
  /** 是否正在加载 */
  isLoading: boolean
  /** 是否已验证成功 */
  isVerified: boolean
  /** 错误信息 */
  error: string | null
  /** 获取新的验证码 */
  fetchChallenge: () => Promise<void>
  /** 提交验证 */
  verify: (sliderX: number) => Promise<boolean>
  /** 刷新验证码 */
  refresh: () => Promise<void>
  /** 重置状态 */
  reset: () => void
  /** 测试模式：强制通过验证 */
  forceVerify: (token?: string) => void
}

export function useServerCaptcha(): UseServerCaptchaReturn {
  const [challenge, setChallenge] = useState<CaptchaChallenge | null>(null)
  const [captchaToken, setCaptchaToken] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [isVerified, setIsVerified] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchChallenge = useCallback(async () => {
    setIsLoading(true)
    setError(null)
    setIsVerified(false)
    setCaptchaToken(null)

    try {
      const result = (await window.electronAPI.api.getCaptchaChallenge()) as {
        success: boolean
        data?: CaptchaChallenge
        error?: string
      }
      if (result.success && result.data) {
        setChallenge(result.data)
      } else {
        setError(result.error || '获取验证码失败')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取验证码失败')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const verify = useCallback(
    async (sliderX: number): Promise<boolean> => {
      if (!challenge) return false

      setIsLoading(true)
      setError(null)

      try {
        const result = (await window.electronAPI.api.verifyCaptcha(
          challenge.captchaId,
          sliderX
        )) as {
          success: boolean
          data?: { token: string }
          error?: string
        }

        if (result.success && result.data?.token) {
          setCaptchaToken(result.data.token)
          setIsVerified(true)
          return true
        }

        setError('验证失败，请重试')
        await fetchChallenge()
        return false
      } catch (err) {
        setError(err instanceof Error ? err.message : '验证请求失败')
        await fetchChallenge()
        return false
      } finally {
        setIsLoading(false)
      }
    },
    [challenge, fetchChallenge]
  )

  const refresh = useCallback(async () => {
    setIsVerified(false)
    setCaptchaToken(null)
    await fetchChallenge()
  }, [fetchChallenge])

  const reset = useCallback(() => {
    setChallenge(null)
    setCaptchaToken(null)
    setIsLoading(false)
    setIsVerified(false)
    setError(null)
  }, [])

  /**
   * 测试模式：强制通过验证
   * 用于E2E测试，绕过实际的服务器验证
   */
  const forceVerify = useCallback((token: string = 'test-token'): void => {
    setCaptchaToken(token)
    setIsVerified(true)
    setError(null)
  }, [])

  return {
    challenge,
    captchaToken,
    isLoading,
    isVerified,
    error,
    fetchChallenge,
    verify,
    refresh,
    reset,
    forceVerify,
  }
}
