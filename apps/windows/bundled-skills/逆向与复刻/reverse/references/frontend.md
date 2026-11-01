# 前端逆向

只看「网站/JS 是怎么做的」，不重建工程。要重建用 `clone`。

## 1. 先看清页面是怎么生成的

```js
browser_eval({ script: `(() => ({
  framework: {
    next: !!document.querySelector('#__NEXT_DATA__, #__next'),
    nuxt: typeof window.__NUXT__ !== 'undefined',
    react: !!(window.React || document.querySelector('[data-reactroot]')),
    vue: !!document.querySelector('[data-v-app]'),
    svelte: !!document.querySelector('[class*="svelte-"]'),
  },
  scripts: [...document.scripts].map(s => s.src).filter(Boolean),
  inlineScripts: [...document.scripts].filter(s => !s.src).length,
  readyState: document.readyState,
}))()` })
```

读 `result.framework`。

## 2. 找数据从哪来

**最强的一步：看网络请求。**

1. `browser_requests({ filter: '' })` 拿到全量清单
2. 按类型与 URL 特征挑出候选：`/api/`、`graphql`、`.json`、`/rpc/`
3. `browser_response_body({ url })` 取响应体核对

> `browser_response_body` **只捕获调用之后发生的响应**。页面已加载完的资源会报
> `Response not found for url pattern`。这时二选一：
> - 重新导航一次页面，紧接着调用它
> - 在 `browser_eval` 里 `await fetch(url)` 自己读（同源或带 CORS 头都能读）

区分两类数据源：

| 特征 | 含义 | 复现难度 |
|---|---|---|
| 返回完整 HTML | 服务端渲染 | 需要后端 |
| 返回 JSON + 前端渲染 | CSR + API | 中间层可复现 |
| 返回的数据在 HTML `<script>` 里（`__NEXT_DATA__` / `__NUXT__`） | SSR 注水 | 可静态提取 |
| 请求带签名参数（`sign` / `token` / `_t`） | 有校验 | 要找到签名函数 |

## 3. 找前端签名 / 加密

页面请求里出现 `sign`、`timestamp`、`nonce`、`x-*` 头时：

1. 从 `browser_requests` 里拿到具体请求 URL 与参数名
2. 从 `document.scripts` 里定位 JS 文件（按大小排序，业务包通常在 100KB~2MB）
3. `bash` 下载后用 `grep` 搜参数名 —— 命中的位置附近就是签名函数
4. 看起来是 Webpack/Vite 打包的，搜 `webpackChunk` / `__vite__mapDeps` 定位入口

```js
browser_eval({ script: `(() => {
  const names = Object.keys(window).filter(k => /sign|crypt|encrypt|md5|sha|auth/i.test(k))
  return { candidates: names, hasCrypto: typeof crypto?.subtle !== 'undefined' }
})()` })
```

> **别解混淆到走火入魔**：签名算法常见就那几种（HMAC / 时间戳拼接 / 固定盐）。
> 先看参数结构，再猜算法，最后才去找确切实现。

## 4. 运行时采样（拿到真实值，不猜）

抓函数真实入参的最省事办法是**包一层**：

```js
browser_eval({ script: `(() => {
  const orig = window.fetch
  window.__tap = []
  window.fetch = function (...args) {
    window.__tap.push({ input: String(args[0]), init: args[1] ?? null })
    return orig.apply(this, args)
  }
  return { installed: true }
})()` })
```

之后操作页面，再读 `window.__tap` 拿到全部请求。这是**只读观察**，不改变行为。

同样的手法能抓 `XMLHttpRequest.prototype.open/send`、`localStorage.setItem`、`console.log`。

## 5. 记录要求

每条结论写清：**观察方式 → 原始输出 → 推论**。
「看起来像是用了 SSR」不算结论；「`#__NEXT_DATA__` 存在且含完整 props，因此是 Next.js SSR」才是。
