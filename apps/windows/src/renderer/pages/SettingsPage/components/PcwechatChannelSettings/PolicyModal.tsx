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
import {
  GROUP_ONLY_TRIGGERS,
  KEYWORD_TRIGGERS,
  NON_AGENT_MODES,
  type ChannelPeerPolicy,
  type ChannelPolicy,
  type PeerReplyMode,
  type PeerTrigger,
} from '../../../../../shared/channel-policy'

/** 四档「怎么处理」——文案就是界面上给用户看的话 */
export const MODE_OPTIONS: Array<{ value: PeerReplyMode; label: string }> = [
  { value: 'auto', label: '直接代回' },
  { value: 'draft', label: '起草给我确认' },
  { value: 'notify', label: '只提醒我' },
  { value: 'ignore', label: '不处理（黑名单）' },
]

/**
 * 「名单外的人怎么处理」只给非-agent 两档。
 *
 * 名单外的消息连对方是谁都不知道，让它叫醒模型就是白烧 token（见 `NON_AGENT_MODES`）。
 * 想代回谁，把人加进下面的名单——那是显式选择。
 */
const DEFAULT_MODE_OPTIONS = MODE_OPTIONS.filter((o) => NON_AGENT_MODES.includes(o.value))

const TRIGGER_OPTIONS: Array<{ value: PeerTrigger; label: string }> = [
  { value: 'all', label: '每条都回' },
  { value: 'mention', label: '只回 @我的' },
  { value: 'keyword', label: '命中关键字才回' },
  { value: 'mention_or_keyword', label: '@我 或 命中关键字' },
]

/** 私聊没有 @，只给「每条都回 / 命中关键字」。 */
const privateTriggerOptions = TRIGGER_OPTIONS.filter(
  (o) => !GROUP_ONLY_TRIGGERS.includes(o.value),
)

/** 关键字在输入框里用逗号分隔（中英文逗号、顿号、空格都当分隔符，写起来不挑） */
const splitKeywords = (s: string): string[] =>
  s.split(/[,，、\s]+/).map((k) => k.trim()).filter(Boolean)

/** 群会话（talker 恒以 `@chatroom` 结尾） */
const isGroupId = (id: string): boolean => id.trim().toLowerCase().endsWith('@chatroom')

interface Candidate {
  id: string
  label: string
  isGroup: boolean
}

/** 名单里的一行（编辑态）：冷却留空 = 用默认值；触发条件见 `PeerTrigger` */
interface DraftPeer {
  id: string
  label: string
  mode: PeerReplyMode
  cooldownSeconds: string
  trigger: PeerTrigger
  keywords: string
}

function toDraft(peers: ChannelPeerPolicy[]): DraftPeer[] {
  return peers.map((p) => ({
    id: p.id,
    label: p.label ?? '',
    mode: p.mode,
    cooldownSeconds: p.cooldownSeconds === undefined ? '' : String(p.cooldownSeconds),
    trigger: p.trigger ?? 'all',
    keywords: (p.keywords ?? []).join('，'),
  }))
}

