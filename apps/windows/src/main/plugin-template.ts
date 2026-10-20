import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClientPluginsDir } from './client-plugin-protocol'

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
  return JSON.stringify({ id, name: '我的插件', version: '0.1.0' }, null, 2) + '\n'
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
        'div',
        { style: { padding: 24 } },
        h('h2', null, '这是 ${id} 提供的页面'),
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
- \`plugin.json\` —— \`{ id, name, version }\`，可选（缺省 id = 目录名）

## 宿主给什么

\`\`\`js
__LUMII_REGISTER_PLUGIN__(id, (api) => {
  api.React       // 用宿主的，别自带第二份 React（两份会让 hooks 抛错）
  api.ReactDOM
  api.jsx         // react/jsx-runtime
  api.registerCard(type, renderer)   // 新增 A2UI 卡片类型
  api.registerSlot(slot, entry)      // 往槽位加条目
})
\`\`\`

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

关掉这个插件：设置 › 扩展 › 客户端插件，1 秒内生效。
`
}
