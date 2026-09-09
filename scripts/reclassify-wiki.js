/**
 * Wiki 全库重新分类脚本
 *
 * 使用方法：
 * 1. 启动 Lumii 应用
 * 2. 打开开发者工具（Ctrl+Shift+I 或 F12）
 * 3. 在控制台中粘贴此脚本并运行
 *
 * 或者直接在控制台运行：
 * ```
 * await window.electronAPI.agentRuntime.sendCommand({
 *   type: 'wiki:reclassify:run',
 *   agentId: 'assistant',
 *   scope: 'all',
 *   force: true,
 *   enableRename: false
 * })
 * ```
 */

async function reclassifyWiki() {
  const api = window.electronAPI?.agentRuntime

  if (!api?.sendCommand) {
    console.error('❌ Agent Runtime API 不可用，请确保在 Lumii 应用中运行此脚本')
    return
  }

  console.log('🚀 开始触发 Wiki 全库重新分类...')
  console.log('📋 范围：全部资料')
  console.log('🔧 启用项目级分类（三级分类）')

  try {
    // 先获取预估信息
    console.log('\n📊 获取预估信息...')
    const estimate = await api.sendCommand({
      type: 'wiki:reclassify:estimate',
      agentId: 'assistant',
      scope: 'all'
    })

    console.log(`📈 预估需要处理的资料数量: ${estimate?.totalCount || 0}`)
    console.log(`📝 其中需要内容分析的: ${estimate?.contentCount || 0}`)

    // 触发重新分类
    console.log('\n🎯 启动重新分类任务...')
    const result = await api.sendCommand({
      type: 'wiki:reclassify:run',
      agentId: 'assistant',
      scope: 'all',
      force: true,  // 如果已有待审阅批次则强制覆盖
      enableRename: false  // 不启用标题改名
    })

    console.log(`✅ 重新分类任务已启动！`)
    console.log(`📦 任务 ID: ${result.runId}`)
    console.log('\n💡 提示：')
    console.log('  - 可以在 Wiki 页面查看分类进度')
    console.log('  - 分类完成后需要在 UI 中审阅并应用结果')
    console.log('  - 新的三级分类（项目）将在分类结果中体现')

    return result
  } catch (error) {
    console.error('❌ 重新分类失败:', error.message)
    console.error(error)
  }
}

// 执行重新分类
reclassifyWiki()
