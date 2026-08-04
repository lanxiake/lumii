/**
 * Pre-LLM Router 验收用例集
 *
 * 该文件 ≠ 单元测试（默认 skip）。
 * 触发方式：
 *   ROUTER_ACCEPTANCE=1 RUN_REAL_LLM=1 npx vitest run router-acceptance.test.ts
 *
 * 在真实 LLM 环境下运行，验证 Router 的 top1/top3 命中率指标。
 * 详见 .qoder/design/Agent-Skill编排优化/03-实施计划.md §6.2
 */

import { describe, expect, it } from "vitest"
import { RouterService } from "./router-service"
import type { RouterLlmCaller } from "./llm-caller"
import type { RouterAgentInfo, RouterInput, RouterSkillInfo } from "./types"

const REAL_LLM = process.env.ROUTER_ACCEPTANCE === "1" && process.env.RUN_REAL_LLM === "1"
const describeOrSkip = REAL_LLM ? describe : describe.skip

// ─── 测试集：50 个真实用户场景 ──────────────────────────────────────

interface AcceptanceCase {
  input: string
  expectedTop1Agent?: string
  expectedAnyAgent?: string[]
  expectedTop1Skill?: string
  expectedAnySkill?: string[]
  expectedNeedsClarification?: boolean
  /** 备注 */
  notes?: string
}

const CASES: AcceptanceCase[] = [
  // ── 编程类（15） ──
  { input: "帮我看看 src/foo.ts 这段代码有什么问题", expectedTop1Agent: "code-reviewer" },
  { input: "重构这个函数让它更简洁", expectedAnyAgent: ["code-reviewer", "refactor-cleaner"] },
  { input: "解释一下这段代码", expectedAnyAgent: ["code-reviewer"] },
  { input: "查找一下 useState 在哪里调用", expectedAnyAgent: ["builtin:explore"] },
  { input: "搜代码中的 TODO", expectedAnyAgent: ["builtin:explore"] },
  { input: "帮我写一个排序函数", expectedAnyAgent: ["coding-helper", "assistant"] },
  { input: "调试这个 bug", expectedAnyAgent: ["code-reviewer", "assistant"] },
  { input: "审查一下我刚写的 PR", expectedAnyAgent: ["code-reviewer"] },
  { input: "这段代码有性能问题吗", expectedAnyAgent: ["code-reviewer"] },
  { input: "怎么优化这个 SQL", expectedAnyAgent: ["assistant"] },
  { input: "把这段 Python 改成 JS", expectedAnyAgent: ["assistant"] },
  { input: "怎么用 React useEffect", expectedAnyAgent: ["assistant"] },
  { input: "实现一个二叉树遍历", expectedAnyAgent: ["assistant"] },
  { input: "Docker 容器启动失败了怎么办", expectedAnyAgent: ["assistant"] },
  { input: "Git rebase 出现冲突怎么办", expectedAnyAgent: ["assistant"] },

  // ── 学习类（10） ──
  { input: "教我学英语", expectedAnyAgent: ["english-tutor", "assistant"] },
  { input: "讲解一下量子力学的基础", expectedAnyAgent: ["assistant"] },
  { input: "推荐一些学习数学的资源", expectedAnyAgent: ["assistant"] },
  { input: "帮孙子辅导英语", expectedAnyAgent: ["english-tutor", "assistant"] },
  { input: "什么是函数式编程", expectedAnyAgent: ["assistant"] },
  { input: "总结一下这篇文章", expectedAnySkill: ["summarize"] },
  { input: "翻译一下这段话", expectedAnySkill: ["translate"] },
  { input: "把这个翻译成英语", expectedAnySkill: ["translate"] },
  { input: "解释一下区块链", expectedAnyAgent: ["assistant"] },
  { input: "如何学习机器学习", expectedAnyAgent: ["assistant"] },

  // ── 写作类（10） ──
  { input: "帮我写一篇产品介绍", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "写一个小红书爆款标题", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "润色一下这段文字", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "改简历", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "起几个吸引眼球的标题", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "写一封商务邮件", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "生成 3 个广告文案", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "写个朋友圈文案", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "把这个改成正式语气", expectedAnyAgent: ["writing-helper", "assistant"] },
  { input: "帮我起个公司名", expectedAnyAgent: ["assistant"] },

  // ── 生活类（10） ──
  { input: "今天天气怎么样", expectedAnyAgent: ["assistant"] },
  { input: "推荐一道菜", expectedAnyAgent: ["assistant"] },
  { input: "计算 1234 × 5678", expectedAnyAgent: ["assistant"] },
  { input: "今天周几", expectedAnyAgent: ["assistant"] },
  { input: "随便聊聊", expectedTop1Agent: "assistant" },
  { input: "你好", expectedTop1Agent: "assistant" },
  { input: "我今天心情不好", expectedAnyAgent: ["assistant"] },
  { input: "讲个笑话", expectedAnyAgent: ["assistant"] },
  { input: "明天提醒我开会", expectedAnyAgent: ["assistant"] },
  { input: "帮我设置一个 30 分钟的倒计时", expectedAnyAgent: ["assistant"] },

  // ── 模糊类（5）—— 必须触发澄清 ──
  { input: "帮我看看", expectedNeedsClarification: true },
  { input: "试一下", expectedNeedsClarification: true },
  { input: "搞一下这个", expectedNeedsClarification: true },
  { input: "帮个忙", expectedNeedsClarification: true },
  { input: "你帮我处理一下", expectedNeedsClarification: true },
]

