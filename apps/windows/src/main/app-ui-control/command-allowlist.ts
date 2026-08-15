/**
 * 控制口可转发的命令白名单（默认拒绝语义）
 *
 * 拒绝的高危项及理由见设计 §14.2.1，其中特别注意：
 * - mcp:writeConfigFile：content 为任意字符串，可注入 stdio server 命令，等价 RCE
 * - files:*：文件系统读写与枚举，与 B 层「不暴露文件操作」保持一致
 * - user:permission:respond：可自动批准权限弹窗，直接击穿权限管线
 * - storage:exportJsonl：可导出全部会话内容
 *
 * 新增命令默认落入拒绝，扩白名单必须走评审。
 */
export const COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  // 定时任务
  'cron:list', 'cron:runs', 'cron:run', 'cron:create', 'cron:update', 'cron:delete',
  // 工具开关
  'tools:list', 'tools:toggle',
  // 会话偏好
  'session:preferredModel:set', 'session:thinkingPrefs:set',
  // 会话只读
  'conversation:list', 'conversation:messages', 'conversation:context-usage',
  // 运行时只读
  'runtime:ping', 'runtime:enabled', 'runtime:featureFlags:get',
  'agent:definitions:list', 'agentInstance:list', 'commands:list', 'tasks:list',
  // 记忆只读
  'agent:memories:list', 'agent:memories:export', 'agent:memories:provenance',
  // MCP 只读
  'mcp:status',
  // 存储只读
  'storage:stats', 'storage:listBackups', 'storage:auditRecent',
  // 编码后端
  'codingDev:getBackend', 'codingDev:listBackends', 'codingDev:setBackend',
])

/** 判断命令 type 是否在白名单内 */
export function isCommandExposed(type: unknown): type is string {
  return typeof type === 'string' && COMMAND_ALLOWLIST.has(type)
}
