/**
 * MemoryIntegration — AgentInstance 的记忆系统集成接线
 *
 * 从 AgentInstance 迁出热记忆注入与记忆候选提取逻辑（S9 R6-2）。
 * 底层实现仍在 MemoryManager；本模块只负责"何时注入/提取、从消息里取什么文本"
 * 的接线，AgentInstance 通过窄接口注入 agent 状态访问能力，避免直接耦合 pi-agent-core。
 */

import type { MemoryManager } from "../memory/manager.js";
import type { MemoryEntry } from "../memory/types.js";
import type { AgentDefinition } from "../types/agent-definition.js";
import { hasMemoryTrigger } from "../memory/memory-extractor.js";

/** 记忆集成所需的最小 agent 状态访问能力（避免依赖 pi-agent-core 具体类型） */
export interface AgentStateAccessor {
  /** 当前对话消息（结构未知，按 role/content 鸭子类型读取） */
  readonly messages: readonly unknown[];
  /** 当前系统提示词 */
  readonly systemPrompt: string;
  /** 覆盖系统提示词（注入热记忆用） */
  setSystemPrompt(prompt: string): void;
}

export interface MemoryIntegrationDeps {
  readonly instanceId: string;
  readonly definitionId: string;
  readonly memoryManager: MemoryManager | undefined;
  readonly userId: string | undefined;
  readonly memoryConfig: AgentDefinition["memory"];
  readonly memoryExtractEvery: number;
  /** 动态读取 agent 状态（每次调用取最新） */
  readonly getAgent: () => AgentStateAccessor;
  /** 动态读取当前 turn 计数 */
  readonly getTurnCount: () => number;
  /** 是否注入工作记忆（宿主可动态关闭） */
  readonly getInjectWorkMemory: () => boolean;
}

/** 从单条消息提取纯文本（string 或 content block 数组） */
function messageToText(msg: unknown): string {
  if (typeof msg !== "object" || msg === null || !("role" in msg)) return "";
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    let text = "";
    for (const block of content) {
      if (typeof block === "object" && block !== null && "text" in block) {
        text += (block as { text: string }).text + " ";
      }
    }
    return text.trim();
  }
  return "";
}

function messageRole(msg: unknown): string | null {
  if (typeof msg !== "object" || msg === null || !("role" in msg)) return null;
  return (msg as { role: string }).role;
}

export class MemoryIntegration {
  private readonly deps: MemoryIntegrationDeps;
  /** 本轮已注入的热记忆快照（随 message:end 带给 UI） */
  private _injectedSnapshot: readonly MemoryEntry[] = [];

  constructor(deps: MemoryIntegrationDeps) {
    this.deps = deps;
  }

  /** 本轮注入的热记忆快照 */
  get injectedSnapshot(): readonly MemoryEntry[] {
    return this._injectedSnapshot;
  }

  /** 清空注入快照（agent_end 时调用） */
  clearInjectedSnapshot(): void {
    this._injectedSnapshot = [];
  }

  /** 加载热记忆并注入到系统提示词 */
  loadAndInjectMemories(): void {
    const { memoryManager, userId, memoryConfig, definitionId, instanceId } = this.deps;
    if (!memoryManager || !userId) return;
    if (memoryConfig?.scope === "none") return;
    if (!this.deps.getInjectWorkMemory()) return;

    try {
      const agent = this.deps.getAgent();
      const currentPrompt = agent.systemPrompt ?? "";
      // 用当前用户消息作 query，做相关性召回（S9）
      const query = this.pickLatestUserText() ?? undefined;
      const { updatedPrompt, injected } = memoryManager.injectIntoSystemPrompt(
        currentPrompt,
        definitionId,
        userId,
        undefined,
        query,
      );
      this._injectedSnapshot = injected;
      if (injected.length > 0) {
        agent.setSystemPrompt(updatedPrompt);
        console.log(`[AgentInstance:${instanceId}] 注入 ${injected.length} 条热记忆到系统提示词`);
      } else {
        this._injectedSnapshot = [];
      }
    } catch (err) {
      console.error(`[AgentInstance:${instanceId}] 加载热记忆失败:`, err);
    }
  }

