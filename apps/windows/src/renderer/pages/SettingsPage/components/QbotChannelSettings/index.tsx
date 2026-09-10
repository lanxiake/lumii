/**
 * QQ 机器人渠道设置：扫码建应用优先，失败降级为手动填写 AppID/AppSecret 表单。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { ChannelCard, type ChannelMetaItem } from '../ChannelCard'
import type { ChannelConnectionState } from '../ChannelStatusPill'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import type { ChannelSnapshot } from '../ChannelsSection/useChannelSnapshots'

type QbotStatus = 'idle' | 'waiting_qrcode' | 'waiting_credential' | 'connected' | 'error'

interface QbotSessionPublic {
  appId: string
  appIdMasked: string
  loginAt: number
}

const STATUS_LABELS: Record<QbotStatus, string> = {
  idle: '未接入',
  waiting_qrcode: '扫码建应用中',
  waiting_credential: '待填凭证',
  connected: '已连接',
  error: '异常',
}

const STATUS_STATES: Record<QbotStatus, ChannelConnectionState> = {
  idle: 'idle',
  waiting_qrcode: 'pending',
  waiting_credential: 'pending',
  connected: 'connected',
  error: 'error',
}

interface QbotChannelSettingsProps {
  snapshot?: ChannelSnapshot
  snapshotLoading?: boolean
}

/**
 * QQ 机器人渠道设置卡片。
 */
export const QbotChannelSettings: React.FC<QbotChannelSettingsProps> = ({
  snapshot,
  snapshotLoading = false,
}) => {
  const [status, setStatus] = useState<QbotStatus>('idle')
  const [session, setSession] = useState<QbotSessionPublic | null>(null)
  const [appId, setAppId] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const s = await window.qbotService?.getStatus?.()
        if (s) setStatus(s as QbotStatus)
        const sess = await window.qbotService?.getSession?.()
        if (sess) setSession(sess as QbotSessionPublic)
      } catch {
        // ignore
      }
    }
    void init()

    const removeStatus = window.qbotService?.onStatusChange?.((s: string, sess?: unknown) => {
      setStatus(s as QbotStatus)
      if (sess) setSession(sess as QbotSessionPublic)
      if (s === 'connected') {
        setLoading(false)
        setErrorMsg(null)
      }
      if (s === 'error') setLoading(false)
    })

    const removeError = window.qbotService?.onError?.((msg: string) => {
      setErrorMsg(msg)
      setLoading(false)
    })

    return () => {
      removeStatus?.()
      removeError?.()
    }
  }, [])

  /** 扫码建应用（优先），失败由主进程自动降级为凭证表单 */
  const handleConnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.qbotService?.startLogin?.()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  /** 手动填写凭证收尾（扫码建应用不可用时的降级路径） */
  const handleSaveCredentials = useCallback(async () => {
    if (!appId.trim() || !appSecret.trim()) {
      setErrorMsg('AppID 与 AppSecret 均不能为空')
      return
    }
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.qbotService?.saveCredentials?.(appId.trim(), appSecret.trim())
      setAppSecret('')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [appId, appSecret])

  const handleDisconnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.qbotService?.logout?.()
      setSession(null)
      setStatus('idle')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const isConnected = status === 'connected'
  const isPending = status === 'waiting_qrcode' || status === 'waiting_credential'

  const actions = (
    <>
      {!isConnected ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleConnect()}
          loading={loading || status === 'waiting_qrcode'}
          disabled={loading || status === 'waiting_qrcode'}
        >
          {status === 'waiting_qrcode' ? '扫码建应用中' : '扫码建应用'}
        </Button>
      ) : (
        <Button
          size="sm"
          variant="danger"
          onClick={() => void handleDisconnect()}
          loading={loading}
          disabled={loading}
        >
          断开
        </Button>
      )}
    </>
  )

  const meta: ChannelMetaItem[] | undefined =
    isConnected && session
      ? [
          { label: '推送能力', value: '原生推送' },
          { label: '接入时间', value: new Date(session.loginAt).toLocaleString() },
          { label: '应用', value: session.appIdMasked, mono: true },
        ]
      : undefined

  return (
    <ChannelCard
      icon={<ChannelBrandIcon kind="qbot" />}
      name="QQ"
      description="接入 QQ 机器人，扫码建应用或手动填写 AppID/AppSecret"
      state={STATUS_STATES[status] ?? 'idle'}
      statusLabel={STATUS_LABELS[status] ?? status}
      actions={actions}
      errorMessage={errorMsg}
      meta={meta}
      peers={isConnected ? (snapshot?.peers ?? []) : undefined}
      peersLoading={snapshotLoading}
    >
      {!isConnected && (status === 'waiting_credential' || status === 'error') && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 12 }}>
          <Input
            label="AppID"
            value={appId}
            onChange={(e) => setAppId(e.target.value)}
            placeholder="粘贴 q.qq.com 上的 AppID"
          />
          <Input
            label="AppSecret"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder="粘贴 AppSecret"
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleSaveCredentials()}
            loading={loading}
            disabled={loading || isPending}
          >
            保存凭证
          </Button>
        </div>
      )}
    </ChannelCard>
  )
}

export default QbotChannelSettings
