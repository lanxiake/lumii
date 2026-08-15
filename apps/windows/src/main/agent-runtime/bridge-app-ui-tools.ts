/**
 * Agent App UI 控制工具注册（Part A/B：app_screenshot / app_goto / app_act）
 *
 * 从 BridgeToolRegistrar.registerAppUiTools() 提取。
 * 通过 createAppUiController 截取主窗口并操作界面，注册三工具。
 */

import { Type } from '@sinclair/typebox'
import { ToolRegistry, createMtBotTool, type ToolExecutionContext, type MtBotTool } from '@mtbot/agent-runtime'
import {
  createAppUiController,
  type AppUiController,
  type ResizeImageFn,
} from '../app-ui-control'
import { isAppUiControlEnabled } from '../app-ui-control/enabled'
import type { BrowserWindow } from 'electron'
import { agentRuntimeLog as log, jsonToolResult } from './bridge-utils'

/**
 * 单轮各工具调用配额。
 *
 * 只给固定额度时，录教学视频、逐字段填表这类长任务会在一轮里被卡死（用户实测：
 * 8 张截图刚够打开设置页，之后只能干等）。改成「基础额度 + 按轮次时长续杯」：
 * 起步额度足够常规操作，长任务每多跑一分钟再补一批，同时用硬上限兜住失控循环。
 */
export const APP_UI_QUOTA = {
  screenshot: { base: 40, refillPerMinute: 20, max: 300 },
  act: { base: 120, refillPerMinute: 60, max: 900 },
  goto: { base: 60, refillPerMinute: 20, max: 300 },
} as const

type AppUiToolKind = keyof typeof APP_UI_QUOTA

/** 续杯周期（毫秒） */
const REFILL_INTERVAL_MS = 60_000

/** 当前轮次已用配额（模块级，agent:turn:end 时重置） */
const turnQuotas: Record<AppUiToolKind, number> = {
  screenshot: 0,
  act: 0,
  goto: 0,
}

/** 本轮首次调用时间，用于计算续杯次数；未调用过时为 null */
let turnStartedAt: number | null = null

/** 重置单轮 App UI 工具调用配额（agent:turn:end 时调用） */
export function resetAppUiToolTurnQuotas(): void {
  turnQuotas.screenshot = 0
  turnQuotas.act = 0
  turnQuotas.goto = 0
  turnStartedAt = null
}

/**
 * 计算某工具在当前时刻的有效上限：基础额度 + 已过分钟数 × 每分钟续杯量，封顶 max。
 */
function effectiveLimit(kind: AppUiToolKind, now: number): number {
  const { base, refillPerMinute, max } = APP_UI_QUOTA[kind]
  const elapsedMs = turnStartedAt == null ? 0 : Math.max(0, now - turnStartedAt)
  const refills = Math.floor(elapsedMs / REFILL_INTERVAL_MS)
  return Math.min(max, base + refills * refillPerMinute)
}

/** 配额超限时回传给模型的信息，避免它盲目 sleep 或反复重试 */
export interface AppUiQuotaExceeded {
  ok: false
  error: 'quota_exceeded'
  tool: AppUiToolKind
  used: number
  limit: number
  /** 距离下一次续杯还需等待的秒数；已到硬上限时为 null */
  retryAfterSec: number | null
  hint: string
}

/**
 * 尝试消耗指定工具的配额；超限时返回剩余量与下次续杯时间。
 */
function consumeAppUiQuota(kind: AppUiToolKind): AppUiQuotaExceeded | null {
  const now = Date.now()
  if (turnStartedAt == null) {
    turnStartedAt = now
  }

  const limit = effectiveLimit(kind, now)
  if (turnQuotas[kind] < limit) {
    turnQuotas[kind] += 1
    return null
  }

  const atHardCap = limit >= APP_UI_QUOTA[kind].max
  const elapsedMs = now - (turnStartedAt ?? now)
  const retryAfterSec = atHardCap
    ? null
    : Math.max(1, Math.ceil((REFILL_INTERVAL_MS - (elapsedMs % REFILL_INTERVAL_MS)) / 1000))

  return {
    ok: false,
    error: 'quota_exceeded',
    tool: kind,
    used: turnQuotas[kind],
    limit,
    retryAfterSec,
    hint: atHardCap
      ? `本轮 ${kind} 调用已达硬上限 ${limit} 次，请结束当前回复并让用户确认后再继续`
      : `本轮 ${kind} 额度暂时用尽，${retryAfterSec} 秒后自动补充 ${APP_UI_QUOTA[kind].refillPerMinute} 次；期间可先做别的步骤`,
  }
}

