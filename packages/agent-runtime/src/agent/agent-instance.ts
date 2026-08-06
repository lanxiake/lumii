/**
 * AgentInstance — 封装 pi-agent-core 的 Agent
 *
 * 每个 AgentInstance 对应一个活跃的 Agent 会话。
 * 负责：
 * - 创建和配置 pi-agent-core Agent 实例
 * - 将 AgentEvent 转换为 AgentRuntimeEvent 并分发
 * - 管理生命周期（prompt, abort, destroy）
 */

import type { Agent, AgentOptions } from "@mariozechner/pi-agent-core";
import { createPiAgent } from "../kernel/create-pi-agent.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { Message, Model, ImageContent } from "@mariozechner/pi-ai";
import type { AgentTool } from "../types/tool.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { type AgentRuntimeEvent, type AgentInstanceState, mapAgentEvent } from "../types/events.js";
import type { MemoryManager } from "../memory/manager.js";
import {
  createTransformContext,
  DEFAULT_COMPACTION_TRIGGER_RATIO,
  DEFAULT_MICRO_COMPACT_RATIO,
  DEFAULT_KEEP_RECENT_TOOL_RESULTS,
  DEFAULT_KEEP_RECENT_TURNS,
  SessionActivityIndex,
  buildActivityIndexAttachment,
  type SummaryGeneratorFn,
  type CompactionInfo,
} from "../compact/index.js";
import {
  createBudgetTracker,
  checkTokenBudget,
  type BudgetTracker,
} from "./token-budget.js";
import type { AgentKernel } from "../kernel/types.js";
import { PiAgentKernelAdapter } from "../kernel/pi-agent-kernel-adapter.js";
import type { AgentTurnOrigin } from "@mtbot/protocol";
import type { CapabilityRegistry } from "../capability/capability-registry.js";
import {
  defaultConvertToLlm,
  classifyLlmError,
  repairMessageSequence,
  type LlmErrorCategory,
} from "../reliability/message-repair.js";
import { MemoryIntegration } from "../context/memory-integration.js";
import { SelfHealController } from "../reliability/self-heal.js";
import { StuckGuard } from "../reliability/stuck-guard.js";
import { pruneThinkingForDeepSeek, type PruneThinkingPolicy } from "./message-pruner.js";

/**
 * 轻量生命周期回调（与 HookExecutor 配置的脚本钩子不同，供宿主进程注入）
 */
export interface AgentLifecycleCallbacks {
  /** agent:start 映射事件后触发 */
  onStart?: (instanceId: string) => void | Promise<void>;
  /** agent:end 映射事件后触发（pause 路径不会触发） */
  onComplete?: (instanceId: string) => void | Promise<void>;
  /** agent:error 触发 */
  onError?: (instanceId: string, error: string) => void | Promise<void>;
}

