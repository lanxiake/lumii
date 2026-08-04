/**
 * pet-model-registry - 渲染层模型注册表访问
 *
 * 通过 electronAPI.pet 从主进程获取规范化后的模型配置（含可加载 URL）。
 * 主进程已完成路径解析与默认值补全（pet-model-resolver.ts），
 * 返回的 PetModelConfigDTO 结构与 PetModelConfig 一致，直接收敛即可。
 */

import type { PetModelConfig } from './pet-model-types'
import type { PetModelConfigDTO } from '../../../shared/pet-mode'

/** DTO → PetModelConfig（结构一致，仅类型收敛） */
function toPetModelConfig(dto: PetModelConfigDTO): PetModelConfig {
  return {
    id: dto.id,
    name: dto.name,
    rendererType: dto.rendererType,
    modelUrl: dto.modelUrl,
    scale: dto.scale,
    idleMotionGroup: dto.idleMotionGroup,
    idleMotionFallbackGroup: dto.idleMotionFallbackGroup,
    idleMotionRandomGroups: dto.idleMotionRandomGroups,
    talkMotionGroup: dto.talkMotionGroup,
    emotionMap: dto.emotionMap,
    tapMotions: dto.tapMotions,
    defaultExpression: dto.defaultExpression,
    personaAddon: dto.personaAddon,
    thumbnailUrl: dto.thumbnailUrl,
  }
}

/** 获取全部模型配置 */
export async function listPetModels(): Promise<PetModelConfig[]> {
  const dtos = (await window.electronAPI?.pet?.listModels()) ?? []
  return dtos.map(toPetModelConfig)
}

/** 获取指定模型配置（modelId 为空取默认） */
export async function getPetModelConfig(modelId: string): Promise<PetModelConfig | null> {
  const dto = await window.electronAPI?.pet?.getModelConfig(modelId)
  return dto ? toPetModelConfig(dto) : null
}
