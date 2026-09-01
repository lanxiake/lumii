/**
 * WikiTab — Wiki 知识库工作区
 *
 * 左栏承载用途目录树与固定入口，顶栏统一承载搜索、当前目录上下文与任务进度，
 * 主内容区按用途目录展示原始文件。历史摘要页面已随 P3 删除。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { PARKING_CATEGORY, wikiRecordsShareFileIdentity } from '@mtbot/agent-runtime/browser'
import { Button } from '../../../components/ui/Button/Button'
import { Loading } from '../../../components/ui/Loading/Loading'
import { Tooltip } from '../../../components/ui/Tooltip/Tooltip'
import { useToast } from '../../../components/ui/Toast/useToast'
import { ConfirmModal, Modal } from '../../../components/ui/Modal'
import {
  useWikiPage,
  type WikiInboxItem,
  type WikiSourceListItem,
  type WikiTopicMutation,
  type WikiTopicTree,
  type WikiReclassifyRunItem,
  type WikiReclassifyScopeDto,
  type WikiReclassifyEstimateItem,
} from '../../../hooks/business/useWikiPage'
import { CleanupView } from './CleanupView'
import { WikiGraphView } from './WikiGraphView'
import { WikiLeftNav, topicCountKey, type WikiNav } from './WikiLeftNav'
import { navSectionLabel } from './wikiTopicDisplay'
import { WikiTopBar } from './WikiTopBar'
import { WikiFileList } from './WikiFileList'
import { WikiTopicPicker } from './WikiTopicPicker'
import { WikiTopicTreeEditor } from './WikiTopicTreeEditor'
import { WikiReclassifyView } from './WikiReclassifyView'
import { WikiInboxPanel, inboxItemToPreviewSnapshot } from './WikiInboxPanel'
import { WikiSubtopicPanel } from './WikiSubtopicPanel'
import { isUrlSourceItem } from './wikiSourcePreview'
import { WikiHelpDrawer } from './WikiHelpDrawer'
import { consumeWikiInitNav, OPEN_MEMORIES_TAB_EVENT } from '../../../utils/open-wiki-library'
import { WIKI_INBOX_INTRO, WIKI_FOLDER_IMPORT_TOOLTIP } from './wikiTooltips'
import { WikiMoreMenu } from './WikiMoreMenu'
import { WikiSourceDetailDrawer, type WikiSourcePreviewSnapshot } from './WikiSourceDetailDrawer'
import { WIKI_MODAL_LAYER } from './wikiModalLayer'
import { buildWikiBreadcrumbs } from './wikiBreadcrumbs'
import { buildWikiRemoveConfirmContent } from './wikiRemoveConfirm'
import { WikiTaskCenter } from './WikiTaskCenter'
import { useWikiTaskCenter, type WikiLocalTask } from './useWikiTaskCenter'
import './WikiTab.css'

/** 归档选择器的目标：inbox 队列条目，或已进资料层但待补分/需要移动的文件 */
type PickerTarget =
  | { mode: 'inbox'; item: WikiInboxItem }
  | { mode: 'source'; item: WikiSourceListItem }

/**
 * 未分类行是否与已归入用途目录（含收藏）的资料指向同一文件。
 */
function isUnfiledDuplicateOfFiled(
  item: WikiSourceListItem,
  filed: readonly WikiSourceListItem[],
): boolean {
  return filed.some((other) =>
    wikiRecordsShareFileIdentity(
      { title: item.title, sourcePath: item.sourcePath },
      { title: other.title, sourcePath: other.sourcePath },
    ),
  )
}

const FIXED_NAV_CONTEXT: Record<string, { title: string; subtitle: string }> = {
  inbox: { title: '收件箱', subtitle: '还没分类的新资料，可批量归档或稍后处理' },
  archived: { title: '已归档', subtitle: '已移出活跃目录、可随时恢复的资料' },
  parking: { title: '临时存放', subtitle: '你主动搁置、暂不进入正式目录的文件' },
  graph: { title: '知识图谱', subtitle: '浏览页面与实体之间的关系' },
  cleanup: { title: '清理', subtitle: '扫描并处理需要维护的资料' },
  reclassify: { title: '重新编目', subtitle: 'AI 的目录调整建议，接受后才生效' },
}

/**
 * 渲染 Wiki 工作区并协调用途目录、文件列表与归档选择器。
 */