  /**
   * 从 agent 消息历史中取"最后一条用户消息"的纯文本。
   * 用于记忆触发关键词的快速判定。
   */
  private pickLatestUserText(): string | null {
    const messages = this.deps.getAgent().messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (messageRole(msg) !== "user") continue;
      const text = messageToText(msg);
      return text.length > 0 ? text : null;
    }
    return null;
  }

  /**
   * 定期从用户消息中提取记忆候选并保存
   *
   * 使用零成本的规则提取（extractByRules），每 N 轮执行一次。
   * 仅当 memory.autoExtract 为 true 时启用。
   */
  extractMemoriesIfNeeded(): void {
    const { memoryManager, userId, memoryConfig, definitionId, instanceId, memoryExtractEvery } =
      this.deps;
    if (!memoryManager || !userId) {
      console.log(
        `[AgentInstance:${instanceId}] 记忆提取跳过: memoryManager=${!!memoryManager}, userId=${userId}`,
      );
      return;
    }
    // autoExtract 默认为 true（当 memoryManager 存在时），只有显式设为 false 才跳过
    if (memoryConfig?.autoExtract === false) return;
    if (memoryConfig?.scope === "none") return;

    // —— 关键词触发优先：若最新用户消息中含"请记住/remember this"等明确触发词，
    //    则跳过 extractEvery 节流，立刻让 LLM 做结构化提取（类 Qoder 体验）。
    const latestUserText = this.pickLatestUserText();
    if (latestUserText && hasMemoryTrigger(latestUserText)) {
      console.log(`[AgentInstance:${instanceId}] 检测到记忆触发关键词，立即 LLM 提取`);
      this.extractMemoriesByLLMIfNeeded(true);
      return;
    }

    if (this.deps.getTurnCount() % memoryExtractEvery !== 0) {
      console.log(
        `[AgentInstance:${instanceId}] 记忆提取跳过: turnCount=${this.deps.getTurnCount()}, extractEvery=${memoryExtractEvery}`,
      );
      return;
    }

    try {
      // 从最近的消息中提取用户消息文本
      const recentMessages = this.deps.getAgent().messages;
      const userTexts: string[] = [];
      for (const msg of recentMessages) {
        if (messageRole(msg) !== "user") continue;
        const content = (msg as { content?: unknown }).content;
        if (typeof content === "string") {
          userTexts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "text" in block) {
              userTexts.push((block as { text: string }).text);
            }
          }
        }
      }

      if (userTexts.length === 0) return;

      const saved = memoryManager.saveRuleExtractedCandidates(userTexts, definitionId, userId);
      if (saved === 0) return;
      console.log(`[AgentInstance:${instanceId}] 规则提取了 ${saved} 条记忆候选`);
    } catch (err) {
      console.error(`[AgentInstance:${instanceId}] 记忆提取失败:`, err);
    }
  }

  /**
   * LLM 辅助记忆提取（异步，fire-and-forget）
   *
   * 参考 Claude Code extractMemories 的 forked agent 模式：
   * - 在 Agent 完成一轮对话后后台异步调用
   * - 不阻塞主流程，失败静默处理
   * - 仅当 memoryConfig.autoExtract 启用且 MemoryManager 有 callLLM 回调时执行
   *
   * @param force 为 true 时跳过 extractEvery 节流（用于"请记住"等关键词触发的即时提取）；
   *   默认 false：仅当 turnCount 是 extractEvery 的整数倍时才执行，避免每轮对话都调用 LLM。
   */
  extractMemoriesByLLMIfNeeded(force = false): void {
    const { memoryManager, userId, memoryConfig, definitionId, instanceId, memoryExtractEvery } =
      this.deps;
    if (!memoryManager || !userId) return;
    if (memoryConfig?.autoExtract === false) return;
    if (memoryConfig?.scope === "none") return;

    // 周期调用（agent_end）受 extractEvery 节流；关键词触发（force）不受限。
    if (!force) {
      const turnCount = this.deps.getTurnCount();
      if (turnCount === 0 || turnCount % memoryExtractEvery !== 0) {
        return;
      }
    }

    // 从最近消息中提取 user + assistant 的文本对（LLM 提取需要完整对话上下文）
    const recentMessages: { role: string; content: string }[] = [];
    const allMessages = this.deps.getAgent().messages;
    // 只取最近 20 条消息（避免上下文过大）
    const startIdx = Math.max(0, allMessages.length - 20);
    for (let i = startIdx; i < allMessages.length; i++) {
      const msg = allMessages[i];
      const role = messageRole(msg);
      if (role !== "user" && role !== "assistant") continue;
      const text = messageToText(msg);
      if (text.length > 0) {
        recentMessages.push({ role, content: text });
      }
    }

    if (recentMessages.length === 0) return;

    // fire-and-forget：异步调用，不阻塞 agent_end 处理
    void memoryManager
      .saveLLMExtractedCandidates(recentMessages, definitionId, userId)
      .then((saved) => {
        if (saved > 0) {
          console.log(`[AgentInstance:${instanceId}] LLM 提取了 ${saved} 条记忆候选`);
        }
      })
      .catch((err) => {
        console.error(`[AgentInstance:${instanceId}] LLM 记忆提取失败:`, err);
      });
  }
}
