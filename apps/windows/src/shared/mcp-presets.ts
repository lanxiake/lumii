/**
 * 内置常用 MCP 服务清单
 *
 * 收录门槛（三条都满足才进来）：
 *   1. 优先 `npx -y` 能装上；少数 Python 包可用 `uvx`（客户端会在连接前自动安装 uv）；
 *      随包自研服务打成独立 exe（`bundledExe`），配置里写部署后的绝对路径，可脱离灵栖使用
 *   2. 包在 npm/PyPI 上，国内配了镜像就能拉；服务端也得是国内可访问的
 *   3. 官方或一方维护，包名可确认
 *
 * 需要用户自行申请的密钥一律把 env 值留空并给出申请地址。
 * 非密钥（如服务 URL、已内置的共享 Key）可以写默认值，播种时视为已就绪。
 *
 * 不收录 @playwright/mcp 与 chrome-devtools-mcp：客户端已内置 browser_* 工具
 * （导航/点击/输入/滚动/截图/执行 JS）和 HTML 预览，装了只是重复一套还多依赖 Chrome。
 *
 * 同理不收录 @modelcontextprotocol/server-sequential-thinking：模型自带推理，
 * 装了只是重复一套。
 *
 * 不收录 @modelcontextprotocol/server-filesystem：客户端已内置 file_read/write/edit、
 * list_dir、file_mkdir、file_move、file_copy、glob、grep，装了只是重复一套还多占上下文。
 */

/**
 * wechat-mcp 的两条分发入口
 *
 * - `WECHAT_MCP_NPM_PACKAGE`：社区客户端 `npx -y <包名>` 用（见 PUBLISHING.md §1），
 *   灵栖内置**不走**它——装了灵栖就随包带 exe，不必联网装 npm 包；
 * - `WECHAT_MCP_VERSION`：随包 exe 的版本，面板上展示，方便对账用户截图。
 *
 * 版本号唯一来源仍是 `resources/wechat-mcp/server.py` 的 `SERVER_VERSION`，这里是它的
 * TS 镜像。为什么不运行时实读：`wechat-mcp.exe --version` 是 PyInstaller onefile，
 * 本机实测冷启动 1.0–3.4s，而面板每 5s 轮询一次状态，实读会把轮询拖垮。
 * `mcp-presets.test.ts` 会读回 server.py 与 npm 模板对账，发版漏改这里会红，不会静默漂移。
 */
export const WECHAT_MCP_NPM_PACKAGE = '@lumii/wechat-mcp'
export const WECHAT_MCP_VERSION = '0.6.2'

export type McpPresetCategory =
  | 'office'
  | 'news'
  | 'legal'
  | 'kids'
  | 'creator'
  | 'life'

export const MCP_PRESET_CATEGORIES: ReadonlyArray<{ id: McpPresetCategory; label: string }> = [
  { id: 'office', label: '办公' },
  { id: 'news', label: '资讯热点' },
  { id: 'legal', label: '法律' },
  { id: 'kids', label: '儿童教育' },
  { id: 'creator', label: '自媒体' },
  { id: 'life', label: '生活' },
]

