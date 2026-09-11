/**
 * QQ 机器人渠道设置：内置注册指引 + 凭证表单（主要路径）+ 扫码建应用（辅助快速路径）。
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
 *
 * 一期设计：扫码建应用（lite_create）是内部 cgi，需要 QQ OAuth 登录态，不稳定。
 * 因此主要入口改为凭证表单 + 注册指引，扫码建应用作为可选辅助按钮。
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
      if (s === 'error' || s === 'waiting_credential') setLoading(false)
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

  /** 扫码建应用（辅助快速路径，可能因缺少 OAuth 登录态而失败降级） */
  const handleLiteCreate = useCallback(async () => {
    setLoading(true)
    setErrorMsg(null)
    try {
      await window.qbotService?.startLogin?.()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setLoading(false)
    }
  }, [])

  /** 填写 AppID/AppSecret 接入（主要路径） */
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
  const isLiteCreating = status === 'waiting_qrcode'

  const actions = (
    <>
      {isConnected ? (
        <Button
          size="sm"
          variant="danger"
          onClick={() => void handleDisconnect()}
          loading={loading}
          disabled={loading}
        >
          断开
        </Button>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void handleLiteCreate()}
          loading={isLiteCreating}
          disabled={isLiteCreating || loading}
          title="通过 lite_create 内部接口快速获取凭证（可能因缺少登录态而不可用）"
        >
          {isLiteCreating ? '扫码建应用中' : '扫码建应用'}
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
      {!isConnected && !isLiteCreating && (
        <div style={{ marginTop: 12 }}>
          {/* 注册指引（可折叠） */}
          <details open style={{ fontSize: 13, color: 'var(--mt-fg-2)', lineHeight: 1.6 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600, marginBottom: 8 }}>
              📖 如何获取 AppID 与 AppSecret？
            </summary>
            <ol style={{ paddingInlineStart: 20, margin: '4px 0 12px' }}>
              <li style={{ marginBottom: 4 }}>
                打开{' '}
                <a
                  href="https://q.qq.com/qqbot/openclaw/login.html"
                  onClick={(e) => {
                    e.preventDefault()
                    void window.electronAPI?.app?.openExternal?.('https://q.qq.com/qqbot/openclaw/login.html')
                  }}
                  style={{ color: 'var(--mt-accent)', cursor: 'pointer' }}
                >
                  q.qq.com/qqbot/openclaw/login.html
                </a>
                ，使用 QQ 登录。
              </li>
              <li style={{ marginBottom: 4 }}>
                点击<strong>「创建机器人」</strong>——即刻创建成功，头像昵称可在 q.qq.com 后台自定义。
              </li>
              <li>将创建后获得的 <strong>AppID</strong> 与 <strong>AppSecret</strong> 填入下方表单，点击「保存凭证」完成接入。</li>
            </ol>
            <p style={{ color: 'var(--mt-fg-3)', fontSize: 12 }}>
              创建机器人后，QQ 机器人会向你发送一条确认消息。
            </p>
          </details>

          {/* 凭证表单 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginTop: 12, flexWrap: 'wrap' }}>
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
              variant="primary"
              onClick={() => void handleSaveCredentials()}
              loading={loading}
              disabled={loading || isLiteCreating}
            >
              保存凭证
            </Button>
          </div>
        </div>
      )}
    </ChannelCard>
  )
}

export default QbotChannelSettings