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
import type { WechatSelfcheckResult } from '../../../../../preload/api/channel-api'
import { PolicyModal, MODE_OPTIONS } from './PolicyModal'

const MODE_LABELS = new Map<PeerReplyMode, string>(MODE_OPTIONS.map((o) => [o.value, o.label]))

/** 数据目录来源 → 人话（与 wechat_core.detect_xwechat_dirs 的 source 对齐） */
const DB_SOURCE_LABELS: Record<string, string> = {
  env: '环境变量',
  ini: '微信设置',
  registry: '注册表',
  default: '默认路径',
  scan: '磁盘扫描',
}

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
  const [check, setCheck] = useState<WechatSelfcheckResult | null>(null)
  const [checking, setChecking] = useState(false)

  const refreshCheck = useCallback(async () => {
    setChecking(true)
    try {
      const r = await window.channelService?.wechatSelfcheck?.()
      // 返回 null = Agent Runtime 还没就绪（MCP 探测入口够不着）——给一份"未连接"的合成结果，
      // 别让卡片永远停在"检测中…"
      setCheck(
        r ?? {
          at: Date.now(),
          connected: false,
          db: { ok: false, root: null, source: null, wxid: null },
          env: null,
          actions: [],
          ok: false,
          reason: 'Agent Runtime 未就绪',
        },
      )
    } catch {
      setCheck(null)
    } finally {
      setChecking(false)
    }
  }, [])

  const repairCheck = useCallback(async () => {
    setChecking(true)
    try {
      const r = await window.channelService?.wechatRepair?.()
      setCheck(r?.selfcheck ?? null)
    } catch {
      // 修复失败就保持旧结果，下次点「重新检测」再看
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void refreshCheck()
  }, [refreshCheck])

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

  // —— 环境自检（确定性：MCP check_env + locate_db；换机/自定义数据目录后一眼看出哪步不对）——
  const envOk = check?.env?.ok === true
  const dbLine = !check
    ? '数据目录：检测中…'
    : check.db.ok
      ? `数据目录：${check.db.root}（来源：${DB_SOURCE_LABELS[check.db.source ?? ''] ?? check.db.source ?? '自动探测'}）`
      : '数据目录：未找到（确认微信已登录；换机后可在微信「设置 → 文件管理」核对路径）'
  const envLine = !check
    ? ''
    : !check.connected
      ? '微信：wechat-local MCP 未连接'
      : `微信：${envOk ? '就绪' : String(check.env?.reason ?? '不可用')}`

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
        <div
          style={{
            marginTop: 10,
            borderTop: '1px solid var(--mt-border)',
            paddingTop: 10,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--mt-fg-3)' }}>环境自检</span>
            <span style={{ display: 'flex', gap: 6 }}>
              <Button size="sm" variant="ghost" disabled={checking} onClick={() => void refreshCheck()}>
                重新检测
              </Button>
              <Button size="sm" variant="secondary" disabled={checking} onClick={() => void repairCheck()}>
                一键修复
              </Button>
            </span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--mt-fg-2)', marginTop: 6, lineHeight: 1.7 }}>
            <div>{dbLine}</div>
            {envLine ? <div>{envLine}</div> : null}
            {check?.actions?.length ? (
              <div style={{ color: 'var(--mt-fg-3)' }}>{check.actions.join('；')}</div>
            ) : null}
          </div>
        </div>
      </ChannelCard>

      <PolicyModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onSaved={handleSaved}
      />
    </>
  )
}
