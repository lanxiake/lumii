/**
 * 本机微信（pcwechat）渠道卡片：**摘要 + 一个「配置」按钮**。
 *
 * 与另外四张卡片不同，这里没有"登录"——"在线"就等于本机 wechat-local MCP 连着
 * （助手用这台电脑上已登录的微信说话）。主体是回复策略，但表单本身放在
 * `PolicyModal` 里单独弹窗（用户 2026-10-08 指定：卡片上塞不下，也不该塞）。
 * 卡片上只说三句人话：在线没有、名单里有几个人、名单外的人怎么处理。
 *
 * 这份策略是**唯一真源**：盯梢循环每拍从主进程同一份缓存读，弹窗里改完立刻生效。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { ChannelCard, type ChannelMetaItem } from '../ChannelCard'
import { ChannelBrandIcon } from '../../../../components/brand/ChannelBrandIcon'
import type { ChannelSnapshot } from '../ChannelsSection/useChannelSnapshots'
import type { ChannelPolicy, PeerReplyMode } from '../../../../../shared/channel-policy'
import { PolicyModal, MODE_OPTIONS } from './PolicyModal'

const MODE_LABELS = new Map<PeerReplyMode, string>(MODE_OPTIONS.map((o) => [o.value, o.label]))

interface PcwechatChannelSettingsProps {
  snapshot?: ChannelSnapshot
  snapshotLoading?: boolean
}

/**
 * 本机微信渠道卡片。
 */
export const PcwechatChannelSettings: React.FC<PcwechatChannelSettingsProps> = ({
  snapshot,
  snapshotLoading = false,
}) => {
  const [policy, setPolicy] = useState<ChannelPolicy | null>(null)
  const [modalOpen, setModalOpen] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const p = await window.channelService?.getPolicy?.('pcwechat')
        if (!cancelled && p) setPolicy(p)
      } catch {
        // 读不到策略不影响卡片（显示默认档），弹窗里会再读一次并报错
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleSaved = useCallback((p: ChannelPolicy) => setPolicy(p), [])

  const connected = snapshot?.connected ?? false
  // 能被代回的人数 = 名单里除黑名单之外的（与出站 provider 的 peers 同一口径）
  const sendable = policy?.peers.filter((p) => p.mode !== 'ignore') ?? []

  const meta: ChannelMetaItem[] = [
    { label: '在线', value: connected ? '本机微信已就绪' : '本机微信未就绪（MCP 没连上）' },
    {
      label: '可代回',
      value: sendable.length === 0 ? '还没有人' : `${sendable.length} 人`,
    },
    {
      label: '名单外的人',
      value: policy ? (MODE_LABELS.get(policy.defaultMode) ?? policy.defaultMode) : '读取中…',
    },
  ]

  const summary =
    sendable.length === 0
      ? '还没配人：助手不会替任何人回消息'
      : sendable
          .slice(0, 4)
          .map((p) => `${p.label ?? p.id}·${MODE_LABELS.get(p.mode) ?? p.mode}`)
          .join('，') + (sendable.length > 4 ? ` 等 ${sendable.length} 人` : '')

  return (
    <>
      <ChannelCard
        icon={<ChannelBrandIcon kind="pcwechat" />}
        name="本机微信"
        description="以你本人身份，跟你微信里的好友说话（用这台电脑上登录的微信）"
        capability="只对名单里的人"
        state={connected ? 'connected' : 'idle'}
        statusLabel={connected ? '已连接' : '未接入'}
        actions={
          <Button size="sm" variant="secondary" onClick={() => setModalOpen(true)}>
            配置
          </Button>
        }
        meta={meta}
      >
        <p style={{ margin: '10px 0 0', fontSize: 13, color: 'var(--mt-fg-2)' }}>{summary}</p>
      </ChannelCard>

      <PolicyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={handleSaved}
      />
    </>
  )
}
