---
name: clone
description: 把已有网页按其真实内容、资源、布局与交互重建为可编辑的前端工程。用于网站复刻、迁移、学习与竞品还原；用户提到还原某个站点、复刻页面、照着这个网页做一个时使用。不含逆向二进制/APP（用 reverse），不含安全测试（用 redteam / blueteam）。
metadata: { "mtbot": { "emoji": "🧬" } }
---

# 网页复刻

## 什么时候不该用它

- 目标站点明确禁止抓取或复现——先确认授权，再动手。
- 只想看懂技术实现、不重建——用 `reverse`，它只产出分析，不产出工程。
- 核心流程依赖后端、数据库或登录态——静态复刻跑不通，先说清楚只能还原到哪一层。

## 四步

1. **Map** —— 列出要复刻的页面，定「源路径 → 本地路由」映射与产物目录。先定范围，再取证。
2. **Observe** —— 逐项取证：结构、样式、资源、状态。**本节的规则是唯一正本**，下面的工具表只是执行手段；逐项清单见 [`references/inspection-guide.md`](references/inspection-guide.md)。
3. **Build** —— 建工程，按区块实现。每块做完立刻对照证据，不要攒到最后。
4. **Compare** —— 同视口、同滚动位置、同页面状态下对比截图，修最大差异，如实声明剩余差异。

判断动效由什么驱动（时间 / 滚动 / 点击 / 指针）、以及是否来自 Framer 或 Lenis，见
[`references/framer-and-motion.md`](references/framer-and-motion.md)。

## 工具怎么用

| 目的 | 工具 | 注意 |
|---|---|---|
| 打开 | `browser_navigate` | 先断言 200；非 200 就停，别在错误页上取证 |
| 全页截图 | `browser_screenshot({fullPage:true})` | 折叠区只有开 `fullPage` 才拍得到 |
| 移动端 | `browser_set_device({name:"iPhone 14"})` 再截图 | 设备是**状态**，截完切回 `"Desktop Chrome"` |
| 自定义视口 | `browser_set_device({width,height})` | 只改尺寸，不改 UA |
| 资源清单 | `browser_requests({filter})` | 上限 500 条；过滤是 URL 子串，重页面先 `clear` 再分段 |
| 取响应体 | `browser_response_body({url})` | 只捕获**调用之后**发生的响应；页面已加载的资源会报 `Response not found`，改用页面内 `fetch()` 读头 |
| 不再发起请求核头 | `browser_eval` 里 `await fetch(url,{cache:'force-cache'})` + `headers.get('content-type')` | 已加载资源的 content-type 用这条；同源或带 CORS 头都可读 |
| 读样式 | `browser_eval({script})` | 读 computed style，不要凭截图猜 |
| 按 ref 下载 | `browser_download({ref, path})` | ref 来自 `browser_snapshot` |

`browser_eval` 的结果是扁平的：对象结果直接摊在 `result` 上，标量结果在 `result.value`，
页面地址在 `result.url`。取字段时按这个形状写脚本。

## 什么叫「取证完成」

三份文件齐、每条指标可追溯、content-type 核对过——缺一条就是没完成。统一落在
`docs/research/<slug>/` 下：

- `brief.md`：页面/区块清单、源路径 → 本地路由映射、字体/颜色/间距/圆角/断点（带选择器与 computed 值）
- `assets.md`：资源原始 URL、真实 content-type、尺寸与用途；文件本身存 `assets/`
- `states.md`：每段交互/动效的 before → after 证据（触发条件、等待时长、computed 值）

完成后明确写出**没复刻到的部分**与原因。不要声称像素级还原。
