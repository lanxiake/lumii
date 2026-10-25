/**
 * 桌面 / 渠道交互投递门控
 *
 * 渠道会把提问与审批文字化推给用户；桌面在对应会话时间线渲染可点选消息卡。
 * 两者可并行（`channel-and-desktop`）：IM 回编号与桌面点选走同一 resolve，先到先生效。
 */

/** ask_user_question 投递目标：`none` = 这个会话里没人能回答（见 `resolveAskUserDelivery`） */
export type AskUserDelivery = 'channel-and-desktop' | 'desktop' | 'none'

/** 工具审批投递目标 */
export type PermissionDelivery =
  | 'auto-approve'
  | 'channel-and-desktop'
  | 'channel-only'
  | 'desktop-ipc'
  | 'desktop-native'

/**
 * 决定 ask_user_question 走渠道文字、桌面消息卡，还是**根本没人可答**。
 *
 * @param channelHandled ChannelInteractionHub 是否已承接该会话
 * @param delegated 会话是否「代聊型」（`DELEGATED_OWNERSHIPS`：助手以用户身份对外说话）。
 *   代聊会话的另一头是用户的**好友**，不是用户本人：推给渠道等于把「要不要这么回」
 *   问给朋友，桌面卡则是等一个用户在后台会话里点确认。两条都送不到 ⇒ `none`，
 *   由调用方立即按「无人应答」收口，**不许等**。
 */
export function resolveAskUserDelivery(
  channelHandled: boolean,
  delegated = false,
): AskUserDelivery {
  if (delegated) return 'none'
  return channelHandled ? 'channel-and-desktop' : 'desktop'
}

/**
 * 渠道能否用文字承载这组提问。
 *
 * 现策略：一律文字化（编号 / 多选逗号分隔），复杂题也在 IM 完成；
 * 桌面侧同时渲染消息卡，用户可任选一端作答。
 */
export function canChannelHandleQuestions(
  _questions: readonly { readonly options: readonly unknown[]; readonly multiSelect?: boolean }[],
): boolean {
  return true
}

/**
 * 决定工具审批的投递路径。
 * 自动审批优先；渠道承接且 IPC 可用 → 双投递；仅渠道 / 仅桌面 / native 依次回退。
 */
export function resolvePermissionDelivery(opts: {
  autoApprove: boolean
  channelHandled: boolean
  ipcAvailable: boolean
}): PermissionDelivery {
  if (opts.autoApprove) return 'auto-approve'
  if (opts.channelHandled && opts.ipcAvailable) return 'channel-and-desktop'
  if (opts.channelHandled) return 'channel-only'
  if (opts.ipcAvailable) return 'desktop-ipc'
  return 'desktop-native'
}