/** registerAppUiTools 依赖（controller 可选，供单测注入 mock） */
export interface RegisterAppUiToolsDeps {
  getWindow: (target: 'main' | 'pet' | 'preview') => BrowserWindow | null
  resizeImageIfNeeded: ResizeImageFn
  /** 读取渲染进程 localStorage 设置 JSON（与 getRendererSettings 同模式） */
  readSettingsJson?: () => Promise<string | null>
  /** 测试注入：跳过 createAppUiController */
  controller?: AppUiController
}

/** app_goto 工具 description（设计 §13.2 分工原文，goto 相关行） */
const APP_GOTO_DESCRIPTION = `打开页面：app_goto（设置/技能/定时等用这个，不要点侧栏）
改思考级别/会话/技能执行/定时：用已有 settings_think、session_*、skill_*、cron_*
外部网页：browser_*
做完写操作后必须再截图或查询确认`

/** app_act 工具 description（设计 §13.2 分工原文 + type/select/key/scroll） */
const APP_ACT_DESCRIPTION = `点控件：app_act click（先截图拿 ref，ref 不跨 snapshotId 复用）
输入文本：app_act type（ref + text，默认整体替换；append=true 才追加。返回写入后的实际值，无需再截图确认）
下拉框：app_act select（ref + value 或 label）。原生下拉点击弹的是系统菜单，截图看不到，必须用 select
按键：app_act key（白名单 Enter/Escape/Tab/Backspace/Delete/Home/End/PageUp/PageDown/Space/方向键，无需 ref）
滚动：app_act scroll（ref + dx/dy，自动滚 ref 所在的可滚动容器；回读 moved/atBottom 判断是否到底）
失败码含义：click_blocked=被弹层挡住先关弹窗；use_select_action=改用 select；not_editable=ref 不是输入框；stale_snapshot=重新截图
做完写操作后必须再截图或查询确认
禁止点聊天输入框和发送键
app_act "始终允许"仅本次运行有效，重启后重置`

const APP_ACT_ACTIONS = ['click', 'type', 'select', 'key', 'scroll'] as const
type AppActAction = (typeof APP_ACT_ACTIONS)[number]

/**
 * 注册 Agent 操作本客户端界面的工具（MVP：app_screenshot / app_goto / app_act）。
 */
