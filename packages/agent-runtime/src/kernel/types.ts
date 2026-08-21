/**
 * AgentKernel 接口 — agent-runtime 内部使用的内核抽象
 *
 * 业务层（AgentInstance 及上层）依赖此接口，不直接依赖 pi-agent-core。
 * 当前实现由 PiAgentKernelAdapter 提供；测试由 FakeAgentKernel 提供。
 *
 * 故意只暴露当前业务实际使用的最小接口，避免为未来假设扩展。
 */

import type { AgentTurnRequest, AgentTurnEvent, AgentTurnResult, AgentKernelModelInfo } from "./agent-turn-types.js";

/** 事件订阅取消函数 */
export type UnsubscribeFn = () => void;

/**
 * Agent Kernel 接口
 *
 * 抽象一个可执行 LLM turn 的内核实体。
 */
export interface AgentKernel {
  /**
   * 启动一个 Agent turn（异步流式）
   *
   * 通过 subscribe() 注册的监听器接收 AgentTurnEvent 流。
   * 返回 Promise 在整个 turn（含所有工具调用）完成后 resolve。
   */
  startTurn(request: AgentTurnRequest): Promise<AgentTurnResult>;

  /**
   * 取消当前正在运行的 turn
   *
   * 幂等操作，已停止时调用无副作用。
   */
  cancelTurn(): void;

  /**
   * 列出当前内核支持的模型
   */
  listModels(): Promise<AgentKernelModelInfo[]>;

  /**
   * 获取默认模型 ID
   */
  getDefaultModel(): string;

  /**
   * 订阅 turn 事件流
   *
   * @returns 取消订阅函数
   */
  subscribe(listener: (event: AgentTurnEvent) => void): UnsubscribeFn;
}
