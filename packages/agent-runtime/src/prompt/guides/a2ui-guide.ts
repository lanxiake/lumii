/**
 * 完整 A2UI 动态 UI 指南（含所有示例）
 *
 * 系统提示词中仅注入精简版（组件列表+1个格式模板），
 * 需要详细格式规范时可按需注入此完整版。
 */

export const A2UI_GUIDE_CONTENT = `## 动态 UI 能力（完整指南）

### A2UI 组件（\\\`\\\`\\\`a2ui 代码块）

可用组件：
- **Chart**: 数据图表（chartType: line/bar/pie/scatter/area），包含 data.labels 和 data.datasets
- **MathVisualizer**: 数学函数可视化（expression: 如 "y=sin(x)"，乘法必须用 * 号，可选 range 和 animated）
- **Text**: 富文本段落（variant: body/caption/heading）
- **Card**: 信息卡片（title, subtitle, 可嵌套 components）
- **Image**: 图片展示（src, alt）
- **Button**: 操作按钮（label, variant: primary/secondary/outline）
- **List**: 列表容器（items, ordered）
- **AudioPlayer**: 音频播放器（src, title）— 支持本地文件路径或 URL
- **VideoPlayer**: 视频播放器（src, title, poster）— 支持本地文件路径或 URL
- **FilePreview**: 文件预览（src, filename, mimeType）
- **DataTable**: 数据表格（columns: [{key, label, sortable}], rows: [对象数组]）— 支持排序、过滤、分页

示例 — 折线图（注意 datasets 每项必须有 label 和 values 字段）：
\\\`\\\`\\\`a2ui
{"components":[{"type":"Chart","id":"c1","chartType":"line","title":"用户增长","data":{"labels":["1月","2月","3月"],"datasets":[{"label":"用户数","values":[100,200,350]}]}}]}
\\\`\\\`\\\`

示例 — 数学函数：
\\\`\\\`\\\`a2ui
{"components":[{"type":"MathVisualizer","id":"mv1","expression":"y=sin(x)","range":{"xMin":-6.28,"xMax":6.28}}]}
\\\`\\\`\\\`

示例 — 数据表格：
\\\`\\\`\\\`a2ui
{"components":[{"type":"DataTable","id":"dt1","columns":[{"key":"name","label":"姓名","sortable":true},{"key":"score","label":"分数","sortable":true}],"rows":[{"name":"Alice","score":95},{"name":"Bob","score":87}]}]}
\\\`\\\`\\\`

### Artifact 沙箱（代码块直接执行）

输出 html/svg/javascript 代码块，客户端自动在安全沙箱中渲染：
- \\\`\\\`\\\`html: 完整 HTML 页面（支持内联 CSS/JS）
- \\\`\\\`\\\`svg: SVG 图形或动画
- \\\`\\\`\\\`javascript: 纯 JS 代码片段（自动注入 body 执行）

安全限制：无 fetch/XHR，允许 https 外部图片/字体，sandbox 隔离。

### 使用指引
- 数据可视化或富交互 → A2UI 组件
- 运行代码、展示动画或小游戏 → Artifact 代码块
- 简单文本 → Markdown
- 数学公式 → LaTeX（$..$ 行内 / $$...$$ 块级）`;
