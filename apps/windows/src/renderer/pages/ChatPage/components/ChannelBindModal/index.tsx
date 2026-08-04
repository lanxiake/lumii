/**
 * ChannelBindModal - 聊天页内快捷绑定渠道（个人微信 / 企业微信 / 飞书）
 *
 * 复用主进程 weixinService / wecomService / feishuService 扫码流程，
 * 避免用户跳转到设置页。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../../../components/ui/Modal/Modal'
import { Button } from '../../../../components/ui/Button/Button'
import { Tag } from '../../../../components/ui/Tag/Tag'
import styles from './ChannelBindModal.module.css'

type BindableChannel = 'wechat' | 'wecom' | 'feishu'

type ChannelRowStatus = 'idle' | 'waiting' | 'connected' | 'error'

interface ChannelRow {
  id: BindableChannel
  name: string
  icon: string
  description: string
  status: ChannelRowStatus
  detail?: string
}

interface ChannelBindModalProps {
  open: boolean
  onClose: () => void
}

const CHANNEL_DEFS: Array<Omit<ChannelRow, 'status' | 'detail'>> = [
  {
    id: 'wechat',
    name: '个人微信',
    icon: '💬',
    description: '扫码登录 iLink Bot，收发个人微信消息',
  },
  {
    id: 'wecom',
    name: '企业微信',
    icon: '🏢',
    description: '扫码接入 AI 智能机器人（长连接）',
  },
  {
    id: 'feishu',
    name: '飞书',
    icon: '🐦',
    description: '扫码一键创建飞书机器人应用',
  },
]

/**
 * 将各渠道服务状态归一化为行状态。
 */
function normalizeStatus(channel: BindableChannel, raw: string): ChannelRowStatus {
  if (channel === 'wechat') {
    if (raw === 'logged_in') return 'connected'
    if (raw === 'waiting_qrcode' || raw === 'scanned' || raw === 'confirmed') return 'waiting'
    if (raw === 'error') return 'error'
    return 'idle'
  }
  if (raw === 'connected') return 'connected'
  if (raw === 'waiting_qrcode' || raw === 'scanned') return 'waiting'
  if (raw === 'error') return 'error'
  return 'idle'
}

const STATUS_LABEL: Record<ChannelRowStatus, string> = {
  idle: '未绑定',
  waiting: '扫码中',
  connected: '已绑定',
  error: '异常',
}

const STATUS_COLOR: Record<ChannelRowStatus, 'default' | 'success' | 'warning' | 'error'> = {
  idle: 'default',
  waiting: 'warning',
  connected: 'success',
  error: 'error',
}

/**
 * 聊天页渠道快捷绑定弹窗。
 */
