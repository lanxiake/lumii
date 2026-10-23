# 插件目录

一份代码只在一个地方：**插件的清单、接线、实现、测试都在 `builtin/<id>/`（内置）或
`external-src/<id>/`（官方外部扩展）下**。`src/main/` 只剩核心（kernel / ipc / agent-runtime /
channel 等），`src/renderer/` 只剩宿主与共享渲染基础设施，不再散落插件代码。
**一个插件可以同时有主进程与渲染层两半**，见下面的「前后端一体」与「UI 归属」。

```
plugins/
  api/               **对外唯一入口**：defineServiceAccessor / createIpcTable / RendererPlugin 类型
  registry.ts        唯一清单：BUILTIN_EXTENSIONS + hot 标记（HOT_SWAPPABLE_BUILTINS 由它派生）
  host.ts            createPluginHost：注册、校验 manifest、按禁用表排除启动
  control.ts         设置页的控制面：list / setEnabled / remove（运行期启停也在这里）
  active.ts          isExtensionActive 运行期门，核心调用点靠它判断插件在不在
  renderer/
    runtime.tsx      渲染层运行时：按启停状态 setup / teardown 插件 UI
    sync.ts          纯逻辑（可测）：启用集 → setup 集合的同步
    registry.ts      有渲染层半边的插件清单（与 registry.ts 按 id 对齐）
  builtin/
    <name>/index.ts    主进程：manifest + apply，接线全部写在这里
    <name>/renderer.tsx 渲染层：注册槽位（可选）
    <name>/*.ts(x)     该插件独占的实现与测试
  external/
    loader.ts        外部扩展（~/.lumii/extensions/<dir>/main.js）加载与热重载
    official.ts      官方扩展同步（resources/extensions → 用户目录）
    paths.ts         用户插件目录 / 内置插件安装目录
    template.ts      新扩展脚手架
    dev-check.ts     扩展开发自检
    bootstrap.ts     依赖预安装（反检测浏览器等）
    bootstrap-config.ts
  external-src/      官方外部扩展的**源码**（构建成 resources/extensions/<id>/main.js）
    <id>/index.ts    外壳：manifest + apply（装配服务、注册 IPC、挂访问器）
    <id>/impl/**     主进程实现（核心只认 main/kernel 里的服务契约，不 import 这里）
    <id>/renderer.tsx 渲染层半边：注册槽位（随主包打 bundle，见下方「UI 归属」）
    <id>/ui/**       该插件独占的页面/组件/采集器
  install/           插件中心的运行时依赖安装（CloakBrowser / ffmpeg …），不是本系统的插件
```

`channel/` 不在这里：它是四个 channel-* 插件共享的子系统（Hub、适配器、Provider、
出站路由），被 agent-runtime 直接使用，搬进某个插件目录只会制造假边界。

## 前后端一体

一个插件目录里可以同时有：

```ts
// builtin/<name>/index.ts —— 主进程
export const xExtension = { manifest, definition }   // apply(ctx) 里注册 IPC / 定时器

// builtin/<name>/renderer.tsx —— 渲染层
export const renderer: RendererPlugin = {
  id: 'com.lumii.x',                    // 必须与 manifest.id 一致
  setup(api) {                          // api 只有 registerSlot / registerCard
    return api.registerSlot('settings.experimental.entry', { id: 'x', component: Xxx })
  },
}
```

再在 `renderer/registry.ts` 加一行（与主进程 `registry.ts` 是两张表，按 id 对齐；
分开是因为渲染层不能 import 主进程那张表——那会把 electron 拖进 renderer bundle）。

启停联动（设置页点一下，两边一起变）：

```
extension:set-enabled → host.activate/stop（IPC/定时器随作用域拆）
                     → mainWindow.send('plugin:state-changed', {id, enabled})
                     → renderer PluginRuntime → setup() / 清理函数
```

只有 `restartRequired:false`（`hot: true`）的插件会推；要重启的不推，
否则渲染层会提前拆 UI 而主进程还在跑旧代码。

**核心怎么调用插件**：不要在核心 import 插件实现。插件在 `apply` 里把服务注册到
`S`（`kernel/services.ts`，用 `LateRef`），核心按需取；取不到就走默认行为
（例如提示词风格回落到 `terse`、接续能力为 `undefined`）。这样禁用才是真的禁用。

核心侧通常再包一层**访问器**（`main/agent-runtime/autonomous-accessor.ts`、
`main/channel/continuity-accessor.ts`）：`index.ts` 注入「从容器现取」的 getter，
调用点只认访问器。type-only import 插件类型不算运行期耦合，守卫 ⑪ 也不计。

### 外部插件也可以是前后端一体

```
~/.lumii/extensions/<目录>/
  main.js       主进程半边（扩展加载器负责，热重载）
  client.js     渲染层半边（可选；有它才会出现在渲染层清单里）
  plugin.json   可选清单（缺省 id = 目录名）
```

