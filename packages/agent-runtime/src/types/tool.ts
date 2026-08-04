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
 * MtBot 工具接口
 *
 * extends AgentTool<T> — 已有 name, label, description, parameters, execute
 */
export interface MtBotTool<T extends TSchema = TSchema, TDetails = unknown> extends AgentTool<
  T,
  TDetails
> {
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
  readonly questions: readonly {
    readonly question: string;
    readonly header: string;
    readonly multiSelect?: boolean;
    readonly options: readonly {
      readonly label: string;
      readonly description: string;
      readonly preview?: string;
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
