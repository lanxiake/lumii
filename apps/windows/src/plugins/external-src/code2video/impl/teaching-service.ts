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
  buildReviewMarkdown,
  buildSceneSpecPrompt,
  buildStoryboardPrompt,
  parseOutline,
  declutterSteps,
  parseSceneSpec,
  parseStoryboard,
  type LayoutIssue,
  type SceneIssue,
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

/**
 * **三段式工作流**（移植自 Code2Video 的推荐用法）。
 *
 * 原版把生成拆成「草稿验证 → 精修成片 → 人工收尾」，而不是一次跑到底：
 * 草稿阶段只出大纲/分镜，让人先看逻辑对不对；精修阶段才渲染并做视觉反馈。
 *
 * 映射到本插件：
 * - `draft`   只跑大纲 + 分镜，产出 `review.md` 供人审。**不调模型出画面、不渲染**，
 *             几十秒就能拿到，用于排除「方向性错误」（推导跳步、分节不合理）。
 * - `produce` 跑完整流程，并把上一轮 draft 的产物**复用**（不重复花 token）。
 * - `revise`  只重跑指定小节（`sectionIds`），其余复用已渲染的 mp4，最后重新合并。
 *             对应原版的「人工改几行后只重渲那一小段」。
 */
export type TeachingStage = 'draft' | 'produce' | 'revise'

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
  /** 阶段，默认 `produce` */
  stage?: TeachingStage
  /**
   * `revise` 阶段要重做的小节（1 起）。留空 = 全部重做。
   * 与 `draft` 配合：用户看完 review.md 说「第 2 节讲错了」→ 改完只重渲第 2 节。
   */
  sectionIds?: number[]
  /**
   * 复用已有产物目录（绝对路径）。`produce`/`revise` 时用它接着上一次的
   * outline/storyboard 跑，不重新生成——原版就是靠「目录里已有文件就跳过」实现的。
   */
  fromDir?: string
}

export interface GenerateResult {
  ok: boolean
  /** 本次实际执行的阶段（draft 时没有视频，只有 review.md） */
  stage?: TeachingStage
  /** 人审用的审阅稿（draft 阶段的主要交付物） */
  reviewPath?: string
  videoPath?: string
  outlinePath?: string
  storyboardPath?: string
  outline?: TeachingOutline
  storyboard?: TeachingStoryboard
  /**
   * 画面布局的几何问题（重叠/出界/疑似伪数轴）。不阻断渲染，但如实回传——
   * 它是质量信号，之前这里算的是不存在的 3×3 面板（见 `checkSectionLayout`）。
   */
  layoutIssues?: Array<{ section: string; issues: LayoutIssue[] }>
  /**
   * 画面规格的毛病（元素超量、被丢弃、步数不足）。
   *
   * 与 `layoutIssues` 分开：那个是**几何**问题（位置），这个是**内容**问题
   * （模型想画的东西没画全）。两者都要如实回传，因为用户看到的是「少了一个标签」，
   * 而日志里如果不写，就无从追查。
   */
  sceneIssues?: Array<{ section: string; issues: SceneIssue[] }>
  /** **生成耗时**（不是视频时长）。字段名刻意写成 generationMs，避免与 videoSeconds 混淆 */
  generationMs?: number
  /** 成片时长（秒），由分镜的每节时长累加而来 */
  videoSeconds?: number
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

/**
 * 主题 → 安全的目录名。
 *
 * 非法字符换成 `-`、截断到 40 字、留时间戳避免同名覆盖。**空结果要兜底**：
 * 主题全是被替换掉的字符时（如 `<>:"/\|?*`）会得到空串，直接拼进路径会变成
 * `outputs/teaching-video/-2026-.../`，虽然能建但人看不懂。
 */
export function safeDirName(topic: string, now: Date = new Date()): string {
  const base = topic
    .replace(/[\\/:*?"<>|]+/g, '-')
    // 换行/制表符当空格处理，再压掉连续空白与首尾分隔符
    .replace(/[\r\n\t\s]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `${base || 'teaching-video'}-${stamp}`
}

/**
 * 记住用户给的时长（秒），跨阶段保留。
 *
 * 写在产物目录里而不是内存：draft 与 produce 是两次独立调用，进程内变量留不住；
 * 原版也是靠「目录里有文件就复用」这条路径带过来的。
 */
const DURATION_HINT_FILE = '.duration-hint'

function readDurationHint(outDir: string): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(outDir, DURATION_HINT_FILE), 'utf8').trim())
    return Number.isFinite(n) && n > 0 ? n : null
  } catch {
    return null
  }
}

