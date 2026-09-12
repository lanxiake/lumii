/**
 * 配置类型定义
 */

/**
 * 开发类 AI 工具（ACP）项目条目。
 * - isExternal=false：在 workspace/projects/<name> 下新建，realPath 即该目录
 * - isExternal=true：workspace/projects/<name> 是指向 realPath 的 junction 软链接
 */
export interface CodingDevProject {
  /** 项目显示名，同时是 projects/ 下的目录/链接名 */
  name: string
  /** 项目真实磁盘路径（ACP cwd 使用此值） */
  realPath: string
  /** 是否为软链接挂载的外部已有项目 */
  isExternal: boolean
}

/**
 * 开发类 Agent 的本机绑定：把一个 Agent 身份接到某个 CLI 与工作目录。
 *
 * 归属本机的原因：workspace 是本机绝对路径、backendId 取决于本机装了什么 CLI，
 * 都不该跨设备同步。Agent 删除后 binding 成为孤儿，读取时忽略（不级联清理）。
 */
export interface AgentDevBinding {
  /** 对应的 AgentDefinition.id（如 'code-dev'） */
  agentId: string
  /** 本机 CLI 后端 */
  backendId: 'claude' | 'codex' | 'cursor' | 'opencode'
  /** 工作目录绝对路径；缺省回退全局活动项目 */
  workspace?: string
  /** 是否启用（停用后该 Agent 退回内置内核） */
  enabled: boolean
  /** 可选的权限模式覆盖（如 'bypassPermissions'；缺省按后端默认，见编码 CLI 参数策略） */
  permissionMode?: string
}

/**
 * 应用配置
 */
export interface AppConfig {
  /** 应用版本 */
  version: string
  /** 语言设置 */
  language: 'zh-CN' | 'en-US'
  /** 主题 */
  theme: 'light' | 'dark' | 'auto'
  /** 启动时自动连接 */
  autoConnect: boolean
  /** 最小化到托盘 */
  minimizeToTray: boolean
  /** 开机自启动 */
  autoStart: boolean
  /** 工作空间目录（用户可自定义） */
  workspaceDirectory?: string
  /**
   * 开发类 AI 工具（Codex/Claude/…）ACP 工作目录；不设置则与 workspaceDirectory 相同。
   * @deprecated 由 codingDevProjects + codingDevActiveProject 取代，保留用于旧配置回退。
   */
  codingDevAcpWorkspace?: string
  /** ACP 项目列表（新建或软链接挂载的已有项目） */
  codingDevProjects?: CodingDevProject[]
  /** 当前活动项目名（其 realPath 写入 MTBOT_*_ACP_CWD） */
  codingDevActiveProject?: string
  /**
   * 开启自主能力的 Agent id 列表（assistant 恒参与，无需列入）。
   * 心跳 tick 遍历 assistant + 本列表；缺省/空表示仅 assistant 参与。
   */
  autonomousAgents?: string[]
  /** 开发类 Agent 的本机绑定列表（Agent → CLI 后端 + 工作目录） */
  codingDevAgentBindings?: AgentDevBinding[]
}

/**
 * 日志配置
 */
export interface LogConfig {
  /** 日志级别 */
  level: 'debug' | 'info' | 'warn' | 'error'
  /** 最大日志文件大小 (MB) */
  maxSize: number
  /** 保留日志文件数量 */
  maxFiles: number
}

/**
 * 搜索工具配置
 */
export interface SearchConfig {
  /** LangSearch API Key（用于 web_search 工具） */
  langSearchApiKey?: string
  /** SearXNG Base URL（用于 web_search 工具后备） */
  searxngBaseUrl?: string
}

/**
 * 完整配置
 */
export interface Config {
  app: AppConfig
  log: LogConfig
  search: SearchConfig
}

/**
 * 部分配置 - 用于更新操作
 */
export type PartialConfig = {
  [K in keyof Config]?: Partial<Config[K]>
}

/**
 * 默认配置
 */
export const DEFAULT_CONFIG: Config = {
  app: {
    version: '0.1.3',
    language: 'zh-CN',
    theme: 'auto',
    autoConnect: true,
    minimizeToTray: true,
    autoStart: false,
  },
  log: {
    level: 'info',
    maxSize: 10,
    maxFiles: 5,
  },
  search: {
    langSearchApiKey: undefined,
    searxngBaseUrl: undefined,
  },
}