export interface AgentInstanceConfig {
  /** 实例唯一 ID */
  id: string;
  /** Agent 定义 */
  definition: AgentDefinition;
  /** Stream 函数（通过网关代理） */
  streamFn: StreamFn;
  /** 已解析的模型 */
  model: Model<string>;
  /** Agent 工具列表 */
  tools: AgentTool[];
  /** 可选的 Agent 选项覆盖 */
  agentOptions?: Partial<AgentOptions>;
  /** 记忆门面（可选，提供时启用记忆功能） */
  memoryManager?: MemoryManager;
  /** 用户 ID（记忆作用域需要） */
  userId?: string;
  /**
   * 模型的最大上下文窗口（tokens）
   * 用于 transformContext 上下文压缩（默认与 128k 级总窗口模型对齐）
   * 默认 1_000_000
   */
  contextWindow?: number;
  /**
   * 为单次模型输出预留的 token 预算（通常来自提供商配置的 maxTokens）
   * 未设置时使用 16_384
   */
  outputReserveTokens?: number;
  /**
   * 为摘要/占位预留的 token（未设置时使用 8_192）
   */
  summaryReserveTokens?: number;
  /**
   * 是否启用 MicroCompact 第一级压缩（主题2 P0-1，默认 true）
   *
   * killswitch：宿主可注入 featureFlags.ENABLE_MICRO_COMPACT 关闭，回退到全摘要+兜底路径。
   */
  enableMicroCompact?: boolean;
  /**
   * 是否启用单 turn token 预算跟踪（主题2 P0-2，默认 false）
   *
   * 启用后在每个 turn_end 检查累积 token 消耗，低于 90% 阈值时注入 followUp nudge 推动继续工作。
   */
  enableTurnTokenBudget?: boolean;
  /**
   * LLM 摘要生成器（可选）
   *
   * 提供后启用 LLM 摘要模式；不提供则降级为占位摘要。
   * 由宿主进程（bridge.ts）注入，使用 streamFn 调用 LLM 生成结构化摘要。
   */
  generateSummary?: SummaryGeneratorFn;
  /**
   * 当前会话的活跃任务列表（可选）
   *
   * 注入到压缩摘要提示词中，确保任务状态在压缩后不丢失。
   * 宿主每轮 prompt 前更新此字段（通过 updateActiveTasks）。
   */
  activeTasks?: readonly { id: string; subject: string; status: string; owner?: string | null }[];
  /**
   * 压缩摘要领域提示（可选，默认 "general"）
   *
   * 由宿主根据该会话是否启用代码类工具/技能传入；"coding" 时摘要追加代码细节。
   */
  domainHint?: "general" | "coding";
  /**
   * 是否在压缩回填消息追加"回查原文"指针（可选，默认 false）
   *
   * 由宿主在该会话注册了记忆检索工具（memory_search + memory_read）时置 true。
   */
  historyRecallHint?: boolean;
  /**
   * 当前会话标识（可选，与 conversationId 等价）。
   *
   * 注入 compact 回查指针，引导 memory_search 优先检索本会话归档原文。
   */
  sessionKey?: string;
  /**
   * 是否向 system prompt 注入工作记忆（SQLite 热记忆），默认 true。
   * 宿主每轮 prompt 前可通过 setMemoryInjectionFlags 更新。
   */
  injectWorkMemory?: boolean;
  /** 可选生命周期回调 */
  lifecycleHooks?: AgentLifecycleCallbacks;
  /** 可注入的 AgentKernel 实现（测试/替换用，默认由 PiAgentKernelAdapter 包装内部 agent） */
  kernel?: AgentKernel;
  /** 可选能力注册表（注入后每次 prompt 按 origin 过滤工具列表） */
  capabilityRegistry?: CapabilityRegistry;
  /**
   * 发往 LLM 前的 thinking 裁剪策略（设计 §6.3），默认 `"deepseek"`。
   *
   * - `off`：不裁剪（非 DeepSeek 模型可设此值）
   * - `deepseek`：按 DeepSeek 思考模式规则裁剪历史轮 thinking（当前轮与有 toolCall 的历史轮保留）
   * - `aggressive`：仅保留当前未闭合 user 轮的 thinking
   *
   * 仅影响发往 LLM 的副本，不改变内存/DB/UI 的完整 thinking。
   */
  pruneThinkingPolicy?: PruneThinkingPolicy;
}

/**
 * Agent 实例
 *
 * 封装 pi-agent-core 的 Agent class，提供面向客户端 UI 的事件流。
 */
export class AgentInstance {
  readonly id: string;
  readonly definitionId: string;
  private readonly agent: Agent;
  private readonly listeners = new Set<(e: AgentRuntimeEvent) => void>();
  private _state: AgentInstanceState = "idle";
  private accumulatedText = "";
  private unsubscribeAgent: (() => void) | null = null;
  /** 超时定时器句柄 */
  private timeoutHandle: ReturnType<typeof setTimeout> | null = null;
  /** Agent 定义中的超时时间 */
  private readonly timeoutMs: number | undefined;
  /** Agent 定义中的最大轮数 */
  private readonly maxTurns: number | undefined;
  /** 当前 turn 计数 */
  private turnCount = 0;
  /** 单 turn token 预算（来自 definition.maxTokensBudget，未设置或未启用时为 null） */
  private readonly tokenBudget: number | null;
  /** token 预算跟踪器（启用时初始化，每次 prompt 重置） */
  private budgetTracker: BudgetTracker | null = null;
  /** 是否启用单 turn token 预算 */
  private readonly enableTurnTokenBudget: boolean;
  /** 循环/卡死检测守卫（工具指纹循环 + assistant 文本重复 + 冷却处理） */
  private readonly stuckGuard: StuckGuard;
  /** 记忆门面（可选） */
  private readonly memoryManager: MemoryManager | undefined;
  /** 记忆系统集成（热记忆注入 + 候选提取接线） */
  private readonly memoryIntegration: MemoryIntegration;
  /** 用户 ID（记忆作用域） */
  private readonly userId: string | undefined;
  /** 记忆配置 */
  private readonly memoryConfig: AgentDefinition["memory"];
  /** 是否注入工作记忆到 system prompt（可由宿主动态关闭） */
  private injectWorkMemory = true;
  /** 记忆提取间隔（每 N 轮提取一次） */
  private readonly memoryExtractEvery: number;

