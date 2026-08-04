/**
 * 生图模型列表与 Agent 选型指南（与 Gateway image-generate-http 白名单对齐）
 */

export interface ImageGenerationModelOption {
  /** 提交给 Gateway / image_generate 的 modelId */
  readonly id: string
  /** 展示名 */
  readonly name: string
  /** 简短说明 */
  readonly description: string
  /** Agent 选型场景提示 */
  readonly whenToUse: string
}

/** 默认生图模型（Agent 未传 modelId 时的兜底） */
export const DEFAULT_IMAGE_MODEL_ID = "gpt-image-2"

/**
 * 可用生图模型（顺序即推荐优先级展示）
 */
export const IMAGE_GENERATION_MODEL_OPTIONS: readonly ImageGenerationModelOption[] = [
  {
    id: "gpt-image-2",
    name: "gpt-image-2",
    description: "快速出图（特价 1K）",
    whenToUse: "日常插画、图标、简单场景、用户未强调高清/专业质量时（默认首选，成本最低）",
  },
  {
    id: "gpt-image-2-vip",
    name: "gpt-image-2-vip",
    description: "官方直连，支持 1K/2K/4K",
    whenToUse: "需要 2K/4K 高分辨率、印刷级清晰度、写实摄影级或用户明确要求「高清/超清/4K」",
  },
  {
    id: "nano-banana",
    name: "nano-banana",
    description: "Gemini Flash 封装，快速",
    whenToUse: "极速草稿、简单图形、对风格要求不高且希望更快返回时",
  },
  {
    id: "nano-banana-2",
    name: "nano-banana-2",
    description: "第二代，综合效果更好",
    whenToUse: "需要比 nano-banana 更好效果、且可能需要 2K/4K 的通用场景",
  },
  {
    id: "nano-banana-pro",
    name: "nano-banana-pro",
    description: "第二代专业档",
    whenToUse: "复杂艺术风格、高细节插画、商业级质量、偏好 Gemini 画风时",
  },
] as const

/**
 * 生成供 Agent / 工具描述使用的 modelId 选型指南文本
 */
export function buildImageModelSelectionGuideForAgent(): string {
  const lines = IMAGE_GENERATION_MODEL_OPTIONS.map(
    (m) => `- ${m.id}：${m.whenToUse}`,
  )
  return [
    "【modelId 选型】默认 gpt-image-2（可不传 modelId）；复杂场景或高分辨率时再按需选择：",
    ...lines,
    "- 仅 1024×1024 或 1536×1024/1024×1536 时可用 gpt-image-2 / nano-banana；更高分辨率请选 gpt-image-2-vip / nano-banana-2 / nano-banana-pro",
    "- 失败后勿换模型重试（每次调用均计费）；将错误告知用户，除非用户明确要求换模型再试",
  ].join("\n")
}

/** @deprecated 使用 buildImageModelSelectionGuideForAgent */
export const IMAGE_MODEL_GUIDE = IMAGE_GENERATION_MODEL_OPTIONS.map(
  (m) => `${m.id}：${m.description}`,
).join("\n")

/**
 * 判断 modelId 是否为已知生图模型
 */
export function isKnownImageGenerationModel(modelId: string | undefined): boolean {
  if (!modelId?.trim()) return false
  const bare = modelId.includes("/") ? modelId.split("/").pop()! : modelId
  return IMAGE_GENERATION_MODEL_OPTIONS.some((m) => m.id === bare.trim())
}

/**
 * 规范化生图 modelId（去掉 provider 前缀）
 */
export function normalizeImageModelId(modelId: string | undefined): string {
  if (!modelId?.trim()) return DEFAULT_IMAGE_MODEL_ID
  const bare = (modelId.includes("/") ? modelId.split("/").pop()! : modelId).trim()
  return isKnownImageGenerationModel(bare) ? bare : DEFAULT_IMAGE_MODEL_ID
}
