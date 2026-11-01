/**
 * 本机微信的「人选名单」候选。
 *
 * 设置页里要的是**人看得懂的东西**：显示"妈妈"而不是"wxid_xxx"，能同时给出
 * 真名与 wxid 的只有微信库本身。候选来自**通讯录**（`list_contacts`：好友 + 群聊），
 * 不是会话列表——会话只有聊过的人，从没聊过的好友在挑人面板里根本选不到。
 *
 * 兜底：微信没连上/读失败时退回**已配过的那几条**——设置页仍然打得开、改得动，
 * 只是不能从微信里挑人（如实把原因带回给界面，不假装列表是完整的）。
 */
import type { ChannelPolicy } from '../../shared/channel-policy'
import { policyForAccount } from '../../shared/channel-policy'

/** 一个候选（微信好友或群） */
export interface WechatContact {
  /** 稳定 id：好友 wxid / 群 `xxx@chatroom` / `filehelper` 之类 */
  id: string
  /** 展示名（微信里"备注 > 昵称 > id"的口径，由 MCP 解析好） */
  label: string
  /** 群聊（`@chatroom` 结尾） */
  isGroup: boolean
}

export interface WechatContactsDeps {
  /** 调一个本机微信原生工具（走侧车）。失败即抛——见 `WechatSidecarClient.callText` */
  callTool: (tool: string, args: Record<string, unknown>) => Promise<string>
  getPolicy: () => ChannelPolicy
}

export interface WechatContactsResult {
  contacts: WechatContact[]
  /** 当前账号自己（页签要显示「名字（wxid）」） */
  self?: WechatContact
  /** 读微信失败的原因（此时 contacts 只有已配过的那几条） */
  error?: string
}

/**
 * `list_contacts` 的返回：`{self: {talker, name}, contacts: [{talker, name, kind}]}`。
 * 形状不对的条目直接跳过；整个 payload 坏掉时给空表。
 */
export function parseWechatContactBook(raw: string): {
  contacts: WechatContact[]
  self?: WechatContact
} {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { contacts: [] }
  }
  if (!parsed || typeof parsed !== 'object') return { contacts: [] }
  const o = parsed as Record<string, unknown>
  const contacts: WechatContact[] = []
  if (Array.isArray(o.contacts)) {
    for (const item of o.contacts) {
      if (!item || typeof item !== 'object') continue
      const c = item as Record<string, unknown>
      const id = typeof c.talker === 'string' ? c.talker.trim() : ''
      if (!id) continue
      const label = typeof c.name === 'string' && c.name.trim() ? c.name.trim() : id
      contacts.push({ id, label, isGroup: c.kind === 'group' || id.endsWith('@chatroom') })
    }
  }
  const selfRaw = o.self && typeof o.self === 'object' ? (o.self as Record<string, unknown>) : null
  const selfId = typeof selfRaw?.talker === 'string' ? selfRaw.talker.trim() : ''
  const self: WechatContact | undefined = selfId
    ? {
        id: selfId,
        label:
          typeof selfRaw?.name === 'string' && selfRaw.name.trim() ? selfRaw.name.trim() : selfId,
        isGroup: false,
      }
    : undefined
  return self ? { contacts, self } : { contacts }
}

/**
 * 合并：微信里读到的在前，已配过但通讯录里没有的（改过名/删过好友）补在后。
 * 同一个 id 只留一条。
 *
 * **仅在兜底时使用**（微信未连接/读失败时，候选 = 已配的人，这样用户至少能编辑已有名单）。
 * 通讯录读成功时，**不再 merge 已配的**：用户期望看到的是"微信里真实存在的人"，
 * 而不是"曾经配过但现在已删除的人"（那些人在微信里压根选不到）。
 */
export function mergeWechatContacts(
  primary: WechatContact[],
  extra: WechatContact[],
): WechatContact[] {
  const seen = new Set<string>()
  const out: WechatContact[] = []
  for (const c of [...primary, ...extra]) {
    const key = c.id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

/** 已配过的条目也要能出现在候选里（否则界面上"名单里有、选项里没有"） */
export function contactsFromPolicy(policy: ChannelPolicy, account?: string): WechatContact[] {
  return policyForAccount(policy, account).peers.map((p) => ({
    id: p.id,
    label: p.label ?? p.id,
    isGroup: p.id.endsWith('@chatroom'),
  }))
}

/** 读一份候选名单；微信读不到时不抛，把原因放在 `error` 里。`account` 限定读哪个号。 */
export async function loadWechatContacts(
  deps: WechatContactsDeps,
  account?: string,
): Promise<WechatContactsResult> {
  const configured = contactsFromPolicy(deps.getPolicy(), account)
  try {
    const raw = await deps.callTool('list_contacts', {
      ...(account ? { account } : {}),
    })
    const { contacts, self } = parseWechatContactBook(raw)
    if (contacts.length === 0) {
      return { contacts: configured, self, error: '没读到微信通讯录（微信可能没登录）' }
    }
    // 成功读到 → **只返回微信里真实存在的**，不 merge 已配的
    // （用户期望看到的是"能在微信里选到的人"，而不是"曾经配过但已删除的人"）
    return { contacts, self }
  } catch (err) {
    return {
      contacts: configured,
      error: `读微信通讯录失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
