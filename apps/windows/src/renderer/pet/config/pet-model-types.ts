/**
 * 虚拟人模型配置类型
 *
 * 设计依据：03-接口与协议设计 §6.1、06-宠物模式设置与Prompt注入设计 §4
 * 主进程注册表（pet-model-registry）与渲染器（Live2dPetRenderer）共用。
 */

/** 渲染后端类型 */
export type PetRendererType = 'live2d' | 'sprite'

/** 注册表占位符：解析为模型内未命名（空 key）或多动作组 */
export const PET_MOTION_GROUP_UNNAMED = '$unnamed'

/** 单个宠物模型配置 */
export interface PetModelConfig {
  /** 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 渲染后端类型 */
  rendererType: PetRendererType
  /**
   * 模型入口文件 URL。
   * 相对路径（相对 resources/pet-models）或绝对 file:// URL。
   * Live2D 为 *.model3.json。
   */
  modelUrl: string
  /** 默认缩放（相对模型原始尺寸） */
  scale: number
  /** 待机动画组名 */
  idleMotionGroup: string
  /** 待机主组仅 1 个动作时的回退组（如 mao_pro 的 "" 组含多段 mtn/special；可用 $unnamed 占位） */
  idleMotionFallbackGroup?: string
  /** 多组轮换随机待机（每组仅 1 个动作时，如 shizuku 的 Idle/FlickUp/Flick3） */
  idleMotionRandomGroups?: string[]
  /** 说话动画组名 */
  talkMotionGroup: string
  /** 表情映射：标签名 → expression 索引 */
  emotionMap: Record<string, number>
  /** 点击区域 → 动作映射：hitArea 名 → { 动作组名: index } */
  tapMotions: Record<string, Record<string, number>>
  /** 默认表情索引 */
  defaultExpression: number
  /** 该虚拟人默认绑定的 Agent ID（可被用户设置覆盖） */
  agentId?: string
  /** 虚拟人专属 system prompt 片段 */
  personaAddon?: string
  /** 工具 Prompt 开关（表情 / 动作描写） */
  toolPrompts?: {
    expression?: boolean
    thinkTag?: boolean
  }
  /** 预览缩略图 */
  thumbnailUrl?: string
}

/** 注册表文件结构 */
export interface PetModelRegistryFile {
  version: number
  models: PetModelConfig[]
  defaultModelId: string
}

/** 注册表加载时为缺失字段提供的默认值 */
export const PET_MODEL_DEFAULTS: Pick<
  PetModelConfig,
  'scale' | 'idleMotionGroup' | 'talkMotionGroup' | 'emotionMap' | 'tapMotions' | 'defaultExpression'
> = {
  scale: 0.4,
  idleMotionGroup: 'Idle',
  talkMotionGroup: 'Talk',
  emotionMap: {},
  tapMotions: {},
  defaultExpression: 0,
}