export const WikiTab: React.FC = () => {
  const toast = useToast()
  const {
    listInbox,
    countInbox,
    retryInbox,
    discardInbox,
    organizeInbox,
    scanFolder,
    importFolder,
    runOrganize,
    listRuns,
    rebuildIndex,
    cleanupScan,
    archiveSources,
    restoreSources,
    deleteSources,
    getGraphData,
    loadTopicTree,
    mutateTopic,
    createNote,
    runReclassify,
    estimateReclassify,
    getReclassifyRun,
    applyReclassify,
    ignoreReclassify,
    discardReclassify,
    listSources,
    updateSourceTopic,
    moveToParking,
    openSource,
    getSource,
    searchSources,
    ensureVaultLayout,
    extractEroFromSources,
    listEntitySources,
    loadAutoClassifySetting,
    setAutoClassifyEnabled,
    loading,
  } = useWikiPage()
  const taskCenter = useWikiTaskCenter()

  const [nav, setNav] = useState<WikiNav>({ kind: 'inbox' })
  const [topicTree, setTopicTree] = useState<WikiTopicTree | null>(null)
  const [sources, setSources] = useState<readonly WikiSourceListItem[]>([])
  const [archivedSources, setArchivedSources] = useState<readonly WikiSourceListItem[]>([])
  const [archivedCount, setArchivedCount] = useState(0)
  const [inboxItems, setInboxItems] = useState<readonly WikiInboxItem[]>([])
  const [inboxPending, setInboxPending] = useState(0)
  const [query, setQuery] = useState('')
  const [searchResults, setSearchResults] = useState<readonly WikiSourceListItem[] | null>(null)
  const [searchDegradeReason, setSearchDegradeReason] = useState<string | null>(null)
  const [removeConfirm, setRemoveConfirm] = useState<{
    inboxIds: readonly string[]
    sourceIds: readonly string[]
  } | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerTarget | null>(null)
  const [isTaskCenterOpen, setIsTaskCenterOpen] = useState(false)
  const [isMoreMenuOpen, setIsMoreMenuOpen] = useState(false)
  const [folderImportBusy, setFolderImportBusy] = useState(false)
  const [aiClassifyBusy, setAiClassifyBusy] = useState(false)
  const [autoClassifyEnabled, setAutoClassifyEnabledState] = useState(false)
  const [isTreeEditorOpen, setIsTreeEditorOpen] = useState(false)
  const [reclassifyRun, setReclassifyRun] = useState<WikiReclassifyRunItem | null>(null)
  const [reclassifyConfirm, setReclassifyConfirm] = useState<{
    count: number
    estimate: WikiReclassifyEstimateItem | null
  } | null>(null)
  const [reclassifyEnableRename, setReclassifyEnableRename] = useState(false)
  const [suggestion, setSuggestion] = useState<{
    category: string
    subtopic: string | null
    reason: string
  } | null>(null)
  const [suggestionState, setSuggestionState] = useState<'idle' | 'loading' | 'failed'>('idle')
  const [highlightSourceId, setHighlightSourceId] = useState<string | null>(null)
  const [selectedSourceIds, setSelectedSourceIds] = useState<ReadonlySet<string>>(new Set())
  const [isBatchPickerOpen, setBatchPickerOpen] = useState(false)
  const [isInboxBatchPickerOpen, setInboxBatchPickerOpen] = useState(false)
  const [isHelpOpen, setHelpOpen] = useState(false)
  const [selectedInboxIds, setSelectedInboxIds] = useState<ReadonlySet<string>>(new Set())
  const [selectedUnfiledIds, setSelectedUnfiledIds] = useState<ReadonlySet<string>>(new Set())
  const [sourcePreview, setSourcePreview] = useState<{
    sourceId: string | null
    snapshot: WikiSourcePreviewSnapshot | null
  } | null>(null)
  const moreButtonRef = useRef<HTMLButtonElement>(null)
  const selectedInboxIdsRef = useRef(selectedInboxIds)
  const selectedUnfiledIdsRef = useRef(selectedUnfiledIds)
  const selectedSourceIdsRef = useRef(selectedSourceIds)

  selectedInboxIdsRef.current = selectedInboxIds
  selectedUnfiledIdsRef.current = selectedUnfiledIds
  selectedSourceIdsRef.current = selectedSourceIds

  const refreshSources = useCallback(async () => {
    setSources(await listSources({}))
  }, [listSources])

  /** 按需拉取已归档资料，供归档分区与左栏角标使用。 */
  const refreshArchivedSources = useCallback(async () => {
    const items = await listSources({ archived: true })
    setArchivedSources(items)
    setArchivedCount(items.length)
    return items
  }, [listSources])

  const refreshInbox = useCallback(async () => {
    const [all, count] = await Promise.all([listInbox('pending'), countInbox('pending')])
    setInboxItems(all)
    setInboxPending(count)
  }, [listInbox, countInbox])

  useEffect(() => {
    void loadTopicTree().then(setTopicTree)
    void refreshSources()
    void refreshInbox()
    void ensureVaultLayout()
    void loadAutoClassifySetting().then(setAutoClassifyEnabledState)
  }, [loadTopicTree, refreshSources, refreshInbox, ensureVaultLayout, loadAutoClassifySetting])

  /** 切换 Wiki「AI 自动分类」开关并持久化。 */
  const handleAutoClassifyChange = useCallback(
    async (enabled: boolean) => {
      const prev = autoClassifyEnabled
      setAutoClassifyEnabledState(enabled)
      const ok = await setAutoClassifyEnabled(enabled)
      if (!ok) {
        setAutoClassifyEnabledState(prev)
        toast.error('保存设置失败，请稍后重试')
        return
      }
      toast.success(
        enabled
          ? '已开启 AI 自动分类，正在整理收件箱中的文件'
          : '已关闭 AI 自动分类，新资料将留在收件箱',
      )
      if (enabled) {
        window.setTimeout(() => {
          void Promise.all([refreshInbox(), refreshSources()])
        }, 2500)
        window.setTimeout(() => {
          void Promise.all([refreshInbox(), refreshSources()])
        }, 12000)
      }
    },
    [autoClassifyEnabled, setAutoClassifyEnabled, toast, refreshInbox, refreshSources],
  )

  /** 外部入口要求打开待整理：首次挂载或 Hub 已打开时再次触发 */
  useEffect(() => {
    const applyWikiInitNav = (): void => {
      if (consumeWikiInitNav() === 'inbox') {
        setNav({ kind: 'inbox' })
      }
    }
    applyWikiInitNav()
    const onOpenWiki = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: string }>).detail?.tab
      if (tab === 'wiki') applyWikiInitNav()
    }
    window.addEventListener(OPEN_MEMORIES_TAB_EVENT, onOpenWiki)
    return () => window.removeEventListener(OPEN_MEMORIES_TAB_EVENT, onOpenWiki)
  }, [])

  /** 进入归档分区时按需拉取列表并同步左栏角标。 */
  useEffect(() => {
    if (nav.kind === 'archived') {
      void refreshArchivedSources()
    }
  }, [nav.kind, refreshArchivedSources])

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
    // v1.1：分区就是大类，key 直接用大类名，不再预置固定的六个槽位
    const sections: Record<string, number> = {}
    const counts: Record<string, number> = {}
    const parking: WikiSourceListItem[] = []
    const unfiled: WikiSourceListItem[] = []
    const filed = sources.filter(
      (item) => item.topicCategory !== null && item.topicCategory !== PARKING_CATEGORY,
    )
    for (const item of sources) {
      if (item.topicCategory === PARKING_CATEGORY) {
        parking.push(item)
        continue
      }
      if (!item.topicCategory) {
        if (!isUnfiledDuplicateOfFiled(item, filed)) unfiled.push(item)
        continue
      }
      sections[item.topicCategory] = (sections[item.topicCategory] ?? 0) + 1
      if (item.topicSubtopic) {
        const key = topicCountKey(item.topicCategory, item.topicSubtopic)
        counts[key] = (counts[key] ?? 0) + 1
      } else {
        // 小类为空 → 计入该大类的「未细分」分组（key 只含大类，与 repo 侧口径一致）
        const key = topicCountKey(item.topicCategory)
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
    // 分区即大类：section 与 category 两种 nav 现在是同一种过滤
    if (nav.kind === 'section') {
      return sources.filter((item) => item.topicCategory === nav.name)
    }
    if (nav.kind === 'category') {
      return sources.filter((item) => item.topicCategory === nav.name)
    }
    if (nav.kind === 'subtopic') {
      // subtopic 为 null → 该大类下未细分的那批
      return sources.filter(
        (item) =>
          item.topicCategory === nav.category &&
          (nav.subtopic === null ? !item.topicSubtopic : item.topicSubtopic === nav.subtopic),
      )
    }
    if (nav.kind === 'parking') {
      return parkingSources
    }
    return []
  }, [nav, sources, parkingSources])

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

  const handleSelectNav = useCallback((next: WikiNav) => {
    setNav(next)
    setIsMoreMenuOpen(false)
    setSearchResults(null)
    setOpenError(null)
    // 换目录必须清选中：否则批量动作会作用到上一个目录里已看不见的文件
    setSelectedSourceIds(new Set())
    setSelectedInboxIds(new Set())
    setSelectedUnfiledIds(new Set())
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
    setSelectedSourceIds((prev) => {
      const allVisibleSelected =
        visibleSources.length > 0 && visibleSources.every((item) => prev.has(item.id))
      return allVisibleSelected
        ? new Set()
        : new Set(visibleSources.map((item) => item.id))
    })
  }, [visibleSources])

  /**
   * 打开资料详情预览（已归档资料走 source:get，待整理条目用快照）。
   */
  const handlePreviewSourceItem = useCallback((item: WikiSourceListItem) => {
    const isUrl = isUrlSourceItem(item.sourcePath)
    setSourcePreview({
      sourceId: item.id,
      snapshot: {
        title: item.title,
        summary: null,
        sourceUrl: isUrl ? item.sourcePath : null,
        sourcePath: isUrl ? null : item.sourcePath,
        mediaType: item.mediaType,
      },
    })
  }, [])

  /**
   * 单条资料移入已归档冷存储（「移到…」选已归档分区）。
   */
  const handleArchivePickerTarget = useCallback(async () => {
    const target = picker
    setPicker(null)
    setSuggestion(null)
    setSuggestionState('idle')
    if (!target || target.mode !== 'source') return
    await trackedArchiveSources([target.item.id])
    await Promise.all([refreshSources(), refreshArchivedSources()])
  }, [picker, trackedArchiveSources, refreshSources, refreshArchivedSources])

  const handleConfirmPicker = useCallback(
    async (category: string, subtopic: string | null) => {
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
      toast.info('已移至左栏「临时存放」')
    },
    [moveToParking, refreshSources, toast],
  )

  /** 从归档分区恢复资料到活跃目录。 */
  const handleRestoreArchived = useCallback(
    async (item: WikiSourceListItem) => {
      await trackedRestoreSources([item.id])
      await Promise.all([refreshSources(), refreshArchivedSources()])
    },
    [trackedRestoreSources, refreshSources, refreshArchivedSources],
  )




  /** 批量移动：逐条走确定性写入路径 */
  const handleMoveSelected = useCallback(
    async (category: string, subtopic: string | null) => {
      for (const id of selectedSourceIds) {
        await updateSourceTopic(id, category, subtopic)
      }
      setSelectedSourceIds(new Set())
      await refreshSources()
    },
    [selectedSourceIds, updateSourceTopic, refreshSources],
  )

  /** 批量移入已归档冷存储 */
  const handleArchiveSelected = useCallback(async () => {
    const ids = [...selectedSourceIdsRef.current]
    if (ids.length === 0) return
    await trackedArchiveSources(ids)
    setSelectedSourceIds(new Set())
    setBatchPickerOpen(false)
    await Promise.all([refreshSources(), refreshArchivedSources()])
  }, [trackedArchiveSources, refreshSources, refreshArchivedSources])

  const handleParkSelected = useCallback(async () => {
    const ids = [...selectedSourceIds]
    if (ids.length === 0) return
    for (const id of ids) {
      await moveToParking(id)
    }
    setSelectedSourceIds(new Set())
    await refreshSources()
    toast.info(`已将 ${ids.length} 项移至左栏「临时存放」`)
  }, [selectedSourceIds, moveToParking, refreshSources, toast])

  /** 逐条移到临时存放，返回成功条数（清理视图的批量动作用） */
  const handleParkMany = useCallback(
    async (sourceIds: readonly string[]): Promise<number> => {
      let moved = 0
      for (const id of sourceIds) {
        if (await moveToParking(id)) moved += 1
      }
      await refreshSources()
      if (moved > 0) {
        toast.info(`已将 ${moved} 项移至左栏「临时存放」`)
      }
      return moved
    },
    [moveToParking, refreshSources, toast],
  )

  /**
   * 启动重新编目并跳到候选视图。
   * running 期间轮询进度；已有待审阅批次时后端会拒绝，这里把中文原因抛给任务中心。
   */
  const handleRunReclassify = useCallback(
    async (scope: WikiReclassifyScopeDto, opts?: { force?: boolean; enableRename?: boolean }) => {
      setNav({ kind: 'reclassify' })
      const taskId = taskCenter.startTask({ kind: 'reclassify', title: '重新编目' })
      const started = await runReclassify(scope, opts)
      if (!started.ok) {
        taskCenter.failTask(taskId, started.error)
        setReclassifyRun(await getReclassifyRun())
        return
      }
      for (;;) {
        const run = await getReclassifyRun()
        setReclassifyRun(run)
        if (!run || run.status !== 'running') {
          if (run?.status === 'failed') {
            taskCenter.failTask(taskId, run.error ?? '重新编目失败')
          } else {
            taskCenter.completeTask(taskId, {
              detail: run ? `${run.candidates.length} 条建议` : undefined,
            })
          }
          return
        }
        await new Promise((resolve) => window.setTimeout(resolve, 400))
      }
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
    async (category: string, subtopic: string | null) => {
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
   * run 启动后立刻返回 running，必须等到 review/failed 再读候选。
   * 拿到就 discard——单文件建议用完即弃，不能长期占住「同时只允许一个批次」的槽位。
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
      let run = await getReclassifyRun()
      while (run?.status === 'running') {
        await new Promise((resolve) => window.setTimeout(resolve, 400))
        run = await getReclassifyRun()
      }
      const first = run?.status === 'failed' ? undefined : run?.candidates[0]
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
          // subtopic 为 null 是「未细分」分组，只要大类还在就有效
          if (prev.subtopic === null) return cat ? prev : { kind: 'inbox' }
          return cat?.subtopics.includes(prev.subtopic) ? prev : { kind: 'inbox' }
        }
        return prev
      })
      return result
    },
    [mutateTopic, refreshSources],
  )

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

  /** 打开删除确认：已入库资料走永久删除，队列条目走丢弃 */
  const requestRemove = useCallback(
    (opts: { inboxIds?: readonly string[]; sourceIds?: readonly string[] }) => {
      const inboxIds = opts.inboxIds ?? []
      const sourceIds = opts.sourceIds ?? []
      if (inboxIds.length === 0 && sourceIds.length === 0) return
      setRemoveConfirm({ inboxIds, sourceIds })
    },
    [],
  )

  /** 确认删除/丢弃所选资料 */
  const handleConfirmRemove = useCallback(async () => {
    if (!removeConfirm) return
    const { inboxIds, sourceIds } = removeConfirm
    setRemoveConfirm(null)

    let discarded = 0
    for (const id of inboxIds) {
      if (await discardInbox(id)) discarded += 1
    }

    let deleted = 0
    if (sourceIds.length > 0) {
      deleted = await trackedDeleteSources(sourceIds)
    }

    setSelectedInboxIds(new Set())
    setSelectedUnfiledIds(new Set())
    setSelectedSourceIds(new Set())
    await Promise.all([refreshInbox(), refreshSources(), refreshArchivedSources()])

    const parts: string[] = []
    if (discarded > 0) parts.push(`已移除 ${discarded} 条队列条目`)
    if (deleted > 0) parts.push(`已删除 ${deleted} 条资料`)
    if (parts.length > 0) toast.success(parts.join('，'))
  }, [
    removeConfirm,
    discardInbox,
    trackedDeleteSources,
    refreshInbox,
    refreshSources,
    refreshArchivedSources,
    toast,
  ])

  /**
   * 选择文件夹并批量导入 Wiki 收件箱（scan 预览 → 确认 → import → intake）。
   */
  const handleImportFromFolder = useCallback(async () => {
    const dialog = window.electronAPI?.dialog
    if (!dialog?.showOpenDialog) {
      toast.error('当前环境不支持文件夹选择')
      return
    }
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择要导入 Wiki 的文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return

    const dir = result.filePaths[0]!
    setFolderImportBusy(true)
    try {
      const preview = await scanFolder(dir, true)
      if (!preview) {
        toast.error('扫描文件夹失败，请检查路径是否在允许范围内')
        return
      }
      const { importable, skipped, alreadyInWiki } = preview.summary
      if (importable === 0) {
        toast.info(
          alreadyInWiki > 0
            ? `该目录 ${preview.summary.total} 个文件均已在 Wiki 中或不可导入`
            : '该目录没有可导入的文件',
        )
        return
      }
      const ok = window.confirm(
        `在「${dir}」中找到 ${importable} 个可导入文件` +
          (skipped > 0 ? `（跳过 ${skipped} 个）` : '') +
          (alreadyInWiki > 0 ? `，${alreadyInWiki} 个已在 Wiki` : '') +
          (autoClassifyEnabled
            ? '。导入后将由 AI 自动分类归档（依据目录结构、已有分类与文件内容）。是否继续？'
            : '。将导入到「收件箱」，不自动分类（可在左栏「更多」开启 AI 自动分类）。是否继续？'),
      )
      if (!ok) return

      const imported = await importFolder(dir, {
        recursive: true,
        autoClassify: autoClassifyEnabled,
      })
      if (!imported || imported.imported === 0) {
        toast.error('导入失败，请稍后重试')
        return
      }
      setNav({ kind: 'inbox' })
      await Promise.all([refreshInbox(), refreshSources()])
      const orgSummary = imported.organizeRun?.summary
      if (autoClassifyEnabled && orgSummary && /\d+\s*项已归档/.test(orgSummary)) {
        toast.success(
          `已导入 ${imported.imported} 个文件 · ${orgSummary}。请在左侧「工作 / 学习 / 生活 / 收藏」查看。`,
        )
      } else if (orgSummary) {
        toast.success(`已导入 ${imported.imported} 个文件 · ${orgSummary}`)
      } else {
        toast.success(`已导入 ${imported.imported} 个文件到收件箱`)
      }
    } finally {
      setFolderImportBusy(false)
    }
  }, [scanFolder, importFolder, refreshInbox, refreshSources, toast, autoClassifyEnabled])

  /** 切换待整理队列条目选中状态 */
  const toggleSelectInbox = useCallback((inboxId: string) => {
    setSelectedInboxIds((prev) => {
      const next = new Set(prev)
      if (next.has(inboxId)) next.delete(inboxId)
      else next.add(inboxId)
      return next
    })
  }, [])

  /** 切换待补分资料选中状态 */
  const toggleSelectUnfiled = useCallback((sourceId: string) => {
    setSelectedUnfiledIds((prev) => {
      const next = new Set(prev)
      if (next.has(sourceId)) next.delete(sourceId)
      else next.add(sourceId)
      return next
    })
  }, [])

  /** 全选/取消全选待整理视图全部条目 */
  const toggleSelectAllInbox = useCallback(() => {
    const total = inboxItems.length + unfiledSources.length
    const selected = selectedInboxIds.size + selectedUnfiledIds.size
    if (selected === total && total > 0) {
      setSelectedInboxIds(new Set())
      setSelectedUnfiledIds(new Set())
      return
    }
    setSelectedInboxIds(new Set(inboxItems.map((item) => item.id)))
    setSelectedUnfiledIds(new Set(unfiledSources.map((item) => item.id)))
  }, [inboxItems, unfiledSources, selectedInboxIds.size, selectedUnfiledIds.size])

  /**
   * 批量归档：队列条目走 organizeInbox，待补分走 updateSourceTopic。
   */
  const handleBatchOrganizeInbox = useCallback(
    async (category: string, subtopic: string | null) => {
      const inboxIds = [...selectedInboxIdsRef.current]
      const unfiledIds = [...selectedUnfiledIdsRef.current]
      for (const id of inboxIds) {
        await organizeInbox(id, category, subtopic)
      }
      for (const id of unfiledIds) {
        await updateSourceTopic(id, category, subtopic)
      }
      setSelectedInboxIds(new Set())
      setSelectedUnfiledIds(new Set())
      await Promise.all([refreshInbox(), refreshSources()])
    },
    [organizeInbox, updateSourceTopic, refreshInbox, refreshSources],
  )

  /**
   * 对勾选（或全部）收件箱条目做 AI 分类归档。
   */
  const handleAiClassifyInbox = useCallback(async () => {
    const hasSelection = selectedInboxIdsRef.current.size + selectedUnfiledIdsRef.current.size > 0
    const inboxIds = hasSelection
      ? [...selectedInboxIdsRef.current]
      : inboxItems.map((item) => item.id)
    const sourceIds = hasSelection
      ? [...selectedUnfiledIdsRef.current]
      : unfiledSources.map((item) => item.id)
    if (inboxIds.length === 0 && sourceIds.length === 0) {
      toast.info('收件箱没有可分类的文件')
      return
    }
    setAiClassifyBusy(true)
    try {
      const result = await taskCenter.wrapAsync('archive', 'AI 分类收件箱', () =>
        runOrganize({ inboxIds, sourceIds }),
      )
      setSelectedInboxIds(new Set())
      setSelectedUnfiledIds(new Set())
      await Promise.all([refreshInbox(), refreshSources()])
      if (result?.summary) toast.success(result.summary)
      else toast.info('没有可分类的条目')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 分类失败')
    } finally {
      setAiClassifyBusy(false)
    }
  }, [inboxItems, unfiledSources, runOrganize, refreshInbox, refreshSources, toast, taskCenter])

  /** 批量重试所选可重试的 inbox 条目 */
  const handleBatchRetryInbox = useCallback(async () => {
    const selected = selectedInboxIdsRef.current
    for (const item of inboxItems) {
      if (!selected.has(item.id)) continue
      if (item.status === 'pending' || item.status === 'failed') {
        await retryInbox(item.id)
      }
    }
    setSelectedInboxIds(new Set())
    void refreshInbox()
  }, [inboxItems, retryInbox, refreshInbox])

  /** 批量删除待整理所选：队列丢弃 + 已入库资料永久删除 */
  const handleBatchDeleteInbox = useCallback(() => {
    requestRemove({
      inboxIds: [...selectedInboxIdsRef.current],
      sourceIds: [...selectedUnfiledIdsRef.current],
    })
  }, [requestRemove])

  /** 删除单条已入库资料（含待补分与已分类） */
  const handleDeleteSource = useCallback(
    (item: WikiSourceListItem) => {
      requestRemove({ sourceIds: [item.id] })
    },
    [requestRemove],
  )

  /** 批量删除小类视图等多选资料 */
  const handleDeleteSelectedSources = useCallback(() => {
    requestRemove({ sourceIds: [...selectedSourceIdsRef.current] })
  }, [requestRemove])

  /** 一键重试全部可重试的 inbox 条目 */
  const handleRetryAllInbox = useCallback(async () => {
    for (const item of inboxItems) {
      if (item.status === 'pending' || item.status === 'failed') {
        await retryInbox(item.id)
      }
    }
    void refreshInbox()
  }, [inboxItems, retryInbox, refreshInbox])

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

  /** 按 sourceId 打开资料详情（知识图谱节点等场景） */
  const handlePreviewSourceId = useCallback((sourceId: string) => {
    setSourcePreview({ sourceId, snapshot: null })
  }, [])

  /** 预览待整理队列条目（含网页资讯摘要与链接） */
  const handlePreviewInboxItem = useCallback((item: WikiInboxItem) => {
    setSourcePreview({ sourceId: null, snapshot: inboxItemToPreviewSnapshot(item) })
  }, [])

  const navBreadcrumbs = searchResults === null ? buildWikiBreadcrumbs(nav) : null
  const currentContext = searchResults !== null
    ? { title: '搜索结果', subtitle: `共找到 ${searchResults.length} 个文件`, breadcrumbs: null as null, breadcrumbSuffix: undefined }
    : navBreadcrumbs
      ? {
          title: navBreadcrumbs[navBreadcrumbs.length - 1]?.label ?? 'Wiki',
          subtitle:
            nav.kind === 'subtopic'
              ? `${visibleSources.length} 个文件`
              : '选择小类查看资料',
          breadcrumbs: navBreadcrumbs,
          breadcrumbSuffix: nav.kind === 'subtopic' ? `(${visibleSources.length})` : undefined,
        }
      : { title: FIXED_NAV_CONTEXT[nav.kind]?.title ?? 'Wiki', subtitle: FIXED_NAV_CONTEXT[nav.kind]?.subtitle ?? '', breadcrumbs: null as null, breadcrumbSuffix: undefined }

  return (
    <div className="wiki-tab">
      <WikiLeftNav
        active={isMoreMenuOpen ? { kind: 'more' } : nav}
        inboxCount={pendingCount}
        categories={topicTree?.categories.map((c) => c.name) ?? []}
        sectionCounts={sectionCounts}
        archivedCount={archivedCount}
        parkingCount={parkingSources.length}
        moreButtonRef={moreButtonRef}
        onSelect={handleSelectNav}
        onOpenMore={() => setIsMoreMenuOpen((open) => !open)}
      />
      <WikiMoreMenu
        open={isMoreMenuOpen}
        anchorRef={moreButtonRef}
        onClose={() => setIsMoreMenuOpen(false)}
        autoClassifyEnabled={autoClassifyEnabled}
        onAutoClassifyChange={(enabled) => void handleAutoClassifyChange(enabled)}
        onCleanup={() => handleSelectNav({ kind: 'cleanup' })}
        onRebuild={handleRebuildIndex}
        onEditTopicTree={() => setIsTreeEditorOpen(true)}
        onReclassifyAll={() => {
          setReclassifyConfirm({ count: filedSourceCount, estimate: null })
          void estimateReclassify({ kind: 'all' }).then((estimate) => {
            setReclassifyConfirm((prev) => (prev ? { ...prev, estimate } : prev))
          })
        }}
      />

      <Modal
        open={reclassifyConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="全库重新编目"
        onClose={() => setReclassifyConfirm(null)}
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setReclassifyConfirm(null)}>
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                const fileCount = reclassifyConfirm?.estimate?.fileCount
                if (fileCount === 0) {
                  setReclassifyConfirm(null)
                  setNav({ kind: 'inbox' })
                  return
                }
                setReclassifyConfirm(null)
                void handleRunReclassify({ kind: 'all' }, { force: true, enableRename: reclassifyEnableRename })
              }}
            >
              {reclassifyConfirm?.estimate?.fileCount === 0 ? '去收件箱分类' : '开始并查看建议'}
            </Button>
          </>
        }
      >
        <p>
          {reclassifyConfirm?.estimate
            ? reclassifyConfirm.estimate.note
            : `将扫描 ${reclassifyConfirm?.count ?? 0} 个已归档文件，不会改临时存放。`}
        </p>
        <p className="wiki-reclassify-hint">AI 只给建议，接受后才生效。</p>
        <label className="wiki-reclassify-rename-toggle">
          <input
            type="checkbox"
            checked={reclassifyEnableRename}
            onChange={(e) => setReclassifyEnableRename(e.target.checked)}
          />
          同时建议修改低信息文件名（可单独取消）
        </label>
      </Modal>

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
          breadcrumbs={currentContext.breadcrumbs}
          breadcrumbSuffix={currentContext.breadcrumbSuffix}
          onBreadcrumbNavigate={handleSelectNav}
          query={query}
          onQueryChange={setQuery}
          onSearch={() => void handleSearch()}
          onClearSearch={handleClearSearch}
          pillText={taskCenter.pillText}
          pillTone={taskCenter.pillTone}
          onOpenTasks={handleOpenTaskCenter}
          onOpenHelp={() => setHelpOpen(true)}
        />

        <main className="wiki-tab-content">
          {loading && (
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
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
              onPark={(item) => void handlePark(item)}
              onDelete={handleDeleteSource}
            />
          </div>
        ) : nav.kind === 'inbox' ? (
          <div className="wiki-inbox-view">
            <div className="wiki-inbox-view-header">
              <h3>收件箱（{pendingCount}）</h3>
              <Tooltip content={WIKI_FOLDER_IMPORT_TOOLTIP}>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={folderImportBusy || loading}
                  onClick={() => void handleImportFromFolder()}
                >
                  {folderImportBusy ? '导入中…' : '从文件夹导入'}
                </Button>
              </Tooltip>
            </div>
            <p className="wiki-inbox-intro">{WIKI_INBOX_INTRO}</p>
            {inboxItems.length < inboxPending && (
              <p className="wiki-empty-hint">仅显示最近 {inboxItems.length} 条</p>
            )}
            <WikiInboxPanel
              items={inboxItems}
              unfiled={unfiledSources}
              selectedInboxIds={selectedInboxIds}
              selectedUnfiledIds={selectedUnfiledIds}
              onToggleInboxSelect={toggleSelectInbox}
              onToggleUnfiledSelect={toggleSelectUnfiled}
              onToggleSelectAll={toggleSelectAllInbox}
              onRetry={(inboxId) => void handleRetry(inboxId)}
              onDiscard={(inboxId) => void handleDiscard(inboxId)}
              onOrganize={(item) => setPicker({ mode: 'inbox', item })}
              onFileUnfiled={(item) => setPicker({ mode: 'source', item })}
              onPreviewInbox={handlePreviewInboxItem}
              onPreviewSource={handlePreviewSourceItem}
              onBatchOrganize={() => setInboxBatchPickerOpen(true)}
              onAiClassify={() => void handleAiClassifyInbox()}
              aiClassifyBusy={aiClassifyBusy}
              onBatchRetry={() => void handleBatchRetryInbox()}
              onBatchDelete={handleBatchDeleteInbox}
              onDeleteUnfiled={(sourceId) => requestRemove({ sourceIds: [sourceId] })}
              onRetryAll={() => void handleRetryAllInbox()}
            />
          </div>
        ) : nav.kind === 'archived' ? (
          <div className="wiki-archived-view">
            <h3>已归档（{archivedSources.length}）</h3>
            <WikiFileList
              items={archivedSources}
              emptyHint="还没有已归档的资料。"
              showTopic
              moveLabel="恢复"
              showParkAction={false}
              onPreview={handlePreviewSourceItem}
              onMove={(item) => void handleRestoreArchived(item)}
              onDelete={handleDeleteSource}
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
              showMediaChips={false}
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
                    <Tooltip content="永久删除所选资料，不可恢复" placement="bottom">
                      <Button variant="ghost" size="sm" onClick={handleDeleteSelectedSources}>
                        批量删除
                      </Button>
                    </Tooltip>
                  </>
                ) : null
              }
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
              onDelete={handleDeleteSource}
            />
          </div>
        ) : nav.kind === 'cleanup' ? (
          <CleanupView
            cleanupScan={trackedCleanupScan}
            archiveSources={trackedArchiveSources}
            restoreSources={trackedRestoreSources}
            deleteSources={trackedDeleteSources}
            moveToParking={handleParkMany}
          />
        ) : nav.kind === 'reclassify' ? (
          <WikiReclassifyView
            run={reclassifyRun}
            inboxHint={pendingCount > 0 ? `收件箱还有 ${pendingCount} 条未分类，不会出现在本页；请回收件箱用「让 AI 分类」。` : null}
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
        ) : nav.kind === 'section' ? (
          <div className="wiki-subtopic-view">
            <WikiSubtopicPanel
              section={nav.name}
              topicTree={topicTree}
              topicCounts={topicCounts}
              onSelectSubtopic={(category, subtopic) =>
                handleSelectNav({ kind: 'subtopic', category, subtopic })
              }
            />
          </div>
        ) : nav.kind === 'category' ? (
          <div className="wiki-subtopic-view">
            <WikiSubtopicPanel
              section={nav.name}
              topicTree={topicTree}
              topicCounts={topicCounts}
              onSelectSubtopic={(category, subtopic) =>
                handleSelectNav({ kind: 'subtopic', category, subtopic })
              }
            />
          </div>
        ) : nav.kind === 'subtopic' ? (
          <div className="wiki-file-list-view">
            <WikiFileList
              items={visibleSources}
              emptyHint="这个小类下还没有文件"
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
                    <Tooltip content="将所选资料移动到另一个分类目录" placement="bottom">
                      <Button variant="ghost" size="sm" onClick={() => setBatchPickerOpen(true)}>
                        移动到…
                      </Button>
                    </Tooltip>
                    <Tooltip
                      content="移到「临时存放」区，暂不归类，之后可从左栏「临时存放」再移出"
                      placement="bottom"
                    >
                      <Button variant="ghost" size="sm" onClick={() => void handleParkSelected()}>
                        存到临时存放
                      </Button>
                    </Tooltip>
                    <Tooltip content="永久删除所选资料，不可恢复" placement="bottom">
                      <Button variant="ghost" size="sm" onClick={handleDeleteSelectedSources}>
                        删除
                      </Button>
                    </Tooltip>
                  </>
                ) : (
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
                )
              }
              onPreview={handlePreviewSourceItem}
              onMove={(item) => setPicker({ mode: 'source', item })}
              onPark={(item) => void handlePark(item)}
              onDelete={handleDeleteSource}
            />
          </div>
        ) : null}
        </main>
      </div>

      <WikiSourceDetailDrawer
        open={sourcePreview !== null}
        sourceId={sourcePreview?.sourceId ?? null}
        snapshot={sourcePreview?.snapshot ?? null}
        getSource={getSource}
        onClose={() => setSourcePreview(null)}
      />
      <WikiTaskCenter
        open={isTaskCenterOpen}
        tasks={taskCenter.tasks}
        onClose={() => setIsTaskCenterOpen(false)}
        onRetry={(task) => void handleRetryTask(task)}
        onDismiss={taskCenter.dismissTask}
      />

      <WikiTopicPicker
        open={isInboxBatchPickerOpen}
        tree={topicTree}
        title="批量归档到…"
        includeArchived={false}
        itemTitle={`已选 ${selectedInboxIds.size + selectedUnfiledIds.size} 项`}
        onCancel={() => setInboxBatchPickerOpen(false)}
        onConfirm={(category, subtopic) => {
          setInboxBatchPickerOpen(false)
          void handleBatchOrganizeInbox(category, subtopic)
        }}
      />

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
        onConfirmArchive={() => void handleArchiveSelected()}
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
        onConfirmArchive={picker?.mode === 'source' ? () => void handleArchivePickerTarget() : undefined}
        includeArchived={picker?.mode !== 'inbox'}
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
        open={removeConfirm !== null}
        layer={WIKI_MODAL_LAYER}
        title="删除资料"
        content={
          removeConfirm
            ? buildWikiRemoveConfirmContent(removeConfirm.inboxIds.length, removeConfirm.sourceIds.length)
            : ''
        }
        confirmText="删除"
        confirmVariant="danger"
        onConfirm={() => void handleConfirmRemove()}
        onCancel={() => setRemoveConfirm(null)}
      />

      <WikiHelpDrawer open={isHelpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}

export default WikiTab
