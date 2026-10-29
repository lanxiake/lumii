/**
 * 渠道入站消息交给哪个 Agent —— 解析绑定 + 创建/复用实例（四个入站适配器共用）
 *
 * 改造前四个适配器各有一份逐字相同的 `getOrCreateInstance`，里面硬编码
 * `createInstanceById('main', …)`——「QQ 进来的消息由 chronicler 接」这种诉求
 * 在配置层根本表达不出来。现在策略里配了 `agentId` 就按配的走，没配沿用 `main`
 * （与改造前逐字一致，存量用户行为不变）。
 *
 * **换绑当场生效**：缓存里的实例定义与配置不一致时先 invalidate 再重建。否则用户在
 * 设置里改成 chronicler，回话的还是 assistant，得等重启才变——那正是「改了没反应」的经典来路。
 * 没配 `agentId` 时不比较定义 id（`'main'` 解析成 `assistant`，比了只会每次重建）。
 */

import { getChannelPolicyStore } from './channel-policy-store'

/** 没配绑定时的历史值（四个适配器原本硬编码的那个） */
export const DEFAULT_CHANNEL_AGENT_ID = 'main'

/** 只取适配器真正用到的那几个能力，便于测试造假对象 */
export interface ChannelInstanceBridge {
  getInstances(): Array<{ id: string; definitionId: string; state: string }>
  createInstanceById(agentId: string, sessionKey?: string, conversationId?: string): Promise<string>
  invalidateInstance?(instanceId: string): 'destroyed' | 'deferred'
}

/** 这个渠道配了哪个 Agent 定义；没配/配成空串 → undefined（走历史默认） */
export function configuredChannelAgentId(channelType: string): string | undefined {
  const id = getChannelPolicyStore().get(channelType).agentId?.trim()
  return id || undefined
}

/**
 * 取（或建）这个会话的 Agent 实例。
 *
 * 缓存命中要同时满足两件事：实例还活着，且（配了绑定时）它的定义就是配置的那个。
 * 任一不满足就作废重建——「实例已销毁」和「绑定被改了」走同一条路。
 */
export async function getOrCreateChannelInstance(
  bridge: ChannelInstanceBridge,
  cache: Map<string, string>,
  channelType: string,
  sessionKey: string,
  /** 测试缝：默认读渠道策略 */
  resolveAgent: (channelType: string) => string | undefined = configuredChannelAgentId,
): Promise<string> {
  const configured = resolveAgent(channelType)

  const cachedId = cache.get(sessionKey)
  if (cachedId) {
    const live = bridge.getInstances().find((i) => i.id === cachedId)
    if (live && (!configured || live.definitionId === configured)) return cachedId
    cache.delete(sessionKey)
    if (live) {
      // 定义变了：旧实例不能留着继续接这个会话的消息，否则两个实例抢同一个 conversationId
      const how = bridge.invalidateInstance?.(cachedId)
      console.log(
        `[channel-agent] 重建实例 channel=${channelType} sessionKey=${sessionKey} ` +
          `${cachedId}(${live.definitionId}) → ${configured ?? DEFAULT_CHANNEL_AGENT_ID}` +
          (how ? ` (invalidate=${how})` : ''),
      )
    } else {
      console.warn(`[channel-agent] 缓存实例已销毁，重建: ${cachedId}`)
    }
  }

  const agentId = configured ?? DEFAULT_CHANNEL_AGENT_ID
  const instanceId = await bridge.createInstanceById(agentId, sessionKey, sessionKey)
  cache.set(sessionKey, instanceId)
  console.log(
    `[channel-agent] 新建实例 channel=${channelType} sessionKey=${sessionKey} agent=${agentId} instanceId=${instanceId}`,
  )
  return instanceId
}
