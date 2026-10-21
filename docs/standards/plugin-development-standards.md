# 插件开发规范

> 适用：写渲染层插件（`~/.lumii/plugins/`）或主进程扩展（`~/.lumii/extensions/`）。
> 契约的完整定义见 [P5 计划 §5](../plans/工程基建/2026-10-20-P5插件中心与开发者工具实施计划.md)；
> 本文只写**踩过的坑**与验收清单——每一条都对应一次真机实测。

---

## 0. 三十秒版本

```
~/.lumii/plugins/<目录>/
  ├── client.js     必需
  └── plugin.json   可选 { id, name, version }
```

```js
// 一个插件 = 一个 id = 一次 REGISTER。保存即生效（约 0.3 秒）。
__LUMII_REGISTER_PLUGIN__('my-plugin', (api) => {
  api.registerSlot('app.view', { id: 'my.page', component: MyPage })
  return () => {}   // 可选：卸载时清理
})
```

- 用 `api.React`，**不要自带第二份 React**（两份 React 会让 hooks 直接抛错）；
- 数据用 `window.electronAPI.*`（与页面同一 JS 上下文，不做沙箱）；
- 样式用设计令牌 `var(--color-…)` / `var(--spacing-…)`，**不写死颜色**（否则主题切换不跟随）。

---

## 1. 硬规则（违反必出事）

| # | 规则 | 踩过的后果 |
|---|---|---|
| 1 | **一个插件 = 一个 id = 一次 `__LUMII_REGISTER_PLUGIN__`** | 拆成两次注册，后一次永远不执行（宿主按 manifest id 取工厂），整段代码静默不生效 |
| 2 | **槽位 id 带插件前缀**（`my-plugin.card`，别用 `card`） | 两个插件撞 id 时**后来者整个激活失败**；谁先加载谁赢，取决于 1 秒轮询的顺序 |
| 3 | 注册时拿到的注销函数与工厂返回的 `dispose` **都会在卸载时执行** | 在模块顶层开定时器/监听器，卸载后继续跑（禁用插件后 ticker 仍在涨） |
| 4 | 定时器、订阅、`requestAnimationFrame` 放 **effect 清理**里 | 同上；边界捕获不到 effect 之外的泄漏 |
| 5 | `app.view` 的条目 id 必须与 `plugin:<id>` 里的 id 一致 | 对不上时 Router 回落概览，页面“点了没反应” |
| 6 | **复制插件目录时改掉 `plugin.json` 的 id** | 两个目录共用一个 id 时只会加载一个（按目录名取第一个），另一个永远不生效；日志有告警（每个重复对只报一次） |

## 2. 槽位与布局预算

| 槽位 | 位置 | 预算 |
|---|---|---|
| `dashboard.main` | 概览顶部整宽（资讯区） | 会挤压资讯，慎用 |
| `dashboard.grid` | 概览底部三栏 | **最多 3 个**，第 4 个不渲染 + 一条去重告警 |
| `dashboard.plugins` | 概览插件专属带 | 168px 高，**内部滚动**，加多少都不挤压上面的布局 |
| `app.nav` | 侧栏导航下方 | 用 context 里的 `classNames` 跟原生导航一致 |
| `app.view` | 整页 | 自己掌握布局 |
| `settings.section` | 设置 › 扩展 | 与其它插件分区并列 |

**先问「这个页面有给插件的布局预算吗」再开槽位**——概览是像素预算的一屏，
`dashboard.grid` 第 4 张会被裁掉（实测）。

`order` 小的在前、相同按注册顺序。

## 3. 错误与边界

- 渲染期抛错由 `PluginErrorBoundary` 兜住：**只降级那一块**（卡片 / 页面），并显示
  「插件 X 渲染失败」+ 重试，其余界面照常。改好文件保存后点「重试」即可，不必重启。
- **边界管不到**：事件处理器、`setTimeout` / `Promise` 里的抛错。事件处理器抛错会被
  `window.onerror` 记进日志、应用存活；异步错误请自己 `catch`。
- 激活中途失败是**原子**的：本次注册的槽位会全部回滚，不会留半截。

## 4. 热更新与失败恢复

| 现象 | 说明 |
|---|---|
| 保存 → 约 0.3 秒生效 | 清单按 revision（mtime+size）每秒轮询 |
| 语法错误 | **旧版本继续服务**，日志报「脚本执行出错：…」，页面不消失 |
| 注册了但没注册成 | 日志报「没有调用 `__LUMII_REGISTER_PLUGIN__`」——检查是不是 id 与 `plugin.json` 不一致 |
| 状态 | 热更新会重建组件，**组件内 state 不保留** |
| 撞 id 失败后 | 删掉冲突方、或改本插件文件，都会自动重试（1 秒内） |

## 5. 样式

- 只用设计令牌：颜色 `--color-*`、间距 `--spacing-*`、圆角 `--radius-*`、字号 `--font-size-*`；
- **不要给令牌写死 fallback**（`var(--color-success, #16a34a)`）——主题/字号切换时 fallback
  会成为异色；仓库有守卫测试会红；
- 深色、护眼、四档字号都要过一遍（令牌全通，不需要额外适配）；
- `app.nav` 用 context 给的 `classNames.item / active / icon / label`，否则一眼看出不是原生导航。

## 6. 数据

```js
await window.electronAPI.usage.query({ from, to, groupBy: 'day' })  // 用量
await window.electronAPI.usage.latency()                            // 首字节
await window.electronAPI.dashboardFeed.latest()                     // 资讯
await window.electronAPI.extensions.list()                          // 扩展状态
```

主进程扩展：`ctx.get('agentRuntime')?.get()` 拿到整个 Agent Runtime 桥；
`ctx.get('perf' | 'cloudSync' | 'mainWindow' | 'tray' | 'mcp'?)` 见 `kernel/services.ts`。
`LateRef` 要 `.get()`，每次现取（**不要** `provide(key, () => x)`，工厂结果会被缓存）。

## 7. 调试

| 做法 | 结果 |
|---|---|
| `console.log` | 进主日志（INFO），前面带 `[Renderer:console]` |
| `console.error` | 同时进**错误日志**——只有这个双写 |
| `console.info` | **完全不落盘**（踩过三次） |

打开 设置 › 扩展 能看到每个插件的状态（已加载 / 失败 + 原因），失败不用翻日志。

## 8. 验收清单

- [ ] 保存后约 0.3 秒看到变化；改出语法错误时**旧界面还在**
- [ ] 侧栏入口、整页、卡片都在该在的位置；找不到页面时回落概览而不是白屏
- [ ] 禁用插件：入口与其页面一起消失，**不残留定时器**（日志里不再有 tick）
- [ ] 深色主题 + 四档字号下没有硬编码色块
- [ ] 故意在渲染里 `throw`：只有那一块显示「渲染失败」，侧栏还在
- [ ] 与另一个插件同槽位共存时顺序符合 `order`
