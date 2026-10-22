import { definePlugin, type PluginContext } from '@mtbot/plugin-core'

import {
  DEFAULT_PROMPT_STYLE,
  normalizePromptStyle,
  type PromptStyleValue,
} from '../../../shared/prompt-style'
import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'

/**
 * 提示词风格（实验功能）——供核心每轮 prompt 读取的档位。
 *
 * 核心消费点固定在两处（`bridge-prompt-dispatcher` 每轮、`bridge-instance-factory`
 * 建实例时），它们只认 `S.promptStyle`。插件停用后服务从容器里消失，核心自然回落到
 * `DEFAULT_PROMPT_STYLE` —— 这条路径就是「禁用即功能消失」的判据。
 *
 * 值从渲染层来（`localStorage['mtbot-assistant-settings'].promptStyle.style`），
 * 切换时渲染层推一次 IPC；冷启动时缓存为空，回读一次渲染层，失败则用默认档。
 * 不做文件存储：这是纯展示偏好，丢了也只是回到默认。
 */

export interface PromptStyleService {
  get(): Promise<{ style: PromptStyleValue }>
}

/** 渲染层切换后写入；避免每轮都 executeJavaScript 读一次 localStorage */
let cache: { style: PromptStyleValue } | null = null

const SETTINGS_LOCAL_STORAGE_KEY = 'mtbot-assistant-settings'

/** 冷启动兜底：从渲染层 localStorage 读一次（窗口没就绪时返回 null） */
async function readFromRendererStyle(
  ctx: PluginContext<MainEvents>,
): Promise<PromptStyleValue | null> {
  const window = ctx.get(S.mainWindow)?.get()
  if (!window || window.isDestroyed()) return null
  try {
    const raw = await window.webContents.executeJavaScript(
      `localStorage.getItem('${SETTINGS_LOCAL_STORAGE_KEY}')`,
    )
    if (typeof raw !== 'string' || !raw) return null
    const parsed = JSON.parse(raw) as { promptStyle?: { style?: unknown } }
    return normalizePromptStyle(parsed?.promptStyle?.style)
  } catch {
    // 渲染层可能还没准备好；按默认档走
    return null
  }
}

export const promptStyleExtension = {
  manifest: {
    id: 'com.lumii.prompt-style',
    name: '提示词风格',
    version: '0.1.0',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.prompt-style',
    apply(ctx) {
      // 渲染层切档：写缓存。通道名沿用设置页的既有约定（不是插件专属前缀），
      // 因为它在插件化之前就存在，改名要同时动 preload 与渲染层。
      ctx.registerIpc?.('settings:updatePromptStyle', (_event, payload) => {
        const value = (payload as { style?: unknown } | null)?.style
        cache = { style: normalizePromptStyle(value) }
      })

      ctx.provide(S.promptStyle, {
        get: async () => cache ?? { style: (await readFromRendererStyle(ctx)) ?? DEFAULT_PROMPT_STYLE },
      } satisfies PromptStyleService)

      // 停用即回到默认档：缓存不清的话，重新启用前核心读到的还是旧值
      ctx.effect(() => {
        cache = null
      })
    },
  }),
}
