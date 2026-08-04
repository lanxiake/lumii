/**
 * 从 Live2D model3.json 解析表情、动作等资源清单，供 pet-lab 自动展示与手动测试。
 */

/** model3.json 中的单个表情条目 */
export interface Model3Expression {
  index: number
  name: string
  file: string
}

/** model3.json 中的单个动作条目 */
export interface Model3Motion {
  /** 模型内真实组名（空串表示未命名组） */
  group: string
  /** 展示用组名（空串 → $unnamed） */
  groupLabel: string
  index: number
  file: string
}

/** 从 model3.json 解析出的资源目录 */
export interface Model3Catalog {
  expressions: Model3Expression[]
  motions: Model3Motion[]
  lipSyncParams: string[]
  hitAreas: { id: string; name: string }[]
}

/** model3.json 原始结构（仅解析所需字段） */
interface Model3Json {
  FileReferences?: {
    Expressions?: { Name?: string; File?: string }[]
    Motions?: Record<string, { File?: string }[]>
  }
  Groups?: { Target?: string; Name?: string; Ids?: string[] }[]
  HitAreas?: { Id?: string; Name?: string }[]
}

/**
 * 将动作组 key 转为可读标签（空串组在 Live2D 中常写作 $unnamed）。
 */
export function formatMotionGroupLabel(group: string): string {
  return group === '' ? '$unnamed' : group
}

/**
 * 从 motion3 文件路径提取文件名（不含目录）。
 */
export function basename(filePath: string): string {
  const parts = filePath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] ?? filePath
}

/**
 * 解析 model3.json 对象为资源目录（纯函数，便于单测）。
 */
export function parseModel3Json(data: unknown): Model3Catalog {
  const raw = data as Model3Json
  const expressions: Model3Expression[] = []
  const motions: Model3Motion[] = []

  const exprList = raw.FileReferences?.Expressions ?? []
  exprList.forEach((entry, index) => {
    expressions.push({
      index,
      name: entry.Name ?? `expr_${index}`,
      file: entry.File ?? '',
    })
  })

  const motionGroups = raw.FileReferences?.Motions ?? {}
  for (const [group, items] of Object.entries(motionGroups)) {
    if (!Array.isArray(items)) continue
    items.forEach((item, index) => {
      const file = item.File ?? ''
      motions.push({
        group,
        groupLabel: formatMotionGroupLabel(group),
        index,
        file,
      })
    })
  }

  const lipGroup = raw.Groups?.find((g) => g.Target === 'Parameter' && g.Name === 'LipSync')
  const lipSyncParams = lipGroup?.Ids?.length ? [...lipGroup.Ids] : []

  const hitAreas = (raw.HitAreas ?? []).map((h) => ({
    id: h.Id ?? '',
    name: h.Name ?? '',
  }))

  return { expressions, motions, lipSyncParams, hitAreas }
}

/**
 * 拉取 model3.json 并解析为资源目录。
 * @param modelUrl 已拼好的绝对 URL（如 /pet-models/mao_pro/runtime/mao_pro.model3.json）
 */
export async function fetchModel3Catalog(modelUrl: string): Promise<Model3Catalog> {
  const res = await fetch(modelUrl)
  if (!res.ok) {
    throw new Error(`无法读取 model3.json: ${res.status} ${modelUrl}`)
  }
  const data: unknown = await res.json()
  return parseModel3Json(data)
}
