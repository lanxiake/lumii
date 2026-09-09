/**
 * BashCommandLogHook — bash 工具调用采集
 *
 * 挂在 ToolRunner 的全局 hook 上，逐条落库 bash 命令原文（含错误/耗时），
 * 供「工具进化」管道的模式挖掘使用。
 *
 * 采集失败绝不抛错（非 critical hook，ToolRunner 会吞掉），
 * 且 repo 未注入时整体跳过，保证不影响 Agent 主链路。
 *
 * V2: 添加调用次数触发 - 记录命令后实时检查是否达到阈值，触发工具进化分析。
 */

import type { ToolHook } from "../tool-hooks.js";
import type { BashCommandRepo } from "../../storage/bash-command-repo.js";

export interface BashCommandLogHookDeps {
  /** 命令日志仓库（SQLite）；未注入时 hook 静默跳过 */
  repo?: BashCommandRepo;
  /** 当前实例的 agentId（闭包注入） */
  getAgentId: () => string;
  /** 当前实例的 conversationId（可为空） */
  getConversationId?: () => string | undefined;
  /**
   * 调用次数触发检查回调（可选）
   * 记录命令后调用，检查是否达到阈值触发工具进化分析
   */
  onCommandLogged?: (command: string) => void | Promise<void>;
}

export function createBashCommandLogHook(deps: BashCommandLogHookDeps): ToolHook {
  return {
    name: 'bash-command-logger',
    filter: { toolNames: ['bash'] },
    afterExecute(ctx) {
      const repo = deps.repo
      if (!repo) return
      const command = ctx.params?.command
      if (typeof command !== 'string' || command.length === 0) return
      try {
        repo.log({
          agentId: deps.getAgentId(),
          conversationId: deps.getConversationId?.(),
          toolCallId: ctx.toolCallId,
          command,
          cwd: typeof ctx.params.cwd === 'string' ? ctx.params.cwd : undefined,
          isError: ctx.isError,
          durationMs: ctx.durationMs,
        })
        // 调用次数触发检查（异步，不阻塞主流程）
        if (deps.onCommandLogged) {
          void Promise.resolve(deps.onCommandLogged(command)).catch(() => {
            // 检查失败不影响主流程
          })
        }
      } catch {
        // 采集失败不影响工具结果
      }
    },
    onError(ctx) {
      const repo = deps.repo
      if (!repo) return
      const command = ctx.params?.command
      if (typeof command !== 'string' || command.length === 0) return
      try {
        repo.log({
          agentId: deps.getAgentId(),
          conversationId: deps.getConversationId?.(),
          toolCallId: ctx.toolCallId,
          command,
          cwd: typeof ctx.params.cwd === 'string' ? ctx.params.cwd : undefined,
          isError: true,
          durationMs: ctx.durationMs,
        })
        // 错误情况下也触发检查
        if (deps.onCommandLogged) {
          void Promise.resolve(deps.onCommandLogged(command)).catch(() => {
            // 检查失败不影响主流程
          })
        }
      } catch {
        // 采集失败不影响工具结果
      }
    },
  }
}
