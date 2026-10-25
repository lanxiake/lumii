import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClientPluginsDir } from './paths'

/**
 * 「新建示例插件」。
 *
 * 做成设置页里的一个按钮而不是 `lumii plugin new` CLI：本机的 CLI 路径不可靠
 * （见记忆 `lumii-cli-not-implemented`），而按钮点完就落盘、1 秒内生效，
 * 比先配 PATH 再跑命令快得多。
 *
 * 生成的东西必须**马上能用**：`client.js` 直接注册四个槽位，
 * 打开概览页就能看见，改文件 0.3 秒热更新。
 */

export interface CreateSampleResult {
  ok: boolean
  dir?: string
  error?: string
}

const BASE_NAME = 'my-plugin'

export function createSamplePlugin(root: string = resolveClientPluginsDir()): CreateSampleResult {
  let dirName = BASE_NAME
  let dir = path.join(root, dirName)

  try {
    mkdirSync(root, { recursive: true })
    // 目录名自动避让，绝不覆盖已存在的插件——那是用户可能正在改的代码
    for (let i = 2; ; i++) {
      try {
        mkdirSync(dir)
        break
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
        dirName = `${BASE_NAME}-${i}`
        dir = path.join(root, dirName)
      }
    }
  } catch (err) {
    return { ok: false, error: `创建目录失败：${(err as Error).message}` }
  }

  try {
    writeFileSync(path.join(dir, 'plugin.json'), PLUGIN_JSON(dirName), 'utf8')
    writeFileSync(path.join(dir, 'client.js'), CLIENT_JS(dirName), 'utf8')
    writeFileSync(path.join(dir, 'README.md'), README(dirName), 'utf8')
  } catch (err) {
    return { ok: false, error: `写入文件失败：${(err as Error).message}` }
  }

  return { ok: true, dir }
}

function PLUGIN_JSON(id: string): string {
  return (
    JSON.stringify(
      {
        id,
        name: '我的插件',
        version: '0.1.0',
        description: '一句话说明这个插件做什么',
        origin: 'user',
        engines: { lumii: '>=0.1.0' },
      },
      null,
      2,
    ) + '\n'
  )
}

/**
 * 示例代码刻意用 `React.createElement` 而不是 JSX：插件是**不打包**的单文件，
 * 加一份构建链就为了写 `<div>`，与「改完 0.3 秒生效」的目标相反。
 */
function CLIENT_JS(id: string): string {
  return `// ${id} —— 一个文件、一次注册。改完保存，约 0.3 秒生效。
//
// 规则：一个插件 = 一个 id = 一次 __LUMII_REGISTER_PLUGIN__ 调用。
// 拆成两次注册的话，后一次永远拿不到（宿主按 plugin.json 的 id 取工厂）。
__LUMII_REGISTER_PLUGIN__('${id}', (api) => {
  const h = api.React.createElement
  const VIEW_ID = '${id}.page'

  // 1) 概览页底部的插件区
  api.registerSlot('dashboard.plugins', {
    id: '${id}.card',
    order: 100,
    component: () =>
      h('div', { style: { padding: 12 } }, '👋 你好，我是 ${id}'),
  })

  // 2) 侧栏导航（classNames 由宿主给，跟着内置导航走）
  api.registerSlot('app.nav', {
    id: '${id}.nav',
    order: 100,
    component: ({ activeView, onViewChange, collapsed, classNames }) => {
      const active = activeView === 'plugin:' + VIEW_ID
      return h(
        'button',
        {
          className: [classNames.item, active ? classNames.active : ''].join(' '),
          onClick: () => onViewChange('plugin:' + VIEW_ID),
          title: '示例页',
        },
        h('span', { className: classNames.icon }, '🧪'),
        !collapsed && h('span', { className: classNames.label }, '示例页'),
      )
    },
  })

  // 3) 整页视图：app.view 的条目 id 必须与 'plugin:<id>' 里的 id 一致
  api.registerSlot('app.view', {
    id: VIEW_ID,
    component: ({ onViewChange }) =>
      h(
        // 整页用 api.Page：与内置页同一套边距/最大宽度，别再自己加 padding
        api.Page,
        { title: '${id}', subtitle: '这是插件提供的整页' },
        h(
          'p',
          null,
          '示例：' +
            api.format.bytes(1536) +
            ' · ' +
            api.format.relative(Date.now() - 3 * 60_000),
        ),
        h(
          'button',
          { onClick: () => onViewChange('dashboard') },
          '回概览',
        ),
      ),
  })

  // 4) 设置中心 › 扩展 里的分区
  api.registerSlot('settings.section', {
    id: '${id}.section',
    component: () =>
      h('div', null, h('h3', null, '${id}'), h('p', null, '在这里放你的设置项。')),
  })

  // 可选：返回一个清理函数，插件被卸载时调用
  return () => {}
})
`
}

