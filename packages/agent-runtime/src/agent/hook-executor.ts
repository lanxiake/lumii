/**
 * HookExecutor — Agent 生命周期钩子执行器
 *
 * 执行 AgentDefinition.hooks 中配置的生命周期钩子。
 * 支持三种类型：command（shell 命令）、script（脚本内容）、rpc（远程调用占位）。
 *
 * 设计依据: .qoder/design/client-agent-runtime/03-Agent定义与生命周期.md §1.2
 */

import type { AgentHooksConfig, AgentHook } from "../types/agent-definition.js";

/** 钩子执行上下文 */
export interface HookContext {
  /** Agent 实例 ID */
  readonly agentId: string;
  /** Agent 定义 ID */
  readonly definitionId: string;
  /** 当前触发的工具名（preToolUse/postToolUse 时有值） */
  readonly toolName?: string;
  /** 工具参数（preToolUse/postToolUse 时有值） */
  readonly toolArgs?: Record<string, unknown>;
  /** 工具执行结果（postToolUse 时有值） */
  readonly toolResult?: unknown;
  /** 错误信息（onError 时有值） */
  readonly error?: string;
}

/** 钩子执行结果 */
export interface HookResult {
  readonly hookType: string;
  readonly hookCommand: string;
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
  readonly durationMs: number;
}

/** 命令执行器接口（由外部注入，解耦执行环境） */
export interface CommandExecutor {
  execute(
    command: string,
    timeoutMs?: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

/**
 * Hook 执行器
 *
 * 使用方式:
 * ```typescript
 * const executor = new HookExecutor(definition.hooks, commandExecutor)
 * await executor.runOnStart(ctx)
 * await executor.runPreToolUse(ctx)
 * await executor.runPostToolUse(ctx)
 * await executor.runOnComplete(ctx)
 * await executor.runOnError(ctx)
 * ```
 */
export class HookExecutor {
  private readonly hooks: AgentHooksConfig;
  private readonly commandExecutor: CommandExecutor | undefined;

  constructor(hooks: AgentHooksConfig | undefined, commandExecutor?: CommandExecutor) {
    this.hooks = hooks ?? {};
    this.commandExecutor = commandExecutor;
  }

  /** Agent 启动时执行所有 onStart 钩子 */
  async runOnStart(ctx: HookContext): Promise<readonly HookResult[]> {
    return this.runHooks(this.hooks.onStart, "onStart", ctx);
  }

  /** 工具调用前执行匹配的 preToolUse 钩子 */
  async runPreToolUse(ctx: HookContext): Promise<readonly HookResult[]> {
    const matched = this.filterByToolMatch(this.hooks.preToolUse, ctx.toolName);
    return this.runHooks(matched, "preToolUse", ctx);
  }

  /** 工具调用后执行匹配的 postToolUse 钩子 */
  async runPostToolUse(ctx: HookContext): Promise<readonly HookResult[]> {
    const matched = this.filterByToolMatch(this.hooks.postToolUse, ctx.toolName);
    return this.runHooks(matched, "postToolUse", ctx);
  }

  /** Agent 正常完成时执行所有 onComplete 钩子 */
  async runOnComplete(ctx: HookContext): Promise<readonly HookResult[]> {
    return this.runHooks(this.hooks.onComplete, "onComplete", ctx);
  }

  /** Agent 出错时执行所有 onError 钩子 */
  async runOnError(ctx: HookContext): Promise<readonly HookResult[]> {
    return this.runHooks(this.hooks.onError, "onError", ctx);
  }

  /** 是否有任何钩子配置 */
  get hasHooks(): boolean {
    return !!(
      this.hooks.onStart?.length ||
      this.hooks.preToolUse?.length ||
      this.hooks.postToolUse?.length ||
      this.hooks.onComplete?.length ||
      this.hooks.onError?.length
    );
  }

  // ==================== 内部方法 ====================

  /** 执行一组钩子，返回所有结果 */
  private async runHooks(
    hooks: readonly AgentHook[] | undefined,
    phase: string,
    ctx: HookContext,
  ): Promise<readonly HookResult[]> {
    if (!hooks || hooks.length === 0) return [];

    const results: HookResult[] = [];
    for (const hook of hooks) {
      const result = await this.runSingleHook(hook, phase, ctx);
      results.push(result);
    }
    return results;
  }

  /** 执行单个钩子 */
  private async runSingleHook(
    hook: AgentHook,
    phase: string,
    ctx: HookContext,
  ): Promise<HookResult> {
    const startTime = Date.now();

    try {
      switch (hook.type) {
        case "command": {
          if (!this.commandExecutor) {
            return {
              hookType: phase,
              hookCommand: hook.command,
              success: false,
              error: "命令执行器未配置，无法执行 command 类型钩子",
              durationMs: Date.now() - startTime,
            };
          }
          const { stdout, stderr, exitCode } = await this.commandExecutor.execute(
            this.interpolateCommand(hook.command, ctx),
            hook.timeoutMs ?? 30_000,
          );
          return {
            hookType: phase,
            hookCommand: hook.command,
            success: exitCode === 0,
            output: stdout || undefined,
            error: exitCode !== 0 ? stderr || `Exit code: ${exitCode}` : undefined,
            durationMs: Date.now() - startTime,
          };
        }

        case "script": {
          // script 类型：将脚本内容作为参数传递给命令执行器
          if (!this.commandExecutor) {
            return {
              hookType: phase,
              hookCommand: hook.command,
              success: false,
              error: "命令执行器未配置，无法执行 script 类型钩子",
              durationMs: Date.now() - startTime,
            };
          }
          const scriptCmd = `node -e ${JSON.stringify(hook.command)}`;
          const result = await this.commandExecutor.execute(scriptCmd, hook.timeoutMs ?? 30_000);
          return {
            hookType: phase,
            hookCommand: `[script] ${hook.command.slice(0, 200)}`,
            success: result.exitCode === 0,
            output: result.stdout || undefined,
            error:
              result.exitCode !== 0 ? result.stderr || `Exit code: ${result.exitCode}` : undefined,
            durationMs: Date.now() - startTime,
          };
        }

        case "rpc": {
          // rpc 类型：预留，后续通过 MessageBus 发送 RPC 调用
          console.log(`[HookExecutor] rpc 类型钩子暂未实现: ${hook.command}`);
          return {
            hookType: phase,
            hookCommand: hook.command,
            success: true,
            output: "rpc hook type not yet implemented",
            durationMs: Date.now() - startTime,
          };
        }

        default:
          return {
            hookType: phase,
            hookCommand: hook.command,
            success: false,
            error: `未知钩子类型: ${hook.type}`,
            durationMs: Date.now() - startTime,
          };
      }
    } catch (err) {
      return {
        hookType: phase,
        hookCommand: hook.command,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }

  /** 按 toolMatch 过滤钩子 */
  private filterByToolMatch(
    hooks: readonly AgentHook[] | undefined,
    toolName?: string,
  ): readonly AgentHook[] {
    if (!hooks) return [];
    return hooks.filter((h) => {
      if (!h.toolMatch) return true; // 无 toolMatch 表示匹配所有工具
      if (!toolName) return false;
      return h.toolMatch === toolName || h.toolMatch === "*";
    });
  }

  /** 在命令中插值上下文变量 */
  private interpolateCommand(command: string, ctx: HookContext): string {
    return command
      .replace(/\$\{agentId\}/g, ctx.agentId)
      .replace(/\$\{definitionId\}/g, ctx.definitionId)
      .replace(/\$\{toolName\}/g, ctx.toolName ?? "")
      .replace(/\$\{error\}/g, ctx.error ?? "");
  }
}
