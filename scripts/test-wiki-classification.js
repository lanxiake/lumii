/**
 * Wiki 三级分类功能全面测试脚本
 *
 * 测试流程：
 * 1. 导入测试文档到 wiki inbox
 * 2. 触发全库重新分类（支持三级分类）
 * 3. 验证分类结果
 */

async function testWikiThreeLevelClassification() {
  const api = window.electronAPI?.agentRuntime

  if (!api?.sendCommand) {
    console.error('❌ Agent Runtime API 不可用')
    return
  }

  console.log('🧪 Wiki 三级分类功能测试')
  console.log('='.repeat(70))

  try {
    // 步骤 1: 检查当前 wiki 状态
    console.log('\n📊 步骤 1: 检查当前 wiki 状态...')

    const inboxList = await api.sendCommand({
      type: 'wiki:inbox:list',
      agentId: 'assistant',
      status: 'pending',
      limit: 100,
      offset: 0
    })

    console.log(`📥 收件箱待处理: ${inboxList.items?.length || 0} 条`)

    const sourceList = await api.sendCommand({
      type: 'wiki:source:list',
      agentId: 'assistant',
      limit: 100,
      offset: 0
    })

    console.log(`📚 资料库总数: ${sourceList.items?.length || 0} 条`)

    // 步骤 2: 如果有数据，进行重新分类预估
    if ((sourceList.items?.length || 0) > 0) {
      console.log('\n📊 步骤 2: 获取重新分类预估...')

      const estimate = await api.sendCommand({
        type: 'wiki:reclassify:estimate',
        agentId: 'assistant',
        scope: 'all'
      })

      console.log(`📈 需要分类的资料: ${estimate?.totalCount || 0}`)
      console.log(`📝 需要内容分析: ${estimate?.contentCount || 0}`)
      console.log(`💰 预估 tokens: 结构轮 ~${(estimate?.totalCount || 0) * 500}, 内容轮 ~${(estimate?.contentCount || 0) * 2000}`)

      // 步骤 3: 启动重新分类
      console.log('\n🎯 步骤 3: 启动三级分类任务...')
      console.log('配置：')
      console.log('  ✓ 范围: 全部资料')
      console.log('  ✓ 三级分类: 大类 → 小类 → 项目')
      console.log('  ✓ 强制覆盖: 是')
      console.log('  ✓ 标题改名: 否')

      const result = await api.sendCommand({
        type: 'wiki:reclassify:run',
        agentId: 'assistant',
        scope: 'all',
        force: true,
        enableRename: false
      })

      console.log('\n✅ 分类任务已启动！')
      console.log(`📦 任务 ID: ${result.runId}`)

      // 步骤 4: 监控分类进度
      console.log('\n⏳ 步骤 4: 监控分类进度...')
      console.log('提示: 可以运行 monitorReclassifyProgress() 查看实时进度')

      // 返回监控函数
      window.monitorReclassifyProgress = async () => {
        const run = await api.sendCommand({
          type: 'wiki:reclassify:get',
          agentId: 'assistant'
        })

        if (!run?.run) {
          console.log('❌ 没有正在进行的分类任务')
          return
        }

        const { status, totalCount, processedCount, candidates } = run.run
        console.log(`\n📊 分类进度:`)
        console.log(`  状态: ${status}`)
        console.log(`  进度: ${processedCount}/${totalCount}`)
        console.log(`  候选数: ${candidates?.length || 0}`)

        if (status === 'review') {
          console.log('\n✅ 分类完成，进入审阅状态！')
          console.log('\n🔍 候选分类预览 (前 5 条):')

          candidates?.slice(0, 5).forEach((c, i) => {
            console.log(`\n  ${i + 1}. ${c.sourceTitle}`)
            console.log(`     大类: ${c.category}`)
            console.log(`     小类: ${c.subtopic || '(无)'}`)
            console.log(`     项目: ${c.project || '(无)'} ⭐ 新功能`)
            console.log(`     原因: ${c.reason?.substring(0, 50)}...`)
          })

          console.log('\n💡 验证三级分类功能:')
          console.log('  1. 检查 project 字段是否已填充')
          console.log('  2. 前往 Wiki 页面应用分类结果')
          console.log('  3. 选择小类后查看项目列表')
          console.log('  4. 点击项目名筛选文件')
          console.log('  5. 移动文件时可以选择项目')
        }

        return run.run
      }

      console.log('\n💡 后续操作:')
      console.log('  • 查看进度: await monitorReclassifyProgress()')
      console.log('  • 前往 Wiki 页面查看实时进度')
      console.log('  • 完成后点击"应用"按钮')

      return result
    } else {
      console.log('\n⚠️  当前没有资料需要分类')
      console.log('\n💡 建议操作:')
      console.log('  1. 导入一些文档到 wiki')
      console.log('  2. 或者从本地文件夹导入')
      console.log('  3. 然后重新运行此测试脚本')
    }

  } catch (error) {
    console.error('❌ 测试失败:', error.message)
    console.error(error)
  }
}

// 执行测试
testWikiThreeLevelClassification()
