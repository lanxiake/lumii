/**
 * 企业微信（WeCom）AI Bot 扫码接入设置。
 *
 * 对齐个人微信体验：扫码 → 自动获取 botId/secret → WebSocket 长连接收发消息。
 * 不再要求填写自建应用 Webhook（CorpId/Token/AESKey/回调 URL）。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Tag } from '../../../../components/ui/Tag/Tag'
import { ChannelCard } from '../ChannelCard'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import { Modal } from '../../../../components/ui/Modal/Modal'

type WecomStatus = 'idle' | 'waiting_qrcode' | 'scanned' | 'connected' | 'error'

interface WecomSessionPublic {
  botId: string
  loginAt: number
  botIdMasked: string
}

const STATUS_LABELS: Record<WecomStatus, string> = {
  idle: '未接入',
  waiting_qrcode: '等待扫码',
  scanned: '已扫码',
  connected: '已连接',
  error: '异常',
}

const STATUS_COLORS: Record<WecomStatus, 'default' | 'success' | 'warning' | 'error'> = {
  idle: 'default',
  waiting_qrcode: 'warning',
  scanned: 'warning',
  connected: 'success',
  error: 'error',
}

/**
 * 企业微信渠道设置卡片（扫码接入）。
 */
export const WecomChannelSettings: React.FC = () => {
  const [status, setStatus] = useState<WecomStatus>('idle')
  const [session, setSession] = useState<WecomSessionPublic | null>(null)
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState<string | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const init = async () => {
      try {
        const s = await window.wecomService?.getStatus?.()
        if (s) setStatus(s as WecomStatus)
        const sess = await window.wecomService?.getSession?.()
        if (sess) setSession(sess as WecomSessionPublic)
      } catch {
        // ignore
      }
    }
    void init()

    const removeStatus = window.wecomService?.onStatusChange?.((s: string, sess?: unknown) => {
      setStatus(s as WecomStatus)
      if (sess) setSession(sess as WecomSessionPublic)
      if (s === 'connected') {
        setQrModalOpen(false)
        setLoading(false)
      }
      if (s === 'error') {
        setLoading(false)
      }
    })

    const removeQrcode = window.wecomService?.onQrcode?.((dataUrl: string) => {
      setQrcodeDataUrl(dataUrl)
      setQrModalOpen(true)
      setLoading(false)
    })

    const removeError = window.wecomService?.onError?.((msg: string) => {
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
   * 点击「扫码接入」：向主进程请求二维码。
   */
  const handleConnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.wecomService?.startLogin?.()
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(msg)
      setLoading(false)
    }
  }, [])

  /**
   * 断开企微长连接并清除本地凭证。
   */
  const handleDisconnect = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.wecomService?.logout?.()
      setSession(null)
      setQrcodeDataUrl(null)
      setStatus('idle')
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      setErrorMsg(msg)
    } finally {
      setLoading(false)
    }
  }, [])

  const isConnected = status === 'connected'
  const isPending = status === 'waiting_qrcode' || status === 'scanned'

  const actions = (
    <>
      {!isConnected ? (
        <Button
          variant="primary"
          onClick={() => void handleConnect()}
          loading={loading || isPending}
          disabled={loading || isPending}
        >
          {isPending ? '扫码中...' : '扫码接入'}
        </Button>
      ) : (
        <Button
          variant="danger"
          onClick={() => void handleDisconnect()}
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

  const extra =
    isConnected && session
      ? `Bot ${session.botIdMasked}  ·  接入于 ${new Date(session.loginAt).toLocaleString()}`
      : undefined

  return (
    <div style={{ height: '100%', minWidth: 0 }}>
      <ChannelCard
        icon={<ChannelBrandIcon kind="wecom" />}
        name="企业微信"
        description="扫码接入 AI 智能机器人（WebSocket 长连接），无需公网回调地址"
        statusSlot={<Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>}
        actionsSlot={actions}
        errorMessage={errorMsg}
        extraSlot={extra}
      />

      <Modal
        open={qrModalOpen}
        title="扫码接入企业微信"
        onClose={() => setQrModalOpen(false)}
        width={320}
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
              alt="企业微信扫码二维码"
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
                background: '#f5f5f5',
                borderRadius: 8,
              }}
            >
              <span style={{ color: '#999', fontSize: 14 }}>正在获取二维码...</span>
            </div>
          )}
          <p style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
            {status === 'scanned'
              ? '已扫码，请在企业微信中确认授权'
              : '请使用企业微信扫描二维码授权接入'}
          </p>
        </div>
      </Modal>
    </div>
  )
}

export default WecomChannelSettings
