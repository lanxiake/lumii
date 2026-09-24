/**
 * 宠物模式 — 共享常量与纯函数（ADR-17）
 *
 * 设计依据：.qoder/design/Windows客户端PET宠物模式/06-宠物模式设置与Prompt注入设计.md
 *           .qoder/design/Windows客户端PET宠物模式/07-宠物模式分阶段实施计划-v3.md §2.1 (4.0)
 *           .qoder/design/Windows客户端PET宠物模式/08-业务闭环反思与完善方案.md (ADR-13/14/17)
 *
 * 集中放置：产品名常量、localStorage 键名、Agent 解析、表情标签解析/剥离等纯函数，
 * 主进程与渲染进程共用。纯函数全部可单测（无 Electron / DOM 依赖）。
 */

/** 用户可见产品名（技术命名空间仍为 pet:*，见 ADR-09） */
export const VIRTUAL_HUMAN_PRODUCT_NAME = '宠物模式'

/**
 * 虚拟人设置的 localStorage 键名（新增 mtbot:vh-*，读时兼容旧 mtbot:pet-*）。
 * 见 06 号文档 §8.1。
 */
export const VH_STORAGE_KEYS = {
  /** 全局对话 Agent 覆盖 */
  agentId: 'mtbot:vh-agent-id',
  /** 旧键：兼容读取 */
  legacyAgentId: 'mtbot:pet-agent-id',
  /** 是否跟随模型默认 Agent */
  followModelAgent: 'mtbot:vh-follow-model-agent',
  /** 是否注入表情标签 Prompt */
  enableExpressionPrompt: 'mtbot:vh-enable-expression-prompt',
  /** 是否注入动作/心理描写标签 Prompt */
  enableThinkTagPrompt: 'mtbot:vh-enable-think-tag-prompt',
  /** 文字回复是否朗读（开=TTS 真音频口型，关=伪口型静默） */
  enableVoiceReply: 'mtbot:vh-enable-voice-reply',
  /** 待机时是否播放随机动作（关=仅基础 Idle，避免与对话动作冲突） */
  enableIdleMotion: 'mtbot:vh-enable-idle-motion',
  /** Agent 活动感知（关=宠物不随 Agent 的思考/工具/等待改姿态） */
  enableAgentActivity: 'mtbot:vh-enable-agent-activity',
  /** Agent 通知（关=不冒气泡、不进待办区） */
  enableAgentNotice: 'mtbot:vh-enable-agent-notice',
  /** 鼠标点击控制（开=点击宠物身体触发互动动作） */
  enableTapInteraction: 'mtbot:vh-enable-tap-interaction',
  /** 强制鼠标穿透默认值（开=进入宠物模式即仅身体穿透） */
  forceIgnoreMouse: 'mtbot:vh-force-ignore-mouse',
  /** 闲置感知（关=用户离开多久都不打盹不睡） */
  enableIdleAwareness: 'mtbot:vh-enable-idle-awareness',
  /** 是否允许宠物主动做事（关=「让它去做」被拒，派发循环也停下） */
  enablePetTask: 'mtbot:vh-enable-pet-task',
} as const

/** 动作/神态标签（替代 OLV 的 <think>，避免与推理块冲突，ADR-12） */
export const VH_ACTION_TAG = 'vh_action'

/**
 * 虚拟人可触发的一个 Live2D 动作（注入提示词 + 渲染层据 tag 真实播放）。
 * tag 为模型相关：注册表 actionMotions 显式命名时用语义名，否则按非待机组序号生成。
 */
export interface VirtualHumanMotionAction {
  /** 标签名（用于 [motion:tag]），如 'dance' 或序号 '1' */
  tag: string
  /** 给模型的动作描述（无语义名时为空，模型按编号触发） */
  description?: string
}

/**
 * 主进程 instanceStates / session 激活态上挂载的虚拟人 Prompt 上下文。
 * 由主进程 resolveVirtualHumanContext(modelId) 从 registry + 设置自解析（ADR-14）。
 */
