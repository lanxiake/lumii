/**
 * 本机微信的「人选名单」候选。
 *
 * 设置页里要的是**人看得懂的东西**：显示"妈妈"而不是"wxid_xxx"。能同时给出
 * 真名与 wxid 的只有微信库本身，所以候选来自 MCP 的 `list_sessions`
 * （返回全量会话 `{talker, name, last}`，只读、不需要窗口在前台、毫秒级）。
 *
 * 兜底：MCP 没连上/读失败时退回**已配过的那几条**——设置页仍然打得开、改得动，
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
  callMcpTool: (server: string, tool: string, args: Record<string, unknown>) => Promise<string>
  mcpServer: string
  getPolicy: () => ChannelPolicy
}

export interface WechatContactsResult {
  contacts: WechatContact[]
  /** 读微信失败的原因（此时 contacts 只有已配过的那几条） */
  error?: string
}

/** `list_sessions` 的返回：`[{talker, name, last}]`；形状不对的条目直接跳过 */
export function parseWechatSessions(raw: string): WechatContact[] {
  const out: WechatContact[] = []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return out
  }
  if (!Array.isArray(parsed)) return out
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const id = typeof o.talker === 'string' ? o.talker.trim() : ''
    if (!id) continue
    const label = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : id
    out.push({ id, label, isGroup: id.endsWith('@chatroom') })
  }
  return out
}

/**
 * 合并：微信里读到的在前，已配过但微信列表里没有的（改过名/删过会话）补在后。
 * 同一个 id 只留一条。
 *
 * **仅在兜底时使用**（MCP 未连接/读失败时，候选 = 已配的人，这样用户至少能编辑已有名单）。
 * MCP 成功返回会话列表时，**不再merge已配的**：用户期望看到的是"微信里真实存在的会话"，
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
    const raw = await deps.callMcpTool(deps.mcpServer, 'list_sessions', {
      ...(account ? { account } : {}),
    })
    if (/未连接|not connected/i.test(raw.slice(0, 200))) {
      return { contacts: configured, error: '本机微信的 MCP 没连上，现在只能编辑已有名单' }
    }
    const parsed = parseWechatSessions(raw)
    if (parsed.length === 0) {
      return { contacts: configured, error: '没读到微信会话（微信可能没登录，或还没有聊天记录）' }
    }
    // MCP 成功读到会话 → **只返回微信里真实存在的**，不merge已配的
    // （用户期望看到的是"能在微信里选到的人"，而不是"曾经配过但已删除的人"）
    return { contacts: parsed }
  } catch (err) {
    return {
      contacts: configured,
      error: `读微信会话失败：${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
