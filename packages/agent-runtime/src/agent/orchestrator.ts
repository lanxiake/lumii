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
import {
  SubagentBroker,
  SUBAGENT_DEFAULTS,
  clampConcurrentLimit,
  type SubagentCompletionPayload,
  type SubagentRunStatus,
} from "./subagent-broker.js";
import { guardSubagentSummary } from "./subagent-summary.js";

/** listChildren 返回项 */
export interface SubagentChildInfo {
  readonly childId: string;
  readonly name: string;
  readonly status: SubagentRunStatus;
  readonly mode: "sync" | "async";
  readonly startedAt: number;
  readonly lastProgressAt: number;
}

/** 生命周期操作结果 */
export type SubagentLifecycleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };
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
  /**
   * 解析父实例的子 Agent 并发上限（来自父 AgentDefinition.subagentMaxConcurrent）
   * 未提供时使用 SUBAGENT_DEFAULTS.maxConcurrentChildren
   */
  readonly getParentMaxConcurrent?: (parentInstanceId: string) => number | undefined;
  /**
   * 异步子 Agent 完成（已 enqueue）后的宿主回调；bridge 负责投递泵与 destroy
   */
  readonly onAsyncSubagentComplete?: (payload: SubagentCompletionPayload) => void;
  /** 摘要落盘工作目录（可选） */
  readonly getSummaryCwd?: () => string | undefined;
}

/**
 * 多 Agent 编排器：spawn、send、活动列表
 */
export class AgentOrchestrator {
  readonly broker: SubagentBroker;

  constructor(
    private readonly registry: AgentRegistry,
    private readonly messageBus: MessageBus,
    private readonly deps: AgentOrchestratorDeps,
    broker?: SubagentBroker,
  ) {
    this.broker = broker ?? new SubagentBroker();
  }

  /**
   * 对输出做摘要护栏后写入 finalize
   */
  private finalizeWithGuard(
    childId: string,
    status: Exclude<SubagentRunStatus, "running">,
    outputText: string,
    errorMessage?: string,
  ) {
    const guarded = guardSubagentSummary(outputText, {
      cwd: this.deps.getSummaryCwd?.(),
    });
    return this.broker.finalizeRun(
      childId,
      status,
      guarded.summary,
      errorMessage,
      guarded.spillPath,
    );
  }

  /**
   * 将完成载荷入队并通知宿主投递泵
   */
  private notifyAsyncComplete(childId: string): void {
    const payload = this.broker.buildCompletion(childId);
    if (!payload) return;
    this.broker.enqueueCompletion(payload);
    console.log(
      `[AgentOrchestrator] async complete → notify parent=${payload.parentId} child=${payload.childId} status=${payload.status}`,
    );
    this.deps.onAsyncSubagentComplete?.(payload);
  }

  /**
   * 启动 stale 监控：无进度超时则 abort + finalize(stale) + 投递
   */
  startStaleMonitor(opts?: { staleIdleMs?: number; intervalMs?: number }): void {
    this.broker.startStaleMonitor((childId) => {
      this.handleStaleChild(childId);
    }, opts);
  }

  /** 停止 stale 监控 */
  stopStaleMonitor(): void {
    this.broker.stopStaleMonitor();
  }

