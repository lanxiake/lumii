/**
 * 按 agent 分键的 runtime_state 读取（含老库全局单键的一次性搬运）
 *
 * 2026-09-24：token 预算与主动消息预算按 agentId 分键
 * （`autonomous.tokens:<agentId>:<日期>` / `autonomous.outreach:<agentId>:<日期>`）。
 * 分键之前这两个键是**全局单键**（`autonomous.tokens.<日期>`）——那时只有一个 agent，
 * 键里没有 agent 维度，所以老键按「属于 assistant」处理：读不到自己的键、且自己就是
 * assistant 时把老键的值搬过来（**先写新键再删旧键**，中途失败下次读会重试，不丢数），
 * 然后删掉老键。与 `readMood` 的迁移同一手法（mood.ts `LEGACY_MOOD_STATE_KEY`）。
 *
 * ⚠️ **只有 assistant 认老键**，这条是这段代码的全部意义所在：
 * 宠物（`pet:<模型ID>`）如果也认，就会把助手当天的用量读成自己的——反之亦然，
 * 助手会替宠物背账。这正是分键要消灭的串账，且两边的症状都是「数字不对但不报错」。
 * 写入侧不参与判断：所有 agent 都只写自己的键。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import { RuntimeStateRepo } from '../storage/runtime-state-repo.js';

/** 分键前的老键只属于它——那时唯一的自主 Agent */
const LEGACY_OWNER_AGENT_ID = 'assistant';

/**
 * 读某个 agent 的分键值；查不到且自己是 assistant 时顺带搬运老键。
 *
 * 读库失败按「没有」处理（返回 undefined）：调用方原本就各自 catch 成 0 / null，
 * 心跳在退出清场期间碰库会抛 "Database not initialized"，不该被这里放大。
 *
 * @param ownKey 分键后的键（`autonomous.<家族>:<agentId>:<...>`）
 * @param legacyKey 分键前的全局单键；老库里没有就是没有，搬不动也不报错
 */
export function readAgentScopedState(
  db: DatabaseAdapter,
  agentId: string,
  ownKey: string,
  legacyKey: string,
): string | undefined {
  try {
    const repo = new RuntimeStateRepo(db);
    const own = repo.get(ownKey);
    if (own !== undefined) return own;
    if (agentId !== LEGACY_OWNER_AGENT_ID) return undefined;
    const legacy = repo.get(legacyKey);
    if (legacy === undefined) return undefined;
    repo.set(ownKey, legacy);
    repo.delete(legacyKey);
    return legacy;
  } catch {
    return undefined;
  }
}
