/**
 * 系统提示词装配 — 包装 buildClientSystemPromptStructured
 *
 * 把 apps/windows bridge-instance-factory.ts 行 448-532 的提示词上下文加载、
 * bundledSkills 实例级激活、buildPrompt 闭包构建逻辑抽到 host-kit。
 *
 * skills / customAgents / devices / soul / mcpHints / contextFiles 改为从注入的
 * PromptContextProvider 取，宿主侧来源（DB / 文件 / 配置）由实现决定。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2
 * 计划依据: .qoder/plan/2026-06-26-plan-A-host-kit.md §A5
 */

import type { AgentDefinition } from "../types/agent-definition.js";
import {
  buildClientSystemPromptStructured,
  type SkillInfo,
  type SystemPromptResult,
  type SkillActivationHint,
  type RouterResultLite,
  type WorkspaceLayout,
  type ActiveTaskInfo,
  type PromptDetail,
} from "../prompt/system-prompt-builder.js";
import type { PromptContextProvider } from "./types.js";

/** buildPrompt 闭包签名：每轮可变的 skillActivations / currentModelId / routerResult */
export type SystemPromptBuilder = (
  hints?: readonly SkillActivationHint[],
  currentModelId?: string,
  routerResult?: RouterResultLite,
) => SystemPromptResult;

/** 提示词装配入参 */
export interface AssembleSystemPromptOptions {
  readonly definition: AgentDefinition;
  readonly promptContext: PromptContextProvider;
  /** 工具名（装配后固定，对齐 bridge 用 toolsWithPermission.map） */
  readonly toolNames: readonly string[];
  readonly cwd?: string;
  readonly osInfo?: string;
  /** Agent 默认模型 ID */
  readonly modelId?: string;
  readonly workspaceLayout?: WorkspaceLayout;
  readonly runtimeInfo?: {
    readonly agentId?: string;
    readonly host?: string;
    readonly channel?: string;
    readonly thinkingLevel?: string;
  };
  readonly promptDetail?: PromptDetail;
  readonly includeFullMemoryGuide?: boolean;
  readonly isSubAgent?: boolean;
  /** 活跃任务取值（每轮闭包调用时实时读取，对齐 bridge 行为） */
  readonly getActiveTasks?: () => readonly ActiveTaskInfo[];
}

/** 提示词装配产物 */
export interface AssembledSystemPrompt {
  /** 实例级生效技能（含 bundledSkills 合并去重） */
  readonly effectiveSkills: readonly SkillInfo[];
  /** 本 Agent 声明的 bundledSkills ID（空则 undefined） */
  readonly bundledSkillIds?: readonly string[];
  /** 每轮可重建的提示词构建闭包 */
  readonly buildPrompt: SystemPromptBuilder;
  /** 首次构建结果（buildPrompt() 的等价调用，宿主可直接用作 basePrompt） */
  readonly initial: SystemPromptResult;
}

/**
 * bundledSkills 实例级激活：把 definition 声明的技能强制并入本实例技能集
 * （即使在全局列表中被禁用），并与全局技能去重。Agent = 能力包 模式的核心。
 * 搬自 bridge 行 464-487，行为一致。
 */
function mergeBundledSkills(
  skills: readonly SkillInfo[],
  bundledSkillIds: readonly string[],
): readonly SkillInfo[] {
  if (bundledSkillIds.length === 0) return skills;
  const skillById = new Map(skills.map((s) => [(s.id ?? s.name).trim(), s]));
  const bundled: SkillInfo[] = [];
  for (const id of bundledSkillIds) {
    const found = skillById.get(id.trim());
    if (found) bundled.push(found);
  }
  const seen = new Set<string>();
  return [...bundled, ...skills].filter((s) => {
    const k = (s.id ?? s.name).trim();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 装配系统提示词：并行加载上下文 → bundledSkills 合并 → 返回 buildPrompt 闭包。
 *
 * 返回的 buildPrompt 固定大部分静态参数，仅 skillActivations / currentModelId /
 * routerResult 按轮次可变；宿主可缓存静态部分，每轮仅重建动态部分。
 */
export async function assembleSystemPrompt(
  opts: AssembleSystemPromptOptions,
): Promise<AssembledSystemPrompt> {
  const def = opts.definition;
  const pc = opts.promptContext;

  const [skills, customAgents, userDevices, soulSnapshot] = await Promise.all([
    pc.getSkills(),
    pc.getCustomAgents(),
    pc.getUserDevices(),
    pc.getSoulContent(),
  ]);

  const contextFiles = pc.getContextFiles();
  const mcpServerHints = pc.getMcpServerHints();

  const bundledSkillIds = def.bundledSkills ?? [];
  const effectiveSkills = mergeBundledSkills(skills, bundledSkillIds);

  /** 每轮取最新 soul：优先 live getter（家长改记忆等），否则用装配时快照。 */
  const resolveSoul = (): string | undefined =>
    pc.getSoulContentLive ? pc.getSoulContentLive() : soulSnapshot;

  const buildPrompt: SystemPromptBuilder = (hints = [], currentModelId, routerResult) =>
    buildClientSystemPromptStructured({
      agentDefinition: def,
      toolNames: opts.toolNames,
      cwd: opts.cwd,
      osInfo: opts.osInfo,
      modelId: opts.modelId,
      currentModelId,
      skills: effectiveSkills,
      customAgents,
      bundledSkillIds: bundledSkillIds.length > 0 ? bundledSkillIds : undefined,
      workspaceLayout: opts.workspaceLayout,
      runtimeInfo: opts.runtimeInfo,
      contextFiles,
      userDevices,
      soulContent: resolveSoul(),
      mcpServerHints,
      activeTasks: opts.getActiveTasks?.(),
      promptDetail: opts.promptDetail,
      includeFullMemoryGuide: opts.includeFullMemoryGuide ?? false,
      isSubAgent: opts.isSubAgent,
      skillActivations: hints.length > 0 ? hints : undefined,
      routerResult,
    });

  return {
    effectiveSkills,
    bundledSkillIds: bundledSkillIds.length > 0 ? bundledSkillIds : undefined,
    buildPrompt,
    initial: buildPrompt(),
  };
}
