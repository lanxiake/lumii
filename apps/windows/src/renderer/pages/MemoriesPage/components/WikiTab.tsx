/**
 * WikiTab — Wiki 知识库工作区
 *
 * 左栏承载用途目录树与固定入口，顶栏统一承载搜索、当前目录上下文与任务进度，
 * 主内容区按用途目录展示原始文件；历史摘要页面只从「更多 → 历史页面」进入。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PARKING_CATEGORY } from '@mtbot/agent-runtime/browser'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { ConfirmModal } from '../../../components/ui/Modal'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiPageListItem,
  type WikiPageDetail,
  type WikiSourceListItem,
  type WikiTopicMutation,
  type WikiTopicTree,
  type WikiReclassifyRunItem,
  type WikiReclassifyScopeDto,
  type WikiSynthesisListItem,
} from '../../../hooks/business/useWikiPage'
import { CleanupView } from './CleanupView'
import { SynthesisView } from './SynthesisView'
import { WikiGraphView } from './WikiGraphView'
import { WikiDetailDrawer } from './WikiDetailDrawer'
import { WikiLeftNav, topicCountKey, type WikiNav } from './WikiLeftNav'
import { navSectionFromLegacyCategory, type WikiNavSection } from './wikiNavMapping'
import { WikiTopBar } from './WikiTopBar'
import { WikiPageList } from './WikiPageList'
import { WikiFileList } from './WikiFileList'
import { WikiTopicPicker } from './WikiTopicPicker'
import { WikiTopicTreeEditor } from './WikiTopicTreeEditor'
import { WikiReclassifyView } from './WikiReclassifyView'
import { WikiInboxPanel, inboxItemToPreviewSnapshot } from './WikiInboxPanel'
import { WikiMoreMenu } from './WikiMoreMenu'
import { WikiSourceDetailDrawer, type WikiSourcePreviewSnapshot } from './WikiSourceDetailDrawer'
import {
  CONSOLIDATE_HINT_MIN_COUNT,
  CONSOLIDATE_MIN_SELECTION,
  countShortSources,
  isShortSource,
  resolveConsolidateTarget,
  waitForSynthesisReady,
  WIKI_CONSOLIDATE_SUBTOPIC,
  type WikiConsolidateTarget,
} from './wikiConsolidate'
import { WIKI_MODAL_LAYER } from './wikiModalLayer'
import { WikiTaskCenter } from './WikiTaskCenter'
import { useWikiTaskCenter, type WikiLocalTask } from './useWikiTaskCenter'
import './WikiTab.css'

/** 归档选择器的目标：inbox 队列条目，或已进资料层但待补分/需要移动的文件 */
type PickerTarget =
  | { mode: 'inbox'; item: WikiInboxItem }
  | { mode: 'source'; item: WikiSourceListItem }

const FIXED_NAV_CONTEXT: Record<string, { title: string; subtitle: string }> = {
  inbox: { title: '待整理', subtitle: '系统还在归档或无法自动归类的文件' },
  parking: { title: '临时存放', subtitle: '你主动搁置、暂不进入正式目录的文件' },
  graph: { title: '知识图谱', subtitle: '浏览页面与实体之间的关系' },
  history: { title: '历史页面', subtitle: '早期归档生成的摘要页面，只读' },
  cleanup: { title: '清理', subtitle: '扫描并处理需要维护的资料' },
  synthesis: { title: '综述合成', subtitle: '从已有页面生成主题综述' },
  reclassify: { title: '重新编目', subtitle: 'AI 的目录调整建议，接受后才生效' },
}

/**
 * 渲染 Wiki 工作区并协调用途目录、文件列表与归档选择器。
 */