function writeDurationHint(outDir: string, seconds: number): void {
  try {
    fs.writeFileSync(path.join(outDir, DURATION_HINT_FILE), String(seconds), 'utf8')
  } catch {
    // 记不住时长只是降级（下次按 3 分钟），不该让生成失败
  }
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

    const stage: TeachingStage = input.stage ?? 'produce'
    const maxRetries = Math.max(1, input.maxRetries ?? 3)
    // 复用上一轮目录：原版就是「文件已存在就跳过」，这里显式传目录，语义一致但更可控
    const outDir = input.fromDir?.trim()
      ? path.resolve(input.fromDir.trim())
      : path.join(deps.outputRoot(), safeDirName(topic))
    fs.mkdirSync(outDir, { recursive: true })

    // ---- 1. 大纲（已有则直接读：draft → produce 不重复花 token）----
    deps.onProgress?.({ stage: '大纲', percent: 5 })
    const outlineFile = path.join(outDir, 'outline.json')
    let outline: TeachingOutline
    if (fs.existsSync(outlineFile)) {
      const cached = parseOutline(JSON.parse(fs.readFileSync(outlineFile, 'utf8')))
      if (cached) {
        outline = cached
        deps.log(`[teaching-video] 复用已有大纲：${outline.sections.length} 节`)
      } else {
        outline = (await askOutline())!
      }
    } else {
      outline = (await askOutline())!
    }
    if (input.audience?.trim()) outline.targetAudience = input.audience.trim()

    async function askOutline(): Promise<TeachingOutline> {
      const res = await askJson(
        buildOutlinePrompt(topic, input.durationMinutes ?? 3, input.audience),
        'outline',
        parseOutline,
        maxRetries,
      )
      if (!res.ok) throw new Error(`生成大纲失败：${res.error}`)
      fs.writeFileSync(outlineFile, JSON.stringify(res.value, null, 2), 'utf8')
      deps.log(`[teaching-video] 大纲完成：${res.value.sections.length} 节`)
      return res.value
    }

    // ---- 2. 分镜（同样可复用）----
    deps.onProgress?.({ stage: '分镜', percent: 20 })
    const storyboardFile = path.join(outDir, 'storyboard.json')
    let storyboard: TeachingStoryboard
    if (fs.existsSync(storyboardFile)) {
      const cached = parseStoryboard(JSON.parse(fs.readFileSync(storyboardFile, 'utf8')))
      if (cached) {
        storyboard = cached
        deps.log(`[teaching-video] 复用已有分镜：${storyboard.sections.length} 节`)
      } else {
        storyboard = await askStoryboard()
      }
    } else {
      storyboard = await askStoryboard()
    }
    // 时长对齐：模型给的分镜步数决定片上长度（每步 3 秒）。用户给的是期望值，
    // 这里按它压/放到接近——否则「1 分钟」会实际产出 100 秒（实测过）。
    // 时长对齐：用户给的期望值优先；**没给就用上一轮记住的**，再没有才按 3 分钟。
    // 回归：produce 第二次调用时模型没再传 durationMinutes，这里 `?? 3` 把用户的
    // 「改成 5 分钟」悄悄打回 3 分钟（实测：用户明确要求 5 分钟，成片仍是 3:00）。
    const rememberedSec = readDurationHint(outDir)
    const targetSec =
      typeof input.durationMinutes === 'number'
        ? Math.round(input.durationMinutes * 60)
        : (rememberedSec ?? 180)
    if (typeof input.durationMinutes === 'number') writeDurationHint(outDir, targetSec)
    if (storyboard.sections.length > 0) {
      const perSection = Math.max(4, Math.floor(targetSec / storyboard.sections.length))
      for (const s of storyboard.sections) s.targetSeconds = perSection
      if (Math.abs(totalSeconds(storyboard) - targetSec) > 30) {
        deps.log(
          `[teaching-video] 时长偏差：目标 ${targetSec}s，实际 ${totalSeconds(storyboard)}s（${storyboard.sections.length} 节 × ${perSection}s 下限所致）`,
        )
      }
    }
    const storyboardPath = path.join(outDir, 'storyboard.json')
    fs.writeFileSync(storyboardPath, JSON.stringify(storyboard, null, 2), 'utf8')
    deps.log(`[teaching-video] 分镜完成：${storyboard.sections.length} 节 / 约 ${totalSeconds(storyboard)} 秒`)

    async function askStoryboard(): Promise<TeachingStoryboard> {
      const res = await askJson(
        buildStoryboardPrompt(outline),
        'storyboard',
        parseStoryboard,
        maxRetries,
      )
      if (!res.ok) throw new Error(`生成分镜失败：${res.error}`)
      return res.value
    }

    // ---- 落审阅稿：draft 阶段的**唯一交付物** ----
    // 原版的草稿模式就是「先看分镜逻辑对不对」，不渲染。这里把它显式化：
    // 产出一份人可读的 review.md，再决定要不要往下走。
    const reviewPath = path.join(outDir, 'review.md')
    fs.writeFileSync(reviewPath, buildReviewMarkdown(outline, storyboard), 'utf8')

    if (stage === 'draft') {
      return {
        ok: true,
        stage,
        outline,
        storyboard,
        reviewPath,
        outlinePath: outlineFile,
        storyboardPath,
        videoSeconds: totalSeconds(storyboard),
        generationMs: Date.now() - startedAt,
      }
    }

    // ---- 3. 逐节画面（Code2Video 的 Coder 阶段）----
    deps.onProgress?.({ stage: '画面', percent: 40 })
    const sceneMode = input.sceneMode ?? deps.sceneMode ?? 'llm'
    /** 画面规格的内容问题（元素超量/丢弃/步数不足），与几何重叠分开回传 */
    const sceneIssues: Array<{ section: string; issues: SceneIssue[] }> = []
    // revise 阶段只重做指定小节；其余节的已渲染 mp4 直接复用
    const reviseSet =
      stage === 'revise' && input.sectionIds?.length
        ? new Set(input.sectionIds.filter((n) => Number.isInteger(n) && n >= 1))
        : null
    if (sceneMode === 'llm') {
      const sceneRetries = Math.max(1, deps.sceneRetries ?? 2)
      for (let i = 0; i < storyboard.sections.length; i++) {
        const section = storyboard.sections[i]!
        // revise 模式下，没点名的节保留已存的 scene（若有），不重新调模型
        if (reviseSet && !reviseSet.has(i + 1) && section.scene?.length) {
          deps.log(`[teaching-video] 第 ${i + 1} 节未指定重做，复用已存画面`)
          continue
        }
        const stepCount = Math.min(section.lectureLines.length, section.animations.length)
        const prompt = buildSceneSpecPrompt(section)
        let scene: SceneStep[] | null = null
        let lastIssues: SceneIssue[] = []
        for (let attempt = 1; attempt <= sceneRetries; attempt++) {
          try {
            const raw = await deps.callLLM(prompt, 'scene_spec')
            const parsed = parseSceneSpec(extractJson(raw), stepCount)
            if (parsed) {
              // 元素超量是**硬门禁**：少一个元素就是画面缺一块，只能让模型重给。
              // 其余问题（出界、步数不足、丢了个别不合格元素）降级放行并如实回告——
              // 它们不会让这一节消失，但需要进质量报告。
              const fatal = parsed.issues.filter((x) => x.kind === 'too_many_elements')
              if (fatal.length === 0) {
                scene = parsed.steps
                lastIssues = parsed.issues
                break
              }
              lastIssues = parsed.issues
              deps.log(
                `[teaching-video] 第 ${i + 1} 节元素超量（第 ${attempt} 次）: ${fatal.map((x) => x.detail).join('; ')}`,
              )
            } else {
              deps.log(`[teaching-video] 第 ${i + 1} 节画面 JSON 不合格（第 ${attempt} 次）`)
            }
          } catch (err) {
            deps.log(
              `[teaching-video] 第 ${i + 1} 节画面生成失败（第 ${attempt} 次）: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        // 拿不到结构化画面就退回模板——宁可画面朴素，也不要这一节消失
        // 模型给的坐标常撞在一起：先本地挪开，再交给渲染（见 declutterSteps）
        section.scene = scene ? declutterSteps(scene) : undefined
        if (lastIssues.length > 0) {
          sceneIssues.push({ section: section.title, issues: lastIssues })
        }
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
    // 画面（scene）随分镜一起落盘：revise 阶段要靠它跳过未点名的节
    fs.writeFileSync(storyboardPath, JSON.stringify(storyboard, null, 2), 'utf8')
    const renderRes = await renderStoryboard(storyboard, {
      launchBrowser: deps.createBrowser,
      ffmpeg: deps.ffmpeg,
      outDir,
      log: deps.log,
      ...(reviseSet ? { onlySections: reviseSet } : {}),
    })

    // 布局统计：不管渲染成没成，都回传（它是质量信号，不是失败原因）
    const { checkSectionLayout } = await import('./render-backend')
    const layoutIssues = storyboard.sections
      .map((s) => ({ section: s.title, issues: checkSectionLayout(s) }))
      .filter((o) => o.issues.length > 0)

    if (!renderRes.ok) {
      return {
        ok: false,
        outlinePath: outlineFile,
        storyboardPath,
        outline,
        storyboard,
        layoutIssues,
        sceneIssues,
        error: renderRes.error,
      }
    }

    deps.onProgress?.({ stage: '完成', percent: 100 })
    return {
      ok: true,
      videoPath: renderRes.videoPath,
      outlinePath: outlineFile,
      storyboardPath,
      outline,
      storyboard,
      layoutIssues,
      sceneIssues,
      // 两个量分开报：前者是这台机器跑这次生成花了多久，后者是成片本身的长度。
      // 之前混用一个 durationMs，模型把它当视频时长汇报过一次（203592ms vs 实际 60s）。
      generationMs: Date.now() - startedAt,
      videoSeconds: totalSeconds(storyboard),
    }
  }

  return { generate }
}

export type TeachingVideoService = ReturnType<typeof createTeachingVideoService>
