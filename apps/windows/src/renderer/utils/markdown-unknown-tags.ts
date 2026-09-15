/**
 * 把 Markdown 源里的「伪标签」转义成字面文本
 *
 * 背景：文件预览走 `@uiw/react-markdown-preview`，它会解析原始 HTML——正文里的
 * `<br>`、`<table>` 正是靠它生效的。但 HTML 分词器只把「`<` 后紧跟 ASCII 字母」
 * 认作标签开头，于是文档里形如 `<N>`、`<page_number>` 的占位符会被当成未知标签：
 * 占位符本身从预览里消失，只剩下一段空白（React 还会为这个未知元素往诊断日志里
 * 记一条警告）。而 `<精确到秒>`、`<时刻>` 这类非 ASCII 开头的占位符反倒安然无恙——
 * 同一份文档里两种占位符表现不一致，用户只会觉得「字丢了」。
 *
 * 这里只转义「不在标签名单里」的那些，`<br>` / `<table>` 等照旧生效；
 * 代码块与行内代码整段跳过——Markdown 在代码里不解码实体，改了反而会把
 * `&lt;` 原样显示出来。
 */

/** 原样保留的标签（HTML 规范的元素名，小写）。名单外的（含自定义元素）一律转义成文本 */
const HTML_TAGS = new Set([
  'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio',
  'b', 'base', 'bdi', 'bdo', 'blockquote', 'body', 'br', 'button',
  'canvas', 'caption', 'cite', 'code', 'col', 'colgroup',
  'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
  'em', 'embed',
  'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr', 'html',
  'i', 'iframe', 'img', 'input', 'ins',
  'kbd',
  'label', 'legend', 'li', 'link',
  'main', 'map', 'mark', 'menu', 'meta', 'meter',
  'nav', 'noscript',
  'object', 'ol', 'optgroup', 'option', 'output',
  'p', 'picture', 'pre', 'progress',
  'q',
  'rp', 'rt', 'ruby',
  's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
  'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
  'u', 'ul',
  'var', 'video',
  'wbr',
])

/**
 * 代码段：围栏块（``` / ~~~）与行内代码。
 * 带一个捕获组，配 `String.split` 用——捕获到的段落在结果数组的奇数下标上。
 */
const CODE_SEGMENT = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/g

/**
 * 只认「光杆标签」：`<name>` / `</name>` / `<name/>`，与 HTML 分词器一致——
 * 只有 `<` 后紧跟 ASCII 字母才算标签开头。
 *
 * 带属性的一概不碰：占位符从不带属性，而 `<` 当小于号用时（SQL 的
 * `LEFT(t,10)<CURDATE()`、`a<b` 之类）也就不会被误伤——没有通配的标签体，
 * 就不存在「一路吃到远处某个 `>`」的问题。
 */
const BARE_TAG = /<(\/?)([A-Za-z][A-Za-z0-9._-]*)(\/?)>/g

/**
 * 转义 Markdown 正文里不在标签名单内的光杆 `<...>`。
 *
 * 只做这一件事，不改动其它任何字符；名单内的标签、带属性的标签原样保留。
 */
export function escapeUnknownHtmlTags(markdown: string): string {
  return markdown
    .split(CODE_SEGMENT)
    .map((segment, index) =>
      index % 2 === 1
        ? segment
        : segment.replace(BARE_TAG, (match, close: string, name: string, slash: string) =>
            HTML_TAGS.has(name.toLowerCase()) ? match : `&lt;${close}${name}${slash}&gt;`,
          ),
    )
    .join('')
}
