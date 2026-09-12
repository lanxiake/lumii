/**
 * 工具名 → 白话标签映射（详情面板展示用）
 *
 * 系统 Agent 的工具白名单来自内置定义（packages/agent-runtime），
 * 原始名（bash / wiki_search / app_act …）对非技术用户不可读，
 * 这里按「能力」聚合为一句白话，原始名收进 title 供悬停查看。
 *
 * 与 AgentsPage.const.tsx 的 CAPABILITY_OPTIONS 共用同一套措辞，
 * 避免同一个工具在「能力配置」与「Agent 详情」里叫两个名字。
 */

/** 一组共享同一白话标签的工具 */
export interface ToolGroup {
  /** 白话标签；未知工具回落为原始工具名 */
  label: string
  /** 该组包含的原始工具名（「全部工具」为通配时为空数组） */
  tools: string[]
}

/** 通配工具面：assistant 的 tools = ['*'] */
const ALL_TOOLS = '*'

const TOOL_LABELS: Record<string, string> = {
  // 联网
  web_search: '联网搜索',
  web_fetch: '访问网页',
  bing_search: '联网搜索',
  // 文件
  file_read: '读取文件',
  list_dir: '读取文件',
  glob: '读取文件',
  grep: '读取文件',
  file_write: '修改文件',
  file_edit: '修改文件',
  file_mkdir: '修改文件',
  file_move: '修改文件',
  file_copy: '修改文件',
  // 执行
  bash: '执行命令',
  // 任务
  todo_write: '任务追踪',
  task_complete: '结束任务',
  ask_user_question: '追问用户',
  // 技能
  skill_list: '查找技能',
  skill_search: '查找技能',
  skill_invoke: '调用技能',
  execute_skill: '调用技能',
  // 定时
  cron_create: '定时任务',
  cron_list: '定时任务',
  cron_delete: '定时任务',
  cron_guide: '定时任务',
  // 资料库（Wiki）
  wiki_overview: '资料库概览',
  wiki_search: '资料库检索',
  wiki_read: '阅读资料',
  // 记忆
  memory_search: '记忆检索',
  memory_read: '阅读记忆',
  memory_manage: '管理记忆',
  profile_memory: '用户画像记忆',
  scene_memory: '场景记忆',
  // 产出与协作
  work_report_read: '工作痕迹',
  dashboard_feed_write: '资讯卡',
  spawn_agent: '协调子 Agent',
  send_message: '给其他 Agent 发消息',
  message: '回复用户',
  channel_list: '渠道列表',
  channel_send: '渠道发消息',
  // 客户端界面（system-keeper）
  app_screenshot: '查看客户端界面',
  app_goto_and_screenshot: '查看客户端界面',
  app_goto: '操作客户端界面',
  app_act: '操作客户端界面',
  app_fill_form: '操作客户端界面',
  app_scroll_to_text: '操作客户端界面',
  app_scroll_to_bottom: '操作客户端界面',
}

/** 单个工具名 → 白话标签；未收录时回落为原始名 */
export function labelForTool(tool: string): string {
  return TOOL_LABELS[tool] ?? tool
}

/**
 * 工具列表 → 白话分组（保持首次出现顺序）。
 * 通配 `'*'` 表示不限制工具面，返回单组「全部工具」。
 */
export function groupTools(tools: readonly string[]): ToolGroup[] {
  if (tools.includes(ALL_TOOLS)) {
    return [{ label: '全部工具', tools: [] }]
  }
  const groups = new Map<string, string[]>()
  for (const tool of tools) {
    const label = labelForTool(tool)
    const bucket = groups.get(label)
    if (bucket) {
      if (!bucket.includes(tool)) bucket.push(tool)
    } else {
      groups.set(label, [tool])
    }
  }
  return [...groups].map(([label, groupToolsList]) => ({ label, tools: groupToolsList }))
}
