/**
 * HTML 单文件报告模板（P1.3，设计 §5.6）。
 *
 * 交付形态：单文件 HTML，样式走 Tailwind Play CDN（需联网），移动端优先。
 * 代码侧只提供骨架 + 纯函数 renderHtmlReport；正文内容由 Agent 填 sections。
 */

export interface HtmlReportSection {
  /** 节标题（编号由模板自动加，或调用方已含编号） */
  title: string
  /** HTML 正文（已由 Agent 生成，直接内嵌，不二次转义） */
  html: string
}

export interface HtmlReportInput {
  title: string
  /** 顶部结论摘要卡内容（HTML） */
  summary: string
  sections: readonly HtmlReportSection[]
  /** 生成时间戳，缺省用当前时间 */
  generatedAt?: number
}

/** HTML 特殊字符转义（标题/摘要若含裸文本时用，Agent 生成的内容不转义） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染单文件 HTML 报告。标题与摘要做转义；节内容视为 Agent 已生成的 HTML 原样内嵌。
 */
export function renderHtmlReport(input: HtmlReportInput): string {
  const generatedAt = input.generatedAt ?? Date.now()
  const timeStr = new Date(generatedAt).toLocaleString('zh-CN')
  const sectionsHtml = input.sections
    .map(
      (s, i) => `
    <section class="mb-6">
      <h2 class="text-lg font-semibold text-gray-800 mb-2">${i + 1}. ${escapeHtml(s.title)}</h2>
      <div class="text-gray-700 leading-relaxed space-y-2">${s.html}</div>
    </section>`,
    )
    .join('')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(input.title)}</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-size: 16.5px; }
    table { border-collapse: collapse; }
    td, th { border: 1px solid #e5e7eb; padding: 0.5rem 0.75rem; }
  </style>
</head>
<body class="bg-gray-50 text-gray-900">
  <div class="max-w-2xl mx-auto px-4 py-6">
    <div class="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-6">
      <h1 class="text-xl font-bold text-blue-900 mb-2">${escapeHtml(input.title)}</h1>
      <div class="text-blue-800 leading-relaxed">${input.summary}</div>
    </div>
${sectionsHtml}
    <footer class="mt-8 pt-4 border-t border-gray-200 text-xs text-gray-400">
      本报告由 Lumii 生成 · ${timeStr}
    </footer>
  </div>
</body>
</html>
`
}
