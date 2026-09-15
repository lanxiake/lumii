/**
 * 预览里的伪标签转义
 *
 * 这条规则存在的唯一理由：文件预览会解析原始 HTML，`<N>` 这类占位符被当成
 * 未知标签后，占位符本身会从界面上消失（只剩一段空白）。所以要两头都锁住——
 * 占位符必须救回来，正文里真在用的 `<br>` / `<table>` 必须原样保留，
 * 否则修一个坏一个。
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import MDEditor from '@uiw/react-md-editor'
import { escapeUnknownHtmlTags } from './markdown-unknown-tags'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('escapeUnknownHtmlTags', () => {
  it('把 ASCII 占位符转成字面文本', () => {
    expect(escapeUnknownHtmlTags('此后仅状态更新 <N> 条')).toBe('此后仅状态更新 &lt;N&gt; 条')
    expect(escapeUnknownHtmlTags('<page_number>')).toBe('&lt;page_number&gt;')
    expect(escapeUnknownHtmlTags('路径 <input_image_path> 与 <skill-name>')).toBe(
      '路径 &lt;input_image_path&gt; 与 &lt;skill-name&gt;',
    )
  })

  it('保留正文里真在用的 HTML 标签', () => {
    for (const tag of ['<br>', '<table>', '<sub>', '<b>', '<p>', '</div>', '<hr/>']) {
      expect(escapeUnknownHtmlTags(`前${tag}后`)).toBe(`前${tag}后`)
    }
  })

  it('带属性的标签一概不碰（占位符从不带属性）', () => {
    expect(escapeUnknownHtmlTags('<img src="a.png">')).toBe('<img src="a.png">')
    expect(escapeUnknownHtmlTags('<div class="x">y</div>')).toBe('<div class="x">y</div>')
  })

  it('非 ASCII 开头的尖括号本来就不是标签，保持原样', () => {
    // HTML 分词器不认这种标签，渲染器本来就当文本，不需要也不应该改写
    for (const s of ['<精确到秒>', '<目标IP>', '<时刻>', '<容器>']) {
      expect(escapeUnknownHtmlTags(s)).toBe(s)
    }
  })

  it('`<` 当小于号用时不受影响', () => {
    const sql = 'WHERE LEFT(complaintTime,10)<CURDATE();" 2>&1'
    expect(escapeUnknownHtmlTags(sql)).toBe(sql)
    expect(escapeUnknownHtmlTags('若 a<b 且 c>d')).toBe('若 a<b 且 c>d')
  })

  it('代码块与行内代码整段跳过（Markdown 在代码里不解码实体）', () => {
    const fenced = '```\ndocker restart <容器>\nrun <N>\n```'
    expect(escapeUnknownHtmlTags(fenced)).toBe(fenced)
    expect(escapeUnknownHtmlTags('用 `<N>` 占位')).toBe('用 `<N>` 占位')
    // 代码段之外照常处理
    expect(escapeUnknownHtmlTags('用 `<N>` 占位，正文写 <N>')).toBe('用 `<N>` 占位，正文写 &lt;N&gt;')
  })

  it('没有伪标签时原样返回', () => {
    const plain = '# 标题\n\n- 一条\n- 两条\n'
    expect(escapeUnknownHtmlTags(plain)).toBe(plain)
    expect(escapeUnknownHtmlTags('')).toBe('')
  })
})

describe('预览渲染后占位符不再消失', () => {
  it('转义过的正文里仍能看到 <N> 的字面文本，也没有未知元素', () => {
    const src = '- 钉死断点：业务时间 **<精确到秒>**，此后仅状态更新 <N> 条、全天零接收；'
    const { container } = render(<MDEditor.Markdown source={escapeUnknownHtmlTags(src)} />)

    expect(container.textContent).toContain('<N>')
    expect(container.textContent).toContain('<精确到秒>')
    expect(container.querySelector('n')).toBeNull()
  })

  it('不转义时占位符确实会丢——这条规则不是多余的', () => {
    // 渲染未知标签时 React 会打 console.error，这里静音掉免得污染测试输出
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { container } = render(<MDEditor.Markdown source="- 此后仅状态更新 <N> 条" />)

    expect(container.textContent).not.toContain('<N>')
  })

  it('<br> 仍然真的换行', () => {
    const { container } = render(<MDEditor.Markdown source={escapeUnknownHtmlTags('第一行<br>第二行')} />)
    expect(container.querySelector('br')).not.toBeNull()
  })
})