export const ChannelBindModal: React.FC<ChannelBindModalProps> = ({ open, onClose }) => {
  const [rows, setRows] = useState<ChannelRow[]>(() =>
    CHANNEL_DEFS.map((d) => ({ ...d, status: 'idle' as ChannelRowStatus })),
  )
  const [busyId, setBusyId] = useState<BindableChannel | null>(null)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [qrOpen, setQrOpen] = useState(false)
  const [qrTitle, setQrTitle] = useState('扫码绑定')
  const [qrHint, setQrHint] = useState('请使用对应 App 扫描二维码')
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null)

  /**
   * 更新某一渠道行的状态。
   */
  const patchRow = useCallback((id: BindableChannel, patch: Partial<ChannelRow>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))
  }, [])

  /**
   * 拉取三渠道当前状态。
   */
  const refreshStatuses = useCallback(async () => {
    const next: ChannelRow[] = []
    for (const def of CHANNEL_DEFS) {
      let raw = 'idle'
      let detail: string | undefined
      try {
        if (def.id === 'wechat') {
          raw = (await window.weixinService?.getStatus?.()) ?? 'idle'
          const sess = (await window.weixinService?.getSession?.()) as
            | { userId?: string }
            | null
          if (sess?.userId) detail = `用户 ${String(sess.userId).slice(0, 12)}…`
        } else if (def.id === 'wecom') {
          raw = (await window.wecomService?.getStatus?.()) ?? 'idle'
          const sess = (await window.wecomService?.getSession?.()) as
            | { botIdMasked?: string }
            | null
          if (sess?.botIdMasked) detail = `Bot ${sess.botIdMasked}`
        } else {
          raw = (await window.feishuService?.getStatus?.()) ?? 'idle'
          const sess = (await window.feishuService?.getSession?.()) as
            | { appIdMasked?: string }
            | null
          if (sess?.appIdMasked) detail = `App ${sess.appIdMasked}`
        }
      } catch {
        raw = 'error'
      }
      next.push({
        ...def,
        status: normalizeStatus(def.id, raw),
        detail,
      })
    }
    setRows(next)
  }, [])

  useEffect(() => {
    if (!open) return
    void refreshStatuses()
    setErrorMsg(null)

    const cleanups: Array<() => void> = []

    /**
     * 订阅某一渠道的状态 / 二维码 / 错误事件。
     */
    const attach = (
      id: BindableChannel,
      onStatusChange: ((cb: (s: string) => void) => () => void) | undefined,
      onQrcode: ((cb: (url: string) => void) => () => void) | undefined,
      onError: ((cb: (msg: string) => void) => () => void) | undefined,
      meta: { qr: string; hint: string; done: string[] },
    ) => {
      if (onStatusChange) {
        cleanups.push(
          onStatusChange((s) => {
            patchRow(id, { status: normalizeStatus(id, s) })
            if (meta.done.includes(s)) {
              setQrOpen(false)
              setBusyId(null)
              void refreshStatuses()
            }
            if (s === 'error') setBusyId(null)
          }),
        )
      }
      if (onQrcode) {
        cleanups.push(
          onQrcode((dataUrl) => {
            setQrDataUrl(dataUrl)
            setQrTitle(meta.qr)
            setQrHint(meta.hint)
            setQrOpen(true)
            setBusyId(null)
            patchRow(id, { status: 'waiting' })
          }),
        )
      }
      if (onError) {
        cleanups.push(
          onError((msg) => {
            setErrorMsg(msg)
            setBusyId(null)
            setQrOpen(false)
            patchRow(id, { status: 'error' })
          }),
        )
      }
    }

    attach(
      'wechat',
      window.weixinService?.onStatusChange
        ? (cb) => window.weixinService.onStatusChange((s) => cb(s))
        : undefined,
      window.weixinService?.onQrcode,
      window.weixinService?.onError,
      {
        qr: '扫码登录个人微信',
        hint: '请使用微信扫描二维码登录',
        done: ['logged_in'],
      },
    )
    attach(
      'wecom',
      window.wecomService?.onStatusChange
        ? (cb) => window.wecomService.onStatusChange((s) => cb(s))
        : undefined,
      window.wecomService?.onQrcode,
      window.wecomService?.onError,
      {
        qr: '扫码接入企业微信',
        hint: '请使用企业微信扫描二维码授权',
        done: ['connected'],
      },
    )
    attach(
      'feishu',
      window.feishuService?.onStatusChange
        ? (cb) => window.feishuService.onStatusChange((s) => cb(s))
        : undefined,
      window.feishuService?.onQrcode,
      window.feishuService?.onError,
      {
        qr: '扫码新建飞书机器人',
        hint: '请使用飞书 App 扫描二维码授权',
        done: ['connected'],
      },
    )

    return () => {
      cleanups.forEach((fn) => fn())
    }
  }, [open, patchRow, refreshStatuses])

  /**
   * 发起绑定（扫码）。
   */
  const handleBind = useCallback(async (id: BindableChannel) => {
    setBusyId(id)
    setErrorMsg(null)
    setQrDataUrl(null)
    try {
      if (id === 'wechat') await window.weixinService?.startLogin?.()
      else if (id === 'wecom') await window.wecomService?.startLogin?.()
      else await window.feishuService?.startLogin?.()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
      setBusyId(null)
    }
  }, [])

  /**
   * 断开绑定。
   */
  const handleUnbind = useCallback(
    async (id: BindableChannel) => {
      setBusyId(id)
      setErrorMsg(null)
      try {
        if (id === 'wechat') await window.weixinService?.logout?.()
        else if (id === 'wecom') await window.wecomService?.logout?.()
        else await window.feishuService?.logout?.()
        await refreshStatuses()
      } catch (e: unknown) {
        setErrorMsg(e instanceof Error ? e.message : String(e))
      } finally {
        setBusyId(null)
      }
    },
    [refreshStatuses],
  )

  return (
    <>
      <Modal
        open={open}
        title="绑定渠道"
        onClose={onClose}
        width={440}
        footer={
          <Button variant="ghost" onClick={onClose}>
            关闭
          </Button>
        }
      >
        <p className={styles.hint}>
          在聊天页直接扫码绑定即时通信渠道，绑定后消息会出现在对应渠道分组中。
        </p>

        {errorMsg && <div className={styles.error}>{errorMsg}</div>}

        <div className={styles.list}>
          {rows.map((row) => {
            const isBusy = busyId === row.id || row.status === 'waiting'
            return (
              <div key={row.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <span className={styles.rowIcon}>{row.icon}</span>
                  <div className={styles.rowText}>
                    <div className={styles.rowTitle}>
                      <span>{row.name}</span>
                      <Tag color={STATUS_COLOR[row.status]}>{STATUS_LABEL[row.status]}</Tag>
                    </div>
                    <div className={styles.rowDesc}>{row.detail ?? row.description}</div>
                  </div>
                </div>
                <div className={styles.rowActions}>
                  {row.status === 'connected' ? (
                    <Button
                      variant="danger"
                      size="sm"
                      loading={busyId === row.id}
                      disabled={isBusy && busyId !== row.id}
                      onClick={() => void handleUnbind(row.id)}
                    >
                      解绑
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      size="sm"
                      loading={isBusy}
                      disabled={busyId !== null && busyId !== row.id}
                      onClick={() => void handleBind(row.id)}
                    >
                      {row.status === 'waiting' ? '扫码中…' : '扫码绑定'}
                    </Button>
                  )}
                  {row.status === 'waiting' && qrDataUrl && (
                    <Button variant="secondary" size="sm" onClick={() => setQrOpen(true)}>
                      查看二维码
                    </Button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Modal>

      <Modal
        open={qrOpen}
        title={qrTitle}
        onClose={() => setQrOpen(false)}
        width={320}
        footer={
          <Button variant="ghost" onClick={() => setQrOpen(false)}>
            取消
          </Button>
        }
      >
        <div className={styles.qrBody}>
          {qrDataUrl ? (
            <img src={qrDataUrl} alt="渠道绑定二维码" className={styles.qrImg} />
          ) : (
            <div className={styles.qrPlaceholder}>正在获取二维码...</div>
          )}
          <p className={styles.qrHint}>{qrHint}</p>
        </div>
      </Modal>
    </>
  )
}

export default ChannelBindModal
