/**
 * agent 节点的工具白名单（纯函数，便于单测）。
 *
 * 四条规则缺一条都会让整条流水线失败：
 * 1. **去掉 `spawn_agent` / `send_message`** —— 与 `orchestrator.FORBIDDEN_CHILD_TOOLS` 一致。
 *    编排层会直接拒这两个名字；我们原样透传父工具集时必然撞上
 *    （2026-11-01 真机：`allowedTools contains unauthorized tool: send_message`，agent 步直接失败）。
 * 2. **去掉 `pipeline_run`** —— 防子 Agent 递归触发流水线，否则「路径由 spec 写死」就失效了。
 * 3. **去掉 `ask_user_question`** —— 流水线是无人值守的。子 Agent 一问，这一轮就挂在那里
 *    等一个不会来的回答：2026-11-03 真机，红队步发现目标没起服务后调 `ask_user_question`，
 *    会话锁从 120s 一路堆到 360s+，整条 run 卡死。缺信息时应当**如实失败**并写清缺什么，
 *    让调用方看 journal 补前置条件——这才是可重跑的。
 * 4. 显式 `allowedTools` 走同一套清洗，而不是原样透传：用户写漏了不该炸整条 run。
 *
 * **与 `FORBIDDEN_CHILD_TOOLS` 是两份清单**：那边在 packages、这边在 app，
 * 没有共享常量。改那边时这份要跟着改——`pipeline-agent-whitelist.test.ts` 锁住了当前四条。
 */
const BLOCKED_FOR_PIPELINE_AGENT = new Set([
  'spawn_agent',
  'send_message',
  'pipeline_run',
  'ask_user_question',
])

export function resolvePipelineAgentWhitelist(
  parentTools: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  const base = requested ?? parentTools
  return base.filter((t) => !BLOCKED_FOR_PIPELINE_AGENT.has(t))
}