function README(id: string): string {
  return `# ${id}

放在 \`~/.lumii/plugins/${id}/\`，保存即生效（约 0.3 秒）。

- \`client.js\` —— 插件代码，必需
- \`plugin.json\` —— \`{ id, name, version, description?, author?, origin?, engines? }\`，可选
  （缺省 id = 目录名；Agent 生成的插件应写 \`origin: "agent"\`）

## 宿主给什么

\`\`\`js
__LUMII_REGISTER_PLUGIN__(id, (api) => {
  api.React       // 用宿主的，别自带第二份 React（两份会让 hooks 抛错）
  api.ReactDOM
  api.jsx         // react/jsx-runtime
  api.registerCard(type, renderer)   // 新增 A2UI 卡片类型
  api.registerSlot(slot, entry)      // 往槽位加条目
  api.registerTimelineCard(def)      // 对话时间线里的「按工具名单独成卡」
  api.Page                           // 整页外壳（标题/副标题/操作区 + 内容区自滚）
  api.format                         // number / percent / currency / bytes / date / dateTime / relative
  api.storage                        // 按插件 id 隔离的持久化：get / set / remove / keys / clear
})
\`\`\`

整页请用 \`api.Page\` 包起来：主内容区已经有 20px 内边距，
再写 \`padding: 24\` 实际会变成 44px，看起来比内置页「胖一圈」。

## 对话时间线卡片：\`api.registerTimelineCard\`

某个工具调用想在对话里**单独成卡**（而不是混进「调用 N 次工具」的批次组），就注册一张：

\`\`\`js
api.registerTimelineCard({
  id: '${id}.my-tool',          // 全局唯一，重复注册会抛错
  order: 100,                    // 小的先匹配；内置三卡是 10–30，插件默认 100
  pinned: true,                  // true = 露在「执行过程」折叠区外；false = 跟着折叠
  match: (part) => part.name === 'my_tool',
  component: ({ part, messageStreaming }) =>
    h('div', null, part.status === 'done' ? '完成' : '执行中…'),
  instanceId: (part) => part.args?.runId,   // 可选：子运行归属
})
\`\`\`

- \`part\` 是工具调用：\`{ id, name, args, status, result }\`；
- \`order\` 默认 100，**顶不掉内置卡片**——插件只能补内置没覆盖的工具；
- 组件抛错只毁这一块，同条消息的其他内容照常渲染；
- 返回的注销函数由宿主在禁用插件时调用，你不用自己留副本。



插件脚本和页面**同一个 JS 上下文**（不做沙箱），所以 preload 暴露的
\`window.electronAPI\` 直接可用——这是插件拿应用数据的唯一通道，不需要宿主再包一层：

\`\`\`js
await window.electronAPI.performance.getReport()   // 性能诊断
await window.electronAPI.plugins.list()            // 资产插件状态
await window.electronAPI.extensions.list()         // 扩展与客户端插件列表
\`\`\`

主进程侧同理：外部扩展（\`~/.lumii/extensions/<dir>/main.js\`）里
\`ctx.get('agentRuntime')\` 拿到的是 \`LateRef\`，\`.get()\` 返回整个 Agent Runtime 桥；
\`ctx.get('perf')\` / \`'cloudSync'\` / \`'mainWindow'\` 等见 \`kernel/services.ts\`。

> 这是**自用客户端**的选择：完全信任、不做权限。插件代码就是你的代码。

## 可用槽位

| 槽位 | 位置 | props |
|---|---|---|
| \`dashboard.main\` | 概览页顶部整宽 | \`{ onViewChange }\` |
| \`dashboard.grid\` | 概览页底部三栏（最多 3 个） | \`{ onViewChange }\` |
| \`dashboard.plugins\` | 概览页插件专属区 | \`{ onViewChange }\` |
| \`app.nav\` | 侧栏导航下方 | \`{ activeView, onViewChange, collapsed, classNames }\` |
| \`app.view\` | 整页视图 | \`{ onViewChange }\` |
| \`settings.section\` | 设置 › 扩展 | — |

## 三条规则

1. 同一槽位内 \`id\` 唯一，重复注册会抛错（不静默覆盖）；
2. 注册函数返回注销函数，卸载/热更新靠它清理；别在全局留自己的副本；
3. \`app.view\` 的条目 id 要和 \`plugin:<id>\` 里的 id 对上。

## 持久化

- 客户端插件：\`api.storage.set/get\`（localStorage，按插件 id 前缀隔离）；
- 主进程扩展：写 \`~/.lumii/plugin-data/<插件 id>/\`。

关掉这个插件：设置 › 扩展 › 客户端插件，1 秒内生效。
`
}
