# 动效驱动源辨识

复刻动效前先判断**它由什么驱动**。驱动源判断错了，后面无论怎么写都不会对。

| 驱动源 | 特征 | 复刻方式 |
|---|---|---|
| 时间 | 页面加载后自动播放，与输入无关 | CSS animation / JS timeline |
| 滚动 | 随 `scrollY` 连续变化，或到达阈值才触发 | 滚动进度映射 / IntersectionObserver |
| 点击 | 点击后开始，与滚动无关 | 事件触发 + 过渡 |
| 指针 | 随鼠标位置、hover、拖拽变化 | pointermove 映射 |

## 三条判据

### 1. Framer

- DOM 上出现 `data-framer-name`、`data-framer-component-type`
- 样式里大量 `transform: translate3d(...)` 与内联 `--framer-*` 变量
- 资源来自 `framerusercontent.com`

命中后在 `browser_eval` 里读元素属性，确认是 Framer 生成而非手写：

```js
browser_eval({ script: `(() => {
  const el = document.querySelector('[data-framer-name]')
  return el ? { name: el.getAttribute('data-framer-name'),
                type: el.getAttribute('data-framer-component-type'),
                vars: el.getAttribute('style') } : { framer: false }
})()` })
```

### 2. Lenis

- `html` 上有 `lenis` / `lenis-smooth` class
- `window.lenis` 存在
- 页面滚动是平滑插值，`scrollY` 不跟手

```js
browser_eval({ script: `(() => ({
  hasLenis: typeof window.lenis !== 'undefined',
  classes: document.documentElement.className,
  smooth: getComputedStyle(document.documentElement).scrollBehavior,
}))()` })
```

### 3. IntersectionObserver 揭示

- 元素初始 `opacity: 0` 或位移，进入视口后加 class / 改样式
- 用 `browser_scroll` 分段滚，观察元素 class 与 computed style 变化
- 在控制台没有滚动事件监听时，优先怀疑 IntersectionObserver

```js
browser_eval({ script: `(() => {
  const el = document.querySelector('.reveal')
  return { cls: el.className, opacity: getComputedStyle(el).opacity,
           transform: getComputedStyle(el).transform }
})()` })
```

## 记录要求

每条动效写清：**驱动源**、触发条件、时长、缓动、终态，以及复刻时用的是哪种实现。
动效未稳定时不取终态值；用 `browser_wait` 等它结束。