  /**
   * 处理单个 stale 子 Agent
   */
  handleStaleChild(childId: string): void {
    const run = this.broker.getRun(childId);
    if (!run || run.status !== "running") return;
    console.log(
      `[AgentOrchestrator] stale abort child=${childId} parent=${run.parentId} name=${run.name}`,
    );
    const child = this.deps.getInstance(childId);
    try {
      child?.abort();
    } catch (err) {
      console.log(
        `[AgentOrchestrator] stale abort error child=${childId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.finalizeWithGuard(
      childId,
      "stale",
      run.outputText,
      `Sub-agent stale: no progress for >${SUBAGENT_DEFAULTS.staleIdleMs}ms`,
    );
    this.notifyAsyncComplete(childId);
  }

  /**
   * 列出某父下 broker 登记的子 Agent（含终态）
   */
  listChildren(parentId: string): readonly SubagentChildInfo[] {
    return this.broker.listRunsForParent(parentId).map((r) => ({
      childId: r.childId,
      name: r.name,
      status: r.status,
      mode: r.mode,
      startedAt: r.startedAt,
      lastProgressAt: r.lastProgressAt,
    }));
  }

  /**
   * 校验 child 是否属于 parent（registry 血缘或 broker 登记）
   */
  private assertChildOf(parentId: string, childId: string): SubagentLifecycleResult | null {
    const run = this.broker.getRun(childId);
    const linked =
      this.registry.isDescendant(parentId, childId) || run?.parentId === parentId;
    if (!linked) {
      return { ok: false, message: `Child "${childId}" is not a descendant of "${parentId}"` };
    }
    return null;
  }

  /**
   * 中断后代子 Agent：abort + cancelled 完成通知
   */
  interruptChild(parentId: string, childId: string): SubagentLifecycleResult {
    const denied = this.assertChildOf(parentId, childId);
    if (denied) {
      console.log(
        `[AgentOrchestrator] interrupt denied: not descendant parent=${parentId} child=${childId}`,
      );
      return denied;
    }
    const run = this.broker.getRun(childId);
    const child = this.deps.getInstance(childId);
    if (!child && !run) {
      return { ok: false, message: `Child "${childId}" not found` };
    }
    console.log(`[AgentOrchestrator] interrupt child=${childId} parent=${parentId}`);
    try {
      child?.abort();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
    if (run?.status === "running") {
      this.finalizeWithGuard(childId, "cancelled", run.outputText, "interrupted by parent");
      this.notifyAsyncComplete(childId);
    }
    return { ok: true };
  }

  /**
   * 向后代子 Agent 注入 steer 文本（不中断当前工具）
   */
  steerChild(parentId: string, childId: string, text: string): SubagentLifecycleResult {
    const denied = this.assertChildOf(parentId, childId);
    if (denied) {
      console.log(
        `[AgentOrchestrator] steer denied: not descendant parent=${parentId} child=${childId}`,
      );
      return denied;
    }
    const child = this.deps.getInstance(childId);
    if (!child) {
      return { ok: false, message: `Child "${childId}" not found` };
    }
    console.log(
      `[AgentOrchestrator] steer child=${childId} parent=${parentId} textLen=${text.length}`,
    );
    try {
      child.steer(text);
      this.broker.updateProgress(childId);
      return { ok: true };
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

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
   * 解析父下子 Agent 并发上限（夹到硬顶）
   */
  private resolveConcurrentLimit(parentInstanceId: string | undefined): number {
    const requested =
      parentInstanceId && this.deps.getParentMaxConcurrent
        ? this.deps.getParentMaxConcurrent(parentInstanceId)
        : undefined;
    return clampConcurrentLimit(requested);
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
    // 深度限制：产品扁平委派 depth=1；更深委派属 P2，且需 bridge 放开 canSpawnSubAgents
    const MAX_SPAWN_DEPTH = SUBAGENT_DEFAULTS.maxSpawnDepth;
    const currentDepth = params._spawnDepth ?? 0;
    if (currentDepth >= MAX_SPAWN_DEPTH) {
      console.log(
        `[AgentOrchestrator] spawn denied depth parent=${parentInstanceId ?? "-"} depth=${currentDepth} max=${MAX_SPAWN_DEPTH}`,
      );
      return {
        status: "error",
        message:
          `spawn_agent depth limit reached (max ${MAX_SPAWN_DEPTH} levels). ` +
          `Sub-agents cannot spawn further agents. Execute the task directly using your own tools.`,
      };
    }

    const parentKey = parentInstanceId ?? "__orphan__";
    const limit = this.resolveConcurrentLimit(parentInstanceId);
    if (!this.broker.tryAcquireSlot(parentKey, limit)) {
      console.log(
        `[AgentOrchestrator] spawn denied concurrency parent=${parentKey} limit=${limit}`,
      );
      return {
        status: "error",
        message:
          `spawn_agent concurrency limit reached (max ${limit} running children). ` +
          `Wait for a child to finish or interrupt one before spawning more.`,
      };
    }

    const typeKey = params.agentType?.trim() || "assistant";
    let agentDef: AgentDefinition;
    try {
      agentDef = await this.deps.resolveDefinition(typeKey);
    } catch (err) {
      this.broker.releasePendingSlot(parentKey);
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
      this.broker.releasePendingSlot(parentKey);
      const message = err instanceof Error ? err.message : String(err);
      return { status: "error", message: `createChildInstance failed: ${message}` };
    }

    // 默认 sync：主 Agent 能收到子 Agent 输出并汇总；
    // 与 spawn_agent 工具 schema 默认值保持一致，避免被透传的 undefined 走回旧行为。
    const mode = params.mode ?? "sync";

    this.broker.registerRun({
      childId: childInstanceId,
      parentId: parentKey,
      name: params.name,
      mode,
    });

    if (mode === "sync") {
      const childInstance = this.deps.getInstance(childInstanceId);
      if (!childInstance) {
        this.broker.releaseSlot(childInstanceId);
        return { status: "error", message: "sub-agent instance missing after create" };
      }

      let outputText = "";
      const unsub = childInstance.subscribe((event: AgentRuntimeEvent) => {
        if (event.type === "message:delta") {
          outputText += event.delta;
          this.broker.updateProgress(childInstanceId);
        } else if (event.type === "message:end") {
          outputText = event.fullText;
          this.broker.updateProgress(childInstanceId);
        } else if (event.type === "tool:start") {
          this.broker.updateProgress(childInstanceId);
        }
      });

      try {
        await this.deps.prompt(childInstanceId, params.prompt);
        await childInstance.waitForIdle();
        this.finalizeWithGuard(childInstanceId, "succeeded", outputText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.finalizeWithGuard(childInstanceId, "failed", outputText, message);
        throw err;
      } finally {
        unsub();
        this.deps.destroy(childInstanceId);
      }

      const guardedOutput =
        this.broker.getRun(childInstanceId)?.outputText ?? outputText;

      // 主题5 P0-1：VERDICT 解析消费 —— 当子 Agent 为 builtin:verify 时，
      // 解析输出末尾的 VERDICT 行，前置一行机器可读摘要，使主 Agent 必然看到结论，
      // 并在 FAIL/PARTIAL 时收到行动引导（回头修复后重验）。
      const verdictEnabled = this.deps.isVerdictConsumptionEnabled?.() ?? true;
      if (verdictEnabled && agentDef.id === "builtin:verify") {
        const { verdict } = parseVerdict(guardedOutput);
        const banner = formatVerdictBanner(verdict);
        return {
          status: "ok",
          mode: "sync",
          instanceId: childInstanceId,
          output: `${banner}\n\n${guardedOutput}`,
          verdict,
        };
      }

      return { status: "ok", mode: "sync", instanceId: childInstanceId, output: guardedOutput };
    }

    // async：后台跑完后入完成队列，由 bridge 投递（destroy 亦由投递成功后执行）
    const child = this.deps.getInstance(childInstanceId);
    let outputText = "";
    const unsub = child?.subscribe((event: AgentRuntimeEvent) => {
      if (event.type === "message:delta") {
        outputText += event.delta;
        this.broker.updateProgress(childInstanceId);
      } else if (event.type === "message:end") {
        outputText = event.fullText;
        this.broker.updateProgress(childInstanceId);
      } else if (event.type === "tool:start") {
        this.broker.updateProgress(childInstanceId);
      }
    });

    void (async () => {
      try {
        await this.deps.prompt(childInstanceId, params.prompt);
        await child?.waitForIdle();
        if (this.broker.getRun(childInstanceId)?.status === "running") {
          this.finalizeWithGuard(childInstanceId, "succeeded", outputText);
          this.notifyAsyncComplete(childInstanceId);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (this.broker.getRun(childInstanceId)?.status === "running") {
          this.finalizeWithGuard(childInstanceId, "failed", outputText, message);
          this.notifyAsyncComplete(childInstanceId);
        }
      } finally {
        unsub?.();
      }
    })();

    console.log(
      `[AgentOrchestrator] spawn async started child=${childInstanceId} parent=${parentKey} name=${params.name}`,
    );
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