`~/.lumii/plugins/<目录>/` 仍然合法（只有 `client.js`）。
两种来源在渲染层用同一个 `lumii-plugin://local/<根>/<目录>/<文件>` 协议加载，
清单里带 `root` 字段；扩展根的启停跟主进程扩展开关走（`disabled`），
客户端插件根跟 `disabledClient` 走。

### 渲染层接入的两种形态

| 形态 | 用在 | 写法 |
|---|---|---|
| **槽位** | 整页 / 卡片 / 设置分区 | `renderer.tsx` 的 `RendererPlugin.setup(api)` 里 `api.registerSlot(...)`，返回注销函数 |
| **实验项** | 设置 › 实验功能 | 导出 `{ id, title, Summary, Detail }`，登记到 `renderer/experiments.ts`；列表按 `usePluginEnabled(id)` 过滤 |

两种都读同一个状态源（`renderer/state.ts`），禁用后 UI 整条消失，不是灰掉。

**现成的槽位约定**：

| 槽位 | 用途 |
|---|---|
| `app.view` | 整页（路由 `plugin:<条目id>`）。条目注销即回落概览 |
| `app.overlay` | 全局浮层（划词层、录屏面板/确认弹窗…），挂在应用最外层 |
| `app.titlebar.actions` | 标题栏右侧常驻控件（录屏、宠物模式开关） |
| `settings.category.<分类id>` | 整块设置分区。同时在 `renderer/settings-categories.ts` 登记归属，停用后左侧导航一起隐藏 |
| `settings.channel.<渠道>` | 渠道设置里的单张卡片（context: `{ snapshot, snapshotLoading }`） |
| `settings.section.<名字>` | 混合页面里的单块（如 `settings.section.perf` = 隐私页的诊断卡、`settings.section.updater`） |
| `dashboard.main` / `dashboard.grid` / `dashboard.plugins` | 概览页的三块区域 |
| `workspace.version` | 工作区「文件 / 变更 / 版本」区（context: 快照与 loading） |

### UI 归属（什么该搬进插件目录）

**插件独占的界面一律放在插件目录里**（`<id>/ui/`），由 `renderer.tsx` 注册槽位，
核心页面不直接 import（守卫 ⑭）。包括：整页、设置分区、浮层、标题栏控件、诊断面板。

留在核心的只有「跨插件共享的渲染基础设施」：

| 留在核心 | 为什么 |
|---|---|
| `renderer/services/*-service.ts` 薄封装 | 同一份数据被核心页面与插件 UI 共用（用量、桌宠、VCS…） |
| `FilePreviewModal` / `ImageLightbox` | 聊天、工具卡、wiki 共用的预览壳，不属于 file-preview 插件的独立窗口 |
| `PetSessionSync` | 主进程事件的渲染层镜像，不是 UI |
| `useSettings` / `renderer/state.ts` | 全局设置与插件启停状态源 |
| `renderer/services/quote-bridge.ts`、`webview-selection-bridge.ts` | 核心（ChatInput / FilePreviewModal）↔ 划词插件之间的契约 |

**官方外部扩展的渲染层半边目前随主包打 bundle**：`external-src/<id>/renderer.tsx` 进
`renderer/registry.ts`，与内置插件同一套槽位与启停。它们**不会**通过 `client.js` 分发——
外部 client 半边只支持 `__LUMII_REGISTER_PLUGIN__` + `api` 提供的能力，
不支持 TSX / 核心组件 / CSS Modules。要在意安装包体积时，再补官方 client 构建管线。

### 插件内注册 IPC 的写法

`apply` 里**不要直接碰 `ipcMain`**（停用摘不掉，守卫 ⑫ 会红）。三种现成写法：

```ts
ctx.registerIpc('foo:bar', handler)              // 单个
ctx.registerIpcListener('foo:event', listener)   // 单向 ipcRenderer.send
const ipcTable = createIpcTable()                // 多个：攒表
ipcTable.register('foo:a', fn)
ipcTable.install((ch, fn) => ctx.registerIpc?.(ch, fn))
```

### 核心 ↔ 插件：服务访问器

```ts
// 核心侧（main/**/*-accessor.ts）
const accessor = defineServiceAccessor<FooService>('foo')
export const setFooAccessor = (fn) => accessor.setResolver(fn)
export const getFooService = () => accessor.get()

// index.ts 注入一次
setFooAccessor(() => pluginHost?.container.get(S.foo) ?? null)
```

服务接口类型写在插件目录（`service.ts`），核心 **type-only** 引用。
插件停用 → 容器里没了 → `getFooService()` 返回 null → 核心按「功能关闭」处理。

### 服务清单（核心 ↔ 插件）

