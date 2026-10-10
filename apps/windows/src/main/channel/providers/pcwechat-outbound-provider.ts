/**
 * 本机微信（pcwechat）出站 Provider
 *
 * ---------------------------------------------------------------------------
 * 与另外四个渠道的两点根本差别
 * ---------------------------------------------------------------------------
 * 1. **没有登录服务**：另外四家的"在线"是某个 token/会话还在；本机微信的"在线"是
 *    **本机的 wechat-local MCP 连着**（那个 MCP 才是读、发微信的那双手，零注入、
 *    只读解密 + GUI 自动化）。所以连接态从 McpManager 的运行时真值读，不碰任何凭证文件。
 *
 * 2. **peers 不是「最近跟谁聊过」，而是渠道策略里配过的名单**
 *    （`~/.lumii/channel/channel-policies.json`，设置页 → 渠道 → 本机微信里改）。
 *    Router 拿这份 peers 当出站白名单，于是「只有配过的人才能被代发」不是提示词里的
 *    君子协定，而是**真的发不出去**：名单外的人连 channel_list 里都不出现，
 *    channel_send 会被 Router 挡成 PEER_NOT_FOUND。名单里 `mode:'ignore'`（黑名单）同理。
 *
 * 发送是**不可撤回**的（对面是真人），所以这一层一律失败闭合：
 * 拿不到工具的明确确认就报 ok:false，绝不把"可能发出去了"写成"已发出"。
 */

import type { ChannelPolicy } from '../../../shared/channel-policy'
import { isSamePeer } from '../../../shared/channel-policy'
import type {
  ChannelSendResult,
  ChannelSnapshot,
  IChannelOutboundProvider,
} from '../outbound-types'

/**
 * 「此刻够不着」而不是「内容不对」的错误码：微信没跑 / 窗口被收起收进托盘 / 切不过去。
 * 这类失败**重试就能成功**，所以投进待补发队列等门开；其余错误码（名单外、找不到会话）
 * 重试一万次也没用，进队列只会把队列变成噪声桶。
 *
 * `target_unconfirmed` 是发送层的 fail-closed 兜底：目标会话没能确认下来，**一个字都没输入**，
 * 所以补发绝不会重复发。不排它的话，切换一失败那条回复就**静默没了**（2026-10-09 定）。
 */
const UNDELIVERABLE_CODES = new Set(['env_not_ready', 'target_unconfirmed'])

/** 发送工具（wechat-local 的 send_text）返回的最小面 */
interface SendTextPayload {
  ok?: boolean
  detail?: string
  /** 工具自报这次是不是演练（默认 dry_run=true）。**必须确认为 false** */
  dry_run?: boolean
  error_code?: string
  /** 工具给的可操作建议（中文），失败时一并带给用户 */
  suggestion?: string
}

export interface PcwechatProviderDeps {
  /** 当前策略（名单即白名单，每拍现读，设置页改完下一个请求就生效） */
  getPolicy: () => ChannelPolicy
  /** wechat-local 的 MCP server 名（装配处给，不写死在 Provider 里） */
  mcpServer: string
  /** 该 MCP 现在连着没有（McpManager 的运行时状态，不是配置文件） */
  isMcpConnected: () => boolean
  /** 直接调 MCP 工具（主进程内，不经 Agent 回合） */
  callMcpTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>
  /**
   * 「此刻发不出去」（`UNDELIVERABLE_CODES`：微信没运行 / 主窗口被收进托盘 / 切不过去）时，
   * 把这条投进待补发队列，等那双手回来了由盯梢回路补发（见 `wechat-watch-tick.ts`）。
   *
   * 为什么生产者在**这一层**：只有这里拿得到工具的错误码——"内容不对"（名单外/找不到会话）
   * 与"环境够不着"必须分得开，前者重试一万次也没用，后者重试就能成功。
   */
  onUndeliverable?: (to: string, text: string) => void
}

export class PcwechatChannelProvider implements IChannelOutboundProvider {
  readonly channel = 'pcwechat' as const

  constructor(private readonly deps: PcwechatProviderDeps) {}

  getSnapshot(): ChannelSnapshot {
    const connected = this.deps.isMcpConnected()
    const policy = this.deps.getPolicy()
    return {
      channel: 'pcwechat',
      connected,
      // 我们有 GUI 自动化这双手：想什么时候发就什么时候发，不受"被动回复窗口"限制
      pushMode: 'native_push',
      // MCP 没连时不给任何 peer：让 Agent 看到"这个渠道没在线"，而不是列一堆发不出去的名单
      peers: connected
        ? policy.peers
            .filter((p) => p.mode !== 'ignore')
            .map((p) => ({
              id: p.id,
              ...(p.label ? { label: p.label } : {}),
              canSend: true,
            }))
        : [],
      ...(policy.accountId ? { accountId: policy.accountId } : {}),
    }
  }

