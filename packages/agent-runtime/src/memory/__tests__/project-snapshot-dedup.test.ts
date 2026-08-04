/**
 * Project 快照去重测试
 *
 * 验证：同一项目的多个进度快照只保留最新，归档旧的。
 */

import { describe, expect, it } from "vitest"

/**
 * 从 project 类记忆 content 中提取项目主题（归一化键）。
 *
 * 复制自 manager.ts 的私有函数用于单元测试。
 */
function extractProjectTheme(content: string): string | null {
  const normalize = (s: string): string =>
    s.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "")

  // 优先用书名号标题作为主题键
  const titleMatch = content.match(/[《「『]([^》」』]{4,40})[》」』]/)
  if (titleMatch?.[1]) {
    const key = normalize(titleMatch[1])
    if (key.length >= 4) return key
  }

  // 回退：项目名前 10 字符核心前缀
  const projectMatch = content.match(/项目[：:]\s*(.+?)(?:\s*[。.状态]|$)/)
  if (projectMatch?.[1]) {
    const key = normalize(projectMatch[1]).slice(0, 10)
    if (key.length >= 6) return key
  }

  return null
}

describe("extractProjectTheme", () => {
  it("从书名号提取主题（优先策略）", () => {
    const c1 = "项目：小红书 K8s 系列「10天架构师速通计划」。状态：序篇配图已完成"
    const c2 = "项目：小红书K8s系列「10天架构师速通计划」配图与发布推进。状态：第01篇"
    const c3 = "项目：小红书K8s系列「10 天架构师速通计划」发布推进。状态：第2篇封面"

    const t1 = extractProjectTheme(c1)
    const t2 = extractProjectTheme(c2)
    const t3 = extractProjectTheme(c3)

    // 3 条都提取到同一书名号内容，归一化后完全相同
    expect(t1).toBe("10天架构师速通计划")
    expect(t2).toBe("10天架构师速通计划")
    expect(t3).toBe("10天架构师速通计划")
    expect(t1).toBe(t2)
    expect(t2).toBe(t3)
  })

  it("无书名号时回退到前 10 字符核心前缀", () => {
    const c1 = "项目：公众号文章发布流程优化。状态：需求分析阶段"
    const c2 = "项目：公众号文章发布流程优化与自动化。状态：开发中"

    const t1 = extractProjectTheme(c1)
    const t2 = extractProjectTheme(c2)

    // 归一化后取前 10 字符，两者前缀相同
    expect(t1).toBe("公众号文章发布流程优")
    expect(t2).toBe("公众号文章发布流程优")
    expect(t1).toBe(t2)
  })

  it("无法识别主题时返回 null", () => {
    expect(extractProjectTheme("这是一条普通记忆，没有项目格式")).toBeNull()
    expect(extractProjectTheme("项目：短")).toBeNull() // 太短
    expect(extractProjectTheme("任务：做某事")).toBeNull() // 非"项目："
  })

  it("真实案例：9 条 K8s 快照归一化到同主题", () => {
    const snapshots = [
      "项目：小红书 K8s 系列「10 天架构师速通计划」。状态：12 篇正文已写完（序篇到完结篇）",
      "项目：小红书K8s系列「10天架构师速通计划」配图与发布推进。状态：用户要求预览续篇",
      "项目：小红书K8s系列「10天架构师速通计划」配图与发布推进。状态：需要批量生成剩余11篇配图",
      "项目：小红书K8s系列「10天架构师速通计划」发布推进。状态：序篇（00-为什么要学K8s）配图已生成",
      "项目：小红书 K8s 系列「10天架构师速通计划」配图与发布。状态：正在进行第01篇",
      "项目：小红书K8s系列「10天架构师速通计划」第一篇（容器即集装箱 K8s即港口调度中心）",
      "项目：小红书K8s系列「10天架构师速通计划」第2篇（kubectl apply 背后藏了6个打工仔）",
      "项目：K8s系列文章配图与预览。状态：第1篇配图已生成但预览文件中路径不可见",
      "项目：小红书K8s系列「10天架构师速通计划」第1篇（容器即集装箱 K8s即港口调度中心）",
    ]

    const themes = snapshots.map(extractProjectTheme)

    // 前 7 条都有书名号，归一化到同一主题
    expect(themes[0]).toBe("10天架构师速通计划")
    expect(themes[1]).toBe("10天架构师速通计划")
    expect(themes[6]).toBe("10天架构师速通计划")
    expect(new Set(themes.slice(0, 7)).size).toBe(1)

    // 第 8 条无书名号，但前缀"k8s系列文章"与前面不同主题
    expect(themes[7]).not.toBe(themes[0])
    expect(themes[7]).toBe("k8s系列文章配图与")
  })
})