| 服务键 | 插件 | 核心拿不到时 |
|---|---|---|
| `S.autonomous` | autonomous | 心跳/规划/反馈全部 no-op |
| `S.promptStyle` | prompt-style | 回落默认档 `terse` |
| `S.channelContinuity` | channel-continuity | 不做接续 |
| `S.browser` | browser | 不启动、不注册工具 |
| `S.usage` | usage | `usage:query` 如实报错 |
| `S.skillEvolution` | skill-evolution | 不注入进化引导 |
| `S.dashboardFeed` | dashboard-feed | cron/API/卡片静默跳过 |
| `S.vcs` | vcs | 回合快照跳过 |
| `S.voice` | voice | 语音入口不可用 |
| `S.pet` | pet | 无桌宠（窗口/提示词/托盘/资产协议全关） |

**守卫 ⑪ 现在是零容忍**（基线为空）：核心任何一处新的 `import '../plugins/builtin/...'`
（非 type-only）都会当场报红。

### 边界规则（守卫 ⑫）

| 规则 | 说明 |
|---|---|
| 插件之间不得运行期 import | type-only 可以；共享代码下沉 `src/shared` 或核心 |
| 渲染层插件文件只许 import `renderer/`、`shared/`、`plugins/` | 否则会把 node 模块拖进 renderer bundle |
| 插件内不得直接 `ipcMain.handle/on` | 走 `ctx.registerIpc` / `registerIpcListener` |

## 生命周期

| 操作 | 要做的事 |
|---|---|
| **新增** | 建 `builtin/<name>/index.ts`（`export const xxxExtension = { manifest, definition }`）；`registry.ts` 加一行 import + 一行条目；需要即时启停就标 `hot: true`。**manifest 必须写 `description`**（插件页展示功能说明）。核心若要在启动阶段取它的服务，通过 `S`（`kernel/services.ts`）交出去，不要让核心 import 实现。 |
| **导入** | 设置 › 插件 › **导入插件**：支持 `.zip` 或文件夹（可套一层目录）。含 `main.js` 装到 `~/.lumii/extensions/<id>/`，只有 `client.js` 装到 `~/.lumii/plugins/<id>/`；**同名目录不覆盖**，`node_modules/.git` 不复制。 |
| **AI 新建** | 设置 › 插件 › **新建插件** → 填一句需求 → 新开对话，按 `plugin-development` 技能实现并自检（也可先生成示例插件再改）。规范随包种到 `workspace/skills/代码开发/plugin-development/`。 |
| **禁用** | 插件注册的页面/导航/浮层/设置分区随作用域注销；整块设置分类在 `renderer/settings-categories.ts` 登记归属后，左侧导航也一起隐藏。 |
| **修改** | 改 `builtin/<name>/` 下的文件即可。只改 `packages/*` 或主进程后必须重启 dev（见根 AGENTS.md）。 |
| **删除** | `rm -rf builtin/<name>/` + 删 `registry.ts` 里两行；`tsc` 会把残留引用全部列出来（核心通过 `isExtensionActive` 判门，删掉后功能自然消失）。再跑 `node scripts/check-wiring.mjs` 与 `scripts/ipc-owners.json` 对账。 |
| **升级** | 内置插件随应用发版；外部扩展改文件即热重载（1s 轮询）；官方扩展走 `external-src/` → `pnpm build:official-extensions` → 发布脚本。 |
| **卸载** | 内置不能卸（只能禁用，`manifest.disabled` 的代码留着但不激活）；外部扩展在设置页删除目录，或直接从 `~/.lumii/extensions/` 删。 |

## 运行期启停（`hot`）

`hot: true` 的含义不是「有 apply」，而是**禁用后功能真的消失**：接线全在 `apply(ctx)`
里（`ctx.registerIpc` / `ctx.effect`），停用时作用域整体拆掉。

没标 hot 的插件，设置页开关仍要求重启。给它们标 hot 之前先确认两件事：

1. 服务的**消费者**也走 `isExtensionActive` 判门，否则插件停了自己还在被核心调用；
2. 初始化不可逆时（如 ONNX 已绑某个运行时版本）要么能识别并拒绝，要么就别标 hot。

核心启动期**不要缓存**插件服务句柄（`const svc = S.xxx.get()`）：插件停用后变量仍指着旧实例，
表现为「关掉了但还在工作」。启动期取值的服务用 `LateRef`，或者每次现取。

**外部扩展（含官方可选扩展）同样运行期启停**（`restartRequired:false`）：加载器在启用时补
`register` + `activate`，停用只拆作用域；`~/.lumii/extensions` 下的条目禁用期间也不会被
1s 轮询重新拉起来。前置条件同上——官方的 perf / cloud-sync / screen-record 已经全部改走
`main/kernel/*-contract.ts` 的访问器。第三方扩展若在 `apply` 里把服务缓存给核心，禁用后
同样会出现「关掉了但还在工作」，所以外部扩展也要遵守上面这条。
