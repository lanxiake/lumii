/**
 * 本机微信的回复策略编辑弹窗。
 *
 * 设计口径（用户 2026-10-08 指定）：**单独弹窗配**，挑人用下拉/勾选，能批量设，
 * 面上写的东西必须是用户看得懂的——显示"妈妈"，不显示"wxid_mama"。
 *
 * 所以唯一需要用户认识 wxid 的地方没有了：候选来自微信自己的会话列表
 * （`list_sessions`，带真名），用户勾名字；wxid 只在名字下面以小字存在，
 * 用来区分同名的人。名单里每条就是「谁 + 怎么处理」。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Select } from '../../../../components/ui/Select/Select'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Modal } from '../../../../components/ui/Modal/Modal'
import type {
  ChannelPeerPolicy,
  ChannelPolicy,
  PeerReplyMode,
} from '../../../../../shared/channel-policy'

/** 四档「怎么处理」——文案就是界面上给用户看的话 */
export const MODE_OPTIONS: Array<{ value: PeerReplyMode; label: string }> = [
  { value: 'auto', label: '直接代回' },
  { value: 'draft', label: '起草给我确认' },
  { value: 'notify', label: '只提醒我' },
  { value: 'ignore', label: '不处理（黑名单）' },
]

/** 档位释义：放在下方当图例，避免用户猜「起草」到底发不发 */
const MODE_HELP =
  '直接代回 = 助手用你的口吻直接回；起草给我确认 = 先写好放到那个好友的会话里等你点头；' +
  '只提醒我 = 不叫模型，只弹通知；不处理 = 当没看见（黑名单就是它）。'

interface Candidate {
  id: string
  label: string
  isGroup: boolean
}

/** 名单里的一行（编辑态）：冷却留空 = 用默认值 */
interface DraftPeer {
  id: string
  label: string
  mode: PeerReplyMode
  cooldownSeconds: string
}

function toDraft(peers: ChannelPeerPolicy[]): DraftPeer[] {
  return peers.map((p) => ({
    id: p.id,
    label: p.label ?? '',
    mode: p.mode,
    cooldownSeconds: p.cooldownSeconds === undefined ? '' : String(p.cooldownSeconds),
  }))
}

function toPeers(rows: DraftPeer[]): ChannelPeerPolicy[] {
  const out: ChannelPeerPolicy[] = []
  for (const r of rows) {
    const id = r.id.trim()
    if (!id) continue
    const cd = Number.parseInt(r.cooldownSeconds.trim(), 10)
    out.push({
      id,
      mode: r.mode,
      ...(r.label.trim() ? { label: r.label.trim() } : {}),
      ...(Number.isFinite(cd) && cd >= 0 ? { cooldownSeconds: cd } : {}),
    })
  }
  return out
}

/** 名单里的显示名：有备注名就显示它，wxid 只当副标题 */
const nameOf = (r: DraftPeer): string => r.label.trim() || r.id

interface PolicyModalProps {
  open: boolean
  onClose: () => void
  /** 保存成功后通知外层刷新卡片摘要 */
  onSaved?: (policy: ChannelPolicy) => void
}

