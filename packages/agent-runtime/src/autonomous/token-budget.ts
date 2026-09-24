/**
 * 每日自主进化 token 预算（预估式，按 agent 分账）
 *
 * 心跳 tick 里真实烧 LLM 的动作只有三个：目标执行（完整 Agent 循环）、反思、
 * 日记。主动消息走系统通知不烧 LLM。这里用固定预估成本做「上限保护」，
 * 避免自主进化在后台无节制消耗 token —— 不是精确计费，够用即可。
 *
 * 预算上限来自 readSettings().maxTokensPerDay，今日已消耗落
 * runtime_state 键 `autonomous.tokens:<agentId>:<YYYY-MM-DD>`，跨天自然重置。
 *
 * **按 agent 分账**（2026-09-24）：宠物（`pet:<模型ID>`）跑一个目标记 8000 到
 * 助手账上、助手当天少跑一个，是分键前的真实后果。老库的全局单键
 * `autonomous.tokens.<日期>` 由 readAgentScopedState 一次性搬给 assistant；
 * 逐日累积的历史老键不搬——分键后没有任何读路径会看它们，留在库里当历史。
 */

import type { DatabaseAdapter } from '../storage/local-database.js';
import { RuntimeStateRepo } from '../storage/runtime-state-repo.js';
import { readAgentScopedState } from './agent-scoped-state.js';

/** 各动作预估 token 成本（偏保守，向上取整） */
export const TOKEN_COST = {
  /** 目标执行：完整 Agent 循环 + 工具调用，是最大头 */
  executeGoal: 8000,
  /** 反思：输入（满意度/能力/会话摘要）约 3000 + 输出上限 2000 */
  reflect: 5000,
  /** 日记：单次生成，输入素材 + 输出正文 */
  writeDiary: 2000,
  /** 主动消息：系统通知不调 LLM，几乎为 0 */
  outreach: 0,
} as const;

function dayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 分键后的键：`autonomous.tokens:<agentId>:<YYYY-MM-DD>` */
function tokenStateKey(agentId: string, now: Date): string {
  return `autonomous.tokens:${agentId}:${dayKey(now)}`;
}

/**
 * 分键前的老键：`autonomous.tokens.<YYYY-MM-DD>`。
 *
 * 与分键后的键**差一个分隔符**（`.` vs `:`），这不是笔误：两个前缀因此互不为前缀，
 * 老键永远不会被误当成新键。
 */
function legacyTokenStateKey(now: Date): string {
  return `autonomous.tokens.${dayKey(now)}`;
}

/** 读取某 agent 今日已消耗 token（无记录或脏数据按 0） */
export function readTodayTokenUsage(db: DatabaseAdapter, agentId: string, now: Date): number {
  const raw = readAgentScopedState(db, agentId, tokenStateKey(agentId, now), legacyTokenStateKey(now));
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 累加某 agent 今日 token 消耗（幂等：以 value 存累计值，非增量记录） */
export function recordTokenUsage(db: DatabaseAdapter, agentId: string, now: Date, tokens: number): void {
  if (!Number.isFinite(tokens) || tokens <= 0) return;
  const current = readTodayTokenUsage(db, agentId, now);
  new RuntimeStateRepo(db).set(tokenStateKey(agentId, now), String(current + tokens));
}

/** 检查某 agent 的预算：本次动作预估成本加上今日已消耗，是否仍在每日上限内 */
export function canSpendTokens(
  db: DatabaseAdapter,
  agentId: string,
  now: Date,
  cost: number,
  maxPerDay: number,
): boolean {
  return readTodayTokenUsage(db, agentId, now) + cost <= maxPerDay;
}
