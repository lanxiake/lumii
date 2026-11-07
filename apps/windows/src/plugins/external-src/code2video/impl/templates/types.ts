/**
 * 结构模板的类型定义。
 *
 * ## 为什么要模板
 *
 * 现状是「每次现编结构」：模型自己决定拆几节、每节讲什么。后果是质量全看运气——
 * 同一个主题跑两次，一次 3 节一次 6 节；而「讲反例 vs 讲正例」这种本该对称的结构，
 * 模型常常只讲一边。
 *
 * 模板把**论证骨架**固定下来，模型只填内容。三层收益：
 * 1. **生成**：模型不用重新发明结构，token 与不确定性都降
 * 2. **示例**：每个模板带一节真实成品（`example`），作为 few-shot
 * 3. **校验**：模板声明了「这类主题该有哪几节」，门禁可以照着验
 *
 * ## 与视觉风格的关系
 *
 * 结构（怎么讲）与风格（长什么样）是两个正交维度：
 * `compare` 模板可以配黑板风，也可以配科技暗色。模板只管论证顺序。
 */

import type { SceneStep } from '../teaching-core'

/**
 * 一节的职责。
 *
 * 这些角色是**通用的论证位置**，不是某个学科的术语——`establish` 在任何主题里
 * 都是「先建立观众已经懂的东西」，`prove` 都是「拿证据把话说死」。
 */
export type SectionRole =
  /** 建立基准/已知/对象——先给观众一个能站住的地方 */
  | 'establish'
  /** 展示变化/冲突/差异——这是全片的转折点 */
  | 'change'
  /** 命名/给结论——把看到的东西说成一句话 */
  | 'name'
  /** 证明/验证/排除反例——防止「看起来对」 */
  | 'prove'
  /** 收束/回扣——回到开头，但答案已经不同 */
  | 'hold'

/** 骨架里的一节 */
export interface TemplateSection {
  role: SectionRole
  /** 给模型的标题提示，`{topic}` 会被替换 */
  titleHint: string
  /** 讲义行骨架，`{…}` 是占位符 */
  lectureHints: string[]
  /** 画面骨架：这类节该画什么 */
  sceneHint: string
  /** 这一节建议用哪些元素（门禁据此判断是否用对了） */
  kinds?: string[]
}

/**
 * 一节真实成品。
 *
 * 三重身份：提示词里的 few-shot、单测里的渲染基准、真机验收的样片。
 * **必须是能直接渲染的合法 scene**（有测试守着）。
 */
export interface TemplateExample {
  title: string
  lectureLines: string[]
  scene: SceneStep[]
}

/**
 * 模板规定的一个**画面对象**。
 *
 * ## 为什么由模板规定对象，而不是让模型自己起 id
 *
 * 实测：提示词里明确写了「同一个 id 出现在多步 = 同一个东西在动」，
 * 门禁也把不合格的画面打回重做三次——模型**每一版都还是每步重新画**。
 * 它的注意力在「这一步讲什么」上，不在「这些是不是同一个东西」上。
 *
 * 而「这个模板需要哪几个对象」是结构问题，模板作者一次想清楚就行。
 * 模型只需要回答「这一步这个对象在哪、是什么样」——那是它擅长的。
 *
 * 副作用是好的：对象的语义（`mover` 是那个移动的东西）由模板给定，
 * 模型不容易画出「每步都换一个主角」的画面。
 */
export interface TemplateRole {
  /** 对象 id，模型必须原样使用 */
  id: string
  /** 建议的元素类型；模型可以换成别的（比如 rect → circle），但不该换语义 */
  kind: string
  /** 这个对象是干什么的，给模型看 */
  purpose: string
}

export interface TeachingTemplate {
  id: string
  /** 展示名 */
  name: string
  /** 一句话说明这类模板解决什么 */
  summary: string
  /** 给模型看的选择依据 */
  whenToUse: string
  /** 本地关键词匹配用；不追求准，只求召回 */
  keywords: string[]
  /** 节骨架。数量即建议节数 */
  sections: TemplateSection[]
  /**
   * 这一套画面的**对象名册**。
   *
   * 给了它，模型就只能用这几个 id——元素身份由模板决定，
   * 模型只填每步的位置与内容。这是「动画」而非「幻灯片」的关键。
   */
  roles?: TemplateRole[]
  /** 这类主题推荐用哪些视觉风格（风格 id） */
  styles?: string[]
  /** 一节真实成品 */
  example: TemplateExample
}

/** 模板匹配结果 */
export interface TemplateMatch {
  template: TeachingTemplate
  /** 匹配依据：关键词命中 / 模型选择 / 兜底 */
  reason: 'keyword' | 'model' | 'fallback'
  /** 命中的关键词（reason=keyword 时） */
  hits?: string[]
}
