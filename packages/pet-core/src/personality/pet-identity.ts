/**
 * 宠物身份口径：一个模型 = 一只宠物（configId 即模型 ID）。
 *
 * 宠物是**独立 Agent**（设计 §3.7）：人格与情绪按 agentId 分键，不碰 `assistant` 那一行——
 * 训宠物不会改变助手的心情，反之亦然。将来多宠物同屏时再把 configId 升级为实例 ID。
 */

/** 宠物 Agent ID（`personality_state.agent_id` / `runtime_state` 分键共用） */
export function petAgentId(configId: string): string {
  return `pet:${configId}`;
}
