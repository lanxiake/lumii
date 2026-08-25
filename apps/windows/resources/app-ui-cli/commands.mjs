/**
 * lumii-ui 命令注册表（单一事实来源）
 *
 * 每一项同时驱动三件事：参数分发、help 文本、Agent 能力发现（help --json）。
 * 新增/修改命令只改这个文件，不需要同步改 lumii-ui.mjs 的分发逻辑或工具 description。
 *
 * 每个命令：
 * - name: 子命令名（如 'screenshot'、'cron list'）
 * - group: help 总览里的分组标题
 * - usage: 单行用法
 * - summary: 一句话说明
 * - layer: 'ui' | 'A' | 'B' | 'C'，仅用于文档标注，不参与分发
 * - route: { method, path } 控制口路由
 * - options: help <command> 展示的参数说明
 * - build(args): 把 { positional, flags } 转成请求体；返回 null 表示参数不合法（exit 2）
 */

/** 解析数字 flag，非法值返回 undefined */
function num(value) {
  if (typeof value !== 'string') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

export const COMMANDS = [
  {
    name: 'screenshot',
    group: '看',
    usage: 'screenshot [--annotate] [--target main|pet] [--out <file.jpg>]',
    summary: '截取当前界面，返回 JPEG 与可交互元素 refs',
    layer: 'ui',
    route: { method: 'POST', path: '/screenshot' },
    options: [
      { flag: '--annotate', desc: '在截图上标注元素编号（SoM）' },
      { flag: '--target <t>', desc: 'main（默认）| pet' },
      { flag: '--out <file>', desc: '另存 JPEG 到指定路径' },
    ],
    build(args) {
      const body = {}
      if (args.flags.annotate === true || args.flags.annotate === 'true') body.annotate = true
      if (typeof args.flags.target === 'string') body.target = args.flags.target
      return body
    },
  },
  {
    name: 'goto',
    group: '动',
    usage: 'goto --view <v> [--category <c>]',
    summary: '打开指定页面（设置/技能/定时等，不要点侧栏）',
    layer: 'ui',
    route: { method: 'POST', path: '/goto' },
    options: [
      { flag: '--view <v>', desc: 'dashboard | chat | settings | skills | mcp | cron | memories | agents | plugins' },
      { flag: '--category <c>', desc: 'settings 分类（可选）' },
    ],
    build(args) {
      if (typeof args.flags.view !== 'string') return null
      const body = { view: args.flags.view }
      if (typeof args.flags.category === 'string') body.category = args.flags.category
      return body
    },
  },
  {
    name: 'click',
    group: '动',
    usage: 'click --ref <r> [--snapshot-id <id>]',
    summary: '点击 ref 对应控件',
    layer: 'ui',
    route: { method: 'POST', path: '/click' },
    options: [
      { flag: '--ref <r>', desc: '来自 screenshot 的元素 ref' },
      { flag: '--snapshot-id <id>', desc: '截图返回的 snapshotId，用于校验 ref 未过期' },
    ],
    build(args) {
      if (typeof args.flags.ref !== 'string') return null
      const body = { ref: args.flags.ref }
      if (typeof args.flags['snapshot-id'] === 'string') body.snapshotId = args.flags['snapshot-id']
      return body
    },
  },
  {
    name: 'act',
    group: '动',
    usage: 'act --action click|type|select|key|scroll [--ref <r>] [--text <t>] [--append] [--value <v>] [--label <l>] [--key <k>] [--dx <n>] [--dy <n>] [--snapshot-id <id>]',
    summary: '通用交互动作（二期遗留，保留兼容）',
    layer: 'ui',
    route: { method: 'POST', path: '/act' },
    options: [
      { flag: '--action <a>', desc: 'click | type | select | key | scroll' },
      { flag: '--ref <r>', desc: '元素 ref（click/type/select/scroll 必填）' },
      { flag: '--text <t>', desc: 'type 要写入的文本' },
      { flag: '--append', desc: 'type 追加而非整体替换' },
      { flag: '--value <v>', desc: 'select 要选中的选项 value' },
      { flag: '--label <l>', desc: 'select 要选中的选项文案' },
      { flag: '--key <k>', desc: 'key 操作的白名单按键' },
      { flag: '--dx <n>', desc: 'scroll 水平偏移' },
      { flag: '--dy <n>', desc: 'scroll 垂直偏移' },
    ],
    build(args) {
      const action = args.flags.action ?? args.positional[0]
      if (!['click', 'type', 'select', 'key', 'scroll'].includes(action)) return null
      const body = { action }
      if (typeof args.flags.ref === 'string') body.ref = args.flags.ref
      if (typeof args.flags['snapshot-id'] === 'string') body.snapshotId = args.flags['snapshot-id']
      if (typeof args.flags.text === 'string') body.text = args.flags.text
      if (args.flags.append === true || args.flags.append === 'true') body.append = true
      if (typeof args.flags.value === 'string') body.value = args.flags.value
      if (typeof args.flags.label === 'string') body.label = args.flags.label
      if (typeof args.flags.key === 'string') body.key = args.flags.key
      const dx = num(args.flags.dx)
      const dy = num(args.flags.dy)
      if (dx !== undefined) body.dx = dx
      if (dy !== undefined) body.dy = dy
      return body
    },
  },
  {
    name: 'settings get',
    group: '设置',
    usage: 'settings get [<key.path>]',
    summary: '读取设置（省略则返回全部）',
    layer: 'C',
    route: { method: 'POST', path: '/settings/read' },
    options: [{ flag: '<key.path>', desc: '如 privacy.saveChatHistory，省略返回整份设置' }],
    build(args) {
      const body = {}
      if (typeof args.positional[0] === 'string') body.keyPath = args.positional[0]
      return body
    },
  },
  {
    name: 'settings set',
    group: '设置',
    usage: 'settings set <key.path> <value>',
    summary: '写入设置并立即生效',
    layer: 'C',
    route: { method: 'POST', path: '/settings/write' },
    options: [
      { flag: '<key.path>', desc: '如 theme.mode' },
      { flag: '<value>', desc: '先尝试 JSON.parse，失败则当字符串' },
    ],
    build(args) {
      const keyPath = args.positional[0]
      const rawValue = args.positional[1]
      if (typeof keyPath !== 'string' || rawValue === undefined) return null
      let value = rawValue
      try {
        value = JSON.parse(rawValue)
      } catch {
        // 非 JSON，按字符串处理
      }
      return { keyPath, value }
    },
  },
  {
    name: 'cron list',
    group: '定时任务',
    usage: 'cron list',
    summary: '列出定时任务',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [],
    build() {
      return { type: 'cron:list' }
    },
  },
  {
    name: 'cron run',
    group: '定时任务',
    usage: 'cron run <id>',
    summary: '立即执行一次',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<id>', desc: '定时任务 ID' }],
    build(args) {
      const id = args.positional[0]
      if (typeof id !== 'string' || id.length === 0) return null
      return { type: 'cron:run', id }
    },
  },
  {
    name: 'skill list',
    group: '技能',
    usage: 'skill list',
    summary: '列出已安装技能',
    layer: 'B',
    route: { method: 'POST', path: '/ipc/skills/list' },
    options: [],
    build() {
      return {}
    },
  },
  {
    name: 'skill enable',
    group: '技能',
    usage: 'skill enable <id>',
    summary: '启用技能',
    layer: 'B',
    route: { method: 'POST', path: '/ipc/skills/setEnabled' },
    options: [{ flag: '<id>', desc: '技能 ID' }],
    build(args) {
      const skillId = args.positional[0]
      if (typeof skillId !== 'string' || skillId.length === 0) return null
      return { skillId, enabled: true }
    },
  },
  {
    name: 'skill disable',
    group: '技能',
    usage: 'skill disable <id>',
    summary: '禁用技能',
    layer: 'B',
    route: { method: 'POST', path: '/ipc/skills/setEnabled' },
    options: [{ flag: '<id>', desc: '技能 ID' }],
    build(args) {
      const skillId = args.positional[0]
      if (typeof skillId !== 'string' || skillId.length === 0) return null
      return { skillId, enabled: false }
    },
  },
  {
    name: 'model set',
    group: '模型与工具',
    usage: 'model set <modelId> --session <key>',
    summary: '设置会话首选模型（--session 必填）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '<modelId>', desc: '目标模型 ID' },
      { flag: '--session <key>', desc: '会话 key，三期必填，不做隐式默认' },
    ],
    build(args) {
      const modelId = args.positional[0]
      const sessionKey = args.flags.session
      if (typeof modelId !== 'string' || typeof sessionKey !== 'string' || sessionKey.length === 0) {
        return null
      }
      return { type: 'session:preferredModel:set', sessionKey, modelId }
    },
  },
  {
    name: 'tools list',
    group: '模型与工具',
    usage: 'tools list',
    summary: '列出工具',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [],
    build() {
      return { type: 'tools:list' }
    },
  },
  {
    name: 'tools toggle',
    group: '模型与工具',
    usage: 'tools toggle <name> on|off',
    summary: '启用/禁用工具',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '<name>', desc: '工具名' },
      { flag: 'on|off', desc: '启用或禁用' },
    ],
    build(args) {
      const toolName = args.positional[0]
      const state = args.positional[1]
      if (typeof toolName !== 'string' || (state !== 'on' && state !== 'off')) return null
      return { type: 'tools:toggle', toolName, enabled: state === 'on' }
    },
  },
  {
    name: 'memory list',
    group: '记忆',
    usage: 'memory list [--session <key>]',
    summary: '列出记忆（默认当前用户所有 Agent 的活跃记忆）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--session <key>', desc: '指定会话（可选），不传则显示该用户全部 Agent 的记忆' },
    ],
    build(args) {
      const body = { type: 'agent:memories:list' }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      return body
    },
  },
  {
    name: 'memory search',
    group: '记忆',
    usage: 'memory search <关键词> [--limit <n>] [--session <key>]',
    summary: 'FTS5 全文搜索记忆（验证中文召回）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '<关键词>', desc: '搜索关键词（中文 bigram 切分，支持 2 字词）' },
      { flag: '--limit <n>', desc: '返回条数上限，默认 10' },
      { flag: '--session <key>', desc: '指定会话，不传则搜索该用户全部记忆' },
    ],
    build(args) {
      const keyword = args.positional[0]
      if (typeof keyword !== 'string' || keyword.trim().length === 0) return null
      const body = { type: 'agent:memories:search', keyword }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      const limit = num(args.flags.limit)
      if (limit !== undefined && limit > 0) body.limit = limit
      return body
    },
  },
  {
    name: 'memory stats',
    group: '记忆',
    usage: 'memory stats [--session <key>]',
    summary: '温度分布统计（hot/warm/cold + 总数）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '--session <key>', desc: '指定会话，不传则统计该用户 assistant Agent 记忆' }],
    build(args) {
      const body = { type: 'agent:memories:stats' }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      return body
    },
  },
  {
    name: 'memory provenance',
    group: '记忆',
    usage: 'memory provenance <id>',
    summary: '溯源到来源 segment + 原文区间 + 宫殿片段',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<id>', desc: '记忆 ID' }],
    build(args) {
      const memoryId = args.positional[0]
      if (typeof memoryId !== 'string' || memoryId.length === 0) return null
      return { type: 'agent:memories:provenance', memoryId }
    },
  },
  {
    name: 'memory archive-cold',
    group: '记忆',
    usage: 'memory archive-cold --yes [--session <key>]',
    summary: '归档冷记忆（> 30 天未用且非 personal 类），--yes 必填确认',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--yes', desc: '确认批量归档（必填）' },
      { flag: '--session <key>', desc: '指定会话，不传则归档该用户 assistant Agent 记忆' },
    ],
    build(args) {
      if (args.flags.yes !== true && args.flags.yes !== 'true') return null
      const body = { type: 'agent:memories:archiveCold' }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      return body
    },
  },
  {
    name: 'memory unarchive',
    group: '记忆',
    usage: 'memory unarchive <id>',
    summary: '恢复归档记忆',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<id>', desc: '记忆 ID' }],
    build(args) {
      const memoryId = args.positional[0]
      if (typeof memoryId !== 'string' || memoryId.length === 0) return null
      return { type: 'agent:memories:unarchive', memoryId }
    },
  },
  {
    name: 'wiki inbox list',
    group: 'Wiki',
    usage: 'wiki inbox list [--status pending|organized|discarded] [--session <key>]',
    summary: '列出 Wiki 收件箱条目',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--status <s>', desc: '按状态筛选：pending | organized | discarded' },
      { flag: '--session <key>', desc: '指定会话，不传则使用默认归属' },
    ],
    build(args) {
      const body = { type: 'wiki:inbox:list' }
      if (typeof args.flags.status === 'string') body.status = args.flags.status
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      return body
    },
  },
  {
    name: 'wiki inbox retry',
    group: 'Wiki',
    usage: 'wiki inbox retry <id>',
    summary: '清零失败计数，让收件箱条目重新可被取件整理',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<id>', desc: '收件箱条目 ID' }],
    build(args) {
      const inboxId = args.positional[0]
      if (typeof inboxId !== 'string' || inboxId.length === 0) return null
      return { type: 'wiki:inbox:retry', inboxId }
    },
  },
  {
    name: 'wiki inbox discard',
    group: 'Wiki',
    usage: 'wiki inbox discard <id>',
    summary: '丢弃收件箱条目（不进入知识库）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<id>', desc: '收件箱条目 ID' }],
    build(args) {
      const inboxId = args.positional[0]
      if (typeof inboxId !== 'string' || inboxId.length === 0) return null
      return { type: 'wiki:inbox:discard', inboxId }
    },
  },
  {
    name: 'wiki page list',
    group: 'Wiki',
    usage: 'wiki page list [--category <c>] [--session <key>]',
    summary: '按分类列出 Wiki 页面',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--category <c>', desc: '按顶层分类筛选：sources | media | inbox | concepts | entities | syntheses' },
      { flag: '--session <key>', desc: '指定会话，不传则使用默认归属' },
    ],
    build(args) {
      const body = { type: 'wiki:page:list' }
      if (typeof args.flags.category === 'string') body.category = args.flags.category
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      return body
    },
  },
  {
    name: 'wiki page get',
    group: 'Wiki',
    usage: 'wiki page get <pageId>',
    summary: '读取单个 Wiki 页面全文',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '<pageId>', desc: '页面 ID（wiki page list 输出中的 id）' }],
    build(args) {
      const pageId = args.positional[0]
      if (typeof pageId !== 'string' || pageId.length === 0) return null
      return { type: 'wiki:page:get', pageId }
    },
  },
  {
    name: 'wiki search',
    group: 'Wiki',
    usage: 'wiki search <关键词> [--limit <n>] [--session <key>]',
    summary: 'FTS5 全文检索 Wiki 页面（验证中文召回）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '<关键词>', desc: '搜索关键词（中文 bigram 切分，支持 2 字词）' },
      { flag: '--limit <n>', desc: '返回条数上限，默认 10' },
      { flag: '--session <key>', desc: '指定会话，不传则使用默认归属' },
    ],
    build(args) {
      const keyword = args.positional[0]
      if (typeof keyword !== 'string' || keyword.trim().length === 0) return null
      const body = { type: 'wiki:search', keyword }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      const limit = num(args.flags.limit)
      if (limit !== undefined && limit > 0) body.limit = limit
      return body
    },
  },
  {
    name: 'wiki runs list',
    group: 'Wiki',
    usage: 'wiki runs list [--session <key>] [--limit <n>]',
    summary: '归档运行日志（追溯页面生成依据）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--session <key>', desc: '指定会话，不传则使用默认归属' },
      { flag: '--limit <n>', desc: '返回条数上限，默认 50' },
    ],
    build(args) {
      const body = { type: 'wiki:runs:list' }
      if (typeof args.flags.session === 'string') body.sessionKey = args.flags.session
      const limit = num(args.flags.limit)
      if (limit !== undefined && limit > 0) body.limit = limit
      return body
    },
  },
  {
    name: 'wiki index rebuild',
    group: 'Wiki',
    usage: 'wiki index rebuild',
    summary: '重建 Wiki 全文检索派生索引',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [],
    build() {
      return { type: 'wiki:index:rebuild' }
    },
  },
  {
    name: 'memory rebuild-index',
    group: '记忆',
    usage: 'memory rebuild-index',
    summary: '重建 FTS5 派生索引（修复索引不一致时使用）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [],
    build() {
      return { type: 'agent:memories:rebuildIndex' }
    },
  },
  {
    name: 'pet mode',
    group: '桌宠',
    usage: 'pet mode <modeName>',
    summary: '切换桌宠模式',
    layer: 'B',
    route: { method: 'POST', path: '/ipc/pet/switchMode' },
    options: [{ flag: '<modeName>', desc: 'pet | desktop' }],
    build(args) {
      const mode = args.positional[0]
      if (mode !== 'pet' && mode !== 'desktop') return null
      return { mode }
    },
  },
  {
    name: 'pet modes',
    group: '桌宠',
    usage: 'pet modes',
    summary: '列出桌宠模型',
    layer: 'B',
    route: { method: 'POST', path: '/ipc/pet/listModels' },
    options: [],
    build() {
      return {}
    },
  },
  {
    name: 'context usage',
    group: '上下文压缩',
    usage: 'context usage --session <key>',
    summary: '查看会话上下文占用（usedTokens / contextWindow / 触发阈值）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '--session <key>', desc: '会话 key' }],
    build(args) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      return { type: 'conversation:context-usage', sessionKey }
    },
  },
  {
    name: 'context compact',
    group: '上下文压缩',
    usage: 'context compact --session <key> [--keep <n>]',
    summary: '手动触发一次上下文压缩，返回压缩前后消息数',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--session <key>', desc: '会话 key' },
      { flag: '--keep <n>', desc: '保留最近 N 轮对话，默认 6' },
    ],
    build(args) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      const body = { type: 'user:compact-context', sessionKey }
      // --keep 传了就必须是非负整数：非法值静默回落默认 6 会让调用方以为参数生效了
      if (args.flags.keep !== undefined) {
        const keep = num(args.flags.keep)
        if (keep === undefined || keep < 0 || !Number.isInteger(keep)) return null
        body.keepRecentTurns = keep
      }
      return body
    },
  },
  {
    name: 'context abort',
    group: '上下文压缩',
    usage: 'context abort --session <key>',
    summary: '中止正在进行的上下文压缩',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '--session <key>', desc: '会话 key' }],
    build(args) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      return { type: 'user:abort-compact-context', sessionKey }
    },
  },
  {
    name: 'context messages',
    group: '上下文压缩',
    usage: 'context messages --session <key> [--limit <n>]',
    summary: '读取会话消息，用于校验压缩后摘要就位、原文未丢',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--session <key>', desc: '会话 key' },
      { flag: '--limit <n>', desc: '返回条数上限' },
    ],
    build(args) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      const body = { type: 'conversation:messages', sessionKey: sessionKey }
      const limit = num(args.flags.limit)
      if (limit !== undefined) body.limit = limit
      return body
    },
  },
  {
    name: 'conversation list',
    group: '上下文压缩',
    usage: 'conversation list',
    summary: '列出会话，取 sessionKey 供上述 context 命令使用',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [],
    build() {
      return { type: 'conversation:list' }
    },
  },
  {
    name: 'conversation create',
    group: '上下文压缩',
    usage: 'conversation create [--title <t>]',
    summary: '新建会话，返回 sessionKey',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '--title <t>', desc: '会话标题（可选）' }],
    build(args) {
      const body = { type: 'conversation:create' }
      if (typeof args.flags.title === 'string') body.title = args.flags.title
      return body
    },
  },
  {
    name: 'send',
    group: '上下文压缩',
    usage: 'send --session <key> [--text <t>|--data -] [--model <id>] [--wait]',
    summary: '向会话发送一条消息（仅纯文本，附件类字段被控制口拒绝）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '--session <key>', desc: '会话 key' },
      { flag: '--text <t>', desc: '消息正文；长文本用 --data - 从 stdin 读' },
      { flag: '--data -', desc: '从 stdin 读取正文，便于灌入大段文本撑高 token' },
      { flag: '--model <id>', desc: '本次发送覆盖的模型 ID（可选）' },
    ],
    build(args, extra) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      const content = args.flags.data === '-' ? extra?.stdin ?? '' : args.flags.text
      if (typeof content !== 'string' || content.length === 0) return null
      const body = { type: 'user:send', sessionKey, content }
      if (typeof args.flags.model === 'string') body.modelId = args.flags.model
      return body
    },
  },
  {
    name: 'send abort',
    group: '上下文压缩',
    usage: 'send abort --session <key>',
    summary: '中止会话正在进行的回复',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [{ flag: '--session <key>', desc: '会话 key' }],
    build(args) {
      const sessionKey = args.flags.session
      if (typeof sessionKey !== 'string' || sessionKey.length === 0) return null
      return { type: 'user:abort', sessionKey }
    },
  },
  {
    name: 'command',
    group: '底层',
    usage: 'command <type> [--data <json>|-]',
    summary: '直接投递命令总线（受白名单约束）',
    layer: 'A',
    route: { method: 'POST', path: '/command' },
    options: [
      { flag: '<type>', desc: '命令类型，如 cron:list' },
      { flag: '--data <json>', desc: '附加参数 JSON 字符串，或 "-" 从 stdin 读' },
    ],
    build(args, extra) {
      const type = args.positional[0]
      if (typeof type !== 'string' || type.length === 0) return null
      const raw = args.flags.data
      if (raw === undefined) return { type }
      const text = raw === '-' ? extra?.stdin ?? '' : raw
      if (typeof text !== 'string' || text.length === 0) return { type }
      try {
        const parsed = JSON.parse(text)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return { type, ...parsed }
        }
        return null
      } catch {
        return null
      }
    },
  },
]
