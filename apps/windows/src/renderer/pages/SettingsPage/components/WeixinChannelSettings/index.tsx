import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { ChannelCard } from '../ChannelCard'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import { LoginStatus } from './LoginStatus'
import { QrCodeModal } from './QrCodeModal'

type WeixinStatus = 'idle' | 'waiting_qrcode' | 'scanned' | 'confirmed' | 'logged_in' | 'error'

/**
 * 格式化已连接会话的时长与有效期说明。
 */
function formatSessionInfo(session: WeixinSession): string {
  const now = Date.now()
  const elapsedMs = now - session.loginAt
  const elapsedDays = Math.floor(elapsedMs / (24 * 3600 * 1000))
  const elapsedHours = Math.floor((elapsedMs % (24 * 3600 * 1000)) / (3600 * 1000))

  const elapsedStr =
    elapsedDays > 0
      ? `已连接 ${elapsedDays} 天 ${elapsedHours} 小时`
      : `已连接 ${elapsedHours} 小时`

  const userPart = session.userId ? `用户ID: ${session.userId} · ` : ''

  if (session.expiresAt) {
    const remainMs = session.expiresAt - now
    if (remainMs <= 0) return `${userPart}${elapsedStr}（会话已过期）`
    const remainDays = Math.ceil(remainMs / (24 * 3600 * 1000))
    return `${userPart}${elapsedStr}  ·  有效期剩余 ${remainDays} 天`
  }

  return `${userPart}${elapsedStr}  ·  登录于 ${new Date(session.loginAt).toLocaleDateString()}`
}

interface WeixinSession {
  userId: string
  botToken: string
  baseUrl?: string
  loginAt: number
  expiresAt?: number
}

/**
 * 个人微信（iLink）渠道设置卡片；开发面板由渠道页统一挂载在卡片下方。
 */
export const WeixinChannelSettings: React.FC = () => {
  const [status, setStatus] = useState<WeixinStatus>('idle')
  const [session, setSession] = useState<WeixinSession | null>(null)
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState<string | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [sessionExpired, setSessionExpired] = useState(false)

  useEffect(() => {
    const init = async () => {
      try {
        const s = await window.weixinService?.getStatus?.()
        if (s) setStatus(s as WeixinStatus)
        const sess = await window.weixinService?.getSession?.()
        if (sess) setSession(sess as WeixinSession)
      } catch (_) {
        // ignore
      }
    }
    init()

    const removeStatus = window.weixinService?.onStatusChange?.((s: string, sess?: unknown) => {
      console.info('[WeixinChannelSettings] statusChange:', s, 'hasSession=', !!sess)
      setStatus(s as WeixinStatus)
      if (sess) setSession(sess as WeixinSession)
      if (s === 'logged_in') {
        setQrModalOpen(false)
        setLoading(false)
      }
      if (s === 'error') {
        setLoading(false)
        setQrModalOpen(false)
      }
    })

    const removeQrcode = window.weixinService?.onQrcode?.((dataUrl: string) => {
      console.info('[WeixinChannelSettings] onQrcode:', 'dataUrl length=', dataUrl?.length)
      setQrcodeDataUrl(dataUrl)
      setQrModalOpen(true)
      setLoading(false)
    })

    const removeError = window.weixinService?.onError?.((msg: string) => {
      console.error('[WeixinChannelSettings] onError:', msg)
      if (msg === 'session_expired') {
        setSessionExpired(true)
        setErrorMsg('微信会话已过期，请重新扫码连接')
      } else {
        setSessionExpired(false)
        setErrorMsg(msg)
      }
      setLoading(false)
    })

    return () => {
      removeStatus?.()
      removeQrcode?.()
      removeError?.()
    }
  }, [])

  /**
   * 发起个人微信扫码登录。
   */
  const handleConnect = useCallback(async () => {
    console.info('[WeixinChannelSettings] connect clicked')
    setLoading(true)
    setErrorMsg(null)
    setSessionExpired(false)
    try {
      await window.weixinService?.startLogin?.()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[WeixinChannelSettings] connect startLogin failed:', msg)
      setErrorMsg(msg)
      setLoading(false)
    }
  }, [])

  /**
   * 断开个人微信连接。
   */
  const handleDisconnect = useCallback(async () => {
    console.info('[WeixinChannelSettings] disconnect clicked')
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.weixinService?.logout?.()
      setSession(null)
      setQrcodeDataUrl(null)
      setStatus('idle')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[WeixinChannelSettings] logout failed:', msg)
      setErrorMsg(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCloseModal = useCallback(() => {
    setQrModalOpen(false)
  }, [])

  const isConnected = status === 'logged_in'
  const isPending = status === 'waiting_qrcode' || status === 'scanned' || status === 'confirmed'

  const actions = (
    <>
      {!isConnected ? (
        <Button
          variant="primary"
          onClick={handleConnect}
          loading={loading || isPending}
          disabled={loading || isPending}
        >
          {isPending ? '登录中...' : sessionExpired ? '重新扫码连接' : '连接微信'}
        </Button>
      ) : (
        <Button
          variant="danger"
          onClick={handleDisconnect}
          loading={loading}
          disabled={loading}
        >
          断开连接
        </Button>
      )}
      {isPending && !qrModalOpen && qrcodeDataUrl && (
        <Button variant="secondary" onClick={() => setQrModalOpen(true)}>
          查看二维码
        </Button>
      )}
    </>
  )

  return (
    <div style={{ height: '100%', minWidth: 0 }}>
      <ChannelCard
        icon={<ChannelBrandIcon kind="weixin" />}
        name="微信（个人）"
        description="通过 iLink Bot API 接入个人微信，扫码登录后自动收发消息"
        statusSlot={<LoginStatus status={status} />}
        actionsSlot={actions}
        errorMessage={errorMsg}
        extraSlot={isConnected && session ? formatSessionInfo(session) : undefined}
      />
      <QrCodeModal
        open={qrModalOpen}
        qrcodeDataUrl={qrcodeDataUrl}
        onClose={handleCloseModal}
      />
    </div>
  )
}

export default WeixinChannelSettings
