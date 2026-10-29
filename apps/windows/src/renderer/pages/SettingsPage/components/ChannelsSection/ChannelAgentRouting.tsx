/**
 * 渠道 → Agent：**入站消息交给哪个 Agent 定义**。
 *
 * 为什么单列一块而不是塞进每张渠道卡片：卡片由五个插件各自注册（`SlotHost`），
 * 同一件事要写五遍；而「谁接管」是一张**跨渠道的表**，放一起才看得出差异。
 *
 * 只列四个走适配器的渠道：本机微信（pcwechat）是代聊通道，入站由代聊循环单独处理，
 * 不经 `getOrCreateChannelInstance`，给它一个「由谁接管」的下拉只会误导。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useAgents } from '../../../../hooks/business/useAgents/useAgents'
import styles from './ChannelsSection.module.css'

/** 走渠道适配器的四家；本机微信不在此列（见文件头） */
const ROUTABLE_CHANNELS = [
  { id: 'weixin', label: '个人微信' },
  { id: 'wecom', label: '企业微信' },
  { id: 'feishu', label: '飞书' },
  { id: 'qbot', label: 'QQ' },
] as const

/** 空串 = 走默认（系统助手），与策略里缺省 `agentId` 同义 */
const DEFAULT_OPTION = ''

export const ChannelAgentRouting: React.FC = () => {
  const { selectableAgents } = useAgents()
  const [agentByChannel, setAgentByChannel] = useState<Record<string, string>>({})
  const [savingChannel, setSavingChannel] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const api = window.channelService
      if (!api?.getPolicy) return
      const entries = await Promise.all(
        ROUTABLE_CHANNELS.map(async (c) => {
          try {
            const policy = await api.getPolicy(c.id)
            return [c.id, policy.agentId ?? DEFAULT_OPTION] as const
          } catch {
            return [c.id, DEFAULT_OPTION] as const
          }
        }),
      )
      if (!cancelled) setAgentByChannel(Object.fromEntries(entries))
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleChange = useCallback(
    async (channel: string, agentId: string) => {
      const api = window.channelService
      if (!api?.getPolicy || !api.setPolicy) return
      const previous = agentByChannel[channel] ?? DEFAULT_OPTION
      setSavingChannel(channel)
      setError(null)
      // 先动界面：失败再回滚，别让下拉卡住等一次磁盘写
      setAgentByChannel((m) => ({ ...m, [channel]: agentId }))
      try {
        const policy = await api.getPolicy(channel)
        await api.setPolicy(channel, { ...policy, agentId: agentId || undefined })
      } catch (err) {
        setAgentByChannel((m) => ({ ...m, [channel]: previous }))
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setSavingChannel(null)
      }
    },
    [agentByChannel],
  )

  /** 已配的 Agent 可能已被停用/删除——仍列出来，否则下拉会静默跳回「默认」 */
  const options = useMemo(() => {
    const seen = new Set(selectableAgents.map((a) => a.id))
    const extras = Object.values(agentByChannel).filter(
      (id): id is string => !!id && !seen.has(id),
    )
    return [
      ...selectableAgents.map((a) => ({ id: a.id, name: a.name })),
      ...Array.from(new Set(extras)).map((id) => ({ id, name: `${id}（未找到定义）` })),
    ]
  }, [selectableAgents, agentByChannel])

  return (
    <section className={styles.route}>
      <div className={styles.routeHead}>
        <h4 className={styles.routeTitle}>渠道由谁接管</h4>
        <p className={styles.routeHint}>
          这些渠道进来的新消息交给选中的 Agent；留空 = 系统助手。换人后**下一条消息即生效**，
          已有实例会作废旧的重建。
        </p>
      </div>
      <div className={styles.routeRows}>
        {ROUTABLE_CHANNELS.map((c) => (
          <label key={c.id} className={styles.routeRow}>
            <span className={styles.routeLabel}>{c.label}</span>
            <select
              className={styles.routeSelect}
              value={agentByChannel[c.id] ?? DEFAULT_OPTION}
              disabled={savingChannel === c.id}
              onChange={(e) => void handleChange(c.id, e.target.value)}
            >
              <option value={DEFAULT_OPTION}>默认（系统助手）</option>
              {options.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {error && <p className={styles.routeError}>保存失败：{error}</p>}
    </section>
  )
}
