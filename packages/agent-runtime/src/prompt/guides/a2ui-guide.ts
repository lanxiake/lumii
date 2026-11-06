/**
 * 完整 A2UI 动态 UI 指南（含所有示例）
 *
 * 系统提示词里不注入（`buildA2UISection` 已停用：实测 0 次调用），完整文档由
 * `a2ui_guide` 工具按需返回。**组件清单只剩 Chart / DataTable**——其余组件已下线，
 * 理由见 `apps/windows/src/renderer/components/A2UIRenderer/validate.ts` 顶部注释。
 */

export const A2UI_GUIDE_CONTENT = `## 动态 UI 能力（完整指南）

### A2UI 组件（\\\`\\\`\\\`a2ui 代码块）

只有两种组件，用于对话内展示**结构化数据**：

- **Chart**: 数据图表。\`chartType\` 取 line/bar/pie/scatter/area；
  \`data.labels\` 是字符串数组，\`data.datasets\` 每项必须有 \`label\` 和数值型 \`values\`。
  - 值必须是数字（不要写 "1,234"、"12%" 这类带符号的字符串）。
  - 每个数据集的 \`values\` 长度应与 \`labels\` 一致。
- **DataTable**: 数据表格。\`columns: [{key, label, sortable?}]\`，
  \`rows\` 是对象数组，键对应 \`columns[].key\`；可选 \`pageSize\` / \`filterable\`。

规模限制（超过会被截断或整块丢弃）：单图 ≤ 2000 点、单表 ≤ 5000 行 / 50 列、
一条消息 ≤ 20 个组件。

示例 — 折线图：
\\\`\\\`\\\`a2ui
{"components":[{"type":"Chart","id":"c1","chartType":"line","title":"用户增长","data":{"labels":["1月","2月","3月"],"datasets":[{"label":"用户数","values":[100,200,350]}]}}]}
\\\`\\\`\\\`

示例 — 数据表格：
\\\`\\\`\\\`a2ui
{"components":[{"type":"DataTable","id":"dt1","columns":[{"key":"name","label":"姓名","sortable":true},{"key":"score","label":"分数","sortable":true}],"rows":[{"name":"Alice","score":95},{"name":"Bob","score":87}]}]}
\\\`\\\`\\\`

### Artifact 沙箱（代码块直接执行）

输出 html/svg/javascript 代码块，客户端自动在沙箱中渲染：
- \\\`\\\`\\\`html: 完整 HTML 页面（支持内联 CSS/JS）
- \\\`\\\`\\\`svg: SVG 图形或动画
- \\\`\\\`\\\`javascript: 纯 JS 代码片段（自动注入 body 执行）

沙箱限制：iframe 为不透明源（无法读写 localStorage/cookie、无法访问宿主页面对象），
但**允许** fetch/XHR 与外部资源（图片/字体/脚本）。

### 选择规则（重要）

| 场景 | 用什么 |
|---|---|
| 趋势 / 对比 / 占比，需要图 | A2UI Chart |
| 表格数据 ≥ 5 行，且用户要看排序、筛选或分页 | A2UI DataTable |
| 表格 ≤ 4 行，或只是一次性罗列 | **Markdown 表格**（不要用 A2UI） |
| 运行代码、动画、小游戏、可交互页面 | Artifact 代码块 |
| 普通文字 / 列表 / 说明 | Markdown |
| 数学公式 | LaTeX（$..$ 行内 / $$...$$ 块级） |

**不要**用 A2UI 展示文件（图片、PDF、音视频）——那些直接用 Markdown 链接或图片语法，
客户端会按本地路径正确预览。`
