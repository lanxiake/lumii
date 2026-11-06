/**
 * 教学视频生成服务：大纲 → 分镜 → 逐节 HTML → 录制 → 合成。
 *
 * 与原版 Code2Video 的对应关系：
 *   原版 Planner(generate_outline/generate_storyboard) → 本文件 `generate()`
 *   原版 Coder(generate_section_code)                  → 本次由 LLM 直接产出完整 HTML
 *   原版 render + MLLM critic                          → 确定性重叠检测 + 逐节渲染
 *   原版 merge_videos                                  → `render-backend.concatVideos`
 *
 * 保留的重试循环：LLM 产出不合格（JSON 解析失败 / 分镜为空）时重试，最多 N 次。
 * 这是流水线引擎做不到的部分（它没有循环），也是这个能力必须是插件而不是流水线的原因。
 */

import fs from 'node:fs'
import path from 'node:path'

import type { BrowserLike, RenderDeps } from './render-backend'
import { renderStoryboard, totalSeconds } from './render-backend'
import {
  buildOutlinePrompt,
  buildSceneSpecPrompt,
  buildStoryboardPrompt,
  parseOutline,
  declutterSteps,
  parseSceneSpec,
  parseStoryboard,
  type TeachingOutline,
  type SceneStep,
  type TeachingStoryboard,
} from './teaching-core'

export interface TeachingVideoDeps {
  callLLM: (prompt: string, purpose: string) => Promise<string>
  ffmpeg: RenderDeps['ffmpeg']
  createBrowser: () => Promise<BrowserLike>
  /** 输出根目录（每条约一个子目录） */
  outputRoot: () => string
  log: (msg: string) => void
  /** 进度回调（推给界面） */
  onProgress?: (e: { stage: string; detail?: string; percent?: number }) => void
  /**
   * 每节画面由谁产出。
   * - `llm`（默认）：调模型按 `buildSectionPrompt` 生成自包含 HTML——这是 Code2Video
   *   的 Coder 阶段，画面才有真正的图形与运镜；多花 N 次模型调用。
   * - `template`：用内置模板渲染（只有文字面板），不调模型，快但画面很朴素。
   */
  sceneMode?: 'llm' | 'template'
  /** 每节生成失败的重试次数（`sceneMode='llm'` 时生效） */
  sceneRetries?: number
}

export interface GenerateInput {
  topic: string
  /** 目标受众（可选，模型会自己判断） */
  audience?: string
  /** 期望时长（分钟），默认 3 */
  durationMinutes?: number
  /** 失败重试次数（默认 3） */
  maxRetries?: number
  /** 每节画面来源；默认跟随服务配置 */
  sceneMode?: 'llm' | 'template'
}

export interface GenerateResult {
  ok: boolean
  videoPath?: string
  outlinePath?: string
  storyboardPath?: string
  outline?: TeachingOutline
  storyboard?: TeachingStoryboard
  /** 元素重叠告警（不阻断，但如实回传） */
  overlaps?: Array<{ section: string; pairs: Array<{ a: string; b: string; ratio: number }> }>
  durationMs?: number
  error?: string
}

/**
 * 从模型回复里抠出**场景 HTML**。
 *
 * 模型常把 HTML 包在 ```html 围栏里，也常附带解释文字。这里只认「看起来像
 * 完整页面」的内容：有 `<html` 或至少有一个 `<div`/`<svg` 且提到 `__seek`
 *（渲染器靠它定位时间轴，没有它就动不了）。
 */
export function extractSceneHtml(text: string): string | null {
  if (!text || text.trim().length === 0) return null
  const fence = /```(?:html)?\s*([\s\S]*?)```/i.exec(text)
  let body = (fence ? fence[1]! : text).trim()
  if (!body) return null
  // 模型偶尔会漏掉开头的 <!DOCTYPE/<html>：从第一个 <html 或 <div 起截，
  // 把前面的解释文字丢掉（否则浏览器会把它当文本渲染在最上方）
  const start = body.search(/<(!doctype|html|body|div|svg)\b/i)
  if (start > 0) body = body.slice(start)
  if (!/<(html|body|div|svg|canvas)\b/i.test(body)) return null
  // 没有 __seek 的页面截出来永远是第一帧——等同于静态图，判为不合格
  if (!/__seek/.test(body)) return null
  return body
}

/** 从 LLM 回复里抠出 JSON（模型常包 ```json 围栏或加解释文字） */
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  const candidate = fence ? fence[1]!.trim() : trimmed
  try {
    return JSON.parse(candidate)
  } catch {
    // 兜底：抓第一个 { 到最后一个 } 之间的内容
    const start = candidate.indexOf('{')
    const end = candidate.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1))
      } catch {
        return null
      }
    }
    return null
  }
}