  /** pause() 后等待 agent_end 以进入 paused 状态 */
  private endingPause = false;

  /** 生命周期回调 */
  private readonly lifecycleHooks: AgentLifecycleCallbacks | undefined;

  /** 当前会话活跃任务（注入到压缩摘要提示词，每轮 prompt 前由宿主更新） */
  private _activeTasks: readonly {
    id: string;
    subject: string;
    status: string;
    owner?: string | null;
  }[] = [];

  /** 会话级文件/技能使用索引（压缩后重建附加消息，兜底摘要遗漏，设计: .qoder/design/agent-context-compact/03-*.md） */
  private readonly sessionIndex = new SessionActivityIndex();

  /** 自愈层控制器（错误检测 + 消息修复 + continue 重试） */
  private readonly selfHeal: SelfHealController;
  /** prompt() 等待整个自愈链完成的 resolve 回调 */
  private _promptDoneResolve: (() => void) | null = null;
  /** AgentKernel 抽象层（默认由 PiAgentKernelAdapter 包装，测试时可注入 FakeAgentKernel） */
  private readonly kernel: AgentKernel;
  /** 可选能力注册表（每次 prompt 按 origin 过滤工具列表） */
  private readonly capabilityRegistry: CapabilityRegistry | undefined;

  constructor(config: AgentInstanceConfig) {
    this.id = config.id;
    this.definitionId = config.definition.id;
    this.timeoutMs = config.definition.timeoutMs;
    this.maxTurns = config.definition.maxTurns;
    this.enableTurnTokenBudget = config.enableTurnTokenBudget ?? false;
    this.tokenBudget =
      this.enableTurnTokenBudget && config.definition.maxTokensBudget
        ? config.definition.maxTokensBudget
        : null;
    this.memoryManager = config.memoryManager;
    this.userId = config.userId;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.memoryConfig = config.definition.memory;
    this.injectWorkMemory = config.injectWorkMemory !== false;
    // 默认每 3 轮提取一次：每轮都跑规则提取/LLM 提取会带来明显额外开销，
    // 且对话刚开始几轮信息量低。含"请记住"等关键词时仍会绕过节流立即提取。
    this.memoryExtractEvery = config.definition.memory?.extractEvery ?? 3;
    this.lifecycleHooks = config.lifecycleHooks;

    this.agent = createPiAgent({
      initialState: {
        systemPrompt: config.definition.systemPrompt ?? "You are MtBot, a helpful AI assistant.",
        model: config.model,
        tools: config.tools,
      },
      streamFn: config.streamFn,
      // §6.3：先按 DeepSeek 思考模式裁剪历史轮 thinking，再做 tool 配对修复。
      // 仅影响发往 LLM 的副本，pi-agent-core 内存态 messages 不变。
      convertToLlm: (msgs) =>
        defaultConvertToLlm(pruneThinkingForDeepSeek(msgs, config.pruneThinkingPolicy ?? "deepseek")),
      // 设计文档 §4.1: steer 模式默认 "all"，一次性注入所有插话消息
      steeringMode: "all",
      // 设计文档 §4.2: followUp 模式默认 "one-at-a-time"，逐个任务处理
      followUpMode: "one-at-a-time",
      transformContext: createTransformContext({
        contextWindow: config.contextWindow ?? 1_000_000,
        triggerRatio: DEFAULT_COMPACTION_TRIGGER_RATIO,
        keepRecentTurns: DEFAULT_KEEP_RECENT_TURNS,
        // 主题2 P0-1：MicroCompact 第一级（默认开启，0.7 早于全摘要 0.9，保留最近 8 个工具结果）
        microCompactRatio: DEFAULT_MICRO_COMPACT_RATIO,
        keepRecentToolResults: DEFAULT_KEEP_RECENT_TOOL_RESULTS,
        enableMicroCompact: config.enableMicroCompact ?? true,
        outputReserveTokens: config.outputReserveTokens ?? 16_384,
        summaryReserveTokens: config.summaryReserveTokens ?? 8_192,
        generateSummary: config.generateSummary,
        domainHint: config.domainHint ?? "general",
        historyRecallHint: config.historyRecallHint ?? false,
        sessionKey: config.sessionKey,
        get activeTasks() {
          // 动态读取：每次压缩时取最新任务列表（由宿主通过 updateActiveTasks 更新）
          return self._activeTasks;
        },
        onCompaction: (info: CompactionInfo) => {
          this.emit({
            type: "context:compaction",
            instanceId: this.id,
            ...info,
          });
        },
        postCompactRebuild: {
          buildAttachments: async () => buildActivityIndexAttachment(self.sessionIndex.snapshot()),
        },
      }),
      ...config.agentOptions,
    });

    this.kernel = config.kernel ?? new PiAgentKernelAdapter(this.agent);
    this.capabilityRegistry = config.capabilityRegistry;

    this.memoryIntegration = new MemoryIntegration({
      instanceId: this.id,
      definitionId: this.definitionId,
      memoryManager: this.memoryManager,
      userId: this.userId,
      memoryConfig: this.memoryConfig,
      memoryExtractEvery: this.memoryExtractEvery,
      getAgent: () => ({
        messages: this.agent.state.messages,
        systemPrompt: this.agent.state.systemPrompt ?? "",
        setSystemPrompt: (prompt: string) => this.agent.setSystemPrompt(prompt),
      }),
      getTurnCount: () => this.turnCount,
      getInjectWorkMemory: () => this.injectWorkMemory,
    });

    this.selfHeal = new SelfHealController({
      instanceId: this.id,
      maxRetries: 2,
      cooldownMs: 1000,
      getMessages: () => this.agent.state.messages,
      replaceMessages: (messages) => this.agent.replaceMessages(messages),
      appendMessage: (message) => this.agent.appendMessage(message),
      continueAgent: () => this.agent.continue(),
      isDestroyed: () => this._state === "destroyed",
      isEndingPause: () => this.endingPause,
      onError: (error) => {
        this.setState("error");
        this.emit({ type: "agent:error", instanceId: this.id, error });
      },
      onSettled: () => {
        this._promptDoneResolve?.();
        this._promptDoneResolve = null;
      },
    });

    this.stuckGuard = new StuckGuard({
      instanceId: this.id,
      duplicateContentThreshold: 2,
      getMessages: () => this.agent.state.messages,
      getTurnCount: () => this.turnCount,
      steer: (content) => this.agent.steer({ role: "user", content, timestamp: Date.now() }),
      followUp: (content) =>
        this.agent.followUp({ role: "user", content, timestamp: Date.now() }),
      abort: () => this.agent.abort(),
    });

    // 订阅 pi-agent-core 事件并转换
    this.unsubscribeAgent = this.agent.subscribe((event) => {
      // 更新累积文本
      if (event.type === "message_start") {
        this.accumulatedText = "";
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.accumulatedText += event.assistantMessageEvent.delta;
      }

      // 关键调试：捕获 LLM 错误响应
      if (event.type === "message_end") {
        const msg = (
          event as {
            message?: {
              stopReason?: string;
              errorMessage?: unknown;
              content?: unknown[];
              model?: string;
              api?: string;
              __llmError?: {
                httpStatus?: number;
                code?: string;
                message?: string;
                retryable?: boolean;
              };
            };
          }
        ).message;
        if (msg?.stopReason === "error") {
          const errStr =
            typeof msg.errorMessage === "string"
              ? msg.errorMessage
              : JSON.stringify(msg.errorMessage);
          const llmErr = msg.__llmError;
          console.error(
            `[AgentInstance:${this.id}] LLM ERROR: stopReason=error` +
              `, errorMessage=${errStr}` +
              `, model=${msg.model ?? "unknown"}` +
              `, api=${msg.api ?? "unknown"}` +
              (llmErr
                ? `, httpStatus=${llmErr.httpStatus ?? "N/A"}` +
                  `, errorCode=${llmErr.code ?? "N/A"}` +
                  `, retryable=${llmErr.retryable ?? "N/A"}` +
                  `, llmErrorDetail=${llmErr.message ?? "N/A"}`
                : "") +
              `, content=${JSON.stringify(msg.content)}` +
              `, timestamp=${new Date().toISOString()}`,
          );
        }
      }

      // 更新实例状态
      if (event.type === "agent_start") {
        if (!this.selfHeal.isHealing) {
          this.setState("running");
        }
        this.turnCount = 0;
        this.stuckGuard.reset();
        // 主题2 P0-2：每次 agent 运行重置预算跟踪器
        if (this.tokenBudget !== null) {
          this.budgetTracker = createBudgetTracker();
        }
        this.startTimeoutTimer();
        // 加载热记忆并注入系统提示词（自愈重试时跳过，已注入过）
        if (!this.selfHeal.isHealing) {
          this.memoryIntegration.loadAndInjectMemories();
        }
      }
      if (event.type === "agent_end") {
        // 自愈层：检测可恢复的 LLM 错误并重试
        if (this.selfHeal.attemptSelfHeal()) {
          return; // 正在自愈重试，抑制 agent:end 和状态转换
        }

        this.memoryIntegration.clearInjectedSnapshot();
        this.clearTimeoutTimer();
        // LLM 异步记忆提取（fire-and-forget，不阻塞主流程）
        // 参考 Claude Code extractMemories：在 agent 完成后后台提取
        this.memoryIntegration.extractMemoriesByLLMIfNeeded();
        if (this.endingPause) {
          this.endingPause = false;
          this.setState("paused");
        } else {
          this.setState("idle");
        }
        // 通知 prompt() 整个自愈链已完成
        this._promptDoneResolve?.();
        this._promptDoneResolve = null;
      }

      // maxTurns 检查 + 循环检测：统一在 turn_end 时处理，避免在工具执行中途打断
      if (event.type === "turn_end") {
        this.turnCount++;
        if (this.maxTurns && this.turnCount >= this.maxTurns) {
          console.log(
            `[AgentInstance:${this.id}] maxTurns reached (${this.turnCount}/${this.maxTurns}), aborting`,
          );
          this.abort();
        } else {
          this.stuckGuard.checkAndHandle();
        }
        // 定期执行规则提取记忆
        this.memoryIntegration.extractMemoriesIfNeeded();

        // 主题2 P0-2：token 预算检查与 nudge 注入
        if (this.budgetTracker && this.tokenBudget !== null) {
          const msg = event.message as { usage?: { totalTokens?: number } };
          const totalTokens = msg.usage?.totalTokens ?? 0;
          const decision = checkTokenBudget(
            this.budgetTracker,
            undefined, // 当前实例非子 Agent
            this.tokenBudget,
            totalTokens,
          );
          if (decision.action === "continue") {
            console.log(
              `[AgentInstance:${this.id}] Token budget nudge (${decision.pct}%, ${decision.turnTokens}/${decision.budget})`,
            );
            this.agent.followUp({
              role: "user",
              content: decision.nudgeMessage,
              timestamp: Date.now(),
            });
          } else if (decision.completionEvent) {
            console.log(
              `[AgentInstance:${this.id}] Token budget exhausted: ${decision.completionEvent.pct}% (${decision.completionEvent.turnTokens}/${decision.completionEvent.budget}), ` +
                `diminishing=${decision.completionEvent.diminishingReturns}, continuationCount=${decision.completionEvent.continuationCount}`,
            );
          }
        }
      }

      // 循环检测：在 tool_execution_start 时记录工具名+参数指纹，不做打断
      if (event.type === "tool_execution_start") {
        const toolName = (event as { toolName?: string }).toolName ?? "";
        const args = (event as { args?: unknown }).args;
        this.stuckGuard.recordToolCall(toolName, args);
        this.sessionIndex.record(toolName, args);
      }

      // 转换并发送事件
      const mapped = mapAgentEvent(this.id, event, this.accumulatedText);
      if (mapped) {
        let toEmit = mapped;
        const injectedSnapshot = this.memoryIntegration.injectedSnapshot;
        if (mapped.type === "message:end" && injectedSnapshot.length > 0) {
          toEmit = {
            ...mapped,
            injectedMemories: injectedSnapshot.map((m) => ({
              id: m.id,
              content: m.content,
              category: m.category,
            })),
          };
        }
        if (mapped.type === "agent:end" && this.stuckGuard.consumeLoopInterrupt()) {
          toEmit = { ...mapped, loopInterrupted: true };
        }
        this.invokeLifecycleMapped(toEmit);
        this.emit(toEmit);
      }
    });
  }