// ─── 验收用 Agent/Skill 元数据（模拟用户实际配置） ───────────────────

const MOCK_AGENTS: RouterAgentInfo[] = [
  {
    id: "assistant",
    name: "通用助手",
    description: "通用任务、闲聊、综合性问题",
    whenToUse: "用户提问无明确分类、闲聊、生活问题、计算时使用",
    triggerExamples: ["你好", "随便聊聊", "什么是"],
    category: "general",
  },
  {
    id: "code-reviewer",
    name: "代码审查专家",
    description: "审查代码质量、找 bug、性能优化",
    whenToUse: "用户想要审查、检查、找 bug、重构代码时使用",
    triggerExamples: ["看看这段代码", "code review", "审查"],
    category: "coding",
  },
  {
    id: "builtin:explore",
    name: "代码探索",
    description: "在大型代码库中查找符号、文件、API",
    whenToUse: "用户想要查找、搜索、定位代码符号或文件时使用",
    triggerExamples: ["找一下", "查找", "search"],
    category: "coding",
  },
  {
    id: "english-tutor",
    name: "英语家教",
    description: "辅导英语、纠语法、做对话练习",
    whenToUse: "用户想要学习英语、辅导英语、练习英语对话时使用",
    triggerExamples: ["教我英语", "辅导英语", "英语作业"],
    category: "learning",
  },
  {
    id: "writing-helper",
    name: "写作助手",
    description: "写文案、起标题、润色、改简历",
    whenToUse: "用户想要写文章、文案、标题、邮件、简历时使用",
    triggerExamples: ["写一篇", "起标题", "润色"],
    category: "writing",
  },
]

const MOCK_SKILLS: RouterSkillInfo[] = [
  { id: "translate", name: "Translate", description: "翻译文本", whenToUse: "用户想要翻译时" },
  { id: "summarize", name: "Summarize", description: "总结长文档", whenToUse: "用户想要总结时" },
  { id: "image-generate", name: "Image Generate", description: "生成图片", whenToUse: "用户想要画图时" },
]

// ─── 真实 LLM 调用 caller 构造（生产环境注入） ──────────────────────

function buildRealCaller(): RouterLlmCaller {
  // 真实环境下，从 bridge 拿 streamFn + modelRouter，构造 GatewayRouterLlmCaller。
  // 由于本测试在 vitest 环境运行，无完整 bridge，此处 throw 提醒手动设置。
  throw new Error(
    "Real LLM caller not wired in this test. Run via integration harness or stub manually.",
  )
}

