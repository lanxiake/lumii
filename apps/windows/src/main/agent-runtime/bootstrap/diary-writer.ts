import {
  DIARY_PROMPT,
  buildDiaryContext,
  hasInnerLife,
  listRecentDiaries,
  markDiaryWritten,
  readConcerns,
  readMood,
  saveDiary,
  todayDateKey,
  type AutonomousRepo,
  type ConversationRepo,
  type DatabaseAdapter,
} from '@mtbot/agent-runtime'

/**
 * 写日记所需的宿主能力。
 *
 * 从 `AgentRuntimeBridge` 抽出：这段逻辑只用这七个依赖，留在 4500 行的门面里
 * 既不能单测，也看不清它真正的输入是什么。
 */
export interface DiaryWriterDeps {
  db: DatabaseAdapter
  autonomousRepo: AutonomousRepo | null
  conversationRepo: ConversationRepo | null
  callLLM: (prompt: string, instanceId?: string, purpose?: string) => Promise<string>
  evolutionConversationIdFor: (agentId: string) => string
  ensurePetConversation: (agentId: string, conversationId: string) => void
  pushSavedMessage: (sessionKey: string, id: string, role: 'user' | 'assistant', text: string) => void
}

/**
 * 为某个 agent 写一篇当日日记：素材（目标/反思/挂念/心情/近期日记/今日事件）
 * → LLM → 双写会话与日记表。
 *
 * @returns 写成功时返回日记前 60 字，否则返回跳过原因（`diary-skipped` / `diary-unavailable`）
 */
export async function writeDiaryFor(agentId: string, deps: DiaryWriterDeps): Promise<string> {
  // 谁能写日记：助手与宠物（`hasInnerLife`）。两处判据同源，不会再各自漂移
  if (!hasInnerLife(agentId)) return 'diary-skipped'
  const repo = deps.autonomousRepo
  if (!repo) return 'diary-unavailable'

  const goals = repo.listGoals(agentId)
  const reflections = repo.reflections(agentId, 5)
  const recentDiaries = listRecentDiaries(deps.db, agentId, 5)

  // 今日真实事件（目标完成 / 有信息量的定时任务结果）→ 日记落到具体事，防空洞开场
  const todayStartMs = new Date().setHours(0, 0, 0, 0)
  const todayEvents: string[] = []
  try {
    const doneToday = deps.db
      .prepare<{ description: string }>(
        `SELECT description FROM autonomous_goals
         WHERE agent_id = ? AND status = 'completed' AND completed_at >= ?
         ORDER BY completed_at DESC LIMIT 5`,
      )
      .all(agentId, new Date(todayStartMs).toISOString())
    for (const g of doneToday) {
      todayEvents.push(`完成目标：${g.description}`)
    }
  } catch {
    /* 事件素材缺失不阻断日记 */
  }
  try {
    const runs = deps.db
      .prepare<{ job_id: string; summary: string | null }>(
        `SELECT job_id, summary FROM local_cron_runs
         WHERE started_at >= ? AND summary IS NOT NULL
         ORDER BY started_at DESC LIMIT 12`,
      )
      .all(todayStartMs)
    for (const r of runs) {
      const s = String(r.summary ?? '')
      if (!s || /^(idle|skipped)/.test(s)) continue
      todayEvents.push(`定时任务（${r.job_id}）：${s.slice(0, 80)}`)
      if (todayEvents.length >= 6) break
    }
  } catch {
    /* 事件素材缺失不阻断日记 */
  }

  const context = buildDiaryContext({
    goals: goals.map((g) => ({ description: g.description, status: g.status })),
    reflections: reflections.map((r) => ({ primaryIssue: r.primary_issue })),
    concerns: readConcerns(deps.db, agentId),
    mood: readMood(deps.db, agentId),
    recentDiaries,
    todayEvents,
  })
  // recentDiaries 已含在 context 中，不再单独拼接（防双份注入强化套话开场）
  const prompt = `${DIARY_PROMPT}\n\n今日素材：${JSON.stringify(context)}`
  const diary = await deps.callLLM(prompt, undefined, 'diary')

  // 会话按 agent 取：助手 `evolution:main`、宠物 `evolution:pet:<模型ID>`。
  // 用 `ensurePetConversation` 而不是裸的 `ensureConversationExists`——
  // 宠物会话还要顺带修参与者归属（见那个方法的注释）
  const diaryConvId = deps.evolutionConversationIdFor(agentId)
  deps.ensurePetConversation(agentId, diaryConvId)

  const askRow = deps.conversationRepo?.saveMessage({
    conversationId: diaryConvId,
    agentId,
    role: 'user',
    contentJson: { type: 'text', text: '写今天的日记' },
  })
  const diaryRow = deps.conversationRepo?.saveMessage({
    conversationId: diaryConvId,
    agentId,
    role: 'assistant',
    contentJson: { type: 'text', text: diary },
  })
  if (askRow) deps.pushSavedMessage(diaryConvId, askRow.id, 'user', '写今天的日记')
  if (diaryRow) deps.pushSavedMessage(diaryConvId, diaryRow.id, 'assistant', diary)

  // 双写：会话（给用户看）+ 表（给 LLM 做连续性上下文），两者都按 agent 分
  saveDiary(deps.db, agentId, todayDateKey(), diary)
  markDiaryWritten(deps.db, agentId)
  return diary.slice(0, 60)
}