export function registerAppUiTools(
  toolRegistry: ToolRegistry,
  ctx: ToolExecutionContext,
  deps: RegisterAppUiToolsDeps,
): void {
  const controller =
    deps.controller ??
    createAppUiController({
      getWindow: deps.getWindow,
      resizeImageIfNeeded: deps.resizeImageIfNeeded,
    })

  const readSettingsJson = deps.readSettingsJson ?? (async () => null)

  /** 总开关与配额前置检查 */
  async function guardAppUiTool(
    kind: AppUiToolKind,
  ): Promise<{ ok: false; error: string } | AppUiQuotaExceeded | null> {
    if (!(await isAppUiControlEnabled(readSettingsJson))) {
      return { ok: false, error: 'disabled' }
    }
    return consumeAppUiQuota(kind)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (tool: any) => toolRegistry.register(tool as MtBotTool)

  reg(
    createMtBotTool(
      {
        name: 'app_screenshot',
        label: 'App Screenshot',
        category: 'channel' as const,
        description:
          '截取 Lumii 主窗口或桌宠窗口当前界面，返回可交互元素 refs 与截图文件路径。' +
          'refs 已剔除被弹层遮挡的元素，并带上输入框当前值 value、占位符 placeholder、下拉框选项 options，' +
          '据此判断字段是否已填、下拉框有哪些可选值，通常不必再读图片。只截图，不操作界面。',
        parameters: Type.Object({
          annotate: Type.Optional(
            Type.Boolean({ description: '是否在截图上标注元素编号（SoM）' }),
          ),
          target: Type.Optional(
            Type.String({
              description: '截图目标：main（默认）| pet | preview（preview 暂未支持）',
            }),
          ),
        }),
        isReadOnly: true,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const blocked = await guardAppUiTool('screenshot')
          if (blocked) return jsonToolResult(blocked)

          const params = rawParams as Record<string, unknown>
          const annotate = params.annotate === true
          const targetRaw = params.target
          const target =
            targetRaw === 'pet' || targetRaw === 'preview' || targetRaw === 'main'
              ? targetRaw
              : undefined

          try {
            const result = await controller.screenshot({ annotate, target })
            if (!result.ok) {
              return jsonToolResult({ ok: false, error: result.error })
            }

            // 不把 JPEG base64 内联进上下文（避免大量无法阅读的数据污染 LLM）；
            // 只回文件路径 + refs，与 image_generate / browser_screenshot 同约定。
            const payload = {
              ok: true as const,
              snapshotId: result.snapshotId,
              view: result.viewState.view,
              hub: result.viewState.hub,
              width: result.width,
              height: result.height,
              refs: result.refs,
              truncated: result.truncated,
              imagePath: result.previewPath,
              note:
                `截图已保存，文件的唯一有效路径是 "${result.previewPath}"。` +
                `界面可交互元素见 refs：value 是输入框当前内容（空串表示未填，password 已脱敏），` +
                `placeholder 只是占位提示不代表已填；combobox 的 options 为全部可选项，请用 app_act select 选中。` +
                `如需查看图片内容请用该路径读取，严禁根据语义自行编造文件名。`,
            }

            return {
              content: [{ type: 'text', text: JSON.stringify(payload) }],
              details: { previewPath: result.previewPath },
            }
          } catch {
            return jsonToolResult({ ok: false, error: 'capture_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'app_goto',
        label: 'App Goto',
        category: 'channel' as const,
        description: APP_GOTO_DESCRIPTION,
        parameters: Type.Object({
          view: Type.String({
            description:
              '目标视图：dashboard | chat | skills | settings | memories | agents | cron | plugins | mcp',
          }),
          category: Type.Optional(
            Type.String({
              description:
                'Settings Hub 分类（可选）：general | workspace | modelConfig | voice | channels | codingDev | pet | usage | privacy | aboutAndUpdate',
            }),
          ),
        }),
        isReadOnly: false,
        needsPermission: false,
        execute: async (_id, rawParams) => {
          const blocked = await guardAppUiTool('goto')
          if (blocked) return jsonToolResult(blocked)

          try {
            const result = await controller.goto(rawParams)
            return jsonToolResult(result)
          } catch {
            return jsonToolResult({ ok: false, error: 'goto_failed' })
          }
        },
      },
      ctx,
    ),
  )

  reg(
    createMtBotTool(
      {
        name: 'app_act',
        label: 'App Act',
        category: 'channel' as const,
        description: APP_ACT_DESCRIPTION,
        parameters: Type.Object({
          action: Type.String({ description: '操作类型：click | type | select | key | scroll' }),
          ref: Type.Optional(
            Type.String({
              description: '来自 app_screenshot 的元素 ref（click/type/select/scroll 必填）',
            }),
          ),
          snapshotId: Type.Optional(
            Type.String({ description: '截图返回的 snapshotId，用于校验 ref 未过期' }),
          ),
          text: Type.Optional(Type.String({ description: 'type 操作要写入的文本' })),
          append: Type.Optional(
            Type.Boolean({ description: 'type 是否追加到原内容末尾，默认 false（整体替换）' }),
          ),
          clear: Type.Optional(
            Type.Boolean({ description: '已废弃：type 默认就是先清空再写入，可不传' }),
          ),
          value: Type.Optional(
            Type.String({ description: 'select 要选中的选项 value（与 label 二选一）' }),
          ),
          label: Type.Optional(
            Type.String({ description: 'select 要选中的选项可读文案（与 value 二选一）' }),
          ),
          key: Type.Optional(
            Type.String({
              description:
                'key 操作的白名单按键：Enter | Escape | Tab | Backspace | Delete | Home | End | PageUp | PageDown | Space | ArrowUp/Down/Left/Right',
            }),
          ),
          dx: Type.Optional(Type.Number({ description: 'scroll 水平偏移像素' })),
          dy: Type.Optional(Type.Number({ description: 'scroll 垂直偏移像素' })),
        }),
        isReadOnly: false,
        needsPermission: true,
        execute: async (_id, rawParams) => {
          const params = rawParams as Record<string, unknown>
          const action = params.action
          if (typeof action !== 'string' || !APP_ACT_ACTIONS.includes(action as AppActAction)) {
            return jsonToolResult({ ok: false, error: 'usage' })
          }

          const blocked = await guardAppUiTool('act')
          if (blocked) return jsonToolResult(blocked)

          try {
            let result
            switch (action as AppActAction) {
              case 'click':
                result = await controller.click(rawParams)
                break
              case 'type':
                result = await controller.type(rawParams)
                break
              case 'select':
                result = await controller.select(rawParams)
                break
              case 'key':
                result = await controller.key(rawParams)
                break
              case 'scroll':
                result = await controller.scroll(rawParams)
                break
            }
            return jsonToolResult(result)
          } catch {
            return jsonToolResult({ ok: false, error: 'act_failed' })
          }
        },
      },
      ctx,
    ),
  )

  log.info('[registerAppUiTools] app_screenshot, app_goto, app_act registered')
}
