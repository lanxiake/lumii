/**
 * QQ 机器人渠道设置：扫码绑定（主要路径）+ 凭证表单（兜底）。
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Modal } from '../../../../components/ui/Modal/Modal'
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

const BOT_CONSOLE_URL = 'https://q.qq.com/qqbot/openclaw/login.html'

const STATUS_LABELS: Record<QbotStatus, string> = {
  idle: '未接入',
  waiting_qrcode: '扫码中',
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
 *
 * 扫码绑定走腾讯官方 connector：用户在 q.qq.com 创建过机器人后，手机 QQ 扫码
 * 选择要绑定的那只，凭证由 SDK 直接回吐，无需手抄。扫码失败才退回凭证表单。
 */
export const QbotChannelSettings: React.FC<QbotChannelSettingsProps> = ({
  snapshot,
  snapshotLoading = false,
}) => {
  const [status, setStatus] = useState<QbotStatus>('idle')
  const [session, setSession] = useState<QbotSessionPublic | null>(null)
  const [qrcodeDataUrl, setQrcodeDataUrl] = useState<string | null>(null)
  const [qrModalOpen, setQrModalOpen] = useState(false)
  const [showManual, setShowManual] = useState(false)
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
        setQrModalOpen(false)
        setQrcodeDataUrl(null)
      }
      // 扫码失败会落到 waiting_credential，此时展开手填表单兜底
      if (s === 'waiting_credential') {
        setLoading(false)
        setQrModalOpen(false)
        setShowManual(true)
      }
      if (s === 'error') setLoading(false)
    })

    const removeQrcode = window.qbotService?.onQrcode?.((dataUrl: string) => {
      setQrcodeDataUrl(dataUrl)
      setQrModalOpen(true)
      setLoading(false)
    })

    const removeError = window.qbotService?.onError?.((msg: string) => {
      setErrorMsg(msg)
      setLoading(false)
    })

    return () => {
      removeStatus?.()
      removeQrcode?.()
      removeError?.()
    }
  }, [])

  /** 扫码绑定（主要路径） */
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

  /** 填写 AppID/AppSecret 接入（兜底路径） */
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
      setQrcodeDataUrl(null)
      setStatus('idle')
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [])

  const isConnected = status === 'connected'
  const isScanning = status === 'waiting_qrcode'

  const actions = (
    <>
      {isScanning && !qrModalOpen && qrcodeDataUrl && (
        <Button size="sm" variant="secondary" onClick={() => setQrModalOpen(true)}>
          查看二维码
        </Button>
      )}
      {!isConnected ? (
        <Button
          size="sm"
          variant="primary"
          onClick={() => void handleConnect()}
          loading={loading || isScanning}
          disabled={loading || isScanning}
        >
          {isScanning ? '扫码中' : '扫码绑定'}
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
    <>
      <ChannelCard
        icon={<ChannelBrandIcon kind="qbot" />}
        name="QQ"
        description="手机 QQ 扫码绑定机器人，无需手动填写 AppID/AppSecret"
        state={STATUS_STATES[status] ?? 'idle'}
        statusLabel={STATUS_LABELS[status] ?? status}
        actions={actions}
        errorMessage={errorMsg}
        meta={meta}
        peers={isConnected ? (snapshot?.peers ?? []) : undefined}
        peersLoading={snapshotLoading}
      >
        {!isConnected && !isScanning && (
          <div style={{ marginTop: 12 }}>
            {/* 前置步骤指引 */}
            <div style={{ fontSize: 13, color: 'var(--mt-fg-2)', lineHeight: 1.6 }}>
              <p style={{ margin: '0 0 6px', fontWeight: 600 }}>扫码前需要先有一只机器人</p>
              <ol style={{ paddingInlineStart: 20, margin: '0 0 8px' }}>
                <li style={{ marginBottom: 4 }}>
                  打开{' '}
                  <a
                    href={BOT_CONSOLE_URL}
                    onClick={(e) => {
                      e.preventDefault()
                      void window.electronAPI?.app?.openExternal?.(BOT_CONSOLE_URL)
                    }}
                    style={{ color: 'var(--mt-accent-500)', cursor: 'pointer' }}
                  >
                    q.qq.com/qqbot/openclaw/login.html
                  </a>
                  ，用 QQ 登录后点<strong>「创建机器人」</strong>，即刻创建成功。
                </li>
                <li>
                  回到这里点<strong>「扫码绑定」</strong>，用手机 QQ 扫码并选择刚创建的机器人，凭证会自动写入。
                </li>
              </ol>
              <p style={{ color: 'var(--mt-fg-3)', fontSize: 12, margin: 0 }}>
                创建机器人后，QQ 机器人会向你发送一条确认消息。
              </p>
            </div>

            {/* 凭证表单（兜底：扫码不可用时手填） */}
            <details
              open={showManual}
              style={{ fontSize: 13, color: 'var(--mt-fg-2)', lineHeight: 1.6, marginTop: 12 }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
                扫码不可用？手动填写 AppID/AppSecret
              </summary>
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'flex-end',
                  marginTop: 10,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                  <Input
                    label="AppID"
                    value={appId}
                    onChange={(e) => setAppId(e.target.value)}
                    placeholder="粘贴从 q.qq.com 获取的 AppID"
                  />
                </div>
                <div style={{ flex: '1 1 180px', minWidth: 160 }}>
                  <Input
                    label="AppSecret"
                    type="password"
                    value={appSecret}
                    onChange={(e) => setAppSecret(e.target.value)}
                    placeholder="粘贴 AppSecret"
                  />
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleSaveCredentials()}
                  loading={loading}
                  disabled={loading || isScanning}
                >
                  保存凭证
                </Button>
              </div>
              <p style={{ color: 'var(--mt-fg-3)', fontSize: 12, margin: '8px 0 0' }}>
                AppSecret 只在创建时明文显示一次，遗忘需在 q.qq.com 后台重置。
              </p>
            </details>
          </div>
        )}
      </ChannelCard>

      <Modal
        open={qrModalOpen}
        title="扫码绑定 QQ 机器人"
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
              alt="QQ 机器人绑定二维码"
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
            请使用手机 QQ 扫码，并选择要绑定的机器人
          </p>
        </div>
      </Modal>
    </>
  )
}

export default QbotChannelSettings
