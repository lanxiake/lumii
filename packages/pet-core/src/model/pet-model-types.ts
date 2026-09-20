/**
 * pet-model-types — 宠物模型配置类型（pet-core）
 *
 * 从 apps/windows/src/renderer/pet/config/pet-model-types.ts 平移到公共包，
 * 供 Windows / kids-mobile / 浏览器预览共用。纯类型 + 纯函数，零运行时依赖。
 *
 * 注意：注册表加载（listPetModels/getPetModelConfig）依赖各端私有的资源解析
 * （Windows 走 electronAPI，mobile 走本地文件），不进公共包。公共包只提供类型
 * 与默认值合并纯函数。
 */

/** 渲染后端类型 */
export type PetRendererType = "live2d" | "sprite";

/**
 * 模型来源。两段式扫描的产物标记：
 *  - `builtin`：随包发布，只读，同 id 会被用户版本覆盖
 *  - `user`：用户宠物目录，可写，优先级更高
 *
 * 该字段由 [mergePetRegistries](./pet-registry.ts) 写入，注册表文件里不必声明。
 */
export type PetModelSource = "builtin" | "user";

/** 注册表占位符：解析为模型内未命名（空 key）或多动作组 */
export const PET_MOTION_GROUP_UNNAMED = "$unnamed";

/** 作者精选的语义动作：tag → 动作组与说明 */
export interface PetActionMotion {
  /** 动作组名 */
  group: string;
  /** 组内 index（省略=该组随机） */
  index?: number;
  /** 给模型看的语义描述 */
  description?: string;
}

/** 单个宠物模型配置 */
export interface PetModelConfig {
  /** 唯一标识 */
  id: string;
  /** 显示名称 */
  name: string;
  /** 渲染后端类型 */
  rendererType: PetRendererType;
  /**
   * 模型入口文件 URL。
   * 相对路径（相对 resources/pet-models）或绝对 file:// URL。
   * Live2D 为 *.model3.json。
   */
  modelUrl: string;
  /** 默认缩放（相对模型原始尺寸） */
  scale: number;
  /** 待机动画组名 */
  idleMotionGroup: string;
  /** 待机主组仅 1 个动作时的回退组（如 mao_pro 的 "" 组含多段；可用 $unnamed 占位） */
  idleMotionFallbackGroup?: string;
  /** 多组轮换随机待机（每组仅 1 个动作时，如 shizuku 的 Idle/FlickUp/Flick3） */
  idleMotionRandomGroups?: string[];
  /** 说话动画组名 */
  talkMotionGroup: string;
  /** 表情映射：标签名 → expression 索引 */
  emotionMap: Record<string, number>;
  /** 点击区域 → 动作映射：hitArea 名 → { 动作组名: index } */
  tapMotions: Record<string, Record<string, number>>;
  /** 默认表情索引 */
  defaultExpression: number;
  /**
   * 作者精选的语义动作：`[motion:tag]` 的 tag → 动作组。
   * 声明时按此命名（最高优先级），否则由 model3.json 的非常规组自动编号。
   */
  actionMotions?: Record<string, PetActionMotion>;
  /** 该虚拟人默认绑定的 Agent ID（可被用户设置覆盖） */
  agentId?: string;
  /** 虚拟人专属 system prompt 片段 */
  personaAddon?: string;
  /** 工具 Prompt 开关（表情 / 动作描写） */
  toolPrompts?: {
    expression?: boolean;
    thinkTag?: boolean;
  };
  /** 预览缩略图 */
  thumbnailUrl?: string;
  /** 来源（两段式扫描写入，非注册表字段） */
  source?: PetModelSource;
  /** true = 该用户模型覆盖了一个同 id 的内置模型（供「恢复内置版本」用） */
  shadowedBuiltin?: boolean;
}

/** 注册表文件结构 */
export interface PetModelRegistryFile {
  version: number;
  models: PetModelConfig[];
  defaultModelId: string;
}

/** 注册表加载时为缺失字段提供的默认值 */
export const PET_MODEL_DEFAULTS: Pick<
  PetModelConfig,
  "scale" | "idleMotionGroup" | "talkMotionGroup" | "emotionMap" | "tapMotions" | "defaultExpression"
> = {
  scale: 0.4,
  idleMotionGroup: "Idle",
  talkMotionGroup: "Talk",
  emotionMap: {},
  tapMotions: {},
  defaultExpression: 0,
};

/** 部分模型配置：id/name/rendererType/modelUrl 必填，其余可由默认值补全 */
export type PartialPetModelConfig = Pick<
  PetModelConfig,
  "id" | "name" | "rendererType" | "modelUrl"
> &
  Partial<PetModelConfig>;

/**
 * 用默认值补全模型配置的缺失字段（纯函数）。
 * 供各端注册表加载后归一，替代散落在各端的默认值拼装逻辑。
 *
 * 值为 `null` / `undefined` 的键按「未声明」处理——它们可能来自手写或机器生成的
 * JSON（`null` 是合法 JSON），若直接展开会以 `null` 覆盖掉默认值。
 */
export function applyModelDefaults(partial: PartialPetModelConfig): PetModelConfig {
  const declared: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(partial)) {
    if (v !== null && v !== undefined) declared[k] = v;
  }
  return {
    ...PET_MODEL_DEFAULTS,
    ...declared,
    // 深合并可选对象字段，避免 undefined 覆盖默认空对象
    emotionMap: declared.emotionMap ?? PET_MODEL_DEFAULTS.emotionMap,
    tapMotions: declared.tapMotions ?? PET_MODEL_DEFAULTS.tapMotions,
  } as PetModelConfig;
}
