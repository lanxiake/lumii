/**
 * 渠道目标派发（cron 定时任务与自主目标 outreach 共用）。
 *
 * 两处此前各抄了一份 feishu/weixin/wecom 派发循环，渠道覆盖已开始漂移
 * （outreach 缺 qbot）。渠道目标统一走这里；本地目标（system/news/focus）
 * 语义各异，仍由调用方自理。
 *
 * 正文以原始 Markdown 交给渠道层编译（飞书卡片 / 企微·QQ markdown /
 * 微信手机友好分段），title 作为来源标签；单渠道失败只记日志，不影响
 * 其余渠道，也不让整个任务判定为失败。
 */

import type { ChannelOutboundRouter } from '../channel/channel-outbound-router'
import { compileForFeishu } from '../channel/format/channel-message-compiler'

const log = {
  warn: (...args: unknown[]) => console.warn('[ChannelTargetDispatch]', ...args),
}

export interface ChannelTargetDispatchDeps {
  getChannelRouter?: () => ChannelOutboundRouter | null | undefined
  /** Router 不可用时的飞书兜底：直发纯文本（无富文本能力） */
  sendFeishuMessage?: (text: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * 派发单个渠道目标。target 语法 `kind` 或 `kind:peerId`。
 *
 * feishu 未指定 peer 时自动选第一个可发送 peer；weixin/qbot 必须显式指定
 * （cached_reply / 被动窗口语义下乱选 peer 会发错人）。
 */
export async function dispatchChannelTarget(
  target: string,
  text: string,
  title: string,
  deps: ChannelTargetDispatchDeps,
): Promise<void> {
  const colon = target.indexOf(':')
  const kind = colon > 0 ? target.slice(0, colon) : target
  const peer = colon > 0 ? target.slice(colon + 1).trim() : ''

  if (kind === 'wecom') {
    log.warn('企业微信不支持主动推送（reply_only），已跳过')
    return
  }
  if (kind !== 'feishu' && kind !== 'weixin' && kind !== 'qbot') {
    log.warn(`未知渠道目标，已忽略: ${target}`)
    return
  }
  if (!peer && kind !== 'feishu') {
    log.warn(`${kind} 目标缺少 peerId，请使用 ${kind}:<peerId>，已跳过`)
    return
  }

  const router = deps.getChannelRouter?.()
  if (!router) {
    if (kind === 'feishu' && deps.sendFeishuMessage) {
      // 兜底是 text 消息（不渲染 Markdown），用编译器的纯文本形态，避免 `##`/`**` 噪声
      const compiled = compileForFeishu(text, title)
      const plain = compiled.kind === 'text' ? compiled.text : compiled.fallbackText
      const res = await deps.sendFeishuMessage(plain)
      if (!res.ok) log.warn('飞书兜底推送失败:', res.error)
      return
    }
    log.warn(`ChannelOutboundRouter 未就绪，${kind} 推送已跳过`)
    return
  }

  let to = peer
  if (!to) {
    const snaps = await router.list()
    const snap = snaps.find((s) => s.channel === kind)
    to = snap?.peers.find((p) => p.canSend)?.id ?? snap?.peers[0]?.id ?? ''
    if (!to) {
      log.warn(`${kind} 无可用 peer，已跳过`)
      return
    }
  }

  const res = await router.send({ channel: kind, to, text, ...(title ? { title } : {}) })
  if (!res.ok) log.warn(`${kind} 推送失败:`, res.errorCode, res.message)
}