// ─── 测试主体 ─────────────────────────────────────────────────────

describeOrSkip("Router 验收：50 个真实用户场景", () => {
  const caller = REAL_LLM ? buildRealCaller() : ({} as RouterLlmCaller)
  const svc = new RouterService({ llmCaller: caller })

  let top1Hits = 0
  let top3Hits = 0
  let clarifyHits = 0
  let totalEvaluated = 0

  for (const tc of CASES) {
    it(`[${tc.input.slice(0, 30)}] ${tc.notes ?? ""}`.trim(), async () => {
      const input: RouterInput = {
        userInput: tc.input,
        availableAgents: MOCK_AGENTS,
        availableSkills: MOCK_SKILLS,
      }
      const result = await svc.route(input)

      if (tc.expectedNeedsClarification) {
        expect(result.needsClarification).toBe(true)
        clarifyHits++
        return
      }

      totalEvaluated++
      const top1Agent = result.topAgents[0]?.id
      const allAgentIds = result.topAgents.map((a) => a.id)
      const top1Skill = result.topSkills[0]?.id
      const allSkillIds = result.topSkills.map((s) => s.id)

      if (tc.expectedTop1Agent) {
        const ok = top1Agent === tc.expectedTop1Agent
        if (ok) top1Hits++
        expect.soft(top1Agent).toBe(tc.expectedTop1Agent)
      }
      if (tc.expectedAnyAgent) {
        const hit = tc.expectedAnyAgent.some((id) => allAgentIds.includes(id))
        if (hit) top3Hits++
        expect.soft(hit).toBe(true)
      }
      if (tc.expectedTop1Skill) {
        const ok = top1Skill === tc.expectedTop1Skill
        if (ok) top1Hits++
        expect.soft(top1Skill).toBe(tc.expectedTop1Skill)
      }
      if (tc.expectedAnySkill) {
        const hit = tc.expectedAnySkill.some((id) => allSkillIds.includes(id))
        if (hit) top3Hits++
        expect.soft(hit).toBe(true)
      }
    })
  }

  it("汇总指标", () => {
    console.log("=== Router 准确率汇总 ===")
    console.log(`总用例: ${CASES.length}`)
    console.log(`评估用例: ${totalEvaluated}`)
    console.log(`澄清触发: ${clarifyHits} / ${CASES.filter((c) => c.expectedNeedsClarification).length}`)
    console.log(`Top1 命中: ${top1Hits} (${((top1Hits / totalEvaluated) * 100).toFixed(1)}%)`)
    console.log(`Top3 命中: ${top3Hits} (${((top3Hits / totalEvaluated) * 100).toFixed(1)}%)`)
    expect(top1Hits / totalEvaluated).toBeGreaterThanOrEqual(0.6) // 期望 ≥ 60%
  })
})

// 默认环境下确认测试集已完整加载（防御性检查）
describe("Router 验收用例集元信息", () => {
  it("加载了 50 个用例", () => {
    expect(CASES.length).toBe(50)
  })
  it("覆盖编程/学习/写作/生活/模糊 5 类", () => {
    const intentTypes = new Set([
      "code-reviewer",
      "english-tutor",
      "writing-helper",
      "assistant",
    ])
    const covered = new Set<string>()
    for (const c of CASES) {
      if (c.expectedTop1Agent) covered.add(c.expectedTop1Agent)
      c.expectedAnyAgent?.forEach((a) => covered.add(a))
    }
    for (const expected of intentTypes) {
      expect(covered.has(expected)).toBe(true)
    }
  })
  it("模糊类用例数 ≥ 5", () => {
    const ambiguous = CASES.filter((c) => c.expectedNeedsClarification)
    expect(ambiguous.length).toBeGreaterThanOrEqual(5)
  })
})
