/**
 * 桌面弹窗门控 —— 渠道文字交互与客户端弹窗互斥
 *
 * 飞书/企微/微信/QQ 等渠道会把提问与审批文字化推给用户；
 * 若同时再向渲染进程推送弹窗事件，客户端会出现无法点遮罩关闭的
 * AskUserModal / 审批卡，与渠道文字通知重复且卡住操作。
 */

/** ask_user_question 投递目标 */
export type AskUserDelivery = 'channel-only' | 'desktop'

/** 工具审批投递目标 */
export type PermissionDelivery =
  | 'auto-approve'
  | 'channel-only'
  | 'desktop-ipc'
  | 'desktop-native'

/**
 * 决定 ask_user_question 走渠道文字还是桌面弹窗。
 * @param channelHandled ChannelInteractionHub 是否已承接该会话
 */
export function resolveAskUserDelivery(channelHandled: boolean): AskUserDelivery {
  return channelHandled ? 'channel-only' : 'desktop'
}

/**
 * 决定工具审批的投递路径。
 * 自动审批优先；否则渠道承接则仅 IM；再否则 IPC 弹窗，最后 native dialog。
 */
export function resolvePermissionDelivery(opts: {
  autoApprove: boolean
  channelHandled: boolean
  ipcAvailable: boolean
}): PermissionDelivery {
  if (opts.autoApprove) return 'auto-approve'
  if (opts.channelHandled) return 'channel-only'
  if (opts.ipcAvailable) return 'desktop-ipc'
  return 'desktop-native'
}
