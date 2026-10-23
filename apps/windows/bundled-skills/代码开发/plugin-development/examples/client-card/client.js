// 示例：概览页卡片 + api.storage 持久化。
// 无构建步骤：保存即生效（约 0.3 秒）。
__LUMII_REGISTER_PLUGIN__('__PLUGIN_ID__', (api) => {
  const h = api.React.createElement
  const KEY = 'cups'

  function WaterCard() {
    const [cups, setCups] = api.React.useState(function () {
      return api.storage.get(KEY, 0)
    })

    function add() {
      const next = cups + 1
      setCups(next)
      api.storage.set(KEY, next)
    }

    return h(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-3)',
          padding: 'var(--spacing-3)',
        },
      },
      h('span', null, '💧 今天 ' + api.format.number(cups) + ' 杯'),
      h('button', { type: 'button', onClick: add }, '喝一杯'),
    )
  }

  // 返回注销函数：插件停用时宿主会调用它
  return api.registerSlot('dashboard.plugins', {
    id: '__PLUGIN_ID__.card',
    order: 100,
    component: WaterCard,
  })
})
