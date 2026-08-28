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
  // 会话读写：create/send 仅用于自动化测试构造对话，字段被 COMMAND_FIELD_DENYLIST 收窄
  'conversation:list', 'conversation:messages', 'conversation:context-usage',
  'conversation:create', 'user:send', 'user:abort',
  // 上下文压缩：只重排既有会话内容，不接受外部注入的正文，
  // 与被拒的 agentInstance:prompt 不同（那个可投喂任意 prompt）
  'user:compact-context', 'user:abort-compact-context',
  // 运行时只读
  'runtime:ping', 'runtime:enabled', 'runtime:featureFlags:get',
  'agent:definitions:list', 'agentInstance:list', 'commands:list', 'tasks:list',
  // 记忆只读 + 搜索（FTS5）+ 统计
  'agent:memories:list', 'agent:memories:export', 'agent:memories:provenance',
  'agent:memories:search', 'agent:memories:stats',
  // 记忆写操作（归档/恢复/重建索引）：不涉及任意内容写入与文件系统，可放行
  'agent:memories:archiveCold', 'agent:memories:unarchive', 'agent:memories:rebuildIndex',
  // Wiki 知识库（P0）：浏览、检索、状态流转与页面编辑。
  // organize / update 接受任意 contentMd，属知识库正文写入而非配置/命令注入，
  // 与被拒的 mcp:writeConfigFile（可注入 stdio 命令，等价 RCE）性质不同，按需放行。
  'wiki:inbox:list', 'wiki:inbox:count', 'wiki:inbox:retry', 'wiki:inbox:discard', 'wiki:inbox:organize',
  'wiki:page:list', 'wiki:page:get', 'wiki:page:update', 'wiki:page:delete',
  'wiki:search', 'wiki:source:get', 'wiki:runs:list', 'wiki:index:rebuild',
  // 用途主题树 / 资料层（记忆重构一期）：set 接受结构化目录 JSON，非任意命令注入，按需放行。
  'wiki:topic:tree:get', 'wiki:topic:tree:set', 'wiki:topic:mutate', 'wiki:source:list',
  'wiki:reclassify:run', 'wiki:reclassify:get', 'wiki:reclassify:apply',
  'wiki:reclassify:ignore', 'wiki:reclassify:discard',
  'wiki:source:create-note', 'wiki:source:rename',
  'wiki:source:update-topic', 'wiki:source:move-to-parking', 'wiki:source:open',
  // Wiki 知识库（P1）：链接/修订/清理/附件/导出/概念候选。export 的 targetDir 来自渲染进程
  // 弹出的系统原生 dialog:showSaveDialog（用户手选目录），不是任意字符串注入，按需放行。
  'wiki:link:backlinks', 'wiki:link:unresolved', 'wiki:page:revisions', 'wiki:page:rollback',
  'wiki:cleanup:scan', 'wiki:source:archive', 'wiki:source:restore', 'wiki:source:delete',
  'wiki:attach:list', 'wiki:attach:add', 'wiki:attach:remove', 'wiki:export',
  'wiki:concept:scan', 'wiki:concept:confirm', 'wiki:concept:reject',
  'wiki:synthesis:create', 'wiki:synthesis:list', 'wiki:synthesis:get',
  'wiki:synthesis:accept', 'wiki:synthesis:accept-as-source', 'wiki:synthesis:reject', 'wiki:synthesis:auto-run',
  'wiki:graph:data', 'wiki:status:scan', 'wiki:status:confirm',
  'wiki:ero:bootstrap', 'wiki:ero:list', 'wiki:ero:extract', 'wiki:ero:entity-sources',
  'wiki:search:hybrid', 'wiki:vector:rebuild',
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

/**
 * 逐命令的字段拒绝清单（默认拒绝语义的第二道闸）。
 *
 * user:send 的 attachments / imageAttachmentPaths 接受绝对路径，主进程会读取文件
 * 转 base64 投喂模型——放开等于把被拒的 files:* 读能力从侧门放进来。
 * 故 user:send 只允许 sessionKey + content + msgId，其余一律拒。
 */
export const COMMAND_FIELD_DENYLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    'user:send',
    new Set(['attachments', 'imageAttachmentPaths', 'audioWavBase64', 'agentId']),
  ],
])

/**
 * 检查请求体是否携带该命令的禁用字段。
 * @returns 命中的字段名；无命中返回 null
 */
export function findDeniedField(body: unknown): string | null {
  const type = (body as { type?: unknown } | null)?.type
  if (typeof type !== 'string') return null
  const denied = COMMAND_FIELD_DENYLIST.get(type)
  if (!denied) return null
  for (const key of Object.keys(body as Record<string, unknown>)) {
    if (denied.has(key)) return key
  }
  return null
}
