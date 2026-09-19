/**
 * MtBotTool 接口 — 扩展 pi-agent-core 的 AgentTool
 *
 * 在 AgentTool 基础上增加分类、权限和可用性控制，
 * 用于客户端 Agent Runtime 的工具注册与管理。
 */

import type {
  AgentTool,
  AgentToolResult,
  AgentToolUpdateCallback,
} from "@mariozechner/pi-agent-core";
import type { TSchema, Static } from "@sinclair/typebox";
import type { SkillInfo } from "../prompt/system-prompt-builder.js";

/** 工具分类 */
export type ToolCategory = "filesystem" | "shell" | "web" | "memory" | "agent" | "channel";

/**
 * 工具结果的失败语义契约（2026-09-18 立）
 *
 * `AgentToolResult` 本身**没有** `isError` 字段（pi-agent-core 只认 throw）。
 * 本类型把它显式化，使工具实现、ToolRunner、ToolRegistry 三处对失败的理解一致。
 *
 * **1. 工具失败必须在顶层产出 `isError: true`。**
 * - `details.success: false` / `details.isError` **都不是失败信号**——
 *   `tool-runner.ts` 只读顶层（`Boolean(result.isError)`），它们仅作结构化归因。
 * - 生效链路：顶层 isError → `tool-registry.ts` 转成 throw →
 *   pi-agent-core 组装为 `is_error: true` 发给模型。**这才是模型唯一能看到的失败信号。**
 *
 * **2. `isError: true` 的副作用：`details` 会被清空。**
 * pi-agent-core 捕获 throw 后重建 result（agent-loop.js）：
 * `{ content: [错误文本], details: {} }`。所以**模型需要的信息必须写在 `content` 里**，
 * 放进 details 等于丢弃。反过来，无消费方的 details 字段（如 `success: false`）丢了也无妨。
 *
 * **3. 「非理想结局」不等于失败**——以下三类**刻意**保持 `isError: false`，不得"统一"掉：
 * - a. 云同步超时（`resolve_sync_conflict` 等）：后台仍在跑，标失败会让 Agent
 *   重新决策、重排一轮落决。2026-09-17 T3.4 已定案。
 *   依据 `docs/design/数据同步功能/2026-09-17-云同步异步化与分级传输设计.md` §2.3
 * - b. 搜索类工具的零结果（`web_search` 的 `provider='none'`）：零结果不是故障，
 *   标错会污染失败率。依据 `docs/plans/专项Agent/12a-详细实施方案.md:451`
 * - c. 语义性非零退出（`grep` 未匹配、`diff` 有差异）：命令本身执行成功。
 * - d. 用户意志造成的未完成（`ask_user_question` 的 `cancelled`/`declined`）：
 *   问题已经问出去了，工具完成了它的工作，是用户选择不答。
 * - e. 行为纠正而非失败（`file_read` 的重复读取去重提示、`blocked: true`）：
 *   标失败会让模型以为工具坏了，反而去换工具重试——正是它要防止的行为。
 * - f. 写后回读校验未通过（`file_write`/`file_edit` 的 `verified: false`）：
 *   写入调用本身没有失败，且无法区分"真写坏了"与"回读环节出问题"；
 *   标失败会诱导模型重写一遍，可能造成重复内容的**实际损害**。
 *   文案已经给了正确指引（"please re-read to confirm"），够了。
 *
 * 与 a~e 相对：**能力缺失**要标失败（`ask_user_question` 的 `not_implemented`、
 * `skill_*` 的 "Skills not available"）。前者是"用户/环境的选择"，后者是"这条路真的走不通"——
 * 不标的话模型会以为得到了有效结果，继续按自己的假设往下走。
 *
 * **4. 失败必须可归因**：`content` 要写清「为什么失败 + 下一步怎么办」——
 * 错误文本是写给模型读的，`web-fetch-tool.ts` 是正面范例。
 *
 * **5. 类型系统只在显式标注返回类型时检查本契约**（2026-09-18 实测）：
 * `execute: async () => ({...})` 这种不标注返回类型的写法**不会**触发多余属性检查，
 * 拼错 `isEror` 也不报错。因此「失败分支漏标 isError」靠类型抓不住，
 * 由 `tools/__tests__/failure-semantics-guard.test.ts` 的登记表守卫兜底。
 */
export interface MtBotToolResult<TDetails = unknown> extends AgentToolResult<TDetails> {
  /** 失败信号——唯一被 ToolRunner / ToolRegistry / pi-agent-core 识别的失败标记 */
  isError?: boolean;
}

/**
 * MtBot 工具接口
 *
 * extends AgentTool<T> — 已有 name, label, description, parameters, execute
 */
export interface MtBotTool<T extends TSchema = TSchema, TDetails = unknown> extends AgentTool<
  T,
  TDetails
