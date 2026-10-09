/**
 * 本机微信（pcwechat）环境**确定性自检**。
 *
 * 换机部署后最常见的两件事：① 微信数据目录不在默认位置（读不到库）；② 微信主窗口
 * 最小化 / 收进托盘 / 尺寸漂移（发不出去，且报 `target_unconfirmed`）。这里跑一遍 MCP 的
 * `check_env` + `locate_db`，把「哪一步不对、数据目录是从哪找到的」如实报出来。
 *
 * **纯确定性**：不叫模型、零 token（用户 2026-10-09 决策）。UI 的「重新检测 / 一键修复」
 * 与它共用同一份实现；「一键修复」= 调 MCP `repair_env`（还原窗口 + 规范化 + 重探目录）+ 复检。
 *
 * 另按用户决策"两者都做"：探测到数据目录、而 MCP 配置里没显式写 `LUMII_WECHAT_DB` 时**补写**一次。
 * 补写只针对 `wechat-local` 且**只在缺失时**（用户显式填过的值不覆盖）。
 */
import { loadMcpServerConfigs, saveMcpServerConfigs } from '../config/mcp-config'
import { WECHAT_WATCH_MCP_SERVER } from '../agent-runtime/wechat-watch-tick'

export interface WechatSelfcheck {
  /** 自检时刻（ms） */
  at: number
  /** wechat-local MCP 是否连着 */
  connected: boolean
  /** 数据目录定位结果 */
  db: {
    ok: boolean
    root: string | null
    /** 从哪找到的：env / ini / registry / default / scan */
    source: string | null
    wxid: string | null
  }
  /** `check_env` 原始返回（微信进程/窗口/锁屏/尺寸/依赖/hint）；连不上时为 null */
  env: Record<string, unknown> | null
  /** 本次自检做的动作（如"已把数据目录写入 MCP 配置"） */
  actions: string[]
  /** 整体是否可用（数据目录 OK + MCP 已连 + check_env ok） */
  ok: boolean
  /** 失败时的一句话原因 */
  reason: string
}

export type CallMcpTool = (
  server: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<string>

/** 探测到的数据目录写进 MCP 配置（仅当缺失时）。返回是否真的写了。 */
export function writeWechatDbToConfig(root: string): boolean {
  if (!root) return false
  try {
    const entries = loadMcpServerConfigs()
    const idx = entries.findIndex((e) => e.name === WECHAT_WATCH_MCP_SERVER)
    if (idx === -1) return false
    const cur = entries[idx]
    if (cur.env?.LUMII_WECHAT_DB) return false // 用户已显式填过，别覆盖
    const next = [...entries]
    next[idx] = { ...cur, env: { ...(cur.env ?? {}), LUMII_WECHAT_DB: root } }
    saveMcpServerConfigs(next)
    return true
  } catch {
    return false
  }
}

/**
 * 跑一次自检。`callMcpTool` 由调用方注入（生产走 `bridge.callMcpTool`）。
 * 任何异常都收敛成 `ok:false` + `reason`，绝不抛（这是个诊断入口，不该把 UI 炸掉）。
 */
export async function runWechatSelfcheck(
  callMcpTool: CallMcpTool,
  opts: { writeConfig?: boolean } = {},
): Promise<WechatSelfcheck> {
  const actions: string[] = []
  const out: WechatSelfcheck = {
    at: Date.now(),
    connected: false,
    db: { ok: false, root: null, source: null, wxid: null },
    env: null,
    actions,
    ok: false,
    reason: '',
  }
  try {
    const envRaw = await callMcpTool(WECHAT_WATCH_MCP_SERVER, 'check_env', {})
    out.env = JSON.parse(envRaw) as Record<string, unknown>
    out.connected = true
  } catch (err) {
    out.reason = `wechat-local MCP 未连接：${err instanceof Error ? err.message : String(err)}`
    return out
  }
  try {
    const dbRaw = await callMcpTool(WECHAT_WATCH_MCP_SERVER, 'locate_db', {})
    const db = JSON.parse(dbRaw) as {
      found?: boolean
      root?: string | null
      source?: string | null
      wxid?: string | null
    }
    out.db = {
      ok: db.found === true,
      root: db.root ?? null,
      source: db.source ?? null,
      wxid: db.wxid ?? null,
    }
  } catch (err) {
    out.reason = `数据目录探测失败：${err instanceof Error ? err.message : String(err)}`
    return out
  }
  // 探测到目录、配置里没写 → 补写一次（用户决策"两者都做"）
  if (out.db.ok && out.db.root && opts.writeConfig !== false) {
    if (writeWechatDbToConfig(out.db.root)) {
      actions.push(`已把数据目录写入 MCP 配置（${out.db.root}）；重连本 MCP 后生效`)
    }
  }
  const envOk = out.env?.ok === true
  out.ok = out.db.ok && envOk
  if (!out.ok) {
    out.reason = !out.db.ok
      ? '未找到微信数据目录（确认微信已登录、或在设置里指定）'
      : String(out.env?.reason || '微信窗口不可用（最小化/收进托盘/锁屏）')
  }
  return out
}

/**
 * 一键修复：调 MCP `repair_env`（还原窗口 + 规范化到预设尺寸 + 重探目录），再复检一次。
 */
export async function repairWechatEnv(callMcpTool: CallMcpTool): Promise<{
  repaired: Record<string, unknown> | null
  selfcheck: WechatSelfcheck
}> {
  let repaired: Record<string, unknown> | null = null
  try {
    const raw = await callMcpTool(WECHAT_WATCH_MCP_SERVER, 'repair_env', {})
    repaired = JSON.parse(raw) as Record<string, unknown>
  } catch {
    repaired = null
  }
  const selfcheck = await runWechatSelfcheck(callMcpTool, { writeConfig: true })
  return { repaired, selfcheck }
}
