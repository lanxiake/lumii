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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Select } from '../../../../components/ui/Select/Select'
import { Checkbox } from '../../../../components/ui/Checkbox/Checkbox'
import { Modal } from '../../../../components/ui/Modal/Modal'
import {
  GROUP_ONLY_TRIGGERS,
  KEYWORD_TRIGGERS,
  NON_AGENT_MODES,
  policyForAccount,
  type ChannelAccountPolicy,
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

/** 一个账号页签的编辑态（每个微信账号一份） */
interface AccountDraft {
  label: string
  defaultMode: PeerReplyMode
  rows: DraftPeer[]
}

const emptyDraft = (defaultMode: PeerReplyMode = 'notify'): AccountDraft => ({
  label: '',
  defaultMode,
  rows: [],
})

/** 账号键大小写不敏感（wxid 大小写混写见得多），找到就用已有那份 */
function findDraftKey(map: Record<string, AccountDraft>, key: string): string | undefined {
  if (!key) return map[''] ? '' : undefined
  if (map[key]) return key
  return Object.keys(map).find((k) => k && k.toLowerCase() === key.toLowerCase())
}

interface PolicyModalProps {
  open: boolean
  onClose: () => void
  /** 保存成功后通知外层刷新卡片摘要 */
  onSaved?: (policy: ChannelPolicy) => void
}

export const PolicyModal: React.FC<PolicyModalProps> = ({ open, onClose, onSaved }) => {
  // 本机登录过的微信号（含没在跑的）；读不到就没有页签可选
  const [accounts, setAccounts] = useState<Array<{ wxid: string; running: boolean }>>([])
  const [accountsError, setAccountsError] = useState<string | null>(null)
  // 当前页签 = wxid（没有「默认」页签：每个号各配各的）
  const [active, setActive] = useState('')
  const activeRef = useRef('')
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>({})
  // 只有**改过**或**原本就有**的账号才落单独一份
  const [touched, setTouched] = useState<Set<string>>(new Set())
  const touchedRef = useRef(touched)
  // 账号自己的显示名（从该号的会话列表里「自己那条」读）；页签显示「名字（wxid）」
  const [accountNames, setAccountNames] = useState<Record<string, string>>({})
  // 顶层策略不在界面里编辑（没有默认页签了），保存时原样带上
  const [basePolicy, setBasePolicy] = useState<ChannelPolicy | null>(null)
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

  const applyLoaded = useCallback(
    (p: ChannelPolicy, list: Array<{ wxid: string; running: boolean }>) => {
      const next: Record<string, AccountDraft> = {}
      const explicit = new Set<string>()
      for (const [key, value] of Object.entries(p.accounts ?? {})) {
        if (!key.trim()) continue
        next[key] = {
          label: value.label ?? '',
          defaultMode: value.defaultMode,
          rows: toDraft(value.peers),
        }
        explicit.add(key.trim().toLowerCase())
      }
      // 没单独配过的号也物化一份「当前生效的策略」，切页签看到的就是它自己的数据
      for (const a of list) {
        if (findDraftKey(next, a.wxid) !== undefined) continue
        const eff = policyForAccount(p, a.wxid)
        next[a.wxid] = {
          label: eff.label ?? '',
          defaultMode: eff.defaultMode,
          rows: toDraft(eff.peers),
        }
      }
      const first = list[0]?.wxid ?? Object.keys(next)[0] ?? ''
      activeRef.current = first
      setBasePolicy(p)
      setAccounts(list)
      setDrafts(next)
      setTouched(explicit)
      setActive(first)
      setChecked(new Set())
      setCandidates(null)
      setPickerOpen(false)
    },
    [],
  )

  useEffect(() => {
    touchedRef.current = touched
  }, [touched])

  // 每次打开都重新读一遍：用户可能在别处（或另一个窗口）改过；
  // 账号列表与策略并行读，账号读失败不影响策略页（只是不能按号分账）
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setErrorMsg(null)
    setAccountsError(null)
    setPickerOpen(false)
    setCandidates(null)
    void (async () => {
      try {
        const p = await window.channelService?.getPolicy?.('pcwechat')
        let accountRes:
          | { accounts?: Array<{ wxid: string; running: boolean }>; error?: string }
          | undefined
        try {
          accountRes = await window.channelService?.listWechatAccounts?.()
        } catch (e: unknown) {
          accountRes = { accounts: [], error: e instanceof Error ? e.message : String(e) }
        }
        if (cancelled) return
        if (p) applyLoaded(p, accountRes?.accounts ?? [])
        if (accountRes?.error) setAccountsError(accountRes.error)
      } catch (e: unknown) {
        if (!cancelled) setErrorMsg(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, applyLoaded])

  // 当前页签的编辑态（每个号一份，互不影响）
  const currentDraft = useMemo(() => {
    const key = findDraftKey(drafts, active)
    return (key !== undefined ? drafts[key] : undefined) ?? emptyDraft()
  }, [drafts, active])
  const { rows, defaultMode } = currentDraft

  /** 改当前页签；账号页签第一次改动时物化成它自己的那一份 */
  const mutateCurrent = useCallback(
    (mut: (d: AccountDraft) => AccountDraft) => {
      const key = active
      setDrafts((prev) => {
        const found = findDraftKey(prev, key)
        const seed = found !== undefined ? prev[found] : emptyDraft()
        const next = { ...prev }
        // 同名不同大小写的键只留一个（否则保存时会写出两份账号分账）
        for (const k of Object.keys(next)) {
          if (k && k.toLowerCase() === key.toLowerCase() && k !== key) delete next[k]
        }
        next[key] = mut(seed ?? emptyDraft())
        return next
      })
      if (key) {
        const lower = key.toLowerCase()
        setTouched((prev) => (prev.has(lower) ? prev : new Set(prev).add(lower)))
      }
    },
    [active],
  )

  const setRows = useCallback(
    (updater: (prev: DraftPeer[]) => DraftPeer[]) => {
      mutateCurrent((d) => ({ ...d, rows: updater(d.rows) }))
    },
    [mutateCurrent],
  )

  const setDefaultMode = useCallback(
    (mode: PeerReplyMode) => mutateCurrent((d) => ({ ...d, defaultMode: mode })),
    [mutateCurrent],
  )

  /** 读这个号自己的会话列表：拿「自己那条」的显示名，也顺手备好挑人面板的数据 */
  const fetchAccountMeta = useCallback(async (wxid: string) => {
    if (!wxid) return null
    try {
      const res = await window.channelService?.listWechatContacts?.(wxid)
      const self = (res?.contacts ?? []).find((c) => c.id.toLowerCase() === wxid.toLowerCase())
      const name = self?.label.trim()
      if (name && name.toLowerCase() !== wxid.toLowerCase()) {
        setAccountNames((prev) =>
          prev[wxid.toLowerCase()] ? prev : { ...prev, [wxid.toLowerCase()]: name },
        )
      }
      return res ?? null
    } catch {
      return null
    }
  }, [])

  /** 切页签时重新拉这个号的数据（策略 + 会话）；有未保存编辑的页签不覆盖 */
  const refreshAccount = useCallback(
    async (wxid: string) => {
      if (!wxid) return
      const lower = wxid.toLowerCase()
      const [res, p] = await Promise.all([
        fetchAccountMeta(wxid),
        Promise.resolve(window.channelService?.getPolicy?.('pcwechat')).catch(() => undefined),
      ])
      if (p) {
        setBasePolicy(p)
        setDrafts((prev) => {
          if (touchedRef.current.has(lower)) return prev
          const key = findDraftKey(prev, wxid) ?? wxid
          const eff = policyForAccount(p, wxid)
          return {
            ...prev,
            [key]: {
              label: eff.label ?? '',
              defaultMode: eff.defaultMode,
              rows: toDraft(eff.peers),
            },
          }
        })
      }
      if (activeRef.current === lower && res) {
        setCandidates(res.contacts)
        setCandidateError(res.error ?? null)
      }
    },
    [fetchAccountMeta],
  )

  const switchAccount = useCallback(
    (key: string) => {
      activeRef.current = key
      setActive(key)
      setChecked(new Set())
      setPickerOpen(false)
      setCandidates(null)
      setCandidateError(null)
      // 每个页签的数据各拉各的：切过去就重新读这个号
      void refreshAccount(key)
    },
    [refreshAccount],
  )

  // 打开弹窗后把每个号的显示名先读出来（页签要用；不阻塞弹窗）
  useEffect(() => {
    if (!open) return
    for (const a of accounts) void fetchAccountMeta(a.wxid)
  }, [open, accounts, fetchAccountMeta])

  /** 这个号改回沿用默认：删掉它单独的配置（下次保存就不再带这一节） */
  const resetAccount = useCallback(() => {
    if (!active) return
    const found = findDraftKey(drafts, active)
    setDrafts((prev) => {
      if (found === undefined) return prev
      const next = { ...prev }
      delete next[found]
      // 删掉单独配置后，界面立刻回到它当前生效的那份（顶层），不是空表
      if (basePolicy) {
        const eff = policyForAccount(basePolicy, active)
        next[active] = {
          label: eff.label ?? '',
          defaultMode: eff.defaultMode,
          rows: toDraft(eff.peers),
        }
      }
      return next
    })
    const lower = active.toLowerCase()
    setTouched((prev) => {
      if (!prev.has(lower)) return prev
      const next = new Set(prev)
      next.delete(lower)
      return next
    })
  }, [active, drafts, basePolicy])

  // 页签 = 本机读到的账号 ∪ 已经单独配过的账号（离线/删号的也要能编辑、能清掉）
  const accountTabs = useMemo(() => {
    const out = [...accounts]
    const seen = new Set(accounts.map((a) => a.wxid.toLowerCase()))
    for (const key of Object.keys(drafts)) {
      if (!key || seen.has(key.toLowerCase())) continue
      out.push({ wxid: key, running: false })
      seen.add(key.toLowerCase())
    }
    return out
  }, [accounts, drafts])

  const loadCandidates = useCallback(async () => {
    setCandidateLoading(true)
    setCandidateError(null)
    try {
      // 多开：候选是**这个号**自己的会话列表
      const res = await window.channelService?.listWechatContacts?.(active || undefined)
      setCandidates(res?.contacts ?? [])
      if (res?.error) setCandidateError(res.error)
      setPickerChecked(new Set())
    } catch (e: unknown) {
      setCandidates([])
      setCandidateError(e instanceof Error ? e.message : String(e))
    } finally {
      setCandidateLoading(false)
    }
  }, [active])

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
      // 只落**改过或原本就有**的账号分账；没动过的继续沿用顶层
      const nextAccounts: Record<string, ChannelAccountPolicy> = {}
      for (const [key, d] of Object.entries(drafts)) {
        if (!key) continue
        if (!touched.has(key.trim().toLowerCase())) continue
        nextAccounts[key] = {
          ...(d.label.trim() ? { label: d.label.trim() } : {}),
          defaultMode: d.defaultMode,
          peers: toPeers(d.rows),
        }
      }
      // 顶层策略（老字段与未单独配置账号的回落）界面上不再编辑，原样保留
      const payload: ChannelPolicy = {
        ...(basePolicy?.accountId ? { accountId: basePolicy.accountId } : {}),
        defaultMode: basePolicy?.defaultMode ?? 'notify',
        peers: basePolicy?.peers ?? [],
        ...(Object.keys(nextAccounts).length ? { accounts: nextAccounts } : {}),
      }
      const saved = await window.channelService?.setPolicy?.('pcwechat', payload)
      if (saved) onSaved?.(saved)
      onClose()
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }, [basePolicy, drafts, touched, onSaved, onClose])

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

        {/* 多开：每个微信号一个页签，名单与名单外处置各管各的 */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--mt-fg-3)', marginBottom: 6 }}>按账号配置</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {accountTabs.map((a) => {
              const key = findDraftKey(drafts, a.wxid)
              const remark = key !== undefined ? drafts[key]?.label.trim() : ''
              // 页签上要能区分账号：微信里的名字 + wxid（名字读不到就退回备注）
              const name = accountNames[a.wxid.toLowerCase()] || remark
              return (
                <Button
                  key={a.wxid}
                  size="sm"
                  variant={active.toLowerCase() === a.wxid.toLowerCase() ? 'primary' : 'ghost'}
                  onClick={() => switchAccount(a.wxid)}
                  disabled={loading}
                  title={name ? `${name}（${a.wxid}）` : a.wxid}
                >
                  {name ? `${name}（${a.wxid}）` : a.wxid}
                  {a.running ? '' : ' · 离线'}
                </Button>
              )
            })}
            {accountTabs.length === 0 && !loading && (
              <span style={{ fontSize: 12, color: 'var(--mt-fg-3)' }}>
                没读到本机微信账号；确认微信已登录后再打开这个弹窗
              </span>
            )}
          </div>
          {accountsError && (
            <p style={{ margin: '6px 0 0', color: 'var(--mt-fg-3)', fontSize: 12 }}>
              {accountsError}
            </p>
          )}
        </div>

        {active && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '1 1 220px', minWidth: 200 }}>
              <Input
                label="账号备注（如「工作号」）"
                value={currentDraft.label}
                onChange={(e) => mutateCurrent((d) => ({ ...d, label: e.target.value }))}
                placeholder="只给你自己看；留空就显示 wxid"
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
            {touched.has(active.toLowerCase()) && (
              <Button size="sm" variant="ghost" onClick={resetAccount} disabled={loading}>
                改回沿用默认
              </Button>
            )}
          </div>
        )}
        <p style={{ margin: 0, color: 'var(--mt-fg-3)', fontSize: 12 }}>
          每个微信号一个页签，名单与档位各配各的（工作号只提醒、生活号直接代回）；
          <strong>切换页签会重新读这个号的会话与策略</strong>，没保存的改动留在原页签里。
          名单外的人一律<strong>不叫模型</strong>（不烧 token）——最多弹条通知。
          回复永远从收到消息的那个号发出。
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
