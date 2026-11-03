/**
 * 从 note.md 生成小红书图卡 HTML（1080×1440，3:4）。
 *
 * 渲染由流水线里的 browser_navigate + browser_screenshot 完成——
 * 这个脚本只负责把 markdown 变成一份能截图的 HTML。
 *
 * 用法：
 *   node render-cards.mjs <note.md 路径> <输出目录>
 * 产出：
 *   <输出目录>/cards.html   ← 用 browser_navigate 打开它
 *   并在 stdout 打印每张卡的锚点 id，供逐张截图
 *
 * 为什么不用 image_generate：它不收宽高（传了 400），只能出默认比例；
 * 而小红书封面/配图要 3:4，且 AI 生图会把中文画成乱码。
 * HTML 卡片把尺寸写死在 CSS 里，文案是自己的字，两步都确定。
 */
const fs = require('fs')
const path = require('path')

const W = 1080
const H = 1440

const notePath = process.argv[2]
const outDir = process.argv[3]

if (!notePath || !outDir) {
  console.error('用法: node render-cards.mjs <note.md> <输出目录>')
  process.exit(2)
}
if (!fs.existsSync(notePath)) {
  console.error(`找不到 ${notePath}——上游 draft 步没有产出正文`)
  process.exit(1)
}

const md = fs.readFileSync(notePath, 'utf8')

/** 按小节切出标题 / 正文 / 标签。切不到就如实报，不猜。 */
function section(name, next) {
  const start = md.indexOf(`## ${name}`)
  if (start < 0) return ''
  const from = start + `## ${name}`.length
  const to = next ? md.indexOf(`## ${next}`, from) : -1
  return md.slice(from, to < 0 ? undefined : to).trim()
}

const titleLine = /^#\s+(.+)$/m.exec(md)?.[1]?.trim() ?? ''
const body = section('正文', '标签')
const tags = section('标签', '配图计划')

if (!titleLine || !body) {
  console.error(
    `note.md 结构不完整（标题=${titleLine ? '有' : '缺'}，正文=${body ? '有' : '缺'}）——` +
      `需要 "# 标题" 与 "## 正文" 两个小节`,
  )
  process.exit(1)
}

/** 正文按空行切段；每张卡放 1-2 段，太多字会挤爆 1080×1440 */
const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
const chunks = []
for (let i = 0; i < paras.length; i += 2) chunks.push(paras.slice(i, i + 2))

const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const card = (id, kind, inner) => `
  <section class="card ${kind}" id="${id}">
    <div class="inner">${inner}</div>
  </section>`

const cover = card(
  'card-cover',
  'cover',
  `<div class="kicker">小红书图文</div>
   <h1>${esc(titleLine)}</h1>
   <div class="rule"></div>
   <div class="tags">${esc(tags.replace(/^#+\s*/gm, '').slice(0, 120))}</div>`,
)

const bodyCards = chunks
  .map((ps, i) =>
    card(
      `card-${i + 1}`,
      'body',
      `<div class="index">${String(i + 1).padStart(2, '0')} / ${String(chunks.length).padStart(2, '0')}</div>
       ${ps.map((p) => `<p>${esc(p)}</p>`).join('\n       ')}`,
    ),
  )
  .join('')

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${esc(titleLine)}</title>
<style>
  @page { size: ${W}px ${H}px; margin: 0; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: #ddd; font-family: "Microsoft YaHei", "PingFang SC", sans-serif; }
  /* 每张卡按真实像素排版；截图时按 id 逐个截，不靠缩放 */
  .card {
    width: ${W}px; height: ${H}px; padding: 110px 92px; background: #FBFAF6; color: #141414;
    position: relative; overflow: hidden; margin: 0 auto 32px;
    display: flex; align-items: center;
  }
  .inner { width: 100%; }
  .cover .kicker { font-size: 34px; letter-spacing: 6px; color: #8a8a8a; margin-bottom: 44px; }
  .cover h1 { font-size: 82px; line-height: 1.28; font-weight: 800; letter-spacing: -1px; }
  .rule { width: 132px; height: 8px; background: #FFE86B; margin: 52px 0 40px; }
  .cover .tags { font-size: 30px; line-height: 1.7; color: #5a5a5a; }
  .body .index { font-size: 26px; letter-spacing: 3px; color: #a0a0a0; margin-bottom: 40px; }
  .body p { font-size: 42px; line-height: 1.72; margin-bottom: 30px; }
  .body p:last-child { margin-bottom: 0; }
</style>
</head>
<body>${cover}${bodyCards}
<script>
  // 单卡模式：cards.html?only=card-2 只显示那一张，并铺满视口。
  // 因为 browser_screenshot 不支持裁剪（只收 fullPage），所以用
  // 「视口 = 卡片尺寸 + 只渲染一张」达到同样效果——比事后裁剪稳，也不用引入图片库。
  const only = new URLSearchParams(location.search).get('only')
  if (only) {
    for (const el of document.querySelectorAll('.card')) {
      if (el.id !== only) el.remove()
      else el.style.margin = '0'
    }
    document.body.style.background = '#FBFAF6'
  }
</script>
</body>
</html>`

fs.mkdirSync(outDir, { recursive: true })
const out = path.join(outDir, 'cards.html')
fs.writeFileSync(out, html, 'utf8')

console.log(`CARDS_HTML=${out}`)
console.log(`CARDS=${1 + chunks.length}`)
for (const id of ['card-cover', ...chunks.map((_, i) => `card-${i + 1}`)]) console.log(`  #${id}`)