export interface McpPreset {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly categories: readonly McpPresetCategory[]
  readonly command: string
  readonly args: readonly string[]
  /** 需要密钥时列出变量名，值留空由用户填 */
  readonly env?: Record<string, string>
  /** 申请密钥的地址 */
  readonly keyUrl?: string
  /** 填进表单后用户还需要动手补的东西 */
  readonly todo?: string
  /** 播种时是否默认启用；未指定时按 isReadyToUse 判断 */
  readonly defaultEnabled?: boolean
  /**
   * 单次请求默认超时（ms）。长耗时服务（如远程 ComfyUI 出片）需调大，
   * 否则会被本地 30s 默认值截断。
   */
  readonly timeoutMs?: number
  /** 需要后台化的工具短名（命中后立即返回，完成后唤醒 Agent，避免拖垮回合） */
  readonly backgroundTools?: readonly string[]
  /**
   * 随包独立可执行文件名（不含 .exe）。设置后播种/迁移写进配置的 command 是
   * 部署后的绝对路径 `<数据根>/mcp/<name>/<name>.exe`，`command` 字段只作展示。
   */
  readonly bundledExe?: string
  /** `bundledExe` 的版本，面板上展示；来源见 `WECHAT_MCP_VERSION` */
  readonly bundledVersion?: string
  /** 同一能力的 npm 分发包名，供用户脱离灵栖时自行安装；灵栖内置不读它 */
  readonly npmPackage?: string
  /**
   * 发送给 Agent 的使用说明（Markdown），注入到 MCP Server 的 instructions 字段。
   * 用于指导 Agent 何时使用工具、如何处理错误、以及禁止的行为。
   */
  readonly instructions?: string
}

/**
 * 预置项是否已可直接启用
 *
 * 首次播种时只有就绪项才默认打开：还要填路径 / Key 的先写进列表但停用，
 * 否则首启就会连一串必定失败的 Server，用户打开设置看到满屏红点。
 * env 里若全是非空默认值（例如服务 URL）也算就绪。
 */
export function isReadyToUse(preset: McpPreset): boolean {
  if (preset.todo) return false
  if (!preset.env) return true
  return Object.values(preset.env).every((value) => value.trim() !== '')
}

