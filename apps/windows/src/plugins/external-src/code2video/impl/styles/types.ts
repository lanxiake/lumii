/**
 * 视觉风格：决定「长什么样」，与结构模板（怎么讲）正交。
 *
 * 同一个 `compare` 骨架可以配黑板风、也可以配科技暗色。风格只改三样东西：
 * 1. **配色**：背景、讲义、标题、强调色
 * 2. **字体与线条**：字号、字重、线宽、圆角
 * 3. **质感**：背景纹理、阴影、发光
 *
 * 它**不改元素结构**——这是关键约束。如果某个风格需要不同的元素布局，
 * 那是另一个结构模板，不是风格。
 */

/** 风格主题：全部落到 CSS 变量，渲染层只需拼一段 `:root{...}` */
export interface StyleTheme {
  /** 背景色 */
  bg: string
  /** 讲义区背景（与正文区分） */
  lectureBg: string
  /** 讲义分隔线 */
  divider: string
  /** 正文文字 */
  text: string
  /** 次要文字（未激活的讲义行） */
  muted: string
  /** 标题色 */
  title: string
  /** 激活行的强调色 */
  accent: string
  /** 激活行的发光（rgba，可为空串） */
  glow: string
  /** 默认元素颜色（模型没给 color 时用） */
  element: string
  /** 讲义字号（px） */
  lectureSize: number
  /** 标题字号（px） */
  titleSize: number
  /** 元素文字字号（px） */
  elementSize: number
  /** 公式字号（px） */
  texSize: number
  /** 字体栈 */
  fontFamily: string
  /** 形状线宽（px） */
  strokeWidth: number
  /** 形状圆角（px） */
  radius: number
  /** 背景附加纹理（CSS background-image 值，可为空串） */
  texture: string
  /** 讲义缩进样式：编号用数字还是圆点 */
  bulletStyle: 'number' | 'dot'
}

export interface VisualStyle {
  id: string
  /** 展示名 */
  name: string
  /** 一句话描述这个风格长什么样 */
  summary: string
  /** 什么时候该用它 */
  whenToUse: string
  /** 本地关键词匹配用 */
  keywords: string[]
  theme: StyleTheme
}
