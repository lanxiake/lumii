/**
 * 内置常用 MCP 服务清单
 *
 * 收录门槛（三条都满足才进来）：
 *   1. 优先 `npx -y` 能装上；少数 Python 包可用 `uvx`（客户端会在连接前自动安装 uv）
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
    name: 'comfyui-remote',
    title: 'ComfyUI 生图',
    description: '连接远程 ComfyUI，用工作流生成图片、处理图像',
    categories: ['creator'],
    command: 'npx',
    args: ['-y', 'comfyui-mcp'],
    env: { COMFYUI_URL: 'https://cfui.cpolar.top' },
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