  /**
   * 暂停当前运行（保留消息上下文，底层 abort 停止本轮）
   */
  pause(): void {
    if (this._state !== "running") return;
    this.endingPause = true;
    this.agent.abort();
  }

  /**
   * 从 paused 恢复为可接受下一轮 prompt
   */
  resume(): void {
    if (this._state !== "paused") return;
    this.setState("idle");
  }

  /**
   * 发送用户消息，启动 Agent 循环
   *
   * @param message 用户文本（可包含 [media attached] 等标记）
   * @param images 可选多模态图片块（base64 + mimeType），由宿主进程在调用前组装好。
   *   传入时 pi-agent-core 会把图片块拼到 UserMessage.content 数组中，
   *   网关 SSE 透传到 LLM provider 的 vision API（OpenAI/Claude/Gemini 等格式各异，
   *   pi-ai 内部按 provider 转换）。
   */
  async prompt(message: string, images?: ImageContent[], origin: AgentTurnOrigin = "local_ui"): Promise<void> {
    if (this._state === "paused") {
      throw new Error(`Agent is paused; call resume() before prompt (${this.id})`);
    }
    if (this._state === "destroyed") {
      throw new Error(`Agent instance destroyed: ${this.id}`);
    }
    this.selfHeal.reset();
    // 创建一个 Promise，等待整个自愈链完成（agent_end 不再触发自愈时 resolve）
    const done = new Promise<void>((resolve) => {
      this._promptDoneResolve = resolve;
    });
    try {
      // 若注入了 CapabilityRegistry，按 origin 过滤工具列表
      if (this.capabilityRegistry) {
        const allowedIds = new Set(
          this.capabilityRegistry.getForOrigin(origin).map((c) => c.id),
        );
        const filtered = this.agent.state.tools?.filter((t) => allowedIds.has(t.name)) ?? [];
        this.agent.setTools(filtered);
      }
      await this.kernel.startTurn({
        message,
        images: images && images.length > 0 ? images.map(({ data, mimeType }) => ({ data, mimeType })) : undefined,
        origin,
      });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.setState("error");
      this.emit({ type: "agent:error", instanceId: this.id, error: errorMsg });
    }
    // FakeAgentKernel 不触发 agent_end，此处兜底 resolve（PiAgentKernelAdapter 已提前 resolve，此为 no-op）
    if (!this.selfHeal.isHealing) {
      this._promptDoneResolve?.();
      this._promptDoneResolve = null;
    }
    // 等待自愈链完成
    await done;
  }

