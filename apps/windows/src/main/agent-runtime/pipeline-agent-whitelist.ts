/**
 * agent 节点的工具白名单（纯函数，便于单测）。
 *
 * 三条规则缺一条都会让整条流水线失败：
 * 1. **去掉 `spawn_agent` / `send_message`** —— 与 `orchestrator.FORBIDDEN_CHILD_TOOLS` 一致。
 *    编排层会直接拒这两个名字；我们原样透传父工具集时必然撞上
 *    （2026-11-01 真机：`allowedTools contains unauthorized tool: send_message`，agent 步直接失败）。
 * 2. **去掉 `pipeline_run`** —— 防子 Agent 递归触发流水线，否则「路径由 spec 写死」就失效了。
 * 3. 显式 `allowedTools` 走同一套清洗，而不是原样透传：用户写漏了不该炸整条 run。
 *
 * **与 `FORBIDDEN_CHILD_TOOLS` 是两份清单**：那边在 packages、这边在 app，
 * 没有共享常量。改那边时这份要跟着改——`agent-whitelist.test.ts` 锁住了当前三条。
 */
const BLOCKED_FOR_PIPELINE_AGENT = new Set(['spawn_agent', 'send_message', 'pipeline_run'])

export function resolvePipelineAgentWhitelist(
  parentTools: readonly string[],
  requested: readonly string[] | undefined,
): string[] {
  const base = requested ?? parentTools
  return base.filter((t) => !BLOCKED_FOR_PIPELINE_AGENT.has(t))
}
