/**
 * createPiAgent — pi-agent-core Agent 的唯一实例化入口
 *
 * 业务编排层（AgentInstance）不再直接 `new Agent()`，而是调用此工厂。
 * pi-agent-core 的运行时值导入因此被收口到 kernel 边界内，业务层只依赖
 * `AgentOptions` 类型与本工厂函数。
 */

import { Agent, type AgentOptions } from "@mariozechner/pi-agent-core";

export type { AgentOptions };

/** 创建一个 pi-agent-core Agent 实例 */
export function createPiAgent(options: AgentOptions): Agent {
  return new Agent(options);
}
