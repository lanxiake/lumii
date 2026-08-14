/**
 * 飞书渠道设置：扫码新建机器人（流程对齐上游飞书 CLI 参考实现 / Nemo 的官方插件式接入）。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { ChannelCard, type ChannelMetaItem } from '../ChannelCard'
import type { ChannelConnectionState } from '../ChannelStatusPill'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import { Modal } from '../../../../components/ui/Modal/Modal'
import type { ChannelSnapshot } from '../ChannelsSection/useChannelSnapshots'

type FeishuStatus = 'idle' | 'waiting_qrcode' | 'scanned' | 'connected' | 'error'

interface FeishuSessionPublic {
  appId: string
  appIdMasked: string
  domain: 'feishu' | 'lark'
  openId?: string
  loginAt: number
}

const STATUS_LABELS: Record<FeishuStatus, string> = {
  idle: '未接入',
  waiting_qrcode: '等待扫码',
  scanned: '已扫码',
  connected: '已连接',
  error: '异常',
}

const STATUS_STATES: Record<FeishuStatus, ChannelConnectionState> = {
  idle: 'idle',
  waiting_qrcode: 'pending',
  scanned: 'pending',
  connected: 'connected',
  error: 'error',
}

interface FeishuChannelSettingsProps {
  /** 渠道出站快照（由分区统一拉取） */
  snapshot?: ChannelSnapshot
  snapshotLoading?: boolean
}

/**
 * 飞书渠道设置卡片（扫码新建机器人）。
 */
export const FeishuChannelSettings: React.FC<FeishuChannelSettingsProps> = ({
  snapshot,
  snapshotLoading = false,
}) => {
  const [status, setStatus] = useState<FeishuStatus>('idle')
  const [session, setSession] = useState<FeishuSessionPublic | null>(null)
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState<string | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const s = await window.feishuService?.getStatus?.()
        if (s) setStatus(s as FeishuStatus)
        const sess = await window.feishuService?.getSession?.()
        if (sess) setSession(sess as FeishuSessionPublic)
      } catch {
        // ignore
      }
    }
    void init()

    const removeStatus = window.feishuService?.onStatusChange?.((s: string, sess?: unknown) => {
      setStatus(s as FeishuStatus)
      if (sess) setSession(sess as FeishuSessionPublic)
      if (s === 'connected') {
        setQrModalOpen(false)
        setLoading(false)
      }
      if (s === 'error') setLoading(false)
    })

    const removeQrcode = window.feishuService?.onQrcode?.((dataUrl: string) => {
      setQrcodeDataUrl(dataUrl)
      setQrModalOpen(true)
      setLoading(false)
    })

    const removeError = window.feishuService?.onError?.((msg: string) => {
      setErrorMsg(msg)
      setLoading(false)
      setQrModalOpen(false)
    })

    return () => {
      removeStatus?.()
      removeQrcode?.()
      removeError?.()
    }
  }, [])

  /**
   * 发起扫码新建飞书机器人。
   */
  const handleConnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.feishuService?.startLogin?.()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  /**
   * 断开飞书长连接并清除本地凭证。
   */
  const handleDisconnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.feishuService?.logout?.()
      setSession(null)
      setQrcodeDataUrl(null)
      setStatus('idle')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const isConnected = status === 'connected'
  const isPending = status === 'waiting_qrcode' || status === 'scanned'

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
          onClick={() => void handleConnect()}
          loading={loading || isPending}
          disabled={loading || isPending}
        >
          {isPending ? '扫码中' : '扫码新建机器人'}
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
          { label: '推送能力', value: '原生推送（无时间限制）' },
          { label: '接入时间', value: new Date(session.loginAt).toLocaleString() },
          { label: '应用', value: session.appIdMasked, mono: true },
          ...(session.openId
            ? [{ label: '登录账号', value: session.openId, mono: true } as ChannelMetaItem]
            : []),
        ]
      : undefined

  return (
    <>
      <ChannelCard
        icon={<ChannelBrandIcon kind="feishu" />}
        name="飞书"
        description="扫码一键创建飞书机器人，无需手动填写 App Secret"
        state={STATUS_STATES[status] ?? 'idle'}
        statusLabel={STATUS_LABELS[status] ?? status}
        actions={actions}
        errorMessage={errorMsg}
        meta={meta}
        peers={isConnected ? (snapshot?.peers ?? []) : undefined}
        peersLoading={snapshotLoading}
      />

      <Modal
        open={qrModalOpen}
        title="扫码新建飞书机器人"
        onClose={() => setQrModalOpen(false)}
        width={320}
        layer="aboveHub"
        footer={
          <Button variant="ghost" onClick={() => setQrModalOpen(false)}>
            取消
          </Button>
        }
      >
        <div style={{ textAlign: 'center', padding: '8px 0' }}>
          {qrcodeDataUrl ? (
            <img
              src={qrcodeDataUrl}
              alt="飞书扫码二维码"
              style={{ width: 256, height: 256, display: 'block', margin: '0 auto' }}
            />
          ) : (
            <div
              style={{
                width: 256,
                height: 256,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                margin: '0 auto',
                background: 'var(--mt-bg-overlay)',
                borderRadius: 8,
              }}
            >
              <span style={{ color: 'var(--mt-fg-3)', fontSize: 14 }}>正在获取二维码...</span>
            </div>
          )}
          <p style={{ marginTop: 12, color: 'var(--mt-fg-3)', fontSize: 13 }}>
            请使用飞书 App 扫描二维码，授权创建机器人应用
          </p>
        </div>
      </Modal>
    </>
  )
}

export default FeishuChannelSettings
