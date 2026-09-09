/**
 * Wiki 数据重置并重新分类脚本
 *
 * 使用方法：
 * 1. 启动 Lumii 应用（开发模式：npm run dev）
 * 2. 打开开发者工具（Ctrl+Shift+I 或 F12）
 * 3. 在控制台中粘贴此脚本并运行
 */

async function resetAndReclassifyWiki() {
  const api = window.electronAPI?.agentRuntime

  if (!api?.sendCommand) {
    console.error('❌ Agent Runtime API 不可用，请确保在 Lumii 应用中运行此脚本')
    return
  }

  console.log('🔧 Wiki 数据重置与重新分类工具')
  console.log('=' .repeat(60))

  try {
    // 步骤 1: 清除现有 wiki 分类数据（保留文件，只清除分类）
    console.log('\n📋 步骤 1: 清除现有分类数据...')
    console.log('⚠️  注意：此操作将清除所有资料的分类信息（大类、小类、项目）')
    console.log('⚠️  文件本身和内容不会被删除')

    const confirmClear = confirm('确定要清除所有 Wiki 资料的分类信息吗？\n\n点击"确定"继续，点击"取消"中止操作。')

    if (!confirmClear) {
      console.log('❌ 操作已取消')
      return
    }

    // 清除分类：将所有 wiki_sources 的 topic_category, topic_subtopic, topic_project 设为 NULL
    // 注意：这需要通过数据库操作完成，或者通过批量更新 API
    console.log('⚠️  直接清除数据库需要应用重启，建议改为重新分类时使用 force: true')

    // 步骤 2: 获取预估信息
    console.log('\n📊 步骤 2: 获取预估信息...')
    const estimate = await api.sendCommand({
      type: 'wiki:reclassify:estimate',
      agentId: 'assistant',
      scope: 'all'
    })

    console.log(`📈 预估需要处理的资料数量: ${estimate?.totalCount || 0}`)
    console.log(`📝 其中需要内容分析的: ${estimate?.contentCount || 0}`)
    console.log(`💰 预估消耗 tokens: ~${(estimate?.totalCount || 0) * 500} (结构轮) + ~${(estimate?.contentCount || 0) * 2000} (内容轮)`)

    // 步骤 3: 启动重新分类
    console.log('\n🎯 步骤 3: 启动重新分类任务...')
    console.log('🔧 配置：')
    console.log('  - 范围: 全部资料')
    console.log('  - 强制覆盖: 是')
    console.log('  - 启用三级分类: 是（大类 → 小类 → 项目）')
    console.log('  - 启用标题改名: 否')

    const result = await api.sendCommand({
      type: 'wiki:reclassify:run',
      agentId: 'assistant',
      scope: 'all',
      force: true,  // 强制覆盖现有批次
      enableRename: false  // 不启用标题改名
    })

    console.log('\n✅ 重新分类任务已启动！')
    console.log(`📦 任务 ID: ${result.runId}`)
    console.log('\n💡 后续步骤：')
    console.log('  1. 等待分类任务完成（可能需要几分钟到几小时，取决于资料数量）')
    console.log('  2. 前往 Wiki 页面查看分类进度和结果')
    console.log('  3. 审阅 AI 分类结果：')
    console.log('     - 检查大类、小类分配是否合理')
    console.log('     - 查看新的项目（第三级分类）')
    console.log('  4. 确认无误后点击"应用"按钮')
    console.log('  5. 验证三级分类功能：')
    console.log('     - 选择小类后查看项目列表')
    console.log('     - 点击项目筛选文件')
    console.log('     - 移动文件时选择项目')

    return result
  } catch (error) {
    console.error('❌ 操作失败:', error.message)
    console.error(error)
  }
}

// 执行脚本
resetAndReclassifyWiki()
