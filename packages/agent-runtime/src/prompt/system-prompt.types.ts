/**
 * 系统提示词构建器类型定义
 *
 * 从 system-prompt-builder.ts 提取，避免巨型单体文件。
 */

import type { AgentDefinition } from "../types/agent-definition.js"

/** 技能描述（用于注入系统提示词） */
export interface SkillInfo {
  /** 技能名称 */
  readonly name: string
  /** 技能描述 */
  readonly description: string
  /** SKILL.md 位置（本地路径或虚拟路径） */
  readonly location: string

  // --- v12 扩展：对齐 CCR `frontmatter` when_to_use + paths ---

  /** 何时应考虑本技能（短句 + 可含触发短语，对应 frontmatter `when_to_use`） */
  readonly whenToUse?: string
  /**
   * 路径 glob 列表（相对于 workspace 根）；任一匹配则视为「路径触发」
   * 例: ["src/gateway/**\/*.ts", "skills/issue-manager/**"]
   */
  readonly pathGlobs?: readonly string[]
  /** 激活优先级：mandatory > suggested > background（默认 background） */
  readonly activationTier?: "mandatory" | "suggested" | "background"

  // --- v13 扩展：executable 技能支持 ---

  /**
   * 技能 ID（目录名），execute_skill 工具所需的 id 参数。
   * instruction-only 技能无此字段时 LLM 应读取 SKILL.md 按文档操作。
   */
  readonly id?: string
  /**
   * 是否为 executable 技能（有 run.ts / run.py / run.sh 等可执行入口）。
   * true 时 LLM 应通过 execute_skill 工具调用，而非手动解读文档。
   */
  readonly executable?: boolean

  // --- v14 扩展：技能分层加载 ---

  /**
   * 技能激活范围分层（对应 SKILL.md frontmatter `activation_scope`）：
   * - always：始终激活，每轮对话自动注入为 mandatory hint（适合核心工作流技能）
   * - contextual：按上下文激活（默认），基于 intent_match / path_glob 触发（多数技能）
   * - on_demand：仅响应用户显式调用 /skill 或 @skill，不参与自动匹配（降噪用）
   *
   * 未设置时等价于 "contextual"。
   */
  readonly activationScope?: "always" | "contextual" | "on_demand"

  // --- v15 扩展：使用频率排序 ---

  /**
   * 技能使用次数（由调用方填入，用于系统提示词按频率排序展示）。
   * 未提供时视为 0，按原始顺序展示。
   */
  readonly usageCount?: number
}

/**
 * 技能激活提示（宿主侧 ActivationResolver 计算后注入系统提示词动态部分）
 *
 * 参考 CCR `SkillTool/prompt.ts` 的 `whenToUse` 注入模式，
 * 但进一步结构化为可观测字段，避免纯自然语言不可解析。
 */
export interface SkillActivationHint {
  readonly skillName: string
  /** 激活分层：mandatory（MUST）/ suggested（可考虑） */
  readonly tier: "mandatory" | "suggested"
  /** 激活原因（对齐 CCR hooks load_reason 语义） */
  readonly reason: "path_glob" | "intent_match" | "user_explicit" | "rule"
  /** 详情（单行，≤120 字符） */
  readonly detail?: string
}

/** 自定义 Agent 描述（用于注入系统提示词的多 Agent 协作 section） */
export interface CustomAgentInfo {
  /** Agent ID */
  readonly id: string
  /** 显示名称 */
  readonly name: string
  /** Agent 描述 */
  readonly description?: string

  // ─── Pre-LLM Router 路由信号（v2 优化，传给 Router 提升准确率） ───
  /** 何时使用该 Agent（用户视角） */
  readonly whenToUse?: string
  /** 用户原话触发例子 */
  readonly triggerExamples?: readonly string[]
  /** 启动该 Agent 时自动激活的技能 ID 列表 */
  readonly bundledSkills?: readonly string[]
  /** UI 展示分类 */
  readonly category?: string
  /** UI 展示 emoji */
  readonly emoji?: string
}

/** Workspace 子目录布局配置 */
export interface WorkspaceLayout {
  /** 上传目录（默认 "uploads"） */
  readonly uploadsDir?: string
  /** 输出目录（默认 "outputs"） */
  readonly outputsDir?: string
  /** 用户文件目录（默认 "files"） */
  readonly filesDir?: string
}

/** 项目上下文文件（如 BOOTSTRAP.md） */
export interface ContextFile {
  /** 文件路径（相对于 workspace） */
  readonly path: string
  /** 文件内容 */
  readonly content: string
}

