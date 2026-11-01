# 取证清单

只在 `Observe` 阶段读这份。每一项都要留下**可追溯的证据**（选择器 + computed 值 + 截图路径），
不要写「大概 24px」这种无法复核的结论。

## 1. 视觉结构

按文档顺序记录，不要按视觉印象重排。

- 段落顺序与每个区块的用途
- 容器：`max-width`、左右 padding、居中对齐方式
- 栅格：列数、列间距、断点；单列与多列切换发生在哪个宽度
- 层级：`sticky` / `fixed` 元素、z-index、遮罩与浮层
- 文字：标题与正文各自的 `font-family` / `font-weight` / `font-size` / `line-height` / `letter-spacing`
- 宽度扫描：从移动端宽度一路加宽到超过设计稿宽度，记录每次布局变化，得到真实断点

一次读全的量法（返回对象，字段直接取）：

```js
browser_eval({ script: `(() => {
  const s = getComputedStyle(document.querySelector('h1'))
  const c = document.querySelector('.container')
  const cs = getComputedStyle(c)
  return {
    heading: { family: s.fontFamily, weight: s.fontWeight, size: s.fontSize,
               lineHeight: s.lineHeight, letterSpacing: s.letterSpacing },
    container: { maxWidth: cs.maxWidth, padding: cs.padding, margin: cs.margin },
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
  }
})()` })
```

读结果：`result.heading.size`、`result.container.maxWidth`。

## 2. 资源

对每张图、每个字体、每段视频记录：

- `currentSrc`（不是 `src`）、`srcset`、实际渲染尺寸、`object-fit`、`alt`
- 字体：`document.fonts` 里**实际加载**的 family + weight，而不是 CSS 里声明的
- 真实 content-type：`browser_response_body({url})` 读 `headers['content-type']`。
  **它只捕获调用之后发生的响应**——页面已经加载完的资源会报 `Response not found for url pattern`。
  这时在 `browser_eval` 里用 `await fetch(url,{cache:'force-cache'})` 读
  `r.headers.get('content-type')`（同源或带 CORS 头都可读），或先导航再立刻调用。
  `.png` 可能返回 `image/avif`，`.woff` 可能是 `font/woff2`——按真实类型保存与引用。
- 资源清单：`browser_requests({ filter: '.woff2' })` 先按扩展名或 CDN 路径前缀过滤；
  重页面分段抓，抓完 `clear: true` 再继续，避免撞 500 条上限。

```js
browser_eval({ script: `(() => {
  const img = document.querySelector('main img')
  return {
    currentSrc: img.currentSrc, srcset: img.srcset,
    natural: [img.naturalWidth, img.naturalHeight],
    rendered: [img.clientWidth, img.clientHeight],
    fit: getComputedStyle(img).objectFit, alt: img.alt,
  }
})()` })
```

```js
browser_eval({ script: `(() => {
  const out = []
  document.fonts.forEach(f => { if (f.status === 'loaded') out.push([f.family, f.weight, f.style]) })
  return { fonts: out }
})()` })
```

## 3. 状态证据

交互与动效必须写成「触发 → 可见结果」，并附前后证据。

- 先滚动再点击：pinned / 滚动驱动的区块容易被误判成 tab 或点击展开
- 用 `browser_eval` 量触发前后的 computed style，而不是只看截图
- 记录触发条件（滚动比例、点击目标、指针位置）、时长、缓动、终态
- 动画未结束时不要取终态值；需要时用 `browser_wait` 等到稳定

```js
browser_eval({ script: `(() => {
  const el = document.querySelector('.hero')
  const s = getComputedStyle(el)
  return { transform: s.transform, opacity: s.opacity, height: s.height, top: el.getBoundingClientRect().top }
})()` })
```

把「触发前 / 触发后」两次结果都贴进证据文件，注明触发动作与等待时长。

## 4. 写完自检

- [ ] 每个断点都有实测宽度，不是猜的
- [ ] 字体是 `document.fonts` 的加载结果，不是 CSS 声明
- [ ] 资源内容类型核对过响应头
- [ ] 状态证据成对（before / after）
- [ ] 没复刻到的部分已写明