  async sendText(params: { to: string; text: string; title?: string }): Promise<ChannelSendResult> {
    const { to, text } = params
    const fail = (
      errorCode: ChannelSendResult['errorCode'],
      message: string,
    ): ChannelSendResult => ({ ok: false, errorCode, message, channel: 'pcwechat', to })

    if (!this.deps.isMcpConnected()) {
      return fail('CHANNEL_NOT_CONNECTED', '本机微信的 wechat-local MCP 没连上')
    }
    // 兜底白名单：Router 已经按快照挡过一次，但「策略刚被改成 ignore」与快照之间有窗口，
    // 而发出去就收不回——这里再判一次，宁可多判
    const allowed = this.deps
      .getPolicy()
      .peers.some((p) => p.mode !== 'ignore' && isSamePeer(p.id, to))
    if (!allowed) {
      return fail(
        'PEER_NOT_FOUND',
        `「${to}」不在本机微信的回复名单里（设置 → 渠道 → 本机微信 里加），名单外的人不能代发`,
      )
    }

    let raw: string
    try {
      raw = await this.deps.callMcpTool(this.deps.mcpServer, 'send_text', {
        talker: to,
        text,
        // 显式 false：工具的默认值是 true（只校验不发送），少写这一次就是"报告已发、其实没发"
        dry_run: false,
      })
    } catch (err) {
      return fail(
        'UPSTREAM_ERROR',
        `调本机微信的发送工具失败：${err instanceof Error ? err.message : String(err)}`,
      )
    }

    let out: SendTextPayload
    try {
      out = JSON.parse(raw) as SendTextPayload
    } catch {
      // 返回不可解析 = 发没发出去无从确认。**绝不能当成功**，也绝不能重发
      return fail(
        'UPSTREAM_ERROR',
        `发送工具返回的不是 JSON，无法确认发没发出去——**不要重发**，请人工看一眼那个会话：${raw.slice(0, 200)}`,
      )
    }

    // 工具要是忽略了 dry_run 只做了演练，它会照回 ok:true —— 那就是"报告已发、实际没发"，
    // 最坏的一种谎。所以成功必须**同时**满足 ok 与 dry_run===false
    if (out.ok && out.dry_run !== false) {
      return fail('UPSTREAM_ERROR', '发送工具只做了演练（dry_run=true），并没有真发出去——不要按"已发送"上报')
    }
    if (!out.ok) {
      const detail = [out.detail, out.suggestion].filter(Boolean).join(' ') || '本机微信发送失败'
      // 原样带上工具自报的错误码：归一化后的 errorCode 粒度太粗（target_unconfirmed → UPSTREAM_ERROR），
      // 调用方（代聊/日志）看不出到底卡在目标确认还是别处
      const upstream = out.error_code ? { upstreamCode: out.error_code } : {}
      if (UNDELIVERABLE_CODES.has(out.error_code ?? '') && this.enqueue(to, text)) {
        // 内容没问题，只是此刻那双手不在——**排队等门开**，并如实报「排队中」：
        // 报成失败会让调用方（代聊）误判成"发错了"而去改内容或转人工
        return {
          ...fail(mapErrorCode(out.error_code), `已排队待补发（此刻还没送达）：${detail}`),
          ...upstream,
          queued: true,
        }
      }
      return { ...fail(mapErrorCode(out.error_code), detail), ...upstream }
    }
    return { ok: true, channel: 'pcwechat', to }
  }

  /**
   * 投进待补发队列，返回是否真的排上了。
   * 没接队列、或队列本身抛错，都算没排上——那就照实报失败，绝不谎报「会自动补发」。
   */
  private enqueue(to: string, text: string): boolean {
    if (!this.deps.onUndeliverable) return false
    try {
      this.deps.onUndeliverable(to, text)
      return true
    } catch {
      return false
    }
  }
}

/**
 * 工具的错误码 → 渠道错误码。
 *
 * `send_not_confirmed`（已按回车但读库没看到新消息）刻意落到 UPSTREAM_ERROR：
 * 它**不是**可重试的失败——工具自己的建议就是"不要自动重发"，这里不该给出任何鼓励重试的码。
 */
function mapErrorCode(code: string | undefined): ChannelSendResult['errorCode'] {
  switch (code) {
    case 'target_not_found':
      return 'PEER_NOT_FOUND'
    case 'env_not_ready':
      // 微信窗口拿不到前台焦点 = 此刻发不了（不是网络问题）
      return 'CHANNEL_NOT_CONNECTED'
    case 'busy':
      return 'RATE_LIMITED'
    default:
      return 'UPSTREAM_ERROR'
  }
}