function toPeers(rows: DraftPeer[]): ChannelPeerPolicy[] {
  const out: ChannelPeerPolicy[] = []
  for (const r of rows) {
    const id = r.id.trim()
    if (!id) continue
    const cd = Number.parseInt(r.cooldownSeconds.trim(), 10)
    const keywords = splitKeywords(r.keywords)
    out.push({
      id,
      mode: r.mode,
      ...(r.label.trim() ? { label: r.label.trim() } : {}),
      ...(Number.isFinite(cd) && cd >= 0 ? { cooldownSeconds: cd } : {}),
      ...(r.trigger !== 'all' ? { trigger: r.trigger } : {}),
      ...(KEYWORD_TRIGGERS.includes(r.trigger) && keywords.length ? { keywords } : {}),
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
        // 群默认「只回 @我的」：群里一天几百条，默认全回等于把模型丢进噪音里
        trigger: (c.isGroup ? 'mention' : 'all') as PeerTrigger,
        keywords: '',
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
              options={DEFAULT_MODE_OPTIONS}
              onChange={(e) => setDefaultMode(e.target.value as PeerReplyMode)}
              disabled={loading}
            />
          </div>
        </div>
        <p style={{ margin: 0, color: 'var(--mt-fg-3)', fontSize: 12 }}>
          账号只给你自己区分是哪个微信（实际发送永远走本机此刻登录的那个）；
          名单外的人一律<strong>不叫模型</strong>（不烧 token）——最多弹条通知。
          想让助手回谁，把人加进下面的名单。
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

          {/* 名单自己滚（`maxHeight`），不让它把上面的「名单外怎么处理」顶出视口——
              人一多整张弹窗就超过 86vh，Modal 的 body 一滚，顶部两个设置项就没影了（实测）。
              固定高度而不是 flex:1：不依赖父链上的 min-height，少一处会随别人改动失效的耦合。 */}
          <div style={{ marginTop: 10, maxHeight: '46vh', overflowY: 'auto', paddingRight: 4 }}>
            {rows.length === 0 && (
              <div style={{ fontSize: 13, color: 'var(--mt-fg-3)' }}>
                名单还是空的。点上面的「从微信里挑人」，勾选允许助手代聊的好友——名单外的人一律不动。
              </div>
            )}
            {rows.map((row) => {
              const patch = (p: Partial<DraftPeer>) =>
                setRows((prev) => prev.map((r) => (r.id === row.id ? { ...r, ...p } : r)))
              const isGroup = isGroupId(row.id)
              const needsKeywords = KEYWORD_TRIGGERS.includes(row.trigger)
              return (
                <div
                  key={row.id}
                  style={{
                    border: '1px solid var(--mt-border-hairline)',
                    borderRadius: 8,
                    padding: '10px 12px',
                    marginTop: 8,
                    background: checked.has(row.id) ? 'var(--mt-bg-overlay)' : undefined,
                  }}
                >
                  {/* 抬头：勾选框 + 名字 + 群/私聊 + wxid（同名的人靠 wxid 区分，所以常显） */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <Checkbox
                      aria-label={`选择 ${nameOf(row)}`}
                      checked={checked.has(row.id)}
                      onChange={(on) => toggleChecked(row.id, on)}
                    />
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--mt-fg-1)' }}>
                      {nameOf(row)}
                    </span>
                    <span
                      style={{
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 999,
                        color: 'var(--mt-fg-3)',
                        border: '1px solid var(--mt-border-hairline)',
                      }}
                    >
                      {isGroup ? '群' : '私聊'}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        fontSize: 11,
                        color: 'var(--mt-fg-3)',
                        fontFamily: 'monospace',
                      }}
                    >
                      {row.id}
                    </span>
                  </div>

                  {/* 控件各自带标签：比"一行四个裸控件"少一半「这格里是什么」的疑问 */}
                  <div
                    style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 10 }}
                  >
                    <div style={{ flex: '1 1 170px', minWidth: 150 }}>
                      <Select
                        label="怎么处理"
                        aria-label={`${nameOf(row)} 的处理方式`}
                        value={row.mode}
                        options={MODE_OPTIONS}
                        onChange={(e) => patch({ mode: e.target.value as PeerReplyMode })}
                      />
                    </div>
                    <div style={{ flex: '0 1 120px', minWidth: 108 }}>
                      <Input
                        label="冷却（秒）"
                        value={row.cooldownSeconds}
                        onChange={(e) => patch({ cooldownSeconds: e.target.value })}
                        placeholder="60"
                      />
                    </div>
                    <div style={{ flex: '1 1 170px', minWidth: 150 }}>
                      <Select
                        label="什么消息才惊动助手"
                        aria-label={`${nameOf(row)} 的触发条件`}
                        value={row.trigger}
                        options={isGroup ? TRIGGER_OPTIONS : privateTriggerOptions}
                        onChange={(e) => patch({ trigger: e.target.value as PeerTrigger })}
                      />
                    </div>
                    {needsKeywords && (
                      <div style={{ flex: '1 1 100%' }}>
                        <Input
                          label="关键字（出现任一个才回，逗号分隔）"
                          aria-label={`${nameOf(row)} 的关键字`}
                          value={row.keywords}
                          onChange={(e) => patch({ keywords: e.target.value })}
                          placeholder="报错，上线，帮我看下"
                        />
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>

          <div
            style={{
              marginTop: 10,
              padding: '8px 10px',
              borderRadius: 8,
              background: 'var(--mt-bg-overlay)',
              color: 'var(--mt-fg-3)',
              fontSize: 12,
              lineHeight: 1.7,
            }}
          >
            <div>
              <strong style={{ color: 'var(--mt-fg-2)' }}>怎么处理</strong>：
              <code style={{ fontFamily: 'inherit' }}>直接代回</code> 用你的口吻直接回；
              <code style={{ fontFamily: 'inherit' }}>起草给我确认</code> 先写好放进那个会话等你点头；
              <code style={{ fontFamily: 'inherit' }}>只提醒我</code> 不叫模型、只弹通知；
              <code style={{ fontFamily: 'inherit' }}>不处理</code> 当没看见。
            </div>
            <div>
              <strong style={{ color: 'var(--mt-fg-2)' }}>什么消息才惊动助手</strong>：不满足条件的消息
              <strong>不叫模型</strong>（只有「只提醒我」那档照旧提醒）；「@我」按微信里被 @ 的 wxid 判定，
              「关键字」是正文出现任一个词（不区分大小写）——私聊也能用关键字。
            </div>
            <div>
              <strong style={{ color: 'var(--mt-fg-2)' }}>冷却</strong>：同一个人两次自动动作至少隔多少秒（留空按 60）。
            </div>
          </div>
        </div>
      </div>
    </Modal>
  )
}
