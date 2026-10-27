/**
 * 图片同源变体（P2 T5）的跨进程契约
 *
 * 语义（D9）：同 prompt / 模型 / 尺寸再生成一张**新文件**，放在源图同一目录；
 * 不提供 seed / 局部重绘 / 扩图 / 去背景——本机模型没有这些参数。
 */

export interface CreateVariantInput {
  sessionKey?: string | null
  /** 源图片：工作区相对路径 */
  path: string
  /** 源图声明的模型；缺失就没资格发起变体 */
  model: string
  /** 源图的原始提示词（不是模型改写后的 revisedPrompt） */
  sourcePrompt: string
  width?: number
  height?: number
  /** 可选附加要求（≤500 字），拼在原始提示词之后 */
  instruction?: string
}

export interface ArtifactVariantResult {
  ok: true
  /** 新文件：工作区相对路径（与源图同目录） */
  path: string
  editId: string
  bytes: number
  /** 文件已生成、但索引没记上时的可读提示（不当成失败） */
  warning?: string
}
