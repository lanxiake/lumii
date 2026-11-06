/**
 * 教学视频扩展（Code2Video 范式）。
 *
 * ## 它做什么
 *
 * 给一个知识点，产出一条**教学视频 MP4**：大纲 → 分镜 → 逐节动画 → 合成。
 * 方法论移植自 [showlab/Code2Video](https://github.com/showlab/Code2Video)
 *（NeurIPS 2025 DL4C），但没有沿用它的 Manim 渲染器。
 *
 * ## 为什么不用 Manim
 *
 * Manim 需要 Python + OpenGL 栈（moderngl/pyglet/pycairo）。本应用的嵌入式
 * Python 连 `venv` 模块都没有（实测 `No module named venv`），而 Manim 在
 * Windows 无 GPU 机器上的安装失败率是社区头号问题。所以渲染走 HTML：
 * 用已有的 playwright-core 驱动本机 Chrome，逐帧截图后由 ffmpeg 合成。
 * 零新增依赖，代价是没有 LaTeX 数学排版。
 *
 * ## 为什么是插件而不是流水线
 *
 * 流水线引擎**没有循环/条件/并发**（`runner.ts` 只有顺序 + 向后引用），而这个
 * 能力天生需要「模型输出不合格就重试」「逐节渲染失败跳过继续」。硬塞进流水线
 * 只能砍掉重试，那就不是这个能力了。仓库自己的判据也指向技能/插件：
 * 「交付物形状固定 → 流水线；内容取决于输入 → 技能」。
 *
 * ## 依赖与降级
 *
 * 需要：模型 chat 槽（必配）、Chrome/Edge（必装）、ffmpeg（有包内回退）。
 * 缺 Chrome 时工具仍注册，但调用会返回明确错误——**不会**自作主张去下载浏览器。
 */

import { definePlugin } from '@mtbot/plugin-core'
import { BrowserWindow } from 'electron'

import type { MainEvents } from '../../../main/kernel/events'
import { S } from '../../../main/kernel/services'
import { createElectronRenderer, type ElectronWindowLike } from './impl/electron-renderer'
import { createTeachingVideoService, type GenerateResult } from './impl/teaching-service'
import { createTool, teachingVideoToolConfig, toolResult } from './tool-config'

/**
 * 本地日志器。
 *
 * 不 import `main/agent-runtime/bridge-utils` 的 `agentRuntimeLog`：那个模块为了
 * 几个常量整包引 `@mtbot/agent-runtime`，而外部扩展是独立打包的——实测因此多背
 * 5MB（openai / anthropic-sdk / pi-ai / google-auth 全被打进来）。
 * 前缀与实际日志口径保持一致，便于在 `~/.lumii/logs/app` 里 grep。
 */
const log = {
  info: (...args: unknown[]) => console.log('[code2video]', ...args),
  warn: (...args: unknown[]) => console.warn('[code2video]', ...args),
  error: (...args: unknown[]) => console.error('[code2video]', ...args),
}

export interface TeachingVideoToolResult extends GenerateResult {
  /** 给模型的下一步提示（成功时告诉它去哪里取文件） */
  hint?: string
}

export const code2videoExtension = {
  manifest: {
    id: 'com.lumii.code2video',
    name: '教学视频',
    version: '0.1.0',
    description: '按知识点生成 3Blue1Brown 风格的教学视频（大纲→分镜→动画→合成）',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    // ffmpeg 有包内/系统 PATH 回退；Chrome 由渲染侧探测，两者缺一个就降级而不是拒绝加载
    requires: { assets: ['ffmpeg'], optional: true },
    origin: 'official' as const,
    main: './main.js',
  },
  definition: definePlugin<MainEvents>({
    id: 'com.lumii.code2video',
    apply(ctx) {
      const wire = (): boolean => {
        const bridge = ctx.get(S.agentRuntime)?.get()
        if (!bridge) return false
        const workspaceDir = ctx.get(S.workspaceDir)?.get()
        if (!workspaceDir) return false

        const ex = bridge.createPipelineExecutor()

        // 渲染窗口：应用本身就是 Chromium，用隐藏 BrowserWindow + capturePage，
        // 不引入 playwright-core、也不依赖用户机器上装没装 Chrome
        const createBrowser = createElectronRenderer({
          createWindow: (opts) =>
            new BrowserWindow({
              width: opts.width,
              height: opts.height,
              // **必须**：不写这个，width/height 是"含边框的窗口尺寸"，内容区会比
              // 它小（实测 1280×720 的窗口只截出 1264×655），按 1280 排版的 HTML
              // 右侧会被裁掉一截
              useContentSize: true,
              show: opts.show,
              webPreferences: opts.webPreferences,
            }) as unknown as ElectronWindowLike,
          ffmpeg: ex.ffmpeg,
          log: (m: string) => log.info(m),
        })

        const service = createTeachingVideoService({
          callLLM: (prompt, purpose) => ex.callLLM(prompt, `teaching_video_${purpose}`),
          ffmpeg: ex.ffmpeg,
          createBrowser,
          // 产物落在工作区 outputs/ 下：与其它产出同一条「用户能找到」的路径，
          // 也能被产物台账/预览面板识别
          outputRoot: () => `${workspaceDir}/outputs/teaching-video`,
          log: (m) => log.info(m),
          onProgress: (e) => {
            try {
              ex.emitProgress({
                runId: 'teaching-video',
                i: 0,
                total: 0,
                stepId: e.stage,
                ...(e.detail ? { label: e.detail } : {}),
                status: 'running',
              })
            } catch {
              // 进度只是界面提示，推不出去不影响生成
            }
          },
        })

        const toolConfig = {
          ...teachingVideoToolConfig,
          execute: async (_toolCallId: string, rawParams: unknown) => {
            const p = rawParams as {
              topic?: string
              audience?: string
              durationMinutes?: number
            }
            if (!p.topic?.trim()) {
              return toolResult({ status: 'error', message: '缺少 topic（要讲的知识点）' })
            }
            try {
              const result = await service.generate({
                topic: p.topic.trim(),
                ...(p.audience?.trim() ? { audience: p.audience.trim() } : {}),
                ...(typeof p.durationMinutes === 'number' ? { durationMinutes: p.durationMinutes } : {}),
              })
              if (!result.ok) {
                return toolResult({
                  status: 'error',
                  message: result.error ?? '生成失败',
                  ...(result.outlinePath ? { outlinePath: result.outlinePath } : {}),
                  ...(result.storyboardPath ? { storyboardPath: result.storyboardPath } : {}),
                })
              }
              return toolResult({
                status: 'ok',
                videoPath: result.videoPath,
                sections: result.storyboard?.sections.length ?? 0,
                durationMs: result.durationMs,
                ...(result.overlaps?.length
                  ? {
                      layoutWarnings: result.overlaps.map((o) => ({
                        section: o.section,
                        pairs: o.pairs,
                      })),
                    }
                  : {}),
                hint: '视频已生成。在回复里用 markdown 链接或文件引用指向 videoPath，不要重新生成。',
              })
            } catch (err) {
              log.error('[code2video] 生成异常:', err)
              return toolResult({
                status: 'error',
                message: err instanceof Error ? err.message : String(err),
              })
            }
          },
        }

        ctx.effect(ex.registerTool(toolConfig as unknown as { name: string }, createTool))
        log.info('[code2video] teaching_video_generate 已注册')
        return true
      }

      if (!wire()) {
        ctx.on('agent:runtime-ready', () => {
          wire()
        })
      }
    },
  }),
}

// 外部扩展加载器按 `export default { manifest, definition }` 读取。
export default code2videoExtension