export const MCP_PRESETS: readonly McpPreset[] = [
  {
    name: 'wechat-local',
    title: '本机微信',
    description: '读取本机微信会话、历史消息、检索聊天记录，并能发送消息、文件、引用回复、群发，以及蒸馏用户/好友画像',
    categories: ['life'],
    // 独立单文件 exe（scripts/build-wechat-mcp.mjs），不依赖 Python 与灵栖占位符
    command: 'wechat-mcp.exe',
    args: [],
    bundledExe: 'wechat-mcp',
    bundledVersion: WECHAT_MCP_VERSION,
    npmPackage: WECHAT_MCP_NPM_PACKAGE,
    // 每条回复都要走一整串 GUI 安全网（UIA 全树读 ≈3–4s/次 × 5–6 次 + 切会话 + 读库确认），
    // 表头不对、要走切会话那条路时单发实测 36.2s；服务端 tool_send 外面还套了
    // `_send_with_retry(max_retries=2)`，最坏两轮 ⇒ 30s 默认值会把**已经发成功**的那次
    // 报成失败（2026-10-09 15:15 实测：消息 15:15:50 落库，服务端 36.2s 自报 ok，客户端
    // 15:15:46 超时）。给足 5 分钟，让本地这双手自己把结论说完。
    timeoutMs: 300_000,
    defaultEnabled: true,
    instructions: `## 微信工具使用指南

### 使用建议

1. **发送前先读取最近消息**：调用 \`wechat_get_recent_messages\` 确认对话上下文，避免重复发送或答非所问。
2. **收到错误时先诊断**：根据返回的 \`status\` 字段判断原因，而不是立即重试。
3. **批量发送时分段确认**：连续发送超过 3 条消息时，中间调用 \`wechat_get_recent_messages\` 确认前面的消息已送达（避免因微信界面刷新导致后续消息发到错误会话）。

### 错误处理与重试策略

根据 \`status\` 字段决定下一步操作：

- **\`target_unconfirmed\`**（联系人不可达）
  - **不要重试**，改用其他方式（如搜索联系人）或告知用户确认联系人名称。
  - 这通常表示联系人名字有歧义或界面状态异常，重试无法解决。

- **\`no_such_contact\`**（联系人不存在）
  - **直接报错**，让用户确认联系人名称是否正确。

- **\`ui_unresponsive\`**（界面冻结）
  - 工具已自动恢复并重试一次，若仍失败则**报告用户**手动检查微信状态。

- **\`sent\`** 且 \`detail\` 包含「超时」字样
  - **消息已成功发送**（服务端已重试 2 次），无需再发。
  - 超时提示是因为操作耗时较长（最长可达 36 秒），但消息实际已送达。

- **\`failed\`** 且 \`detail\` 包含「文件路径不存在」
  - **检查路径**后重试一次。

### 禁止行为

- **同一消息不要连续发送超过 2 次**（避免刷屏）。
- **收到 \`target_unconfirmed\` 后不要盲目重试**（这不是暂时故障，重试只会浪费时间）。
- **不要在短时间内频繁切换会话**（每次切换需要 3–7 秒的界面确��）。

### 工具耗时说明

- **正常发送**：约 7–15 秒（包括界面读取、切换会话、发送、数据库确认）。
- **需要切换会话时**：最长可达 36 秒。
- **界面冻结恢复**：额外增加 5–10 秒。

请耐心等待工具返回结果，不要因为耗时较长就提前判断失败。`,
  },
  {
    name: 'comfyui-remote',
    title: 'ComfyUI 生图',
    description: '连接远程 ComfyUI，用工作流生成图片、处理图像',
    categories: ['creator'],
    command: 'npx',
    args: ['-y', 'comfyui-mcp'],
    env: { COMFYUI_URL: 'https://cfui.cpolar.top' },
    // 一次 wait:true 最长等 300s，且 npx 冷启动握手也慢；30s 默认值会在本地先超时
    timeoutMs: 360_000,
    // 出片是分钟级长任务：后台执行,完成后唤醒 Agent 续跑
    backgroundTools: ['enqueue_workflow'],
    defaultEnabled: false,
  },
  {
    name: 'excel-mcp',
    title: 'Excel 表格读取',
    description: '无需装 Office，直接读取解析 Excel/CSV 表格数据，交给 AI 汇总与分析',
    categories: ['office'],
    command: 'npx',
    args: ['-y', 'excel-mcp'],
  },
  {
    name: 'mcp-trends-hub',
    title: '全网热点聚合',
    description: '获取微博、B 站、科技圈热点资讯，输出热点标题与摘要',
    categories: ['news', 'creator', 'life'],
    command: 'npx',
    args: ['-y', 'mcp-trends-hub'],
  },
  {
    name: 'civil-code-mcp',
    title: '民法典查询',
    description: '检索民法典法条，精准引用条文原文',
    categories: ['legal', 'life'],
    command: 'npx',
    args: ['-y', '@iflow-mcp/civil-code-of-china-mcp'],
  },
  {
    name: '12306-mcp',
    title: '12306 火车票',
    description: '查询火车票余票、车次与站点信息',
    categories: ['life'],
    command: 'npx',
    args: ['-y', '12306-mcp'],
  },
  {
    name: 'flight-price-compare',
    title: '机票比价',
    description: '对比各平台机票价格，辅助出行决策',
    categories: ['life'],
    command: 'uvx',
    args: ['flight-price-compare-mcp==4.0.2'],
  },
  {
    name: 'amap-maps',
    title: '高德地图',
    description: '地点检索、路线规划、周边推荐',
    categories: ['life', 'kids'],
    command: 'npx',
    args: ['-y', '@amap/amap-maps-mcp-server'],
    env: { AMAP_MAPS_API_KEY: '6be468a574af8f0c366a930f42bd692b' },
  },
]

const PRESET_BY_NAME = new Map(MCP_PRESETS.map((preset) => [preset.name, preset]))

/**
 * 按 Server 名查内置说明
 *
 * 落盘的 mcp-servers.json 只存 command/args/env，没有 title/description/keyUrl，
 * 设置页要展示这些就得回查清单。用户自建的服务查不到，返回 undefined。
 */
export function findMcpPreset(name: string): McpPreset | undefined {
  return PRESET_BY_NAME.get(name)
}
