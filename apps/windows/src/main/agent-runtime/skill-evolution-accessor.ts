import { defineServiceAccessor } from '../../plugins/api'
import type { SkillEvolutionService } from '../../plugins/builtin/skill-evolution/service-api'

/**
 * 技能进化的核心侧入口。
 *
 * 该插件 `manifest.disabled`（代码留着但产品上停用）⇒ 服务不存在 ⇒ 注入跳过。
 * 之前核心是无条件动态 import 注入函数的，插件禁用着、提示词却照旧被改。
 */
const accessor = defineServiceAccessor<SkillEvolutionService>('skillEvolution')

export function setSkillEvolutionAccessor(
  fn: (() => SkillEvolutionService | null) | null,
): void {
  accessor.setResolver(fn)
}

export function getSkillEvolutionService(): SkillEvolutionService | null {
  return accessor.get()
}
