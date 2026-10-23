---
name: plugin-development
description: Lumii 插件开发规范：判断客户端插件 / 主进程扩展，写 manifest 与槽位，遵守生命周期与边界，并用 plugin_dev 自检。
metadata: { "mtbot": { "emoji": "🧩" } }
---

# Lumii 插件开发

给 Lumii 写插件时用这份规范。**先判断形态，再动手写**；插件是纯 JS（无构建步骤），
保存后客户端插件约 0.3 秒生效、主进程扩展 ≤1 秒热重载。

## 1. 选形态

| 要做的事 | 形态 | 落点 |
|---|---|---|
| 只加界面（页面 / 卡片 / 设置分区 / 浮层） | 客户端插件 | `~/.lumii/plugins/<id>/client.js` |
| 需要主进程能力（文件、网络、定时器、IPC、系统 API） | 主进程扩展 | `~/.lumii/extensions/<id>/main.js` |
| 两者都要 | 同一个目录 | `~/.lumii/extensions/<id>/{main.js, client.js?}` |

先用 `plugin_dev` 工具的 `guide` 动作拿到**本机绝对路径**，不要猜路径。

## 2. 目录与清单

```
<id>/
  plugin.json   可选但强烈建议：{ id, name, version, description, origin, engines }
  main.js       主进程半边（可选）
  client.js     渲染层半边（可选）
  README.md     可选
```

- **两半边至少有一个**；两半边共用同一个 `id`。
- `description` 必须写（一句话功能说明，插件页直接展示）。
- `origin`：Agent 创建写 `"agent"`，用户手写写 `"user"`。
- `engines.lumii`：如 `">=0.1.0"`；不满足时**不会加载**，面板显示「不兼容」。
- 主进程扩展的 `manifest` 写在 `main.js` 里（见 §4），`plugin.json` 可只给渲染层用。

## 3. 客户端插件（client.js）

一个文件、一次注册，**一个插件 = 一个 id = 一次注册**：

```js
__LUMII_REGISTER_PLUGIN__('my-plugin', (api) => {
  const h = api.React.createElement

  api.registerSlot('app.view', {
    id: 'my-plugin.page',                 // 路由地址：plugin:my-plugin.page
    component: ({ onViewChange }) =>
      h(api.Page, { title: '我的插件', subtitle: '说明' },
        h('p', null, '文件大小示例：' + api.format.bytes(1536)),
        h('button', { onClick: () => onViewChange('dashboard') }, '回概览'),
      ),
  })

  api.registerSlot('app.nav', {
    id: 'my-plugin.nav',
    component: ({ activeView, onViewChange, collapsed, classNames }) => {
      const active = activeView === 'plugin:my-plugin.page'
      return h('button', {
        className: [classNames.item, active ? classNames.active : ''].join(' '),
        onClick: () => onViewChange('plugin:my-plugin.page'),
      }, h('span', { className: classNames.icon }, '🧩'),
         !collapsed && h('span', { className: classNames.label }, '我的插件'))
    },
  })

  return () => {}   // 可选：卸载清理
})
```

`api` 提供：

| 能力 | 说明 |
|---|---|
| `api.React` | 宿主的那一份 React，**不要自带第二份**（hooks 会直接抛错） |
| `api.registerSlot(name, entry)` | 注册槽位；返回注销函数。entry = `{ id, component, order?, owner? }` |
| `api.registerCard(type, renderer)` | 注册卡片类型（内建类型会被拒绝） |
| `api.Page` | 整页外壳（标题/副标题/操作区 + 内容区滚动），**不要再加 padding** |
| `api.format` | `number / percent / currency / bytes / date / dateTime / relative` |
| `api.storage` | 按插件 id 隔离的持久化：`get / set / keys / remove / clear` |

### 可用槽位

| 槽位 | 用途 |
|---|---|
| `app.view` | 整页；条目 id 就是 `plugin:<id>` 的路由目标 |
| `app.nav` | 侧栏导航；用宿主给的 `classNames` |
| `app.overlay` | 全局浮层（fixed 定位） |
| `app.titlebar.actions` | 标题栏右侧常驻控件 |
| `dashboard.main` / `dashboard.grid` / `dashboard.plugins` | 概览页区域（grid 最多 3 条） |
| `settings.category.<分类id>` | 整块设置分区（需同时登记归属，见开发规范） |
| `settings.channel.<渠道>` | 渠道设置卡片（context：`{ snapshot, snapshotLoading }`） |
| `settings.section.<名字>` | 混合页面里的单块 |
| `workspace.version` | 工作区版本区 |

**槽位 id 带插件前缀**（`my-plugin.card`），撞 id 会让后来者整个激活失败。

### 样式

- 只用设计令牌：`var(--color-*)` / `var(--spacing-*)` / `var(--radius-*)` / `var(--font-size-*)`；
- 不要给令牌写死 fallback（`var(--color-success, #16a34a)`），主题切换会露馅；
- 深色 / 护眼 / 四档字号都要过一遍。

## 4. 主进程扩展（main.js）

ESM 默认导出：

```js
export default {
  manifest: {
    id: 'com.example.foo',
    name: '示例',
    version: '0.1.0',
    description: '一句话说明它做什么',
    engines: { lumii: '>=0.1.0' },
    kind: 'code',
    main: './main.js',
  },
  definition: {
    id: 'com.example.foo',
    apply(ctx) {
      // 请求/响应 IPC
      ctx.registerIpc?.('foo:get', async () => ({ ok: true }))
      // 单向 IPC（ipcRenderer.send）
      ctx.registerIpcListener?.('foo:notify', (_e, value) => {})
      // 定时器/订阅：dispose 随插件停用执行
      const timer = setInterval(() => {}, 60_000)
      ctx.effect(() => clearInterval(timer))
    },
  },
}
```

