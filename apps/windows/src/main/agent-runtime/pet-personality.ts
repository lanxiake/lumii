/**
 * 宠物人格：宠物是**独立 Agent**（`pet:<模型ID>`），人格与情绪都不碰 `assistant` 那一行。
 *
 * 这里只做「读一次、算个气质标签」：首次读到即出生抽签（`PersonalityTracker` 惰性初始化），
 * 抽签结果落 `personality_state`，出生快照落 `runtime_state['personality:birth:{agentId}']`。
 */
import { PersonalityTracker, EMA_ALPHA, applyPersonalityEvent, readBirthSnapshot, type BirthSnapshot, } from '@mtbot/agent-runtime';
import { petAgentId, traitLabel, type TraitValues } from '@mtbot/pet-core';
import type { PetPersonalityDTO, PetTraitValues } from '../../shared/pet-mode';
import { getAgentRuntimeBridge } from '../ipc/agent-runtime-ipc';
import { toAsyncClient } from './autonomous-wiring';
import { agentRuntimeLog as log } from './bridge-utils';
/**
 * 读某只宠物的人格标签（首次读 = 出生）。
 *
 * bridge 未就绪返回 null，渲染层按「暂时读不到」处理——不要在设置页凭空编一个脾气出来。
 */
export async function getPetPersonalityLabel(configId: string): Promise<PetPersonalityDTO | null> {
    if (!configId)
        return null;
    const bridge = getAgentRuntimeBridge();
    if (!bridge)
        return null;
    const agentId = petAgentId(configId);
    const tracker = new PersonalityTracker({ emaAlpha: EMA_ALPHA, eventWeights: {}, trackingEnabled: true }, toAsyncClient(bridge.db));
    const state = await tracker.getCurrentState(agentId);
    const traits: TraitValues = toTraitValues(state);
    return { agentId, label: traitLabel(traits), traits };
}
/**
 * 把一次**真实发生的事**记进宠物的人格（第七期 T7.3）。
 *
 * ---------------------------------------------------------------------------
 * 这是"它会变"唯一缺的那根线
 * ---------------------------------------------------------------------------
 * 2026-09-24 真机实测：宠物的 `personality_state.update_count = 0`、
 * `personality_events` 里宠物行 0 条——**从出生到现在一次都没变过**。
 * 根因不在 EMA（那套早就实现了），在于**事件没人产生**：
 * `EVENT_PERSONALITY_IMPACT` 定义的五个事件里，`recordPersonalityEvent`
 * 全仓只有协调器上那两个调用点（`goal-generated` / `evolution-decided`），
 * 而宠物派的目标走 `pet-task-service` 直接 INSERT、**根本不经过协调器**。
 *
 * ---------------------------------------------------------------------------
 * 只用设计 §12.2 点名的那三个事件
 * ---------------------------------------------------------------------------
 * | 事件 | 什么时候发 | 为什么是它 |
 * |---|---|---|
 * | `error-handled` | 它真去做了但没做成 | "办砸过一次"→ 更谨慎、更神经质 |
 * | `user-feedback-positive` | 反思判出 `closer` | 被回应 → 更亲和、更少焦虑 |
 * | `user-feedback-negative` | 反思判出 `distant` | 被冷落 → 更焦虑、更较真 |
 *
 * **"做成了一件事"刻意不发**：不是遗漏——Big Five 上"办成一件事"该往哪挪
 * 说不清（更外向？更开放？）。塑造这只宠物的应当**是这个人和它的关系**，
 * 不是它的绩效。助手那条链恰好反着来，于是长出了一个天天自我审计的它。
 *
 * 由反思汇总后发（一天 1–2 次）而不是每条信号发一次：一次摸头就让性格挪一格，
 * 那既不叫"缓慢且不可逆"（§3.5），也会让同一件事被反复计账。
 *
 * 不抛错：演进是旁路，失败只记日志——一次已经跑完的任务不该因为记账而变失败。
 */
export async function recordPetPersonalityEvent(eventType: 'error-handled' | 'user-feedback-positive' | 'user-feedback-negative', agentId: string, context: Record<string, unknown>): Promise<void> {
    const bridge = getAgentRuntimeBridge();
    if (!bridge)
        return;
    try {
        const tracker = new PersonalityTracker({ emaAlpha: EMA_ALPHA, eventWeights: {}, trackingEnabled: true }, toAsyncClient(bridge.db));
        await applyPersonalityEvent(eventType, agentId, context, toAsyncClient(bridge.db), tracker);
        log.info(`[recordPetPersonalityEvent] agent=${agentId} event=${eventType}`);
    }
    catch (err) {
        log.warn(`[recordPetPersonalityEvent] 失败 agent=${agentId} event=${eventType}:`, err instanceof Error ? err.message : err);
    }
}
/** 五维的形状转换（`personality_state` 行 → DTO），两处共用一份，避免字段漏抄 */
export function toTraitValues(state: {
    openness: number;
    conscientiousness: number;
    extraversion: number;
    agreeableness: number;
    neuroticism: number;
}): PetTraitValues {
    return {
        openness: state.openness,
        conscientiousness: state.conscientiousness,
        extraversion: state.extraversion,
        agreeableness: state.agreeableness,
        neuroticism: state.neuroticism,
    };
}
