/**
 * 生图模型意图分类器
 *
 * 用一次轻量 LLM 调用判断用户的生图需求是"简单/快速"还是"复杂/专业"，
 * 据此自动选择生图模型：
 *   - 简单快速图形  → gpt-image-2     （便宜，0.2 元/张）
 *   - 复杂/高清图像 → gpt-image-2-vip （高清档，0.3 元/张）
 *
 * 任何异常（超时/解析失败/LLM 错误）都回退到 gpt-image-2，绝不抛错、不阻断出图。
 */

import type { RouterLlmCaller } from "./router/llm-caller"
import { createLogger } from "../logger"

const log = createLogger("image-intent-classifier")

export const IMAGE_MODEL_SIMPLE = "gpt-image-2"
export const IMAGE_MODEL_PRO = "gpt-image-2-vip"

export type ImageModelChoice = typeof IMAGE_MODEL_SIMPLE | typeof IMAGE_MODEL_PRO

/** 分类超时（ms）。生图本身耗时长，这步判断要快，超时即回退简单档。 */
const CLASSIFY_TIMEOUT_MS = 2500

function buildClassifyPrompt(userPrompt: string): string {
  const truncated = userPrompt.length > 600 ? userPrompt.slice(0, 600) + "…" : userPrompt
  return [
    "你是图像生成需求分级器。判断下面的绘图需求属于哪一档，只回一个词：",
    "- simple：日常、快速、简单图形（图标、表情、草图、简单插画、随手画一个）",
    "- complex：复杂或专业图像（写实摄影级、精细场景、多元素构图、商业海报、专业设计、强调高质量/细节/逼真）",
    "",
    `绘图需求：「${truncated}」`,
    "",
    "只输出 simple 或 complex，不要任何解释。",
  ].join("\n")
}

/** 从 LLM 原始输出解析档位。无法判定时返回 null（由调用方兜底）。 */
export function parseImageChoice(raw: string): ImageModelChoice | null {
  const text = raw.toLowerCase()
  // 优先匹配 complex（避免 "not simple" 之类误判，complex 关键词更具体）
  if (text.includes("complex")) return IMAGE_MODEL_PRO
  if (text.includes("simple")) return IMAGE_MODEL_SIMPLE
  return null
}

/**
 * 分类生图需求 → 选择模型。
 * @param caller 复用 router 的轻量 LLM 调用器（basic/chat tier）
 * @param prompt 用户原始绘图描述
 * @returns gpt-image-2（简单，默认）或 gpt-image-2-vip（复杂/高清）
 */
export async function classifyImageModel(
  caller: RouterLlmCaller,
  prompt: string,
): Promise<ImageModelChoice> {
  const start = Date.now()
  try {
    const raw = await caller.call(buildClassifyPrompt(prompt), CLASSIFY_TIMEOUT_MS)
    const choice = parseImageChoice(raw)
    if (!choice) {
      log.warn(`[classifyImageModel] 无法解析输出「${raw.slice(0, 40)}」，回退 ${IMAGE_MODEL_SIMPLE}`)
      return IMAGE_MODEL_SIMPLE
    }
    log.info(`[classifyImageModel] 选择=${choice} duration=${Date.now() - start}ms`)
    return choice
  } catch (err) {
    log.warn(
      `[classifyImageModel] 分类失败（回退 ${IMAGE_MODEL_SIMPLE}）: ${err instanceof Error ? err.message : String(err)}`,
    )
    return IMAGE_MODEL_SIMPLE
  }
}