/** 用户设备信息（对齐网关 UserDevice） */
export interface UserDeviceInfo {
  /** 设备节点 ID */
  readonly nodeId: string
  /** 显示名称 */
  readonly displayName?: string
  /** 操作系统平台（如 "win32 10.0.22621"） */
  readonly platform?: string
  /** 是否为主设备 */
  readonly isPrimary: boolean
  /** 是否在线 */
  readonly connected: boolean
}

/** 单个 MCP 工具的名称与描述 */
export interface McpToolInfo {
  /** 工具全名（含 mcp__server__ 前缀） */
  readonly name: string
  /** 工具自带的说明（来自 MCP Server 元数据） */
  readonly description?: string
}

/** MCP Server 提示词描述 */
export interface McpServerHint {
  /** MCP Server 名称 */
  readonly name: string
  /** 提供的工具（名称 + 描述） */
  readonly tools: readonly McpToolInfo[]
  /** 可选的使用说明 */
  readonly instructions?: string
}

/** 当前活跃任务信息（注入系统提示词动态部分，防止目标偏移） */
export interface ActiveTaskInfo {
  /** 任务 ID */
  readonly id: string
  /** 任务标题 */
  readonly subject: string
  /** 任务状态 */
  readonly status: string
  /** 任务负责人 */
  readonly owner?: string | null
  /** 任务作用域：session=当前会话 todo，ticket=跨会话工单 */
  readonly scope?: "session" | "ticket"
}

/**
 * 系统提示词构建结果（支持 prompt caching）
 *
 * 静态部分在实例生命周期内不变（Identity/Tooling/Skills/Safety 等），
 * 动态部分每轮可能变化（Memory/Active Tasks/Runtime/User Devices 等）。
 * Anthropic API 的 prompt caching 可缓存 CACHE_BOUNDARY 之前的静态前缀。
 */
export interface SystemPromptResult {
  /** 静态部分（跨轮次不变） */
  readonly staticPrompt: string
  /** 动态部分（每轮可能变化） */
  readonly dynamicPrompt: string
  /** 完整提示词 = staticPrompt + CACHE_BOUNDARY + dynamicPrompt */
  readonly fullPrompt: string
}

/** 缓存断点标记（分隔静态/动态部分） */
export const CACHE_BOUNDARY_MARKER = "\n<!-- CACHE_BOUNDARY -->\n"

/**
 * 上下文计量用的分区标签名。
 *
 * 宿主按这些标签精确切分系统提示词、统计各分类 token 占用。此前靠 `## 标题`
 * 文本做正则匹配，标题一改（如英文化）归类就静默失效，某个分类直接归零。
 * 标签把「归类」与「标题文案」解耦：标题随便改，归类只认标签。
 *
 * 未被标签包裹的内容一律归入 systemPrompt，因此只需包裹需要单独计量的分区。
 */
export const PROMPT_SECTION_TAGS = [
  "tooling",
  "skills",
  "mcp_servers",
  "subagents",
  "memory",
] as const

export type PromptSectionTag = (typeof PROMPT_SECTION_TAGS)[number]

/** 提示词详度控制（根据模型能力自动选择） */
export type PromptDetail = "compact" | "standard" | "full"

export interface ClientSystemPromptParams {
  /** Agent 定义（含系统提示词和描述） */
  readonly agentDefinition: AgentDefinition
  /** 已注册的工具名称列表 */
  readonly toolNames: readonly string[]
  /** 当前工作目录 */
  readonly cwd?: string
  /** 操作系统信息（如 "win32 x64"） */
  readonly osInfo?: string
  /** 模型 ID（如 "claude-sonnet-4-20250514"） */
  readonly modelId?: string
  /** 已启用的技能列表（用于生成 Skills section） */
  readonly skills?: readonly SkillInfo[]
  /** 可用的自定义 Agent 列表（用于生成多 Agent 协作 section） */
  readonly customAgents?: readonly CustomAgentInfo[]

  // === Phase 1: 对齐网关 ===

  /** Workspace 子目录结构配置 */
  readonly workspaceLayout?: WorkspaceLayout
  /** 详细运行时信息（对齐网关 runtimeInfo） */
  readonly runtimeInfo?: {
    readonly agentId?: string
    readonly host?: string
    readonly channel?: string
    readonly thinkingLevel?: string
  }
  /** 用户记忆内容（Markdown 格式，注入 "About the User" section） */
  readonly userMemoryContent?: string
  /** 项目上下文文件列表（对齐网关 contextFiles） */
  readonly contextFiles?: readonly ContextFile[]