  /** 中止当前运行 */
  abort(): void {
    this.endingPause = false;
    this.agent.abort();
    this.setState("aborted");
    // 立刻结束 prompt() 等待，避免 SessionManager 会话锁卡住后续 user:send
    this._promptDoneResolve?.();
    this._promptDoneResolve = null;
  }

  /** 订阅事件（UI 侧监听） */
  subscribe(fn: (e: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** 获取当前状态 */
  get state(): AgentInstanceState {
    return this._state;
  }

  /** 获取对话消息历史 */
  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /** 等待 Agent 空闲 */
  async waitForIdle(): Promise<void> {
    return this.agent.waitForIdle();
  }

  /** 更新工具列表 */
  setTools(tools: AgentTool[]): void {
    this.agent.setTools(tools);
  }

  /** 更新系统提示词 */
  setSystemPrompt(prompt: string): void {
    this.agent.setSystemPrompt(prompt);
  }

  /** 读取当前系统提示词（含记忆注入等动态部分，用于上下文用量估算） */
  getSystemPrompt(): string {
    return this.agent.state.systemPrompt ?? "";
  }

  /** 读取当前内存中的对话消息（比 DB 更及时，用于上下文用量估算） */
  getAgentMessages(): AgentMessage[] {
    return this.agent.state.messages ?? [];
  }

  /** 清空消息历史 */
  clearMessages(): void {
    this.agent.clearMessages();
    this.accumulatedText = "";
  }

  // ==================== 消息队列管理 ====================

  /**
   * 用户中途插话（注入 steering queue）
   *
   * Agent 在当前工具执行完成后，在下一轮 LLM 调用前消费 steering queue。
   * 适用于用户中途修改指令或补充信息。
   * 设计文档 §4.1
   */
  steer(message: string | AgentMessage): void {
    const msg: AgentMessage =
      typeof message === "string"
        ? { role: "user", content: message, timestamp: Date.now() }
        : message;
    this.agent.steer(msg);
  }

  /**
   * 注入后续消息（followUp queue）
   *
   * 仅在 Agent 完成当前回合（无更多 tool_use 且无 steering）后消费。
   * 适用于其他 Agent 的协作消息、定时任务触发、Webhook 事件等。
   * 设计文档 §4.2
   */
  followUp(message: string | AgentMessage): void {
    const msg: AgentMessage =
      typeof message === "string"
        ? { role: "user", content: message, timestamp: Date.now() }
        : message;
    this.agent.followUp(msg);
  }

  /**
   * 替换全部消息历史
   *
   * 用于对话恢复、上下文压缩后重建消息等场景。
   * 设计文档 §6.5
   */
  replaceMessages(messages: AgentMessage[]): void {
    this.agent.replaceMessages(messages);
    this.accumulatedText = "";
  }

  /**
   * 更新当前会话的活跃任务列表
   *
   * 宿主在每次 prompt() 前调用，确保压缩摘要能感知最新任务状态。
   */
  updateActiveTasks(
    tasks: readonly { id: string; subject: string; status: string; owner?: string | null }[],
  ): void {
    this._activeTasks = tasks;
  }

  /**
   * 更新记忆注入开关（宿主每轮 prompt 前调用，读取用户设置）
   */
  setMemoryInjectionFlags(flags: { injectWorkMemory?: boolean }): void {
    if (flags.injectWorkMemory !== undefined) {
      this.injectWorkMemory = flags.injectWorkMemory;
    }
  }

  /**
   * 追加单条消息到历史
   *
   * 用于注入中断标记、系统通知等。
   * 设计文档 §4.3
   */
  appendMessage(message: AgentMessage): void {
    this.agent.appendMessage(message);
  }

  /** 清空所有消息队列（steering + followUp） */
  clearAllQueues(): void {
    this.agent.clearAllQueues();
  }

  /** 清空 steering queue */
  clearSteeringQueue(): void {
    this.agent.clearSteeringQueue();
  }

  /** 清空 followUp queue */
  clearFollowUpQueue(): void {
    this.agent.clearFollowUpQueue();
  }

  /** 销毁实例，释放资源 */
  destroy(): void {
    this.clearTimeoutTimer();
    this.selfHeal.dispose();
    this.endingPause = false;
    this.agent.abort();
    this.setState("destroyed");
    this.unsubscribeAgent?.();
    this.unsubscribeAgent = null;
    this.listeners.clear();
  }

  private setState(state: AgentInstanceState): void {
    this._state = state;
    this.emit({ type: "agent:state-change", instanceId: this.id, state });
  }

  private emit(event: AgentRuntimeEvent): void {
    if (event.type === "agent:error") {
      void this.lifecycleHooks?.onError?.(this.id, event.error);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 防止个别 listener 异常影响其他
      }
    }
  }

  /** 根据映射后的事件触发生命周期回调 */
  private invokeLifecycleMapped(mapped: AgentRuntimeEvent): void {
    const h = this.lifecycleHooks;
    if (!h) return;
    if (mapped.type === "agent:start") {
      void h.onStart?.(this.id);
    }
    if (mapped.type === "agent:end") {
      void h.onComplete?.(this.id);
    }
  }

  /** 启动超时定时器（如果 timeoutMs 已配置） */
  private startTimeoutTimer(): void {
    this.clearTimeoutTimer();
    if (this.timeoutMs && this.timeoutMs > 0) {
      this.timeoutHandle = setTimeout(() => {
        if (this._state === "running") {
          console.log(`[AgentInstance:${this.id}] timeout reached (${this.timeoutMs}ms), aborting`);
          this.abort();
          this.emit({
            type: "agent:error",
            instanceId: this.id,
            error: `Timeout after ${this.timeoutMs}ms`,
          });
        }
      }, this.timeoutMs);
    }
  }

  /** 清除超时定时器 */
  private clearTimeoutTimer(): void {
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }
  }
}
