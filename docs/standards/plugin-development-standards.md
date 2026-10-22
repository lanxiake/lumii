# 插件开发规范

> 适用：写渲染层插件（`~/.lumii/plugins/`）或主进程扩展（`~/.lumii/extensions/`）。
> 契约的完整定义见 [P5 计划 §5](../plans/工程基建/2026-10-20-P5插件中心与开发者工具实施计划.md)；
> 本文只写**踩过的坑**与验收清单——每一条都对应一次真机实测。

---

## 0. 三十秒版本

```
~/.lumii/plugins/<目录>/
  ├── client.js     必需
  └── plugin.json   可选 { id, name, version, description?, author?, origin?, engines? }
```

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "0.1.0",
  "description": "一句话说明它做什么",
  "author": "agent",
  "origin": "agent",
  "engines": { "lumii": ">=0.1.0" }
}
```

- `origin`：`agent`（Agent 自举开发）或 `user`（用户手写），面板据此显示来源徽标；
- `engines.lumii`：semver range；不满足当前客户端时**不会加载**，面板显示「不兼容」；
- 改 `plugin.json` 也会触发热更新（revision 包含它）。

```js
// 一个插件 = 一个 id = 一次 REGISTER。保存即生效（约 0.3 秒）。
__LUMII_REGISTER_PLUGIN__('my-plugin', (api) => {
  api.registerSlot('app.view', { id: 'my.page', component: MyPage })
  return () => {}   // 可选：卸载时清理
})
```

- 用 `api.React`，**不要自带第二份 React**（两份 React 会让 hooks 直接抛错）；
- 整页用 **`api.Page`** 包起来（标题/副标题/操作区 + 内容区自滚），**不要再自己加 padding**；
- 数据用 `window.electronAPI.*`（与页面同一 JS 上下文，不做沙箱）；
- 样式用设计令牌 `var(--color-…)` / `var(--spacing-…)`，**不写死颜色**（否则主题切换不跟随）；
- 持久化用 `api.storage`，格式化用 `api.format`——不要每个插件各写一份。

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
| 7 | **主进程扩展注册的 `ipcMain.handle` 必须在 teardown 里摘掉** | 外部扩展热重载 / 按需卸载后重装时，第二次注册会抛 `Attempted to register a second handler`，表现为「装上了但没起来」。用 `ctx.effect(() => ipcMain.removeHandler(ch))`（参考 `screen-record-ipc.ts` 的 `unregisterScreenRecordIpc`） |

## 2. 槽位与布局预算

| 槽位 | 位置 | 预算 |
|---|---|---|
| `dashboard.main` | 概览顶部整宽（资讯区） | 会挤压资讯，慎用 |
| `dashboard.grid` | 概览底部三栏 | **最多 3 个**，第 4 个不渲染 + 一条去重告警 |
| `dashboard.plugins` | 概览插件专属带 | 168px 高，**内部滚动**，加多少都不挤压上面的布局 |
| `app.nav` | 侧栏导航下方 | 用 context 里的 `classNames` 跟原生导航一致 |
| `app.view` | 整页 | 用 `api.Page` 起手（主内容区已有 20px 内边距） |
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
| 主进程扩展**改文件** | 外部扩展 ≤1 秒热重载；内置扩展要重启主进程 |
| 主进程扩展**启用/禁用** | 写偏好，**必须重启**才生效；设置页会显示「待重启」横幅与「立即重启」 |

> 注意区分「热更新代码」与「切换启用状态」：前者外部扩展亚秒级生效，
> 后者对主进程扩展一律要重启——原因是启动时取出的服务单例被各处直接引用。

## 5. 样式

- 整页用 `api.Page`：它按内置页的口径设置最大宽度（`--mt-page-max`）与高度，
  **不再加 padding**——`.main-layout-content-inner` 已经有 20px，再加 24 会变成 44px，
  这是插件页看起来比内置页「胖一圈」的直接原因；
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

### 字段清单（别靠猜）

插件是纯 JS，看不到 preload 的类型声明。下面是真用得到的几张表的**返回字段**
（定义在 `main/plugins/builtin/usage/store.ts` / `main/provider-latency.ts` /
`main/plugins/builtin/dashboard-feed/store.ts` / `main/plugins/control.ts`，改字段时这里跟着改）。

**多数查询接口包一层信封**：`{ success: boolean, data?: T, error?: string }`——
先判 `success`，`error` 是给人看的原文，不要当枚举解析。

`usage.query(...)` → `UsageSummary`

| 字段 | 含义 |
|---|---|
| `totalCalls` / `totalPromptTokens` / `totalCompletionTokens` | 区间内总计 |
| `totalCacheReadTokens` / `totalCacheWriteTokens` | 缓存命中/写入（判断省了多少靠它） |
| `totalCostYuan` | 已知价格部分的花费合计（**人民币元**，不是分） |
| `unpricedCalls` | 价格未知的调用数——`>0` 时金额只是下限，UI 要标注 |
| `buckets[]` | 按 `groupBy` 分桶：`ts`(epoch ms) / `calls` / `promptTokens` / `completionTokens` / `cacheReadTokens` / `cacheWriteTokens` / `costYuan` / `unpricedCalls` / `byModel[]` |
| `byModel[]` | 模型聚合（花费降序）：`model` / `calls` / 同上各 token / `costYuan` / `unpricedCalls` |

`usage.latency()` → `LatencyView`：`medianMs?`（无样本时缺省）/ `sampleCount` / `isLocal`
（`isLocal=true` 是本地推理，没有网络往返，别直接叫「延迟」）。

`dashboardFeed.latest()` → `DashboardFeedSnapshot | null`：`feedId` / `title` / `updatedAt` /
`summary?` / `items[]` / `batch?`。单条 item：`id` / `title` / `summary?` / `href?` /
`source?` / `timestamp?` / `kind?`（工作流自定义，日报/任务/资讯都能走它）/ `metadata?`（任意键值）。
`batch` 记这一期的出处：`source`（`agent` / `cron` / `manual` / `legacy`）、会话、综述。

`extensions.list()` → `ExtensionInfo[]`（**裸数组，没有信封**）：`id` / `name` / `version` /
`kind`（`builtin` / `external` / `client`）/ `origin`（`builtin` / `user` / `agent` / `official`）/
`enabled` / `state`（`active` / `failed` / `disabled` / `available` / `unknown`…）/ `pendingRestart`
（开关改了但还没重启）/ `activationMs?` / `error?` / `description?` / `installable?` / `updatable?`。

> `pendingRestart` 才是「这个开关现在生效没」的判据；`enabled` 只表示偏好文件里怎么写的。

主进程扩展：`ctx.get('agentRuntime')?.get()` 拿到整个 Agent Runtime 桥；
`ctx.get('perf' | 'cloudSync' | 'mainWindow' | 'tray' | 'mcp'?)` 见 `kernel/services.ts`。
`LateRef` 要 `.get()`，每次现取（**不要** `provide(key, () => x)`，工厂结果会被缓存）。

### 6.1 共享格式化 `api.format`

```js
api.format.number(1234.5)        // 1,234.5
api.format.percent(0.426, 1)     // 42.6%
api.format.currency(1234)        // ¥1,234.00
api.format.bytes(1536)           // 1.5 KB
api.format.date(iso)             // 2026/10/21
api.format.dateTime(iso)         // 2026/10/21 10:08
api.format.relative(ts)          // 3 分钟前 / 2 小时后 / 超过 7 天回落日期
```

不要在每个插件里重写 `formatBytes`——仓库里已经有四个版本，口径开始分叉。

### 6.2 页面壳 `api.Page`

```js
h(api.Page, { title: '我的插件', subtitle: '…', actions: h(Button) }, children)
```

负责最大宽度、标题层级、内容区滚动；**不负责内边距**（主内容区已有 20px）。

### 6.3 持久化 `api.storage`

```js
api.storage.set('settings', { theme: 'dark' })
api.storage.get('settings', {})   // 按插件 id 前缀隔离，不会和别的插件串 key
api.storage.keys() / remove(key) / clear()
```

主进程扩展写 `~/.lumii/plugin-data/<插件 id>/`（`~/.lumii` 在文件工具的允许根内）。

## 7. 调试

| 做法 | 结果 |
|---|---|
| `console.log` | 进主日志（INFO），前面带 `[Renderer:console]` |
| `console.error` | 同时进**错误日志**——只有这个双写 |
| `console.info` | **完全不落盘**（踩过三次） |

打开 设置 › 扩展 能看到每个插件的状态（已加载 / 失败 + 原因），失败不用翻日志。

## 8. 来源与生命周期

| 操作 | 内置扩展 | 外部扩展 / 客户端插件 |
|---|---|---|
| 启用 / 禁用 | 支持；标了 `hot: true` 的**即时生效**，其余重启生效 | 支持（主进程重启生效；客户端 ≤1 秒） |
| 打开目录 | —（代码在 bundle 里） | 支持 |
| 删除 | **不允许**，只能禁用 | 支持（二次确认；先卸载再删目录） |

> 为什么外部扩展仍是「重启生效」：它们的服务句柄（`S.perf` / `S.cloudSync` / `S.syncScheduler`）
> 在启动期被核心取走并缓存，卸载扩展只拆自己的作用域，已经分发出去的调度器照旧在跑。
> 内置插件没有这个问题——接线在 `apply(ctx)` 里，作用域一拆功能就没了。

### 8.1 内置插件的代码放哪

```
src/plugins/builtin/<name>/
  index.ts   manifest + apply（接线全在这里）
  *.ts       该插件独占的实现与测试