function safeDirName(topic: string): string {
  const base = topic.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${base || 'teaching-video'}-${stamp}`
}

export function createTeachingVideoService(deps: TeachingVideoDeps) {
  /** 带重试的 LLM 结构化调用：解析失败就再要一次 */
  async function askJson<T>(
    prompt: string,
    purpose: string,
    parse: (raw: unknown) => T | null,
    maxRetries: number,
  ): Promise<{ ok: true; value: T; raw: string } | { ok: false; error: string }> {
    let lastError = '模型没有返回可用内容'
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      deps.onProgress?.({ stage: purpose, detail: `第 ${attempt}/${maxRetries} 次` })
      let text: string
      try {
        text = await deps.callLLM(prompt, purpose)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        deps.log(`[teaching-video] ${purpose} 调用失败: ${lastError}`)
        continue
      }
      const parsed = parse(extractJson(text))
      if (parsed) return { ok: true, value: parsed, raw: text }
      deps.log(`[teaching-video] ${purpose} 输出不合格（第 ${attempt} 次），重试`)
      lastError = '模型输出不符合 JSON 结构'
    }
    return { ok: false, error: `${purpose} 多次失败：${lastError}` }
  }

  async function generate(input: GenerateInput): Promise<GenerateResult> {
    const startedAt = Date.now()
    const topic = input.topic?.trim()
    if (!topic) return { ok: false, error: '缺少知识点（topic）' }

    const maxRetries = Math.max(1, input.maxRetries ?? 3)
    const outDir = path.join(deps.outputRoot(), safeDirName(topic))
    fs.mkdirSync(outDir, { recursive: true })

    // ---- 1. 大纲 ----
    deps.onProgress?.({ stage: '大纲', percent: 5 })
    const outlineRes = await askJson(
      buildOutlinePrompt(topic, input.durationMinutes ?? 3),
      'outline',
      parseOutline,
      maxRetries,
    )
    if (!outlineRes.ok) return { ok: false, error: `生成大纲失败：${outlineRes.error}` }
    const outline = outlineRes.value
    if (input.audience?.trim()) outline.targetAudience = input.audience.trim()
    const outlinePath = path.join(outDir, 'outline.json')
    fs.writeFileSync(outlinePath, JSON.stringify(outline, null, 2), 'utf8')
    deps.log(`[teaching-video] 大纲完成：${outline.sections.length} 节`)

    // ---- 2. 分镜 ----
    deps.onProgress?.({ stage: '分镜', percent: 20 })
    const boardRes = await askJson(
      buildStoryboardPrompt(outline),
      'storyboard',
      parseStoryboard,
      maxRetries,
    )
    if (!boardRes.ok) return { ok: false, error: `生成分镜失败：${boardRes.error}` }
    const storyboard = boardRes.value
    // 时长对齐：模型给的分镜步数决定片上长度（每步 3 秒）。用户给的是期望值，
    // 这里按它压/放到接近——否则「1 分钟」会实际产出 100 秒（实测过）。
    const targetSec = Math.round((input.durationMinutes ?? 3) * 60)
    if (storyboard.sections.length > 0) {
      const perSection = Math.max(4, Math.floor(targetSec / storyboard.sections.length))
      for (const s of storyboard.sections) s.targetSeconds = perSection
    }
    const storyboardPath = path.join(outDir, 'storyboard.json')
    fs.writeFileSync(storyboardPath, JSON.stringify(storyboard, null, 2), 'utf8')
    deps.log(`[teaching-video] 分镜完成：${storyboard.sections.length} 节 / 约 ${totalSeconds(storyboard)} 秒`)

    // ---- 3. 逐节画面（Code2Video 的 Coder 阶段）----
    deps.onProgress?.({ stage: '画面', percent: 40 })
    const sceneMode = input.sceneMode ?? deps.sceneMode ?? 'llm'
    if (sceneMode === 'llm') {
      const sceneRetries = Math.max(1, deps.sceneRetries ?? 2)
      for (let i = 0; i < storyboard.sections.length; i++) {
        const section = storyboard.sections[i]!
        const stepCount = Math.min(section.lectureLines.length, section.animations.length)
        const prompt = buildSceneSpecPrompt(section)
        let scene: SceneStep[] | null = null
        for (let attempt = 1; attempt <= sceneRetries; attempt++) {
          try {
            const raw = await deps.callLLM(prompt, 'scene_spec')
            scene = parseSceneSpec(extractJson(raw), stepCount)
            if (scene) break
            deps.log(`[teaching-video] 第 ${i + 1} 节画面 JSON 不合格（第 ${attempt} 次）`)
          } catch (err) {
            deps.log(
              `[teaching-video] 第 ${i + 1} 节画面生成失败（第 ${attempt} 次）: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        // 拿不到结构化画面就退回模板——宁可画面朴素，也不要这一节消失
        // 模型给的坐标常撞在一起：先本地挪开，再交给渲染（见 declutterSteps）
        section.scene = scene ? declutterSteps(scene) : undefined
        if (!scene) deps.log(`[teaching-video] 第 ${i + 1} 节退回模板渲染`)
        deps.onProgress?.({
          stage: '画面',
          detail: `${i + 1}/${storyboard.sections.length}`,
          percent: 40 + Math.round(((i + 1) / storyboard.sections.length) * 30),
        })
      }
    }

    // ---- 4. 渲染 ----
    deps.onProgress?.({ stage: '渲染', percent: 72 })
    const renderRes = await renderStoryboard(storyboard, {
      launchBrowser: deps.createBrowser,
      ffmpeg: deps.ffmpeg,
      outDir,
      log: deps.log,
    })

    // 重叠统计：不管渲染成没成，都回传（它是质量信号，不是失败原因）
    const { checkSectionLayout } = await import('./render-backend')
    const overlaps = storyboard.sections
      .map((s) => ({ section: s.title, pairs: checkSectionLayout(s) }))
      .filter((o) => o.pairs.length > 0)

    if (!renderRes.ok) {
      return {
        ok: false,
        outlinePath,
        storyboardPath,
        outline,
        storyboard,
        overlaps,
        error: renderRes.error,
      }
    }

    deps.onProgress?.({ stage: '完成', percent: 100 })
    return {
      ok: true,
      videoPath: renderRes.videoPath,
      outlinePath,
      storyboardPath,
      outline,
      storyboard,
      overlaps,
      durationMs: Date.now() - startedAt,
    }
  }

  return { generate }
}

export type TeachingVideoService = ReturnType<typeof createTeachingVideoService>
