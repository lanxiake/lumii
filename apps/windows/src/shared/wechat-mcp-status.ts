/**
 * 「本机微信」的**就绪判定**（纯函数，无 IO）。
 *
 * ---------------------------------------------------------------------------
 * 为什么不再是「MCP 的检测」
 * ---------------------------------------------------------------------------
 * 2026-10-28 定案：本机微信的能力**已归内置扩展** `com.lumii.pcwechat`——它以原生工具
 * 注册（31 个，名字不带 `mcp__` 前缀），底层是一个应用托管的 Python 侧车进程
 * （`main/agent-runtime/wechat-sidecar-client.ts`）。用户不再需要自己装/配任何 MCP，
 * 「能不能用」由**扩展开关**与**侧车能不能拉起**两件事决定。
 *
 * 于是这里判的是：
 * - `pluginEnabled: false` → 扩展没开（用户自己的选择，去设置里打开）
 * - 侧车拉不起来 → 环境问题（Python 运行时 / 依赖 / 脚本缺失），把原因如实报出来
 * - 拉起来了但关键工具缺失 → 版本不匹配（理论上不该发生，同包发布）
 *
 * 文件名与导出名保留 `wechat-mcp-status` / `WechatMcp*`：这是 UI 与 preload 层的既有
 * 契约，改名要动一串文件却没有信息增益。**语义以本注释为准。**
 *
 * 判「可用」不看版本号猜，而是看**本客户端真正会调的那几个工具在不在**：
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

/** 侧车自报版本的下限（只提示，不阻断——工具齐就照跑） */
export const WECHAT_MCP_MIN_VERSION = '0.10.0'

export type WechatMcpState =
  /** 扩展 `com.lumii.pcwechat` 没启用（默认就是这一档，要用户手动开） */
  | 'not-configured'
  /** 保留：内置扩展没有独立于「启用」的第二道开关，这一档不再产生 */
  | 'disabled'
  /** 扩展开着，但侧车拉不起来（Python 运行时/依赖/脚本问题） */
  | 'not-connected'
  /** 侧车起来了，但关键工具缺失：不可用 */
  | 'incompatible'
  /** 侧车起来了且关键工具齐全 */
  | 'ready'

export interface WechatMcpStatusInput {
  /** 扩展 `com.lumii.pcwechat` 是否启用 */
  pluginEnabled: boolean
  /** 侧车进程是否就绪（`getWechatSidecar().isReady()`） */
  sidecarReady: boolean
  /** 侧车 `initialize` 自报的版本；没报就是 `undefined` */
  serverVersion?: string
  /** 已加载的工具名（可能是裸名，也可能带 `mcp__<server>__` 前缀——老写法兼容） */
  tools?: readonly string[]
  /** 侧车拉不起来时的原因（原样转述，别改写） */
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
 * 判定当前状态。**只根据事实下结论**：扩展开没开、侧车起没起来、工具齐不齐。
 *
 * 优先级（后面的都不成立才轮到前一个）：
 * 未启用 → 侧车没起来 → 工具不全（不兼容）→ 可用。
 *
 * @param input 事实
 */
export function evaluateWechatMcp(input: WechatMcpStatusInput): WechatMcpVerdict {
  const compare = input.compare ?? defaultCompare
  const version = input.serverVersion?.trim() || undefined
  const outdated = !!version && compare(version, WECHAT_MCP_MIN_VERSION) < 0

  if (!input.pluginEnabled) {
    return {
      state: 'not-configured',
      label: '未启用',
      missingTools: [],
      outdated: false,
      hint: '本机微信默认关闭：到「设置 › 插件 › 本机微信」打开它，能力才会注入。',
    }
  }
  if (!input.sidecarReady) {
    return {
      state: 'not-connected',
      label: '未就绪',
      missingTools: [],
      outdated,
      hint: input.lastError
        ? `侧车没起来：${input.lastError}`
        : '扩展已启用，但侧车进程没起来：检查 Python 运行时是否就位、微信是否已登录。',
    }
  }

  const present = new Set((input.tools ?? []).map(bareToolName))
  const missingTools = WECHAT_MCP_REQUIRED_TOOLS.filter((t) => !present.has(t))
  if (missingTools.length > 0) {
    return {
      state: 'incompatible',
      label: '不完整',
      missingTools,
      outdated,
      hint: `侧车缺本客户端要用的工具（${missingTools.join('、')}）：应用可能装坏了，重装或更新到匹配版本。`,
    }
  }

  return {
    state: 'ready',
    label: outdated ? `v${version}（低于验证版 ${WECHAT_MCP_MIN_VERSION}）` : version ? `v${version}` : '已就绪',
    missingTools: [],
    outdated,
  }
}

/** 这一档能不能直接代聊（只有 ready 能） */
export function isWechatMcpUsable(state: WechatMcpState): boolean {
  return state === 'ready'
}
