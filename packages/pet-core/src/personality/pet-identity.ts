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

/**
 * 这个会话键是不是**某只宠物自己的会话**（`evolution:pet:<模型ID>`，不区分是哪一只）。
 *
 * 由主进程的 `evolutionConversationIdFor(agentId)` 生成（assistant 是 `evolution:main`，
 * 其余是 `evolution:<agentId>`）。
 *
 * 用途只有一个：`notice.ts` 要认出"这是宠物干活的那条会话"，好在它上面只播报回执
 * （见 `noticeFromEvent` 的会话守卫）。**不解析出是哪只宠物**——那要读配置，pet-core 不持有。
 */
export function isPetSessionKey(sessionKey: string): boolean {
  return sessionKey.startsWith('evolution:pet:');
}
