/**
 * 飞书渠道设置：扫码新建机器人（对齐 OpenClaw / Nemo 官方插件式接入）。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Tag } from '../../../../components/ui/Tag/Tag'
import { ChannelCard } from '../ChannelCard'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import { Modal } from '../../../../components/ui/Modal/Modal'

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

const STATUS_COLORS: Record<FeishuStatus, 'default' | 'success' | 'warning' | 'error'> = {
  idle: 'default',
  waiting_qrcode: 'warning',
  scanned: 'warning',
  connected: 'success',
  error: 'error',
}

/**
 * 飞书渠道设置卡片（扫码新建机器人）。
 */
export const FeishuChannelSettings: React.FC = () => {
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
      {!isConnected ? (
        <Button
          variant="primary"
          onClick={() => void handleConnect()}
          loading={loading || isPending}
          disabled={loading || isPending}
        >
          {isPending ? '扫码中...' : '扫码新建机器人'}
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
      ? `App ${session.appIdMasked}  ·  接入于 ${new Date(session.loginAt).toLocaleString()}`
      : undefined

  return (
    <>
      <ChannelCard
        icon={<ChannelBrandIcon kind="feishu" />}
        name="飞书"
        description="扫码一键创建飞书机器人（WebSocket 长连接），无需手动填写 App Secret"
        statusSlot={<Tag color={STATUS_COLORS[status]}>{STATUS_LABELS[status]}</Tag>}
        actionsSlot={actions}
        errorMessage={errorMsg}
        extraSlot={extra}
      />

      <Modal
        open={qrModalOpen}
        title="扫码新建飞书机器人"
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
                background: '#f5f5f5',
                borderRadius: 8,
              }}
            >
              <span style={{ color: '#999', fontSize: 14 }}>正在获取二维码...</span>
            </div>
          )}
          <p style={{ marginTop: 12, color: '#666', fontSize: 13 }}>
            请使用飞书 App 扫描二维码，授权创建机器人应用
          </p>
        </div>
      </Modal>
    </>
  )
}

export default FeishuChannelSettings
