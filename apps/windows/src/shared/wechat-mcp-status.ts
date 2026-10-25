/**
 * 「本机微信助手」这个 MCP 的**检测与兼容性判定**（纯函数，无 IO）。
 *
 * ---------------------------------------------------------------------------
 * 为什么 MCP 不再由插件安装
 * ---------------------------------------------------------------------------
 * 2026-10-25 定案：**MCP 与插件分开**。之前把 `wechat-chat-mcp` 做成插件中心的
 * 「运行时资产」，结果是两条互不相干的链路被拧在一起——
 * 插件的 `status()` 读本地 `version.json` 边车判断「装没装、要不要更新」，
 * 而 MCP 是否可用其实是**连接**说了算（配置有没有、启没启、握手成不成）。
 * 两者一旦不同步，界面就会说"可更新"而实际能跑（本机实测：边车被 PowerShell 写成
 * 带 BOM 的 JSON，解析失败 ⇒ 版本恒为未知 ⇒ 永远提示更新、每次点都重下 38MB）。
 *
 * 现在的分工：
 * - **用户自己装、自己配** MCP（`mcp-servers.json` 里写命令/参数/环境）；
 * - **客户端只检测**：有没有这条配置、开没开、连没连上、对端自报的版本与工具齐不齐；
 * - 缺了就把人**送到**「设置 › MCP 服务」去配，不在插件页放安装按钮。
 *
 * 判「兼容」不看版本号猜，而是看**本客户端真正会调的那几个工具在不在**：
 * 版本号是给用户看的提示，工具清单才是能不能用的硬事实。
 */

/** 本客户端**硬依赖**的工具（缺了就等于不能用，不是"少个功能"）。 */
export const WECHAT_MCP_REQUIRED_TOOLS = [
  'poll_new',
  'read_history',
  'send_text',
  'check_env',
  'locate_db',
] as const

/**
 * 客户端验证过的**最低版本**。
 *
 * 只作提示：低于它不一定不能用（工具齐就照跑），高于它也不代表没问题
 * （所以上面那句"看工具不看版本"才是判据）。推断/不报版本时不做任何结论。
 */
export const WECHAT_MCP_MIN_VERSION = '0.10.0'

export type WechatMcpState =
  /** `mcp-servers.json` 里没有 `wechat-chat` 这一条 */
  | 'not-configured'
  /** 有配置但被关掉了 */
  | 'disabled'
  /** 配置在、已启用，但没连上（进程起不来 / 密钥没就绪 / 命令不对） */
  | 'not-connected'
  /** 连上了，但关键工具缺失：不可用 */
  | 'incompatible'
  /** 连上了且关键工具齐全 */
  | 'ready'

export interface WechatMcpStatusInput {
  /** 配置里有这条 Server */
  configured: boolean
  /** 条目是否启用（未配置时传什么都不影响结论） */
  enabled?: boolean
  connected: boolean
  /** 握手时对端自报的版本（`serverInfo.version`）；没报就是 `undefined` */
  serverVersion?: string
  /** 已加载的工具名，可带 `mcp__<server>__` 前缀 */
  tools?: readonly string[]
  /** 最近一次连接失败的原因（原样转述，别改写） */
  lastError?: string
  /** 比较版本用（测试注入；默认 `compareVersions`） */
  compare?: (a: string, b: string) => number
}

export interface WechatMcpVerdict {
  state: WechatMcpState
  /** 一句话结论（卡片上直接显示） */
  label: string
  /** 还缺哪些客户端要用的工具（空 = 齐） */
  missingTools: readonly string[]
  /** 版本低于验证下限（**只提示，不阻断**：工具齐就是能用） */
  outdated: boolean
  /** 下一步该做什么（缺东西时给；ready 时没有） */
  hint?: string
}

/** 去掉 `mcp__<server>__` 前缀，只留工具本名 */
export function bareToolName(name: string): string {
  const m = /^mcp__[^_].*?__(.+)$/.exec(name)
  return m ? m[1]! : name
}

function defaultCompare(a: string, b: string): number {
  const core = (v: string) => v.split(/[-+]/, 1)[0]!.split('.').map((n) => Number(n) || 0)
  const [x, y] = [core(a), core(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/**
 * 判定当前状态。**只根据事实下结论**：连没连、工具齐不齐、版本报了多少。
 *
 * 优先级（后面的都不成立才轮到前一个）：
 * 未配置 → 已停用 → 未连接 → 工具不全（不兼容）→ 可用。
 * 「未配置」排最前：没这条配置时，`enabled` / `connected` 都是空值，说别的没意义。
 */
export function evaluateWechatMcp(input: WechatMcpStatusInput): WechatMcpVerdict {
  const compare = input.compare ?? defaultCompare
  const version = input.serverVersion?.trim() || undefined
  const outdated = !!version && compare(version, WECHAT_MCP_MIN_VERSION) < 0

  if (!input.configured) {
    return {
      state: 'not-configured',
      label: '未配置',
      missingTools: [],
      outdated: false,
      hint: '还没有在本机配置这个 MCP：到「设置 › MCP 服务」添加（命令指向你装好的 wechat-chat-mcp.exe）。',
    }
  }
  if (input.enabled === false) {
    return {
      state: 'disabled',
      label: '已停用',
      missingTools: [],
      outdated,
      hint: '配置在，但开关是关的：到「设置 › MCP 服务」打开它。',
    }
  }
  if (!input.connected) {
    return {
      state: 'not-connected',
      label: '未连接',
      missingTools: [],
      outdated,
      hint: input.lastError
        ? `连接失败：${input.lastError}`
        : '配置在，但没连上：检查命令路径是否正确、微信是否已登录。',
    }
  }

  const present = new Set((input.tools ?? []).map(bareToolName))
  const missingTools = WECHAT_MCP_REQUIRED_TOOLS.filter((t) => !present.has(t))
  if (missingTools.length > 0) {
    return {
      state: 'incompatible',
      label: '版本不兼容',
      missingTools,
      outdated,
      hint: `这个 Server 缺本客户端要用的工具（${missingTools.join('、')}）：换一个兼容的版本。`,
    }
  }

  return {
    state: 'ready',
    label: outdated ? `v${version}（低于验证版 ${WECHAT_MCP_MIN_VERSION}）` : version ? `v${version}` : '已连接',
    missingTools: [],
    outdated,
  }
}

/** 这一档能不能直接代聊（只有 ready 能） */
export function isWechatMcpUsable(state: WechatMcpState): boolean {
  return state === 'ready'
}