export const WikiTab: React.FC = () => {
  const {
    listInbox,
    countInbox,
    retryInbox,
    discardInbox,
    organizeInbox,
    listPages,
    getPage,
    updatePage,
    deletePage,
    listRuns,
    rebuildIndex,
    listBacklinks,
    listRevisions,
    rollbackPage,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    autoRunSynthesis,
    getGraphData,
    statusScan,
    confirmStatus,
    loadTopicTree,
    mutateTopic,
    createNote,
    createSynthesis,
    runReclassify,
    getReclassifyRun,
    applyReclassify,
    ignoreReclassify,
    discardReclassify,
    listSources,
    listSyntheses,
    getSynthesis,
    acceptSynthesisAsSource,
    rejectSynthesis,
    updateSourceTopic,
    moveToParking,
    openSource,
    getSource,
    searchSources,
    extractEroFromSources,
    listEntitySources,
    loading,
  } = useWikiPage()
  const taskCenter = useWikiTaskCenter()

  const [nav, setNav] = useState<WikiNav>({ kind: 'inbox' })
  const [topicTree, setTopicTree] = useState<WikiTopicTree | null>(null)
  const [sources, setSources] = useState<readonly WikiSourceListItem[]>([])
  const [pages, setPages] = useState<readonly WikiPageListItem[]>([])
  const [inboxItems, setInboxItems] = useState<readonly WikiInboxItem[]>([])
  const [inboxPending, setInboxPending] = useState(0)
  const [selectedPage, setSelectedPage] = useState<WikiPageDetail | null>(null)
  const [isDetailOpen, setIsDetailOpen] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [editDraft, setEditDraft] = useState('')
  const [editTitle, setEditTitle] = useState('')
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly WikiSourceListItem[] | null>(null)
  const [searchDegradeReason, setSearchDegradeReason] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<{ backlinks: number } | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [isTaskCenterOpen, setIsTaskCenterOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [isTreeEditorOpen, setIsTreeEditorOpen] = useState(false)
  const [reclassifyRun, setReclassifyRun] = useState<WikiReclassifyRunItem | null>(null)
  const [reclassifyConfirm, setReclassifyConfirm] = useState<{ count: number } | null>(null)
  const [suggestion, setSuggestion] = useState<{
    category: string
    subtopic: string
    reason: string
  } | null>(null)
  const [suggestionState, setSuggestionState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [highlightSourceId, setHighlightSourceId] = useState<string | null>(null)
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<string>>(new Set())
  const [isBatchPickerOpen, setBatchPickerOpen] = useState(false)
  const [synthesisConfirm, setSynthesisConfirm] = useState<{ count: number } | null>(null)
  const [synthesisRows, setSynthesisRows] = useState<readonly WikiSynthesisListItem[]>([])
  const [consolidateConfirm, setConsolidateConfirm] = useState<{
    count: number
    sourceIds: readonly string[]
  } | null>(null)
  const [sourcePreview, setSourcePreview] = useState<{
    sourceId: string | null
    snapshot: WikiSourcePreviewSnapshot | null
  } | null>(null)
  const [consolidateTarget, setConsolidateTarget] = useState<WikiConsolidateTarget | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)

  const refreshSources = useCallback(async () => {
    setSources(await listSources({}))
  }, [listSources])

  const refreshPages = useCallback(async () => {
    setPages(await listPages())
  }, [listPages])

  const refreshInbox = useCallback(async () => {
    const [all, count] = await Promise.all([listInbox('pending'), countInbox('pending')])
    setInboxItems(all)
    setInboxPending(count)
  }, [listInbox, countInbox])

  const refreshSynthesisRows = useCallback(async () => {
    setSynthesisRows(await listSyntheses('candidate'))
  }, [listSyntheses])

  useEffect(() => {
    void loadTopicTree().then(setTopicTree)
    void refreshSources()
    void refreshInbox()
  }, [loadTopicTree, refreshSources, refreshInbox])

  // 历史页面与综述、图谱仍以 wiki_pages 为数据源，进入这些视图时才加载
  useEffect(() => {
    if (nav.kind === 'history' || nav.kind === 'synthesis' || nav.kind === 'graph') {
      void refreshPages()
    }
    if (nav.kind === 'synthesis') {
      void refreshSynthesisRows()
    }
  }, [nav.kind, refreshPages, refreshSynthesisRows])

  useEffect(() => {
    /** 将已有归档运行合并进任务中心历史。 */
    const loadRunHistory = async (): Promise<void> => {
      taskCenter.mergeRuns(await listRuns())
    }

    void loadRunHistory()
  }, [listRuns, taskCenter.mergeRuns])

  // 按 section 分组计数 + 保留 topicCounts（小类芯片仍需）+ 分离 parking/unfiled。
  // 已归档不在这里统计：listSources 的 SQL 固定过滤 archived_at IS NULL，
  // 归档列表与计数走独立的按需查询（archivedSources state）。
  const { sectionCounts, topicCounts, parkingSources, unfiledSources } = useMemo(() => {
    const sections: Record<WikiNavSection, number> = {
      work: 0,
      study: 0,
      life: 0,
      collection: 0,
      inbox: 0,
      archived: 0,
      unfiled: 0,
    }
    const counts: Record<string, number> = {}
    const parking: WikiSourceListItem[] = []
    const unfiled: WikiSourceListItem[] = []
    for (const item of sources) {
      if (item.topicCategory === PARKING_CATEGORY) {
        parking.push(item)
        continue
      }
      if (!item.topicCategory) {
        unfiled.push(item)
        continue
      }
      const section = navSectionFromLegacyCategory(item.topicCategory)
      sections[section] = (sections[section] ?? 0) + 1
      counts[topicCountKey(item.topicCategory)] = (counts[topicCountKey(item.topicCategory)] ?? 0) + 1
      if (item.topicSubtopic) {
        const key = topicCountKey(item.topicCategory, item.topicSubtopic)
        counts[key] = (counts[key] ?? 0) + 1
      }
    }
    return { sectionCounts: sections, topicCounts: counts, parkingSources: parking, unfiledSources: unfiled }
  }, [sources])

  // 收件箱角标 = 队列 pending + 未分类（两者都需要用户处理）
  const pendingCount = inboxPending + unfiledSources.length

  // 全库重新编目的扫描量：正式归档的（有大类且不是临时存放）
  const filedSourceCount = useMemo(
    () =>
      sources.filter((item) => item.topicCategory !== null && item.topicCategory !== PARKING_CATEGORY)
        .length,
    [sources],
  )

  const visibleSources = useMemo(() => {
    if (nav.kind === 'category') {
      return sources.filter((item) => item.topicCategory === nav.name)
    }
    if (nav.kind === 'subtopic') {
      return sources.filter(
        (item) => item.topicCategory === nav.category && item.topicSubtopic === nav.subtopic,
      )
    }
    return []
  }, [nav, sources])

  /**
   * 打开任务中心并清除失败任务的未读提示。
   */
  const handleOpenTaskCenter = useCallback(() => {
    taskCenter.markFailuresSeen()
    setIsTaskCenterOpen(true)
    void listRuns()
      .then(taskCenter.mergeRuns)
      .catch(() => undefined)
  }, [listRuns, taskCenter.markFailuresSeen, taskCenter.mergeRuns])

  /**
   * 重试任务记录中保留的原操作或归档 inbox 项。
   */
  const handleRetryTask = useCallback(
    async (task: WikiLocalTask): Promise<void> => {
      try {
        if (task.retry) {
          await task.retry()
          taskCenter.dismissTask(task.id)
          return
        }
        if (task.kind !== 'archive' || !task.inboxIds?.length) return
        await taskCenter.wrapAsync('archive', task.title, async () => {
          const results = await Promise.all(task.inboxIds?.map(retryInbox) ?? [])
          if (results.some((result) => !result)) throw new Error('部分归档任务重试失败')
          await refreshInbox()
        })
        taskCenter.dismissTask(task.id)
      } catch {
        // wrapAsync 已将失败原因写入新的任务记录，避免事件处理产生未捕获拒绝。
      }
    },
    [refreshInbox, retryInbox, taskCenter.dismissTask, taskCenter.wrapAsync],
  )

  const trackedCleanupScan = useCallback(
    (staleDays?: number) => taskCenter.wrapAsync('cleanup', '扫描清理项', () => cleanupScan(staleDays)),
    [cleanupScan, taskCenter.wrapAsync],
  )

  const trackedArchiveSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync('cleanup', '归档资料', () => archiveSources(sourceIds)),
    [archiveSources, taskCenter.wrapAsync],
  )

  const trackedRestoreSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync('cleanup', '恢复资料', () => restoreSources(sourceIds)),
    [restoreSources, taskCenter.wrapAsync],
  )

  const trackedDeleteSources = useCallback(
    (sourceIds: readonly string[]) => taskCenter.wrapAsync('cleanup', '删除资料', () => deleteSources(sourceIds)),
    [deleteSources, taskCenter.wrapAsync],
  )

  const trackedAutoRunSynthesis = useCallback(
    () => taskCenter.wrapAsync('synthesis', '自动综述合成', autoRunSynthesis),
    [autoRunSynthesis, taskCenter.wrapAsync],
  )

  const handleSelectNav = useCallback((next: WikiNav) => {
    setNav(next)
    setIsMoreMenuOpen(false)
    setSearchResults(null)
    setOpenError(null)
    setSelectedPage(null)
    setIsDetailOpen(false)
    // 换目录必须清选中：否则批量动作会作用到上一个目录里已看不见的文件
    setSelectedSourceIds(new Set())
    setHighlightSourceId(null)
  }, [])

  const toggleSelectSource = useCallback((id: string) => {
    setSelectedSourceIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  /** 全选/取消全选当前视图可见的文件 */
  const toggleSelectAllSources = useCallback(() => {
    setSelectedSourceIds((prev) =>
      prev.size === visibleSources.length && prev.size > 0
        ? new Set()
        : new Set(visibleSources.map((item) => item.id)),
    )
  }, [visibleSources])

  /**
   * 打开原始文件；失败时在主区展示具体原因，不静默丢弃。
   */
  const handleOpenSource = useCallback(
    async (item: WikiSourceListItem) => {
      setOpenError(null)
      try {
        await openSource(item.id)
      } catch (error) {
        setOpenError(error instanceof Error ? error.message : '无法打开原文件')
      }
    },
    [openSource],
  )

  /**
   * 确认归档目标后按来源分流：队列条目走 organizeInbox，资料层条目走 updateSourceTopic。
   */
  const handleConfirmPicker = useCallback(
    async (category: string, subtopic: string) => {
      const target = picker
      setPicker(null)
      setSuggestion(null)
      setSuggestionState('idle')
      if (!target) return
      if (target.mode === 'inbox') {
        await organizeInbox(target.item.id, category, subtopic)
        await refreshInbox()
      } else {
        await updateSourceTopic(target.item.id, category, subtopic)
      }
      await refreshSources()
    },
    [picker, organizeInbox, updateSourceTopic, refreshInbox, refreshSources],
  )

  const handlePark = useCallback(
    async (item: WikiSourceListItem) => {
      await moveToParking(item.id)
      await refreshSources()
    },
    [moveToParking, refreshSources],
  )

  /** 接受整合/综述：整合类接受后跳转到统一「整合长文」目录 */
  const handleAcceptSynthesis = useCallback(
    async (synthesisId: string, category: string, subtopic: string, archiveSources = false) => {
      const result = await acceptSynthesisAsSource(synthesisId, category, subtopic, archiveSources)
      if (result) {
        await refreshSources()
        if (subtopic === WIKI_CONSOLIDATE_SUBTOPIC) {
          setHighlightSourceId(result.sourceId)
          setNav({ kind: 'subtopic', category, subtopic })
        }
      }
      setSynthesisRows(await listSyntheses('candidate'))
    },
    [acceptSynthesisAsSource, listSyntheses, refreshSources, setNav],
  )

  const handleRejectSynthesis = useCallback(
    async (synthesisId: string) => {
      await rejectSynthesis(synthesisId)
      setSynthesisRows(await listSyntheses('candidate'))
    },
    [rejectSynthesis, listSyntheses],
  )

  /**
   * 将多篇短文整合为一篇 1000 字以上的长文；完成后自动归档到「{大类} / 整合长文」。
   */
  const runConsolidate = useCallback(
    async (sourceIds: readonly string[], confirmed = false) => {
      if (sourceIds.length < CONSOLIDATE_MIN_SELECTION) return
      const target = resolveConsolidateTarget(nav)
      if (!target) {
        taskCenter.failTask(
          taskCenter.startTask({ kind: 'synthesis', title: '整合短文' }),
          '请在具体大类或小类目录下发起整合',
        )
        return
      }
      setConsolidateTarget(target)
      const title =
        nav.kind === 'subtopic'
          ? `${nav.subtopic} 整合`
          : nav.kind === 'category'
            ? `${nav.name} 整合`
            : '主题整合'
      const taskId = taskCenter.startTask({ kind: 'synthesis', title: '整合短文' })
      const created = await createSynthesis({
        sourceIds,
        confirmed,
        title,
        mode: 'consolidate',
      })
      if (!created.ok) {
        if (created.needsConfirm) {
          taskCenter.dismissTask(taskId)
          setConsolidateConfirm({ count: created.count, sourceIds: [...sourceIds] })
          return
        }
        taskCenter.failTask(taskId, created.error)
        return
      }
      taskCenter.updateTask(taskId, { detail: '生成中…' })
      const ready = await waitForSynthesisReady(getSynthesis, created.synthesisId)
      if (ready !== 'ready') {
        taskCenter.failTask(taskId, ready === 'timeout' ? '生成超时，请到综述合成查看' : '生成失败')
        setNav({ kind: 'synthesis' })
        void refreshSynthesisRows()
        return
      }
      const accepted = await acceptSynthesisAsSource(
        created.synthesisId,
        target.category,
        target.subtopic,
        true,
      )
      if (!accepted) {
        taskCenter.failTask(taskId, '归档到整合长文失败，请到综述合成手动接受')
        setNav({ kind: 'synthesis' })
        void refreshSynthesisRows()
        return
      }
      taskCenter.completeTask(taskId, {
        detail: `${sourceIds.length} 篇 → ${target.category} / ${target.subtopic}`,
      })
      setSelectedSourceIds(new Set())
      setHighlightSourceId(accepted.sourceId)
      setNav({ kind: 'subtopic', category: target.category, subtopic: target.subtopic })
      await refreshSources()
      void refreshSynthesisRows()
      void loadTopicTree().then(setTopicTree)
    },
    [
      createSynthesis,
      getSynthesis,
      acceptSynthesisAsSource,
      taskCenter,
      setNav,
      refreshSynthesisRows,
      refreshSources,
      loadTopicTree,
      nav,
    ],
  )

  const handleConsolidateSelected = useCallback(
    (confirmed = false) => void runConsolidate([...selectedSourceIds], confirmed),
    [runConsolidate, selectedSourceIds],
  )

  /** 一键整合当前目录下全部短文 */
  const handleConsolidateAllShort = useCallback(() => {
    const shortIds = visibleSources
      .filter((item) => isShortSource(item.textLength, item.title.length))
      .map((item) => item.id)
    void runConsolidate(shortIds)
  }, [visibleSources, runConsolidate])

  const shortInViewCount = useMemo(
    () => countShortSources(visibleSources),
    [visibleSources],
  )

  /**
   * 生成一组选中文件的综述，完成后跳到候选视图。
   * 后端在超量时抛「需要二次确认」，这里转成确认框再带 confirmed 重发。
   */
  const handleSynthesizeSelected = useCallback(
    async (confirmed = false) => {
      const ids = [...selectedSourceIds]
      if (ids.length === 0) return
      const taskId = taskCenter.startTask({ kind: 'synthesis', title: '生成综述' })
      const created = await createSynthesis({ sourceIds: ids, confirmed })
      if (!created.ok) {
        if (created.needsConfirm) {
          taskCenter.dismissTask(taskId)
          setSynthesisConfirm({ count: created.count })
          return
        }
        taskCenter.failTask(taskId, created.error)
        return
      }
      taskCenter.completeTask(taskId, { detail: `${ids.length} 个文件` })
      setSelectedSourceIds(new Set())
      setNav({ kind: 'synthesis' })
      void refreshSynthesisRows()
    },
    [selectedSourceIds, createSynthesis, taskCenter, setNav, refreshSynthesisRows],
  )

  /** 批量移动：逐条走确定性写入路径 */
  const handleMoveSelected = useCallback(
    async (category: string, subtopic: string) => {
      for (const id of selectedSourceIds) {
        await updateSourceTopic(id, category, subtopic)
      }
      setSelectedSourceIds(new Set())
      await refreshSources()
    },
    [selectedSourceIds, updateSourceTopic, refreshSources],
  )

  const handleParkSelected = useCallback(async () => {
    for (const id of selectedSourceIds) {
      await moveToParking(id)
    }
    setSelectedSourceIds(new Set())
    await refreshSources()
  }, [selectedSourceIds, moveToParking, refreshSources])

  /** 逐条移到临时存放，返回成功条数（清理视图的批量动作用） */
  const handleParkMany = useCallback(
    async (sourceIds: readonly string[]): Promise<number> => {
      let moved = 0
      for (const id of sourceIds) {
        if (await moveToParking(id)) moved += 1
      }
      await refreshSources()
      return moved
    },
    [moveToParking, refreshSources],
  )

  /**
   * 启动重新编目并跳到候选视图。
   * running 期间轮询进度；已有待审阅批次时后端会拒绝，这里把中文原因抛给任务中心。
   */
  const handleRunReclassify = useCallback(
    async (scope: WikiReclassifyScopeDto, opts?: { force?: boolean }) => {
      setNav({ kind: 'reclassify' })
      const taskId = taskCenter.startTask({ kind: 'reclassify', title: '重新编目' })
      const started = await runReclassify(scope, opts)
      if (!started.ok) {
        taskCenter.failTask(taskId, started.error)
        setReclassifyRun(await getReclassifyRun())
        return
      }
      const run = await getReclassifyRun()
      setReclassifyRun(run)
      if (run?.status === 'failed') {
        taskCenter.failTask(taskId, run.error ?? '重新编目失败')
        return
      }
      taskCenter.completeTask(taskId, {
        detail: run ? `${run.candidates.length} 条建议` : undefined,
      })
    },
    [runReclassify, getReclassifyRun, taskCenter],
  )

  const handleApplyReclassify = useCallback(
    async (candidateIds: readonly string[]) => {
      await applyReclassify(candidateIds)
      setReclassifyRun(await getReclassifyRun())
      await refreshSources()
    },
    [applyReclassify, getReclassifyRun, refreshSources],
  )

  const handleIgnoreReclassify = useCallback(
    async (candidateId: string) => {
      await ignoreReclassify(candidateId)
      setReclassifyRun(await getReclassifyRun())
    },
    [ignoreReclassify, getReclassifyRun],
  )

  /**
   * 在当前小类下新建笔记，成功后刷新列表并高亮新行。
   * 大类聚合视图不给这个入口——必须先选定小类，避免误放。
   */
  const handleCreateNote = useCallback(
    async (category: string, subtopic: string) => {
      const created = await createNote(category, subtopic)
      if (!created) {
        setOpenError('新建笔记失败')
        return
      }
      await refreshSources()
      setHighlightSourceId(created.sourceId)
    },
    [createNote, refreshSources],
  )

  /**
   * 选择器里的「让 AI 建议」：跑一次 scope=source 的编目，取第一条候选当建议。
   * 拿到就 discard 掉批次——单文件建议用完即弃，不能长期占住「同时只允许一个批次」的槽位。
   */
  const handleRequestSuggestion = useCallback(
    async (sourceId: string) => {
      setSuggestionState('loading')
      setSuggestion(null)
      const started = await runReclassify({ kind: 'source', sourceId }, { force: true })
      if (!started.ok) {
        setSuggestionState('failed')
        return
      }
      const run = await getReclassifyRun()
      const first = run?.candidates[0]
      await discardReclassify()
      if (!first) {
        setSuggestionState('failed')
        return
      }
      setSuggestion({ category: first.toCategory, subtopic: first.toSubtopic, reason: first.reason })
      setSuggestionState('idle')
    },
    [runReclassify, getReclassifyRun, discardReclassify],
  )

  const handleDiscardReclassify = useCallback(async () => {
    await discardReclassify()
    setReclassifyRun(null)
    setNav({ kind: 'inbox' })
  }, [discardReclassify])

  /**
   * 应用一次主题树变更，成功后刷新树与文件列表。
   * 若当前所在目录被这次变更删掉/改名，导航回待整理，避免停在空节点上。
   */
  const handleMutateTopic = useCallback(
    async (mutation: WikiTopicMutation) => {
      const result = await mutateTopic(mutation)
      if (!result.ok) return result
      setTopicTree(result.tree)
      await refreshSources()
      setNav((prev) => {
        if (prev.kind === 'category') {
          return result.tree.categories.some((c) => c.name === prev.name) ? prev : { kind: 'inbox' }
        }
        if (prev.kind === 'subtopic') {
          const cat = result.tree.categories.find((c) => c.name === prev.category)
          return cat?.subtopics.includes(prev.subtopic) ? prev : { kind: 'inbox' }
        }
        return prev
      })
      return result
    },
    [mutateTopic, refreshSources],
  )

  const handleOpenPage = useCallback(
    async (pageId: string) => {
      const page = await getPage(pageId)
      setSelectedPage(page)
      setIsDetailOpen(page !== null)
      setIsEditing(false)
    },
    [getPage],
  )

  const handleStartEdit = useCallback(() => {
    if (!selectedPage) return
    setEditTitle(selectedPage.title)
    setEditDraft(selectedPage.contentMd)
    setIsEditing(true)
  }, [selectedPage])

  const handleSaveEdit = useCallback(async () => {
    if (!selectedPage) return
    const updated = await updatePage(selectedPage.path, editTitle, editDraft)
    if (updated) {
      setSelectedPage(updated)
      setIsEditing(false)
      void refreshPages()
    }
  }, [selectedPage, editTitle, editDraft, updatePage, refreshPages])

  const requestDeletePage = useCallback(async () => {
    if (!selectedPage) return
    const backlinks = await listBacklinks(selectedPage.id)
    setDeleteConfirm({ backlinks: backlinks.length })
  }, [selectedPage, listBacklinks])

  const handleConfirmDeletePage = useCallback(async () => {
    if (!selectedPage) return
    const ok = await deletePage(selectedPage.id)
    setDeleteConfirm(null)
    if (ok) {
      setSelectedPage(null)
      setIsDetailOpen(false)
      void refreshPages()
    }
  }, [selectedPage, deletePage, refreshPages])

  const handleRetry = useCallback(
    async (inboxId: string) => {
      await retryInbox(inboxId)
      void refreshInbox()
    },
    [retryInbox, refreshInbox],
  )

  const handleDiscard = useCallback(
    async (inboxId: string) => {
      await discardInbox(inboxId)
      void refreshInbox()
    },
    [discardInbox, refreshInbox],
  )

  /**
   * 主搜索框只检索资料层正文，历史页面检索留在「历史页面」视图内。
   */
  const handleSearch = useCallback(async () => {
    if (!query.trim()) {
      setSearchResults(null)
      setSearchDegradeReason(null)
      return
    }
    const result = await searchSources(query)
    setSearchResults(
      result.hits.map((hit) => ({
        id: hit.sourceId,
        title: hit.title,
        sourcePath: hit.sourcePath,
        mediaType: hit.mediaType,
        topicCategory: hit.category,
        topicSubtopic: hit.subtopic,
        textLength: 0,
        updatedAt: hit.updatedAt,
        useCount: 0,
      })),
    )
    setSearchDegradeReason(result.degradeReason)
  }, [query, searchSources])

  const handleClearSearch = useCallback(() => {
    setQuery('')
    setSearchResults(null)
    setSearchDegradeReason(null)
  }, [])

  /**
   * 在任务中心追踪索引重建，主内容保持当前页面不变。
   */
  const handleRebuildIndex = useCallback(() => {
    void taskCenter.wrapAsync('rebuild', '重建索引', rebuildIndex).catch(() => undefined)
  }, [rebuildIndex, taskCenter.wrapAsync])

  const handleRolledBack = useCallback(() => {
    if (!selectedPage) return
    void handleOpenPage(selectedPage.id)
  }, [selectedPage, handleOpenPage])

  /**
   * 打开资料详情预览（已归档资料走 source:get，待整理条目用快照）。
   */
  const handlePreviewSourceItem = useCallback((item: WikiSourceListItem) => {
    setSourcePreview({
      sourceId: item.id,
      snapshot: {
        title: item.title,
        summary: null,
        sourceUrl: null,
        sourcePath: item.sourcePath,
        mediaType: item.mediaType,
      },
    })
  }, [])

  /** 按 sourceId 打开资料详情（知识图谱节点等场景） */
  const handlePreviewSourceId = useCallback((sourceId: string) => {
    setSourcePreview({ sourceId, snapshot: null })
  }, [])

  /** 预览待整理队列条目（含网页资讯摘要与链接） */
  const handlePreviewInboxItem = useCallback((item: WikiInboxItem) => {
    setSourcePreview({ sourceId: null, snapshot: inboxItemToPreviewSnapshot(item) })
  }, [])

  const breadcrumb = nav.kind === 'category'
    ? nav.name
    : nav.kind === 'subtopic'
      ? `${nav.category} / ${nav.subtopic}`
      : null
  const currentContext = searchResults !== null
    ? { title: '搜索结果', subtitle: `共找到 ${searchResults.length} 个文件` }
    : breadcrumb
      ? { title: breadcrumb, subtitle: '该目录下的原始文件' }
      : FIXED_NAV_CONTEXT[nav.kind]

  return (
    <div className="wiki-tab">
      <WikiLeftNav
        active={isMoreMenuOpen ? { kind: 'more' } : nav}
        inboxCount={pendingCount}
        sectionCounts={sectionCounts}
        archivedCount={0}
        moreButtonRef={moreButtonRef}
        onSelect={handleSelectNav}
        onOpenMore={() => setIsMoreMenuOpen((open) => !open)}
      />
      <WikiMoreMenu
        open={isMoreMenuOpen}
        anchorRef={moreButtonRef}
        onClose={() => setIsMoreMenuOpen(false)}
        onGraph={() => handleSelectNav({ kind: 'graph' })}
        onSection={(name) => handleSelectNav({ kind: 'section', name: name as WikiNavSection })}
        onHistory={() => handleSelectNav({ kind: 'history' })}
        onCleanup={() => handleSelectNav({ kind: 'cleanup' })}
        onSynthesis={() => handleSelectNav({ kind: 'synthesis' })}
        onRebuild={handleRebuildIndex}
        onEditTopicTree={() => setIsTreeEditorOpen(true)}
        onReclassifyAll={() => setReclassifyConfirm({ count: filedSourceCount })}
      />

      <ConfirmModal
        open={consolidateConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="整合短文"
        content={`将 ${consolidateConfirm?.count ?? 0} 篇资料合并为一篇长文，数量较多、耗时较长，确定继续？`}
        confirmText="继续"
        onConfirm={() => {
          const pending = consolidateConfirm
          setConsolidateConfirm(null)
          if (pending) void runConsolidate(pending.sourceIds, true)
        }}
        onCancel={() => setConsolidateConfirm(null)}
      />

      <ConfirmModal
        open={synthesisConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="生成综述"
        content={`本次将合成 ${synthesisConfirm?.count ?? 0} 个文件，数量较多、耗时较长，确定继续？`}
        confirmText="继续"
        onConfirm={() => {
          setSynthesisConfirm(null)
          void handleSynthesizeSelected(true)
        }}
        onCancel={() => setSynthesisConfirm(null)}
      />

      <ConfirmModal
        open={reclassifyConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="全库重新编目"
        content={`将扫描 ${reclassifyConfirm?.count ?? 0} 个已归档文件，不会改临时存放。AI 只给建议，接受后才生效。`}
        confirmText="开始"
        onCancel={() => setReclassifyConfirm(null)}
        onConfirm={() => {
          setReclassifyConfirm(null)
          void handleRunReclassify({ kind: 'all' }, { force: true })
        }}
      />

      <WikiTopicTreeEditor
        open={isTreeEditorOpen}
        tree={topicTree}
        topicCounts={topicCounts}
        onMutate={handleMutateTopic}
        onClose={() => setIsTreeEditorOpen(false)}
      />

      <div className="wiki-tab-right">
        <WikiTopBar
          title={currentContext.title}
          subtitle={currentContext.subtitle}
          query={query}
          onQueryChange={setQuery}
          onSearch={() => void handleSearch()}
          onClearSearch={handleClearSearch}
          pillText={taskCenter.pillText}
          pillTone={taskCenter.pillTone}
          onOpenTasks={handleOpenTaskCenter}
        />

        <main className="wiki-tab-content">
          {loading && !selectedPage && (
            <div className="wiki-loading">
              <Loading text="加载中..." />
            </div>
          )}
          {openError && (
            <p className="wiki-open-error" role="alert">
              {openError}
            </p>
          )}
        {searchResults !== null ? (
          <div className="wiki-search-results">
            <h3>搜索结果（{searchResults.length}）</h3>
            {searchDegradeReason && (
              <p className="wiki-search-degrade" role="status">
                {searchDegradeReason}
              </p>
            )}
            <WikiFileList
              items={searchResults}
              emptyHint="未找到相关文件"
              showTopic
              showMediaChips={false}
              onOpen={(item) => void handleOpenSource(item)}
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
              onPark={(item) => void handlePark(item)}
            />
          </div>
        ) : nav.kind === 'inbox' ? (
          <div className="wiki-inbox-view">
            <h3>待整理（{pendingCount}）</h3>
            {inboxItems.length < inboxPending && (
              <p className="wiki-empty-hint">仅显示最近 {inboxItems.length} 条</p>
            )}
            <WikiInboxPanel
              items={inboxItems}
              unfiled={unfiledSources}
              onRetry={(inboxId) => void handleRetry(inboxId)}
              onDiscard={(inboxId) => void handleDiscard(inboxId)}
              onOrganize={(item) => setPicker({ mode: 'inbox', item })}
              onFileUnfiled={(item) => setPicker({ mode: 'source', item })}
              onPreviewInbox={handlePreviewInboxItem}
              onPreviewSource={handlePreviewSourceItem}
            />
          </div>
        ) : nav.kind === 'parking' ? (
          <div className="wiki-parking-view">
            <h3>临时存放（{parkingSources.length}）</h3>
            <WikiFileList
              items={parkingSources}
              emptyHint="临时存放里还没有文件。"
              moveLabel="移出"
              showParkAction={false}
              onOpen={(item) => void handleOpenSource(item)}
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
            />
          </div>
        ) : nav.kind === 'cleanup' ? (
          <CleanupView
            cleanupScan={trackedCleanupScan}
            archiveSources={trackedArchiveSources}
            restoreSources={trackedRestoreSources}
            deleteSources={trackedDeleteSources}
            moveToParking={handleParkMany}
            statusScan={statusScan}
            confirmStatus={confirmStatus}
          />
        ) : nav.kind === 'synthesis' ? (
          <SynthesisView
            pages={pages}
            autoRunSynthesis={trackedAutoRunSynthesis}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            onRefreshPages={refreshPages}
            synthesisRows={synthesisRows}
            topicTree={topicTree}
            consolidateTarget={consolidateTarget}
            onAcceptSynthesis={(id, category, subtopic, archiveSources) =>
              void handleAcceptSynthesis(id, category, subtopic, archiveSources)
            }
            onRejectSynthesis={(id) => void handleRejectSynthesis(id)}
            onRefreshSyntheses={refreshSynthesisRows}
          />
        ) : nav.kind === 'history' ? (
          <div className="wiki-page-list-view">
            <h3>历史页面（{pages.length}）</h3>
            {pages.length === 0 ? (
              <p className="wiki-empty-hint">没有历史摘要页面。新归档的文件请用左侧目录浏览。</p>
            ) : (
              <WikiPageList
                pages={pages}
                selectedPageId={selectedPage?.id ?? null}
                onOpen={(pageId) => void handleOpenPage(pageId)}
              />
            )}
          </div>
        ) : nav.kind === 'reclassify' ? (
          <WikiReclassifyView
            run={reclassifyRun}
            onApply={(ids) => void handleApplyReclassify(ids)}
            onIgnore={(id) => void handleIgnoreReclassify(id)}
            onDiscard={() => void handleDiscardReclassify()}
          />
        ) : nav.kind === 'graph' ? (
          <WikiGraphView
            currentNav={nav}
            getGraphData={getGraphData}
            extractEroFromSources={async (scope) => {
              const result = await taskCenter.wrapAsync('graph', '抽取实体关系', () =>
                extractEroFromSources(scope),
              )
              return result
            }}
            listEntitySources={listEntitySources}
            openSource={openSource}
            onPreviewSource={handlePreviewSourceId}
            onNavigateTo={setNav}
            runLongTask={(title, fn) => taskCenter.wrapAsync('graph', title, fn)}
          />
        ) : (
          <div className="wiki-file-list-view">
            <h3>{breadcrumb}（{visibleSources.length}）</h3>
            {(nav.kind === 'subtopic' || nav.kind === 'category') &&
              shortInViewCount >= CONSOLIDATE_HINT_MIN_COUNT && (
              <div className="wiki-consolidate-hint">
                <p>
                  检测到 {shortInViewCount} 篇短文，可整合为一篇 1000 字以上的长文，减少目录碎片化。
                </p>
                <Button variant="secondary" size="sm" onClick={() => void handleConsolidateAllShort()}>
                  整合全部短文
                </Button>
              </div>
            )}
            <WikiFileList
              items={visibleSources}
              emptyHint={nav.kind === 'subtopic' ? '这个小类下还没有文件' : '这个大类下还没有文件'}
              showTopic={nav.kind === 'category'}
              highlightId={highlightSourceId}
              selectable
              selectedIds={selectedSourceIds}
              onToggleSelect={toggleSelectSource}
              onToggleSelectAll={toggleSelectAllSources}
              headerActions={
                selectedSourceIds.size > 0 ? (
                  <>
                    <span className="wiki-file-list-batch-count">
                      已选 {selectedSourceIds.size} 项
                    </span>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={selectedSourceIds.size < CONSOLIDATE_MIN_SELECTION}
                      onClick={() => void handleConsolidateSelected()}
                    >
                      整合为长文
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleSynthesizeSelected()}
                    >
                      生成本组综述
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setBatchPickerOpen(true)}>
                      移动到…
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void handleParkSelected()}>
                      存到临时存放
                    </Button>
                  </>
                ) : nav.kind === 'subtopic' ? (
                  <>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void handleCreateNote(nav.category, nav.subtopic)}
                    >
                      新建笔记
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void handleRunReclassify(
                          { kind: 'subtopic', category: nav.category, subtopic: nav.subtopic },
                          { force: true },
                        )
                      }
                    >
                      重新编目本小类
                    </Button>
                  </>
                ) : undefined
              }
              onOpen={(item) => void handleOpenSource(item)}
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
              onPark={(item) => void handlePark(item)}
            />
          </div>
        )}
          <WikiSourceDetailDrawer
            open={sourcePreview !== null}
            sourceId={sourcePreview?.sourceId ?? null}
            snapshot={sourcePreview?.snapshot ?? null}
            getSource={getSource}
            onClose={() => setSourcePreview(null)}
            onOpenExternal={(detail) => {
              void openSource(detail.id).catch((error) => {
                setOpenError(error instanceof Error ? error.message : '无法打开原文件')
              })
            }}
          />
          <WikiDetailDrawer
            open={isDetailOpen}
            page={selectedPage}
            pages={pages}
            isEditing={isEditing}
            editTitle={editTitle}
            editDraft={editDraft}
            onEditTitleChange={setEditTitle}
            onEditDraftChange={setEditDraft}
            onStartEdit={handleStartEdit}
            onCancelEdit={() => setIsEditing(false)}
            onSaveEdit={() => void handleSaveEdit()}
            onRequestDelete={() => void requestDeletePage()}
            onClose={() => {
              setIsDetailOpen(false)
              setIsEditing(false)
            }}
            listBacklinks={listBacklinks}
            listRevisions={listRevisions}
            rollbackPage={rollbackPage}
            onOpenPage={(pageId) => void handleOpenPage(pageId)}
            onRolledBack={handleRolledBack}
          />
          <WikiTaskCenter
            open={isTaskCenterOpen}
            tasks={taskCenter.tasks}
            onClose={() => setIsTaskCenterOpen(false)}
            onRetry={(task) => void handleRetryTask(task)}
            onDismiss={taskCenter.dismissTask}
          />
        </main>
      </div>

      <WikiTopicPicker
        open={isBatchPickerOpen}
        tree={topicTree}
        title="批量移动到…"
        itemTitle={`已选 ${selectedSourceIds.size} 个文件`}
        onCancel={() => setBatchPickerOpen(false)}
        onConfirm={(category, subtopic) => {
          setBatchPickerOpen(false)
          void handleMoveSelected(category, subtopic)
        }}
      />

      <WikiTopicPicker
        open={picker !== null}
        tree={topicTree}
        itemTitle={picker?.item.title}
        onCancel={() => {
          setPicker(null)
          setSuggestion(null)
          setSuggestionState('idle')
        }}
        onConfirm={(category, subtopic) => void handleConfirmPicker(category, subtopic)}
        // 只有已进资料层的文件能让 AI 建议：inbox 条目还没 source id
        onRequestSuggestion={
          picker?.mode === 'source' ? () => void handleRequestSuggestion(picker.item.id) : undefined
        }
        suggestion={suggestion}
        suggestionState={suggestionState}
        onAdoptSuggestion={
          suggestion
            ? () => void handleConfirmPicker(suggestion.category, suggestion.subtopic)
            : undefined
        }
      />

      <ConfirmModal
        open={deleteConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="删除页面"
        content={
          deleteConfirm && deleteConfirm.backlinks > 0
            ? `删除后，${deleteConfirm.backlinks} 处指向此页的链接将变为未解析。修订历史仍会保留在数据库中。`
            : '删除后修订历史仍会保留在数据库中，但页面不再可见。'
        }
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={() => void handleConfirmDeletePage()}
        onCancel={() => setDeleteConfirm(null)}
      />
    </div>
  )
}

export default WikiTab
