// 示例：整页 + 侧栏入口 + 读取宿主已有数据（用量统计）。
//
// 要点：
// - app.view 的条目 id 就是路由地址 plugin:<id>
// - app.nav 的 classNames 由宿主提供，跟着内置导航走
// - 整页用 api.Page 起手，不要再自己加 padding
__LUMII_REGISTER_PLUGIN__('__PLUGIN_ID__', (api) => {
  const h = api.React.createElement
  const VIEW_ID = '__PLUGIN_ID__.page'

  function usageToday() {
    const now = Date.now()
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    return window.electronAPI.usage
      .query({ from: start.getTime(), to: now, groupBy: 'day' })
      .then(function (r) {
        return r && r.success ? r.data : null
      })
      .catch(function () {
        return null
      })
  }

  function UsagePage() {
    const [data, setData] = api.React.useState(null)
    const [error, setError] = api.React.useState('')

    api.React.useEffect(function () {
      let alive = true
      usageToday().then(function (d) {
        if (!alive) return
        if (d) setData(d)
        else setError('暂时读不到用量数据')
      })
      return function () {
        alive = false
      }
    }, [])

    return h(
      api.Page,
      { title: '今日用量', subtitle: '示例：读取宿主已有的统计数据' },
      error ? h('p', { style: { color: 'var(--color-error)' } }, error) : null,
      !data && !error ? h('p', null, '读取中…') : null,
      data
        ? h(
            'div',
            { style: { display: 'flex', gap: 'var(--spacing-4)' } },
            h('div', null, '调用 ', api.format.number(data.totalCalls), ' 次'),
            h('div', null, '花费 ', api.format.currency(data.totalCostYuan)),
          )
        : null,
    )
  }

  const offView = api.registerSlot('app.view', { id: VIEW_ID, component: UsagePage })

  const offNav = api.registerSlot('app.nav', {
    id: '__PLUGIN_ID__.nav',
    order: 100,
    component: function (ctx) {
      const active = ctx.activeView === 'plugin:' + VIEW_ID
      return h(
        'button',
        {
          type: 'button',
          className: [ctx.classNames.item, active ? ctx.classNames.active : ''].join(' '),
          title: '今日用量',
          onClick: function () {
            ctx.onViewChange('plugin:' + VIEW_ID)
          },
        },
        h('span', { className: ctx.classNames.icon }, '📈'),
        !ctx.collapsed && h('span', { className: ctx.classNames.label }, '今日用量'),
      )
    },
  })

  return function () {
    offView()
    offNav()
  }
})