export interface VirtualHumanPromptContext {
  /** 当前模型 ID */
  modelId: string
  /** 模型显示名（用于 Prompt 文案） */
  modelName: string
  /** 表情名列表（emotionMap 的 key） */
  emotionKeys: string[]
  /** 可触发的动作列表（空表示模型无可用动作，不注入动作段） */
  motionActions: VirtualHumanMotionAction[]
  /** 模型人设追加片段 */
  personaAddon?: string
  /** 是否注入表情标签说明 */
  enableExpressionPrompt: boolean
  /** 是否注入动作/心理描写标签说明 */
  enableThinkTagPrompt: boolean
}

/** 虚拟人设置 DTO（设置页 ↔ 主进程 pet-mode-store 同步） */
export interface VirtualHumanSettingsDTO {
  /** 全局 Agent 覆盖（空表示跟随会话/模型） */
  agentId: string
  /** 跟随模型默认 Agent（开启时忽略全局 agentId，用 model.agentId） */
  followModelAgent: boolean
  /** 注入表情标签 Prompt */
  enableExpressionPrompt: boolean
  /** 注入动作/心理描写标签 Prompt */
  enableThinkTagPrompt: boolean
  /** 文字回复是否朗读（true=合成 TTS 出声并用真音频驱动口型；false=静默，用伪口型） */
  enableVoiceReply: boolean
  /** 待机随机动作（true=8~15s 轮播随机待机；false=仅循环基础 Idle，减少与对话冲突） */
  enableIdleMotion: boolean
  /**
   * Agent 活动感知（true=Agent 在思考 / 跑工具 / 等确认时，宠物的呼吸与姿态跟着变；
   * false=宠物只按自己的节奏待机）。
   *
   * 这是 L1 表达层——呼吸/浮动/倾斜的**姿态调制**，零素材依赖，对所有模型生效
   * （含没有分层脸的自制模型）。它是"让 Agent 的状态可见"的唯一手段里最不打扰的一层。
   */
  enableAgentActivity: boolean
  /**
   * Agent 通知（true=任务完成/等你审批/向你提问时，宠物冒气泡并进控制坞待办区；
   * false=完全不感知）。
   *
   * 与 `enableAgentActivity` 是**两个开关**：那个是"Agent 在忙"的连续底色（不看没代价），
   * 这个是"要不要你现在看一眼"的待办（错过有代价——审批 5 分钟超时即失败）。
   * 有人就是不想要任何打扰，所以**必须能单独关**。
   */
  enableAgentNotice: boolean
  /** 鼠标点击控制（true=点击宠物身体区域触发互动动作；false=点击不触发） */
  enableTapInteraction: boolean
  /** 强制鼠标穿透默认值（true=进入宠物模式即仅身体穿透，控制坞仍可点） */
  forceIgnoreMouse: boolean
  /**
   * 闲置感知（true=用户离开一段时间后宠物打盹、再久则闭眼睡着；回来即醒）。
   *
   * 默认开，但**必须能关**：「它睡着了」可能被误读成程序卡死，
   * 也有人就是不想要宠物自作主张。
   */
  enableIdleAwareness: boolean
  /**
   * 是否允许宠物**主动做事**（五期 T5.9）。
   *
   * 管的是"派它去看一眼"这条线：关掉之后，「让它去做」会被受理侧直接拒掉，
   * 派发循环也不再跑。**已经跑出去的那一件会跑完**——它已经花掉预算在路上了，
   * 半路掐断只会留下一句没头没尾的回执。
   *
   * 默认开：这是宠物最"有用"的一件事（设计 §4.2 说它是成本最低、感知最强的一条）。
   * 但必须能关——它花的是真金白银的 token，而且会真的去读用户的文件。
   */
  enablePetTask: boolean
  /** 开启主动联系（仅宠物模式下触达） */
  proactiveCareEnabled: boolean
  /** 联系频率：温和 / 热情 */
  proactiveCareMode: 'gentle' | 'active'
  /** 主动消息里怎么称呼用户（可选） */
  proactiveCareNickname: string
}

/** 虚拟人设置默认值 */
export const DEFAULT_VH_SETTINGS: VirtualHumanSettingsDTO = {
  agentId: '',
  followModelAgent: true,
  enableExpressionPrompt: true,
  enableThinkTagPrompt: false,
  enableVoiceReply: false,
  enableIdleMotion: true,
  enableAgentActivity: true,
  enableAgentNotice: true,
  enableTapInteraction: true,
  forceIgnoreMouse: false,
  enableIdleAwareness: true,
  enablePetTask: true,
  proactiveCareEnabled: false,
  proactiveCareMode: 'gentle',
  proactiveCareNickname: '',
}

