/**
 * 桌面弹窗门控 —— 渠道文字交互与客户端弹窗互斥
 *
 * 飞书/企微/微信/QQ 等渠道会把提问与审批文字化推给用户；
 * 若同时再向渲染进程推送弹窗事件，客户端会出现无法点遮罩关闭的
 * AskUserModal / 审批卡，与渠道文字通知重复且卡住操作。
 */

/** ask_user_question 投递目标：`none` = 这个会话里没人能回答（见 `resolveAskUserDelivery`） */
export type AskUserDelivery = 'channel-only' | 'desktop' | 'none'

/**
 * 渠道文字化能承载的最大选项数（设计 §5.5）。
 * 超过这个数的选项列表在聊天窗里刷屏且无法对照，改为引导回客户端。
 */
const CHANNEL_MAX_OPTIONS = 3

/** 工具审批投递目标 */
export type PermissionDelivery =
  | 'auto-approve'
  | 'channel-only'
  | 'desktop-ipc'
  | 'desktop-native'

/**
 * 决定 ask_user_question 走渠道文字、桌面弹窗，还是**根本没人可答**。
 *
 * @param channelHandled ChannelInteractionHub 是否已承接该会话
 * @param delegated 会话是否「代聊型」（`DELEGATED_OWNERSHIPS`：助手以用户身份对外说话）。
 *   代聊会话的另一头是用户的**好友**，不是用户本人：推给渠道等于把「要不要这么回」
 *   问给朋友，桌面弹窗则是等一个用户在后台会话里点确认。两条都送不到 ⇒ `none`，
 *   由调用方立即按「无人应答」收口，**不许等**。
 *
 *   为什么这条要紧（2026-10-09 14:42 实测）：代聊回合是 `wechat-watch` 的一次 tick，
 *   而 `waitForAnswer` 默认挂 10 分钟超时 ⇒ 整条盯梢回路停摆（15 秒一拍变 10 分钟一拍，
 *   期间所有新消息都不处理），且**没有任何用户可见信号**。
 */
export function resolveAskUserDelivery(
  channelHandled: boolean,
  delegated = false,
): AskUserDelivery {
  if (delegated) return 'none'
  return channelHandled ? 'channel-only' : 'desktop'
}

/**
 * 渠道能否承载这组提问（§5.5 交互降级）。
 *
 * 任一问题选项数超上限、或需要多选，就超出纯文字能表达的范围：
 * 多选要求用户拼「1,3,5」并自行核对，错一个字符就答错。这类回客户端弹窗。
 */
export function canChannelHandleQuestions(
  questions: readonly { readonly options: readonly unknown[]; readonly multiSelect?: boolean }[],
): boolean {
  return questions.every(
    (q) => q.options.length <= CHANNEL_MAX_OPTIONS && !q.multiSelect,
  )
}

/** 超出渠道承载能力时，推给渠道用户的引导文案（§5.5） */
export const CHANNEL_DOWNGRADE_TEXT =
  '这个操作选项较多，需要在桌面客户端完成。请打开 Lumii 客户端继续，我在那边等你。'

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