export const PolicyModal: React.FC<PolicyModalProps> = ({ open, onClose, onSaved }) => {
  const [accountId, setAccountId] = useState('')
  const [defaultMode, setDefaultMode] = useState<PeerReplyMode>('notify')
  const [rows, setRows] = useState<DraftPeer[]>([])
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [batchMode, setBatchMode] = useState<PeerReplyMode>('draft')

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // 挑人面板
  const [pickerOpen, setPickerOpen] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)
  const [candidateError, setCandidateError] = useState<string | null>(null)
  const [candidateLoading, setCandidateLoading] = useState(false)
  const [pickerChecked, setPickerChecked] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const applyPolicy = useCallback((p: ChannelPolicy) => {
    setAccountId(p.accountId ?? '')
    setDefaultMode(p.defaultMode)
    setRows(toDraft(p.peers))
    setChecked(new Set())
  }, [])

  // 每次打开都重新读一遍：用户可能在别处（或另一个窗口）改过
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setErrorMsg(null)
    setPickerOpen(false)
    setCandidates(null)
    void (async () => {
      try {
        const p = await window.channelService?.getPolicy?.('pcwechat')
        if (!cancelled && p) applyPolicy(p)
      } catch (e: unknown) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, applyPolicy])

  const loadCandidates = useCallback(async () => {
    setCandidateLoading(true)
    setCandidateError(null)
    try {
      const res = await window.channelService?.listWechatContacts?.()
      setCandidates(res?.contacts ?? [])
      if (res?.error) setCandidateError(res.error)
      setPickerChecked(new Set())
    } catch (e: unknown) {
      setCandidates([])
      setCandidateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCandidateLoading(false)
    }
  }, [])

  const openPicker = useCallback(() => {
    setPickerOpen(true)
    setSearch('')
    if (candidates === null) void loadCandidates()
  }, [candidates, loadCandidates])

  const inList = useMemo(() => new Set(rows.map((r) => r.id.toLowerCase())), [rows])

  /** 候选里排除已经在名单上的人（避免"加了两遍"的困惑） */
  const selectableCandidates = useMemo(() => {
    const kw = search.trim().toLowerCase()
    return (candidates ?? []).filter(
      (c) =>
        !inList.has(c.id.toLowerCase()) &&
        (kw === '' ||
          c.label.toLowerCase().includes(kw) ||
          c.id.toLowerCase().includes(kw)),
    )
  }, [candidates, inList, search])

  const addCheckedCandidates = useCallback(() => {
    // 不能用 selectableCandidates 取人：它是「按当前搜索词过滤后」的可见列表。
    // 勾选集是跨搜索累积的，一旦改了搜索词，先勾的人就不在可见列表里了，会被静默丢掉
    // （2026-10-09 用户实测：先勾几个 → 搜索再勾几个 → 加入名单，只有最后勾的进去了）。
    // 所以按 id 回到完整候选表解析。
    const byId = new Map((candidates ?? []).map((c) => [c.id, c]))
    const chosen = [...pickerChecked]
      .map((id) => byId.get(id))
      .filter((c): c is Candidate => c !== undefined)
    if (chosen.length === 0) return
    setRows((prev) => [
      ...prev,
      ...chosen.map((c) => ({
        id: c.id,
        label: c.label,
        // 新加的人默认「起草给我确认」：先看得见草稿，再决定要不要放开直接回
        mode: 'draft' as PeerReplyMode,
        cooldownSeconds: '',
      })),
    ])
    setPickerOpen(false)
    setPickerChecked(new Set())
  }, [candidates, pickerChecked])

  const toggleChecked = useCallback((id: string, on: boolean) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const applyBatchMode = useCallback(() => {
    setRows((prev) => prev.map((r) => (checked.has(r.id) ? { ...r, mode: batchMode } : r)))
  }, [checked, batchMode])

  const removeChecked = useCallback(() => {
    setRows((prev) => prev.filter((r) => !checked.has(r.id)))
    setChecked(new Set())
  }, [checked])

  const handleSave = useCallback(async () => {
    setSaving(true)
    setErrorMsg(null)
    try {
      const saved = await window.channelService?.setPolicy?.('pcwechat', {
        ...(accountId.trim() ? { accountId: accountId.trim() } : {}),
        defaultMode,
        peers: toPeers(rows),
      })
      if (saved) {
        applyPolicy(saved)
        onSaved?.(saved)
      }
      onClose()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [accountId, defaultMode, rows, applyPolicy, onSaved, onClose])

  const footer = (
    <>
      <Button variant="ghost" onClick={onClose} disabled={saving}>
        取消
      </Button>
      <Button variant="primary" onClick={() => void handleSave()} loading={saving} disabled={loading || saving}>
        保存
      </Button>
    </>
  )

  return (
    <Modal
      open={open}
      title="本机微信 · 回复策略"
      onClose={onClose}
      width={720}
      layer="aboveHub"
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {errorMsg && (
          <div style={{ color: 'var(--mt-error)', fontSize: 13 }}>{errorMsg}</div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ flex: '1 1 220px', minWidth: 200 }}>
            <Input
              label="账号（备注）"
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              placeholder="留空即本机登录的那个号"
              disabled={loading}
            />
          </div>
          <div style={{ flex: '1 1 200px', minWidth: 180 }}>
            <Select
              label="名单外的人怎么处理"
              value={defaultMode}
              options={MODE_OPTIONS}
              onChange={(e) => setDefaultMode(e.target.value as PeerReplyMode)}
              disabled={loading}
            />
          </div>
        </div>
        <p style={{ margin: 0, color: 'var(--mt-fg-3)', fontSize: 12 }}>
          账号只给你自己区分是哪个微信（实际发送永远走本机此刻登录的那个）；
          名单外的人建议留<strong>只提醒我</strong>——谁都动不了，你只多一条通知。
        </p>

        <div style={{ borderTop: '1px solid var(--mt-border-hairline)', paddingTop: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--mt-fg-2)' }}>
              谁可以被代回（{rows.length}）
            </span>
            <Button size="sm" variant="secondary" onClick={openPicker} disabled={loading}>
              {pickerOpen ? '收起' : '从微信里挑人'}
            </Button>
            <span style={{ fontSize: 12, color: 'var(--mt-fg-3)' }}>挑完记得点下面的「保存」</span>
          </div>

          {pickerOpen && (
            <div
              style={{
                marginTop: 10,
                border: '1px solid var(--mt-border-hairline)',
                borderRadius: 8,
                padding: 10,
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{ flex: '1 1 220px', minWidth: 180 }}>
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜名字或 wxid"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    // 「全选」= 把当前可见的人并进勾选，而不是覆盖整个勾选集：
                    // 与上一处同源——搜索会换掉可见列表，覆盖式全选会吞掉先前勾的人。
                    setPickerChecked((prev) => new Set([...prev, ...selectableCandidates.map((c) => c.id)]))
                  }
                  disabled={candidateLoading || selectableCandidates.length === 0}
                >
                  全选
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setPickerChecked(new Set())}
                  disabled={pickerChecked.size === 0}
                >
                  清空勾选
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={addCheckedCandidates}
                  disabled={pickerChecked.size === 0}
                >
                  加入名单（{pickerChecked.size}）
                </Button>
              </div>

              {candidateError && (
                <p style={{ margin: '8px 0 0', color: 'var(--mt-fg-3)', fontSize: 12 }}>
                  {candidateError}
                </p>
              )}

              <div style={{ maxHeight: 240, overflowY: 'auto', marginTop: 8 }}>
                {candidateLoading && (
                  <div style={{ fontSize: 13, color: 'var(--mt-fg-3)' }}>正在读微信会话…</div>
                )}
                {!candidateLoading && selectableCandidates.length === 0 && (
                  <div style={{ fontSize: 13, color: 'var(--mt-fg-3)' }}>
                    {search.trim() ? '没有匹配的人' : '没有可选的人（可能都已经在名单里了）'}
                  </div>
                )}
                {selectableCandidates.map((c) => (
                  <div
                    key={c.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' }}
                  >
                    <Checkbox
                      aria-label={`选择 ${c.label}`}
                      checked={pickerChecked.has(c.id)}
                      onChange={(on) =>
                        setPickerChecked((prev) => {
                          const next = new Set(prev)
                          if (on) next.add(c.id)
                          else next.delete(c.id)
                          return next
                        })
                      }
                    />
                    <span style={{ fontSize: 13, color: 'var(--mt-fg-1)' }}>{c.label}</span>
                    {c.isGroup && (
                      <span style={{ fontSize: 11, color: 'var(--mt-fg-3)' }}>群</span>
                    )}
                    <span style={{ fontSize: 11, color: 'var(--mt-fg-3)', fontFamily: 'monospace' }}>
                      {c.id}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {checked.size > 0 && (
            <div
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-end',
                flexWrap: 'wrap',
                marginTop: 10,
                padding: '8px 10px',
                background: 'var(--mt-bg-overlay)',
                borderRadius: 8,
              }}
            >
              <span style={{ fontSize: 13, color: 'var(--mt-fg-2)' }}>已勾选 {checked.size} 人：</span>
              <div style={{ flex: '0 1 190px', minWidth: 170 }}>
                <Select
                  aria-label="批量档位"
                  value={batchMode}
                  options={MODE_OPTIONS}
                  onChange={(e) => setBatchMode(e.target.value as PeerReplyMode)}
                />
              </div>
              <Button size="sm" variant="secondary" onClick={applyBatchMode}>
                应用
              </Button>
              <Button size="sm" variant="ghost" onClick={removeChecked}>
                移出名单
              </Button>
            </div>
          )}

          <div style={{ marginTop: 10 }}>
            {rows.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--mt-fg-3)' }}>
                名单还是空的。点上面的「从微信里挑人」，勾选允许助手代聊的好友——名单外的人一律不动。
              </div>
            )}
            {rows.map((row) => (
              <div
                key={row.id}
                style={{
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '6px 0',
                  borderBottom: '1px solid var(--mt-border-hairline)',
                }}
              >
                <Checkbox
                  aria-label={`选择 ${nameOf(row)}`}
                  checked={checked.has(row.id)}
                  onChange={(on) => toggleChecked(row.id, on)}
                />
                <div style={{ flex: '2 1 200px', minWidth: 170 }}>
                  <div style={{ fontSize: 13, color: 'var(--mt-fg-1)' }}>{nameOf(row)}</div>
                  {row.label.trim() !== '' && (
                    <div
                      style={{ fontSize: 11, color: 'var(--mt-fg-3)', fontFamily: 'monospace' }}
                    >
                      {row.id}
                    </div>
                  )}
                </div>
                <div style={{ flex: '1 1 160px', minWidth: 150 }}>
                  <Select
                    aria-label={`${nameOf(row)} 的处理方式`}
                    value={row.mode}
                    options={MODE_OPTIONS}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id ? { ...r, mode: e.target.value as PeerReplyMode } : r,
                        ),
                      )
                    }
                  />
                </div>
                <div style={{ flex: '0 1 110px', minWidth: 96 }}>
                  <Input
                    value={row.cooldownSeconds}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r) =>
                          r.id === row.id ? { ...r, cooldownSeconds: e.target.value } : r,
                        ),
                      )
                    }
                    placeholder="冷却 60"
                  />
                </div>
              </div>
            ))}
          </div>

          <p style={{ margin: '8px 0 0', color: 'var(--mt-fg-3)', fontSize: 12 }}>
            {MODE_HELP}
            <br />
            冷却 = 同一个人的两次自动动作之间至少隔多少秒（留空按 60）。同一个 id 只算一条。
          </p>
        </div>
      </div>
    </Modal>
  )
}