```

加插件 = 建目录 + `plugins/registry.ts` 加两行（import + 条目，需要即时启停就标 `hot: true`）。
删插件 = 删目录 + 删那两行，`tsc` 会把残留引用列全。完整约定与生命周期清单见
[`apps/windows/src/main/plugins/README.md`](../../apps/windows/src/main/plugins/README.md)。

- Agent 生成的插件必须写 `origin: "agent"`，面板会显示「Agent 创建」；
- 官方可选扩展写 `origin: "official"`，面板显示「官方」；安装包只带扩展清单
  （`catalog.json`），代码按需从 GitHub Release 下载并校验 sha256，装到
  `~/.lumii/extensions/`。未安装时显示「可安装」；已安装可「卸载」，卸载后回到可安装。
  开发模式下 `resources/extensions/` 有完整目录，启动时按 sha256 自动同步；
- 来源只是显示/治理标记，**不是权限**——三者与主进程同权限（D1/D2）；
- 外部扩展删除时会先卸载（执行清理），再删目录；客户端插件删除后渲染层在 ≤1 秒内卸载。

### 8.1 界面命名与依赖联动

设置中心只保留一个 **代码扩展** 页签（主进程扩展 + 客户端插件）。
「运行时组件」不再单独成页，安装入口放回使用它的功能：

| 组件 | 安装入口 |
|---|---|
| CloakBrowser | 工具 › 浏览器控制 |
| ffmpeg | 代码扩展 › 录屏卡片（依赖行直接安装） |
| wechat-mcp | MCP › 微信本机助手（可选组件） |
| 宠物模型 | 设置 › 宠物模式 › 形象资源 |

主进程扩展可在 manifest 声明运行时依赖，扩展卡片会显示安装状态并允许就地安装/取消：

```js
manifest: {
  // …
  requires: { assets: ['ffmpeg'], optional: true },
}
```

- `assets` 用运行时组件的 id；`optional: true` 表示未安装也能工作（有回退路径）；
- **不是加载门槛**——缺了照常激活，由扩展自己决定降级；
- 运行时组件卡片上的「用于：…」是反向链接，能定位到页签的直接可点。

## 9. 验收清单

- [ ] 保存后约 0.3 秒看到变化；改出语法错误时**旧界面还在**
- [ ] 侧栏入口、整页、卡片都在该在的位置；找不到页面时回落概览而不是白屏
- [ ] 禁用插件：入口与其页面一起消失，**不残留定时器**（日志里不再有 tick）
- [ ] 深色主题 + 四档字号下没有硬编码色块
- [ ] 故意在渲染里 `throw`：只有那一块显示「渲染失败」，侧栏还在
- [ ] 与另一个插件同槽位共存时顺序符合 `order`
- [ ] 整页左右边距与概览页一致（用了 `api.Page`，没有额外 padding）
- [ ] 持久化数据用 `api.storage`（客户端）或 `~/.lumii/plugin-data/<id>/`（主进程）

## 10. Agent 自举开发

客户端 Agent 可以给自己写插件。写文件走现有 `file_write`（`~/.lumii` 已在允许根内），
`plugin_dev` 只提供契约与反馈：

| action | 用途 |
|---|---|
| `guide` | 两个插件根目录的**绝对路径**、热更时效、模块契约、槽位表、`api` 全量、工作流、无构建步骤说明 |
| `status` | 主进程扩展的 `state/error/pendingRestart` + 渲染层上报的客户端插件 `state/error`（含上报时间） |
| `check {kind,id}` | 静态体检：plugin.json 与 engines、文件形状、语法、注册次数与 id、槽位名、`import/require`、硬编码色 |

工作流：

1. `plugin_dev guide` 拿路径与契约；
2. `file_write` 写 `<client>/<id>/plugin.json`（**必须写 `origin: "agent"`**，建议写
   `description` 与 `engines.lumii`）与 `client.js`（或 `<main>/<id>/main.js`）；
3. `plugin_dev check` 体检；
4. `plugin_dev status` 看加载结果（加载有 0.3–1 秒延迟，刚写完可能还是上一版）；
5. 改文件保存即可；**只有主进程扩展的启用/禁用需要重启**。

限制：`main.js` 是 ESM，静态检查无法编译，语法错误由加载器在 ≤1 秒内作为运行时错误返回。
