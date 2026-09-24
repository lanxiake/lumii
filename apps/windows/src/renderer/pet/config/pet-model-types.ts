/**
 * 虚拟人模型配置类型
 *
 * 设计依据：03-接口与协议设计 §6.1、06-宠物模式设置与Prompt注入设计 §4
 *
 * **类型本体在 @mtbot/pet-core**，这里只做再导出。原先此处有一份与公共包各写一份的
 * 副本，两边字段一旦不同步就会出现「主进程发得出来、渲染层类型上没有」的静默错配；
 * 改为再导出后结构上不可能分叉，也顺带让 sprite 渲染后端（P0-b）拿到同一套类型。
 *
 * 主进程返回的 DTO 见 `shared/pet-mode.ts` 的 PetModelConfigDTO。
 */

export type {
  PetModelConfig,
} from '@mtbot/pet-core'

export { PET_MOTION_GROUP_UNNAMED } from '@mtbot/pet-core'
