/**
 * AgentOrchestrator — 多 Agent 编排与 spawn/send 统一入口
 *
 * 将子 Agent 创建、同步/异步执行、MessageBus 投递与实例查询集中管理，
 * 便于宿主（如 Electron bridge）注入 createInstance / prompt 等平台能力。
 */

import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "../types/agent-definition.js";
import { MessageBus } from "../messaging/message-bus.js";
import type { AgentBusMessage } from "../messaging/message-bus.js";
import { serializeMessage, normalizeMessage } from "../messaging/message-types.js";
import { AgentRegistry } from "./agent-registry.js";
import type { AgentInstance } from "./agent-instance.js";
import type { AgentRuntimeEvent } from "../types/events.js";
import { parseVerdict, formatVerdictBanner, type Verdict } from "./verdict-parser.js";

/** spawn_agent 工具入参（与 spawn-agent-tool 对齐） */
export interface SpawnAgentParams {
  readonly name: string;
  readonly prompt: string;
  readonly agentType?: string;
  readonly mode?: "sync" | "async";
  readonly description?: string;
  readonly model?: string;
  /** 子 Agent 工具白名单（支持参数级语法如 "bash(git:*)"\uff09 */
  readonly allowedTools?: readonly string[];
  /**
   * @internal 由 orchestrator 自动维护，不暴露给 LLM 可见的 spawn-agent-tool Schema
   * 标记当前 spawn 调用的深度，用于防止无限递归委派（R1）
   */
  readonly _spawnDepth?: number;
}

/** spawn_agent 执行结果 */
export type SpawnAgentResult =
  | {
      readonly status: "ok";
      readonly mode: "sync";
      readonly instanceId: string;
      readonly output: string;
      /** 当子 Agent 为 builtin:verify 时，解析出的结构化验证结论（主题5 P0-1） */
      readonly verdict?: Verdict;
    }
  | {
      readonly status: "ok";
      readonly mode: "async";
      readonly instanceId: string;
      readonly message: string;
    }
  | { readonly status: "error"; readonly message: string };

/**
 * 宿主必须提供的能力：解析定义、创建子实例、投递消息、销毁等
 */
export interface AgentOrchestratorDeps {
  /** 按 agentType 字符串解析 AgentDefinition */
  resolveDefinition: (typeKey: string) => Promise<AgentDefinition>;
  /** 创建子实例（内部应完成 AgentRegistry.create 与邮箱注册） */
  createChildInstance: (opts: {
    readonly definition: AgentDefinition;
    readonly sessionKey: string;
    readonly parentInstanceId?: string;
    readonly conversationId?: string;
    /** 子 Agent 工具白名单（支持参数级语法如 "bash(git:*)"），由父 Agent 通过 spawn_agent 传入 */
    readonly allowedTools?: readonly string[];
    /**
     * 当前 spawn 调用深度（0-based），由 orchestrator 自动注入，
     * bridge 层应将此值存入子实例 context，子实例再次调用 spawn_agent 时
     * 将 _spawnDepth 设为此值，使深度检查生效
     */
    readonly spawnDepth?: number;
  }) => Promise<string>;
  /** 获取实例关联的对话 ID（用于子 Agent 继承父会话，消息写入同一 DB 对话） */
  getConversationId?: (instanceId: string) => string | undefined;
  readonly prompt: (instanceId: string, message: string) => Promise<void>;
  /** Agent 间协作优先走 followUp 队列（与 prompt 区分） */
  readonly followUp: (instanceId: string, message: string) => void;
  readonly destroy: (instanceId: string) => void;
  readonly getInstance: (instanceId: string) => AgentInstance | undefined;
  /** 解析 send_message 的 to 参数 */
  readonly findInstanceByRecipient: (to: string) => AgentInstance | undefined;
  /** UI 展示用名称 */
  readonly getDisplayNameForInstance: (instanceId: string) => string;
  /**
   * 是否启用 VERDICT 解析消费（主题5 P0-1，默认 true）
   * killswitch：宿主可注入 featureFlags.ENABLE_VERDICT_CONSUMPTION 关闭。
   */
  readonly isVerdictConsumptionEnabled?: () => boolean;
}

/**
 * 多 Agent 编排器：spawn、send、活动列表
 */
export class AgentOrchestrator {
  constructor(
    private readonly registry: AgentRegistry,
    private readonly messageBus: MessageBus,
    private readonly deps: AgentOrchestratorDeps,
  ) {}

  /**
   * 在 MessageBus 上注册实例邮箱（实例创建后调用）
   */
  registerMailbox(instanceId: string): void {
    this.messageBus.register(instanceId);
  }

  /**
   * 注销邮箱（实例销毁时调用）
   */
  unregisterMailbox(instanceId: string): void {
    this.messageBus.unregister(instanceId);
  }