  // === Phase 3: 完善与一致性 ===

  /** 用户设备列表（注入 "User Devices" section） */
  readonly userDevices?: readonly UserDeviceInfo[]
  /** 用户 SOUL 内容（人格/风格/边界，来自数据库，替代 DEFAULT_IDENTITY） */
  readonly soulContent?: string

  // === MCP 支持 ===

  /** MCP Server 提示词提示（工具归属与使用说明） */
  readonly mcpServerHints?: readonly McpServerHint[]

  // === 系统提示词优化 ===

  /** 当前活跃任务列表（注入动态部分，防止目标偏移） */
  readonly activeTasks?: readonly ActiveTaskInfo[]

  /**
   * 提示词详度控制（根据模型 tier 自动选择）
   * - compact: 精简版，适合 basic tier 小模型（节省 ~30% token）
   * - standard: 标准版（默认，当前行为）
   * - full: 完整版，适合 performance tier 大模型
   */
  readonly promptDetail?: PromptDetail

  /**
   * 是否注入完整记忆管理指南（默认 false）
   * false → 仅注入 3 行摘要（节省 ~700 tokens）
   * true → 注入完整 4 类记忆说明 + 保存规则 + 验证原则
   * 宿主层在检测到首次 memory_search/profile_memory 调用后设为 true
   */
  readonly includeFullMemoryGuide?: boolean

  /**
   * 是否为子 Agent（由父 Agent spawn_agent 创建）
   * true 时：跳过 Agent 协作目录，注入"禁止再次委派"约束（R1 缓解）
   * 由 bridge 层在 createChildInstance 时传入： isSubAgent: !!parentInstanceId
   */
  readonly isSubAgent?: boolean

  /**
   * 当前实际使用的模型 ID（每轮动态覆盖 modelId）
   * 用于用户切换模型后，Runtime section 能立即反映最新模型。
   * 若未传入，回退到 modelId。
   */
  readonly currentModelId?: string

  /**
   * 本轮技能激活提示（由宿主 ActivationResolver 计算）
   *
   * 参考 CCR：`src/tools/SkillTool/prompt.ts` 将 description + whenToUse 拼接注入
   * 若未命中任何技能，宿主可省略或传入空数组（本函数对空数组不输出任何 section）
   */
  readonly skillActivations?: readonly SkillActivationHint[]

  /**
   * Pre-LLM Router 决策结果（可选，由宿主在每轮入口调用 Router 后注入）。
   *
   * 注入后：
   * - 仅向主 LLM 展示 routerResult.topSkills / topAgents 对应的能力子集
   *   （能力相关 token 节省 ~80%）
   * - 末尾追加一段简短 "Routing rationale" 段，主 LLM 仍可 override
   *
   * 当 routerResult.fallback !== "none" 或 confidence < 0.6 时，本字段被忽略
   * 走旧路径（展示完整 skills/customAgents 清单），保证不阻断主流程。
   *
   * 详见 .qoder/design/Agent-Skill编排优化/02-技术设计.md §3.1
   */
  readonly routerResult?: RouterResultLite

  /**
   * 当前 Agent 的 bundledSkills ID 列表（v2 Router 集成）。
   * 若提供，将在主 prompt 顶部插入 "Your bundled capabilities" 段，
   * 让 LLM 知道这些技能已经为本会话预装，不必通过 skill_search 查找。
   */
  readonly bundledSkillIds?: readonly string[]
}

/**
 * 主 Prompt builder 不直接依赖 windows 端的 RouterResult 类型，
 * 此处定义只读子集，仅取过滤所需字段。
 */
export interface RouterResultLite {
  readonly confidence: number
  readonly fallback: "timeout" | "parse_error" | "llm_error" | "none"
  readonly intent?: string
  readonly topAgents: ReadonlyArray<{ readonly id: string; readonly score: number; readonly reason: string }>
  readonly topSkills: ReadonlyArray<{ readonly id: string; readonly score: number; readonly reason: string }>
  /** Router 是否建议向用户澄清（confidence 较低或多义） */
  readonly needsClarification?: boolean
  /** Router 建议的澄清问题（用于 prompt 中提示主 LLM 主动反问） */
  readonly clarifyQuestion?: string
  /** Router 建议的澄清选项（≤ 4 个，中文） */
  readonly clarifyOptions?: ReadonlyArray<string>
}
