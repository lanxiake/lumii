/**
 * 宠物人格：宠物是**独立 Agent**（`pet:<模型ID>`），人格与情绪都不碰 `assistant` 那一行。
 *
 * 这里只做「读一次、算个气质标签」：首次读到即出生抽签（`PersonalityTracker` 惰性初始化），
 * 抽签结果落 `personality_state`，出生快照落 `runtime_state['personality:birth:{agentId}']`。
 */

import { PersonalityTracker, EMA_ALPHA } from '@mtbot/agent-runtime'
import { petAgentId, traitLabel, type TraitValues } from '@mtbot/pet-core'
import type { PetPersonalityDTO } from '../../shared/pet-mode'
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc'
import { toAsyncClient } from './autonomous-wiring'

/**
 * 读某只宠物的人格标签（首次读 = 出生）。
 *
 * bridge 未就绪返回 null，渲染层按「暂时读不到」处理——不要在设置页凭空编一个脾气出来。
 */
export async function getPetPersonalityLabel(configId: string): Promise<PetPersonalityDTO | null> {
  if (!configId) return null
  const bridge = getAgentRuntimeBridge()
  if (!bridge) return null

  const agentId = petAgentId(configId)
  const tracker = new PersonalityTracker(
    { emaAlpha: EMA_ALPHA, eventWeights: {}, trackingEnabled: true },
    toAsyncClient(bridge.db),
  )
  const state = await tracker.getCurrentState(agentId)
  const traits: TraitValues = {
    openness: state.openness,
    conscientiousness: state.conscientiousness,
    extraversion: state.extraversion,
    agreeableness: state.agreeableness,
    neuroticism: state.neuroticism,
  }
  return { agentId, label: traitLabel(traits) }
}