/**
 * Agent 解析优先级（06 号文档 §3.3）：
 *   1. 用户全局 Agent（未勾选「跟随模型默认」且设置了 agentId）
 *   2. registry 当前模型的 agentId
 *   3. 当前 Chat 会话绑定的 Agent（sessionAgentId）
 *   4. 系统默认 Agent（返回 undefined，由下游用默认）
 *
 * @returns 解析出的 agentId；返回 undefined 表示交由下游使用系统默认。
 */
export function resolveAgentId(input: {
  settings: Pick<VirtualHumanSettingsDTO, 'agentId' | 'followModelAgent'>
  modelAgentId?: string
  sessionAgentId?: string
}): string | undefined {
  const { settings, modelAgentId, sessionAgentId } = input
  // 1. 全局覆盖（未跟随模型 且 显式指定）
  if (!settings.followModelAgent && settings.agentId) {
    return settings.agentId
  }
  // 2. 模型默认
  if (modelAgentId) {
    return modelAgentId
  }
  // 3. 会话绑定
  if (sessionAgentId) {
    return sessionAgentId
  }
  // 4. 系统默认
  return undefined
}

/** 表情标签正则：匹配 [emotion_name]，名仅允许字母/数字/下划线/中文 */
const EMOTION_TAG_REGEX = /\[([a-zA-Z0-9_一-龥]+)\]/g

/** 动作标签正则：匹配 [motion:tag]，tag 允许字母/数字/下划线/中文 */
const MOTION_TAG_REGEX = /\[motion:([a-zA-Z0-9_一-龥]+)\]/g

/** 动作标签正则：匹配 <vh_action>...</vh_action>（含跨行） */
const VH_ACTION_REGEX = /<vh_action>[\s\S]*?<\/vh_action>/g
/** 未闭合的动作标签开头（流式中途，剥离残留） */
const VH_ACTION_OPEN_REGEX = /<vh_action>[\s\S]*$/

/**
 * 从文本中提取动作标签 [motion:tag]，返回命中的 tag 列表。
 * 不依赖模型动作表，调用方负责映射到动作组/index 并触发播放。
 */
export function extractMotionTags(text: string): string[] {
  const tags: string[] = []
  MOTION_TAG_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = MOTION_TAG_REGEX.exec(text)) !== null) {
    tags.push(m[1]!)
  }
  return tags
}

/**
 * 从文本中提取表情标签，返回清洁文本与命中表情名列表。
 * 不依赖 emotionMap，调用方负责映射到索引（mapEmotionsToIndices）。
 */
export function extractEmotionTags(text: string): {
  cleanText: string
  emotions: string[]
} {
  const emotions: string[] = []
  EMOTION_TAG_REGEX.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EMOTION_TAG_REGEX.exec(text)) !== null) {
    emotions.push(m[1]!)
  }
  const cleanText = text.replace(EMOTION_TAG_REGEX, '')
  return { cleanText, emotions }
}

/**
 * 从 TTS 输入中剥离所有虚拟人标签（表情 [tag] + 动作 <vh_action>...）。
 * 在 sentence-splitter 前全局调用（ADR-13），保证标签不进入朗读。
 *
 * 对流式 delta 也安全：未闭合的 <vh_action> 开头会被剥到行尾，
 * 闭合标签在后续 delta 到达时由 splitter/调用方累积处理。
 */
export function stripVirtualHumanTags(text: string): string {
  EMOTION_TAG_REGEX.lastIndex = 0
  MOTION_TAG_REGEX.lastIndex = 0
  return text
    .replace(VH_ACTION_REGEX, '')
    .replace(VH_ACTION_OPEN_REGEX, '')
    .replace(MOTION_TAG_REGEX, '')
    .replace(EMOTION_TAG_REGEX, '')
}

/** 将表情名映射为渲染器 expression 索引（过滤未知标签） */
export function mapEmotionsToIndices(
  emotions: string[],
  emotionMap: Record<string, number>,
): number[] {
  const indices: number[] = []
  for (const name of emotions) {
    const idx = emotionMap[name]
    if (typeof idx === 'number') {
      indices.push(idx)
    }
  }
  return indices
}
