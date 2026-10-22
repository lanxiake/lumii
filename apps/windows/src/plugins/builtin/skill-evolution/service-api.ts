/**
 * 技能进化对核心暴露的唯一能力：把进化引导注入提示词结果。
 *
 * 插件默认 `manifest.disabled` ⇒ 服务不存在 ⇒ 核心拿到 null 就跳过。
 * 这样「代码留着但别跑」才是真的不跑——之前核心是**无条件**动态 import 这个函数，
 * 插件禁用着、注入却照旧生效。
 */
export interface SkillEvolutionService {
  injectInto<T extends { staticPrompt: string; dynamicPrompt: string; fullPrompt: string }>(
    result: T,
  ): T
}