  /**
   * 执行 spawn_agent：同步阻塞或异步后台
   *
   * @param parentInstanceId — 父实例 ID（来自工具执行上下文）
   */
  async spawnAgent(
    params: SpawnAgentParams,
    parentInstanceId: string | undefined,
  ): Promise<SpawnAgentResult> {
    // 深度限制：防止子 Agent 递归委派（R1）
    const MAX_SPAWN_DEPTH = 3;
    const currentDepth = params._spawnDepth ?? 0;
    if (currentDepth >= MAX_SPAWN_DEPTH) {
      return {
        status: "error",
        message:
          `spawn_agent depth limit reached (max ${MAX_SPAWN_DEPTH} levels). ` +
          `Sub-agents cannot spawn further agents. Execute the task directly using your own tools.`,
      };
    }

    const typeKey = params.agentType?.trim() || "assistant";
    let agentDef: AgentDefinition;
    try {
      agentDef = await this.deps.resolveDefinition(typeKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `resolveDefinition failed: ${message}` };
    }

    const childSessionKey = `child-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // 继承父实例的 conversationId，子 Agent 消息写入同一个 DB 对话，不产生新会话
    const parentConversationId =
      parentInstanceId && this.deps.getConversationId
        ? this.deps.getConversationId(parentInstanceId)
        : undefined;

    let childInstanceId: string;
    try {
      childInstanceId = await this.deps.createChildInstance({
        definition: agentDef,
        sessionKey: childSessionKey,
        parentInstanceId,
        conversationId: parentConversationId,
        allowedTools: params.allowedTools,
        spawnDepth: currentDepth + 1,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `createChildInstance failed: ${message}` };
    }

    // 默认 sync：主 Agent 能收到子 Agent 输出并汇总；
    // 与 spawn_agent 工具 schema 默认值保持一致，避免被透传的 undefined 走回旧行为。
    const mode = params.mode ?? "sync";

    if (mode === "sync") {
      const childInstance = this.deps.getInstance(childInstanceId);
      if (!childInstance) {
        return { status: "error", message: "sub-agent instance missing after create" };
      }

      let outputText = "";
      const unsub = childInstance.subscribe((event: AgentRuntimeEvent) => {
        if (event.type === "message:delta") {
          outputText += event.delta;
        } else if (event.type === "message:end") {
          outputText = event.fullText;
        }
      });

      try {
        await this.deps.prompt(childInstanceId, params.prompt);
        await childInstance.waitForIdle();
      } finally {
        unsub();
        this.deps.destroy(childInstanceId);
      }

      // 主题5 P0-1：VERDICT 解析消费 —— 当子 Agent 为 builtin:verify 时，
      // 解析输出末尾的 VERDICT 行，前置一行机器可读摘要，使主 Agent 必然看到结论，
      // 并在 FAIL/PARTIAL 时收到行动引导（回头修复后重验）。
      const verdictEnabled = this.deps.isVerdictConsumptionEnabled?.() ?? true;
      if (verdictEnabled && agentDef.id === "builtin:verify") {
        const { verdict } = parseVerdict(outputText);
        const banner = formatVerdictBanner(verdict);
        return {
          status: "ok",
          mode: "sync",
          instanceId: childInstanceId,
          output: `${banner}\n\n${outputText}`,
          verdict,
        };
      }

      return { status: "ok", mode: "sync", instanceId: childInstanceId, output: outputText };
    }

    void this.deps.prompt(childInstanceId, params.prompt).catch(() => {
      // 宿主侧可打日志
    });

    return {
      status: "ok",
      mode: "async",
      instanceId: childInstanceId,
      message: `Sub-agent "${params.name}" is running in the background.`,
    };
  }

  /**
   * 执行 send_message：广播或单播；MessageBus 记录 + followUp 投递
   */
  async sendMessage(params: {
    readonly to: string;
    readonly message: string;
    readonly summary?: string;
    readonly fromInstanceId: string;
  }): Promise<
    | { readonly status: "ok"; readonly broadcast: true; readonly recipientCount: number }
    | {
        readonly status: "ok";
        readonly broadcast: false;
        readonly to: string;
        readonly delivered: boolean;
      }
    | { readonly status: "error"; readonly message: string }
  > {
    const { to, message, summary, fromInstanceId } = params;
    const textPayload = serializeMessage(normalizeMessage(message));
    const busMsg: AgentBusMessage = {
      id: randomUUID(),
      from: fromInstanceId,
      text: textPayload,
      summary,
      timestamp: new Date().toISOString(),
    };

    if (to === "*") {
      const all = this.registry.getAll();
      let sent = 0;
      for (const inst of all) {
        if (inst.id === fromInstanceId) continue;
        if (!this.messageBus.has(inst.id)) {
          this.messageBus.register(inst.id);
        }
        try {
          this.messageBus.send(inst.id, busMsg);
        } catch {
          // 邮箱未注册时仍尝试 followUp
        }
        this.deps.followUp(inst.id, message);
        sent++;
      }
      return { status: "ok", broadcast: true, recipientCount: sent };
    }

    const target = this.deps.findInstanceByRecipient(to);
    if (!target) {
      return { status: "error", message: `Agent "${to}" not found` };
    }
    if (!this.messageBus.has(target.id)) {
      this.messageBus.register(target.id);
    }
    try {
      this.messageBus.send(target.id, busMsg);
    } catch {
      // 仍投递 followUp
    }
    this.deps.followUp(target.id, message);
    return { status: "ok", broadcast: false, to, delivered: true };
  }

  /**
   * 返回当前进程内全部实例的活动摘要（供调试或 UI）
   */
  getActiveAgents(): readonly {
    readonly agentId: string;
    readonly name: string;
    readonly state: string;
  }[] {
    return this.registry.getAll().map((i) => ({
      agentId: i.id,
      name: this.deps.getDisplayNameForInstance(i.id),
      state: i.state,
    }));
  }
}
