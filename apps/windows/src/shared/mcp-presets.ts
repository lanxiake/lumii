/**
 * 内置常用 MCP 服务清单
 *
 * 收录门槛（三条都满足才进来）：
 *   1. `npx -y` 能装上——不引入 uv/pip/docker 这类需要用户先装运行时的方式
 *   2. 包在 npm 上，国内配了镜像就能拉；服务端也得是国内可访问的
 *   3. 官方或一方维护，包名可确认
 *
 * 需要密钥的一律把 env 值留空并给出申请地址，不写死假值。
 * 非密钥（如服务 URL）可以写默认值，播种时视为已就绪。
 *
 * 不收录 @playwright/mcp 与 chrome-devtools-mcp：客户端已内置 browser_* 工具
 * （导航/点击/输入/滚动/截图/执行 JS）和 HTML 预览，装了只是重复一套还多依赖 Chrome。
 */

export type McpPresetCategory = 'office' | 'frontend' | 'kids' | 'creator' | 'life'

export const MCP_PRESET_CATEGORIES: ReadonlyArray<{ id: McpPresetCategory; label: string }> = [
  { id: 'office', label: '办公' },
  { id: 'frontend', label: '前端开发' },
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
    name: 'filesystem',
    title: '本地文件',
    description: '读写指定文件夹里的文档，整理资料、批量改名、汇总内容、生成项目文件',
    categories: ['office', 'frontend', 'creator'],
    command: 'npx',
    // {{USER_DOCUMENTS}} 由主进程播种/加载时解析为真实「文档」目录，勿写死盘符
    args: ['-y', '@modelcontextprotocol/server-filesystem', '{{USER_DOCUMENTS}}'],
    todo: '确认参数最后一行目录：默认为本机「文档」文件夹，可改成任意愿意开放给 AI 的路径',
  },
  {
    name: 'sequential-thinking',
    title: '分步思考',
    description: '把复杂需求拆成一步步推演，做方案、讲应用题、理作文思路都更有条理',
    categories: ['office', 'frontend', 'kids'],
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  },
  {
    name: 'comfyui-remote',
    title: 'ComfyUI 生图',
    description: '连接远程 ComfyUI，用工作流生成图片、处理图像',
    categories: ['creator'],
    command: 'npx',
    args: ['-y', 'comfyui-mcp'],
    env: { COMFYUI_URL: 'https://cfui.cpolar.top' },
  },
  {
    name: 'baidu-map',
    title: '百度地图',
    description: '地点检索、路线规划、周边推荐',
    categories: ['life', 'kids'],
    command: 'npx',
    args: ['-y', '@baidumap/mcp-server-baidu-map'],
    env: { BAIDU_MAP_API_KEY: '' },
    keyUrl: 'https://lbsyun.baidu.com/apiconsole/key',
    todo: '申请免费 Key（选「服务端」应用类型）填进环境变量',
  },
]
