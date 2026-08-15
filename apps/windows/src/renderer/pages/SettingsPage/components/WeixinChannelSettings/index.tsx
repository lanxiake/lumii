import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { ChannelCard, type ChannelMetaItem } from '../ChannelCard'
import type { ChannelConnectionState } from '../ChannelStatusPill'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import type { ChannelSnapshot } from '../ChannelsSection/useChannelSnapshots'
import { QrCodeModal } from './QrCodeModal'

type WeixinStatus = 'idle' | 'waiting_qrcode' | 'scanned' | 'confirmed' | 'logged_in' | 'error'

const STATUS_STATES: Record<WeixinStatus, ChannelConnectionState> = {
  idle: 'idle',
  waiting_qrcode: 'pending',
  scanned: 'pending',
  confirmed: 'pending',
  logged_in: 'connected',
  error: 'error',
}

const STATUS_LABELS: Record<WeixinStatus, string> = {
  idle: '未连接',
  waiting_qrcode: '获取二维码中',
  scanned: '等待扫码',
  confirmed: '确认登录中',
  logged_in: '已连接',
  error: '连接出错',
}

interface WeixinSession {
  userId: string
  botToken: string
  baseUrl?: string
  loginAt: number
  expiresAt?: number
}

const DAY_MS = 24 * 3600 * 1000

/**
 * 把会话信息拆成 meta 条目，替代原先挤在一行的灰色长文本。
 */
function buildSessionMeta(session: WeixinSession): ChannelMetaItem[] {
  const now = Date.now()
  const elapsedMs = now - session.loginAt
  const days = Math.floor(elapsedMs / DAY_MS)
  const hours = Math.floor((elapsedMs % DAY_MS) / (3600 * 1000))

  const items: ChannelMetaItem[] = [
    { label: '推送能力', value: '主动发送（依赖 24h 内会话）' },
    { label: '连接时长', value: days > 0 ? `${days} 天 ${hours} 小时` : `${hours} 小时` },
  ]

  if (session.expiresAt) {
    const remainMs = session.expiresAt - now
    items.push({
      label: '会话有效期',
      value: remainMs <= 0 ? '已过期' : `剩余 ${Math.ceil(remainMs / DAY_MS)} 天`,
    })
  } else {
    items.push({ label: '登录于', value: new Date(session.loginAt).toLocaleDateString() })
  }

  if (session.userId) {
    items.push({ label: '登录账号', value: session.userId, mono: true })
  }

  return items
}

interface WeixinChannelSettingsProps {
  /** 渠道出站快照（由分区统一拉取） */
  snapshot?: ChannelSnapshot
  snapshotLoading?: boolean
}

/**
 * 个人微信（iLink）渠道设置卡片。
 */
export const WeixinChannelSettings: React.FC<WeixinChannelSettingsProps> = ({
  snapshot,
  snapshotLoading = false,
}) => {
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
      {isPending && !qrModalOpen && qrcodeDataUrl && (
        <Button size="sm" variant="secondary" onClick={() => setQrModalOpen(true)}>
          查看二维码
        </Button>
      )}
      {!isConnected ? (
        <Button
          size="sm"
          variant="primary"
          onClick={handleConnect}
          loading={loading || isPending}
          disabled={loading || isPending}
        >
          {isPending ? '登录中' : sessionExpired ? '重新扫码' : '连接微信'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="danger"
          onClick={handleDisconnect}
          loading={loading}
          disabled={loading}
        >
          断开
        </Button>
      )}
    </>
  )

  return (
    <>
      <ChannelCard
        icon={<ChannelBrandIcon kind="weixin" />}
        name="微信（个人）"
        description="通过 iLink Bot API 接入，扫码登录后自动收发消息"
        state={STATUS_STATES[status] ?? 'idle'}
        statusLabel={STATUS_LABELS[status] ?? status}
        actions={actions}
        errorMessage={errorMsg}
        meta={isConnected && session ? buildSessionMeta(session) : undefined}
        peers={isConnected ? (snapshot?.peers ?? []) : undefined}
        peersLoading={snapshotLoading}
      />
      <QrCodeModal
        open={qrModalOpen}
        qrcodeDataUrl={qrcodeDataUrl}
        onClose={handleCloseModal}
      />
    </>
  )
}

export default WeixinChannelSettings