> {
  /**
   * 覆盖 AgentTool.execute 的返回类型为 {@link MtBotToolResult}。
   *
   * 与基类兼容（返回类型协变），但让工具实现能在 `isError` 上获得类型提示与检查。
   */
  execute: (
    toolCallId: string,
    params: Static<T>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<MtBotToolResult<TDetails>>;
  /** 工具分类 */
  readonly category: ToolCategory;
  /** 是否只读操作（只读工具不需要用户权限确认） */
  readonly isReadOnly: boolean;
  /** 是否需要用户确认后才能执行 */
  readonly needsPermission: boolean;
  /** 工具是否在当前环境可用 */
  isEnabled: () => boolean;
}

/**
 * 工具执行上下文 — 由平台层 (Windows/macOS) 注入
 *
 * 工具通过此接口访问本地文件系统、Shell 等平台能力。
 * Phase 1 中工具实现为 stub，实际执行逻辑由平台集成层提供。
 */
export interface ToolExecutionContext {
  /** 当前执行工具的 Agent 实例 ID（用于 send_message/spawn_agent 等需要知道调用者的场景） */
  instanceId?: string;

  /** 执行 shell 命令 */
  executeCommand: (
    command: string,
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      shell?: string;
      signal?: AbortSignal;
    },
  ) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

  /** 读取文件内容 */
  readFile: (
    filePath: string,
    opts?: {
      offset?: number;
      limit?: number;
    },
  ) => Promise<string>;

  /** 写入文件内容 */
  writeFile: (filePath: string, content: string) => Promise<void>;

  /** 文件模式匹配查找 */
  glob: (
    pattern: string,
    opts?: {
      cwd?: string;
    },
  ) => Promise<string[]>;

  /** 内容正则搜索 */
  grep: (
    pattern: string,
    opts?: {
      path?: string;
      glob?: string;
      maxResults?: number;
    },
  ) => Promise<Array<{ file: string; line: number; content: string }>>;

  /** HTTP 请求 */
  fetch: (url: string, opts?: RequestInit) => Promise<{ status: number; body: string }>;

  /** 获取当前工作目录 */
  getCwd: () => string;

  /**
   * 获取 workspace 之外额外允许访问的根目录（可选，由宿主注入）。
   *
   * Windows 宿主用它把用户在本机注册的项目目录（`codingDevProjects`）纳入文件工具
   * 的允许范围，使主助手与 pi 兜底 Agent 无需绕道 bash 即可读改项目文件。
   *
   * 未注入或返回空数组 = 仅 workspace 单根（与历史行为一致）。
   * 注意：ACP 路径（灵栖开发走 CLI 子进程）不经过此处，其文件访问由 CLI 自行管理。
   */
  getAllowedRoots?: () => readonly string[];

  /**
   * 获取当前 Agent 可用的技能列表（由宿主 bridge 注入）
   * 未注入时 skill_* 工具降级为"无技能可用"
   */
  getSkills?: () => readonly SkillInfo[];

  /**
   * 可选能力：向用户发起结构化提问（ask_user_question 工具入口）
   *
   * 当平台层未注入时，ask_user_question 工具将返回 `status=not_implemented` 文本；
   * 平台层（Electron 主进程）应通过 IPC 往返实现此接口。
   *
   * 对齐 claude-code-rev/src/tools/AskUserQuestionTool 实现。
   */
  askUserQuestion?: (input: AskUserQuestionContextInput) => Promise<AskUserQuestionContextResult>;

  /**
   * 可选能力：执行本地已安装的 executable 技能
   *
   * 由平台层（Electron 主进程）注入，直接调用 ClientSkillRuntime.executeSkill()。
   * 仅对有 run.ts / run.py 等可执行入口的技能有意义。
   */
  executeSkill?: (
    skillId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
    executionTimeMs: number;
  }>;

  /**
   * 可选能力：skill_invoke 工具加载某技能成功（读出 SKILL.md）后触发，
   * 用于宿主层累计技能执行次数（写入 skillStore 的 executionCount / lastExecutedAt）。
   * 平台层未注入时 skill_invoke 静默跳过，不影响正常运行。
   */
  recordSkillExecution?: (skillIdOrName: string) => Promise<void> | void;
}

/**
 * ask_user_question 主进程入口参数
 *
 * 保持 schema 与工具入参一致（1-4 问题、2-4 选项、multiSelect），
 * 并附带 toolCallId 作为 requestId，便于主进程关联 pending 请求。
 */
export interface AskUserQuestionContextInput {
  readonly requestId: string;
  readonly instanceId?: string;
  /** 提问的前因后果（为什么问、查到什么、答了影响什么）；渲染在弹窗/渠道卡片里 */
  readonly context?: string;
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly multiSelect?: boolean;
    readonly options: readonly {
      readonly label: string;
      readonly description: string;
      readonly preview?: string;
      /** AI 推荐项标记（UI 高亮；每问至多一个） */
      readonly recommended?: boolean;
      /** 推荐理由（一句话，配合 recommended 使用） */
      readonly recommendReason?: string;
    }[];
  }[];
  /** 可选 timeout，默认由主进程控制（常规 10 min） */
  readonly timeoutMs?: number;
}

export interface AskUserQuestionContextResult {
  /** 用户答案：key=问题文本，value=答案字符串（多选以逗号拼接） */
  readonly answers: Record<string, string>;
  /** 可选的用户备注 / preview 选择 */
  readonly annotations?: Record<string, { preview?: string; notes?: string }>;
  /** 用户选择"拒绝回答" */
  readonly declined?: boolean;
  /** 请求超时或被取消 */
  readonly cancelled?: boolean;
}

export type { AgentTool, AgentToolResult, AgentToolUpdateCallback };