`ctx` 能力：

| 能力 | 说明 |
|---|---|
| `ctx.registerIpc(ch, fn)` / `ctx.registerIpcListener(ch, fn)` | **不要直接碰 `ipcMain`**——停用摘不掉 |
| `ctx.effect(dispose)` | 可逆副作用（定时器、监听、协议注册）；LIFO 执行 |
| `ctx.provide(S.x, impl)` / `ctx.get(S.x)` | 服务提供给核心 / 读取核心服务 |
| `ctx.on / emit / waterfall / serial` | 插件事件总线 |
| `ctx.log` | 带插件 id 前缀的日志 |

核心与插件之间只认 `main/kernel/*-contract.ts` 的服务契约；插件停用后核心拿不到实例，
按「功能关闭」降级。**不要**让核心直接 import 你的实现。

## 5. 生命周期与启停

- 保存文件 → 热重载（客户端 0.3s / 主进程 ≤1s）；语法错误时**旧版本继续服务**。
- 设置 › 插件里的开关：禁用即拆作用域（IPC、定时器、服务、槽位一起消失）。
- 一个插件只能注册一次；拆成两次注册，后一次永远不执行。
- 改 `plugin.json` 也会触发重载。
- **不要重启应用**来让插件生效。

## 6. 硬规则

1. 一个插件 = 一个 id = 一次注册。
2. 槽位 id / IPC 通道名带插件前缀。
3. 定时器、订阅、`requestAnimationFrame` 放 effect 清理里。
4. 主进程别直接 `ipcMain.handle/on`。
5. 插件之间不得运行期 import（共享代码放 `shared` 或走服务契约）。
6. 插件自带的页面/设置必须走槽位，不要改核心页面。
7. 透传外部输入要校验（路径、URL、ipc 载荷），不要信任渲染层。
8. 别自带第二份 React。

## 7. 固定开发流程（照这个顺序做）

本技能自带一个**不依赖 App/Electron** 的脚本（Node 18+）：

```bash
SKILL_DIR=<本 SKILL.md 所在目录>
node "$SKILL_DIR/scripts/plugin-dev.mjs" <命令>
```

| 命令 | 作用 |
|---|---|
| `examples` | 列出内置示例（名称、形态、说明、绝对路径） |
| `new <example> <id> [--dir <父目录>]` | 从示例复制一份并替换 id（默认直接放进插件根，立刻能被加载） |
| `validate <dir>` | 静态校验：入口文件、plugin.json 字段/版本格式、ESM/脚本语法、禁用 `ipcMain`/`require`/`import`、槽位名 |
| `test <dir>` | 冒烟测试：`client.js` 在 VM 里跑注册工厂并检查槽位条目；`main.js` 动态导入并校验 manifest/apply（依赖 Electron 时跳过 apply） |
| `deploy <dir> [--data-dir <dir>]` | 部署到插件根；**同名且版本更高才升级**，同版本/降级拒绝，失败自动还原 |

数据根默认 `~/.lumii`；dev 实例用 `--data-dir <它自己的数据根>`。所有命令输出一行 JSON，
退出码非 0 即失败。

**推荐流程**：

1. `plugin_dev { action: "guide" }`（或读本技能）确认落点与契约；
2. `examples` 选一个最接近的示例 → `new <example> <my-id>`；
3. 用文件工具改代码；
4. `validate <dir>` → 0 error；
5. `test <dir>` → 0 error；
6. `deploy <dir>`（或让用户用「设置 › 插件 › 导入插件」导入 zip）；
7. `plugin_dev { action: "status" }` 确认真的加载（有 0.3–1 秒延迟）；
8. 在设置 › 插件里禁用再启用一次，确认页面/入口一起消失、回来。

### 内置示例（`examples/`）

| 示例 | 形态 | 覆盖点 |
|---|---|---|
| `client-card` | 客户端 | `dashboard.plugins` 卡片 + `api.storage` 持久化 + hooks |
| `client-page` | 客户端 | `app.view` 整页 + `app.nav` 侧栏入口 + 读取 `window.electronAPI` 已有数据 |
| `main-ipc` | 主进程 | `manifest + definition`、`ctx.registerIpc`/`registerIpcListener`、`ctx.effect` 清理定时器 |

示例里用 `__PLUGIN_ID__` 占位，`new` 会自动替换；直接读代码参考也可以。

## 8. 分发与版本

插件页「导入插件」支持 `.zip` 或文件夹（也可用脚本 `deploy`）：

- `.zip` 里可以套一层同名目录（自动剥掉）；必须包含 `main.js` 或 `client.js`；
- 含 `main.js` 装到外部扩展目录，只有 `client.js` 装到客户端插件目录；
- `node_modules` / `.git` 不会被复制；
- **版本规则**：`plugin.json.version` 写成 `x.y.z`（可带 `-tag`）。同名插件已存在时：
  - 新版本更高 → 升级（旧目录备份到插件根之外，失败自动还原）；
  - 同版本或更低 → **拒绝**，不会静默覆盖；
  - 任一方没有 version → 无法判断升级，拒绝并要求先删除旧版本。
- 升级前的运行期状态（启用/禁用）由插件偏好保存，不会因为换文件被重置。

参考：`docs/standards/plugin-development-standards.md`（踩坑与验收清单）、
`apps/windows/src/plugins/README.md`（仓库内插件的完整约定）。
