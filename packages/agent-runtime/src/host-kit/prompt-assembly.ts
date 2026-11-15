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
  type PromptStyle,
} from "../prompt/system-prompt-builder.js";
import type { PromptContextProvider } from "./types.js";

/** buildPrompt 闭包签名：每轮可变的 skillActivations / currentModelId / routerResult / promptStyle */
export type SystemPromptBuilder = (
  hints?: readonly SkillActivationHint[],
  currentModelId?: string,
  routerResult?: RouterResultLite,
  promptStyle?: PromptStyle,
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
  readonly promptStyle?: PromptStyle;
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
 * `definition.skills`（UI 上的「专属技能」）实例级**收敛**：非空 = 只保留这些。
 *
 * 为什么必须有它：`bundledSkills` 只能**加**（强制并入），加不加都得先看全量列表。
 * 用户勾了「这个 Agent 只用这几招」却仍能在 `skill_search` 里搜到全部技能，
 * 等于勾选框没有作用——Agent 越配越多，每个都拿到同一份长列表。
 *
 * 匹配 name 或 id：UI 存的是 `skill.name`，而索引里的 id 是「分类/技能名」，
 * 两者都可能被写进 filter，只认一个会让另一批静默失效。
 */
function restrictSkillsToAgent(
  skills: readonly SkillInfo[],
  filter: readonly string[] | undefined,
): readonly SkillInfo[] {
  const wanted = (filter ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) return skills;
  const allow = new Set(wanted);
  return skills.filter(
    (s) => allow.has(s.name.trim().toLowerCase()) || allow.has((s.id ?? "").trim().toLowerCase()),
  );
}

/** 按 id 从候选里挑出命中的技能（bundled 走这条，不参与收敛） */
function pickSkillsByIds(
  skills: readonly SkillInfo[],
  ids: readonly string[],
): readonly SkillInfo[] {
  if (ids.length === 0) return [];
  const byId = new Map(skills.map((s) => [(s.id ?? s.name).trim(), s]));
  const out: SkillInfo[] = [];
  for (const id of ids) {
    const found = byId.get(id.trim());
    if (found) out.push(found);
  }
  return out;
}

/**
 * bundledSkills 实例级激活：把已挑出的 bundled 放到最前，并与其余技能去重。
 * Agent = 能力包 模式的核心（bundled 提前 → 提示词里优先展示）。
 */
function mergeBundledSkills(
  skills: readonly SkillInfo[],
  bundled: readonly SkillInfo[],
): readonly SkillInfo[] {
  if (bundled.length === 0) return skills;
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
  // 流水线摘要：与 mcpServerHints 一样是装配时快照（插件 wire 后才有；无则不注入）
  const pipelineHints = pc.getPipelineHints?.() ?? [];

  const bundledSkillIds = def.bundledSkills ?? [];
  // bundled 从**全量**取，不从收敛结果取：它是显式的强制激活，不该被同一份定义里的
  // 专属技能列表裁掉（否则两边都勾了，技能会静默消失）。
  const bundledSkills = pickSkillsByIds(skills, bundledSkillIds);
  const effectiveSkills = mergeBundledSkills(
    restrictSkillsToAgent(skills, def.skills),
    bundledSkills,
  );

  /** 每轮取最新 soul：优先 live getter（家长改记忆等），否则用装配时快照。 */
  const resolveSoul = (): string | undefined =>
    pc.getSoulContentLive ? pc.getSoulContentLive() : soulSnapshot;

  const buildPrompt: SystemPromptBuilder = (hints = [], currentModelId, routerResult, promptStyle) =>
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
      pipelineHints,
      activeTasks: opts.getActiveTasks?.(),
      // 每轮传入的风格优先；缺省回退创建时快照
      promptStyle: promptStyle ?? opts.promptStyle,
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
