/**
 * Wiki 界面元素悬停说明文案
 */

import type { WikiNavSection } from './wikiNavMapping'

/** 左栏分区 Tooltip */
export const WIKI_NAV_TOOLTIPS: Record<WikiNavSection, string> = {
  inbox:
    '新上传的文件、保存的链接、任务产物会先出现在这里。选中多条后可批量归档到同一分类，或一键全部重试。',
  work: '与上班、项目、会议、汇报相关的资料。归档时选「工作」及其小类（如文档、会议记录）。',
  study: '读书、课程、教程、考试等学习材料。适合放笔记、课件、参考资料。',
  life: '私人生活相关：证件、家庭事务、计划复盘与个人随笔。',
  collection: '长期参考的链接、模板、媒体收藏。网页链接默认只存网址，需要正文时再保存。',
  archived: '暂时不用但仍需保留的资料。可从归档恢复回活跃目录。',
  unfiled: '已入库但尚未指定分类的资料，会出现在「收件箱」中，可补选目录。',
}

/** 左栏「更多」按钮 */
export const WIKI_MORE_TOOLTIP =
  '高级功能：清理重复资料、综述合成、重建搜索索引、编辑分类结构、全库 AI 重新编目、历史页面等。'

/** 左栏固定入口（临时存放、知识图谱） */
export const WIKI_LEFT_FIXED_TOOLTIPS = {
  parking: '暂存尚未决定去向的资料。从文件列表「存到临时存放」后，可在此统一查看与移出。',
  graph: '可视化资料、页面与实体之间的关系，支持从节点跳回原文。',
} as const

/** 顶栏搜索框 */
export const WIKI_SEARCH_TOOLTIP =
  '搜索已入库资料的正文与标题。历史摘要页面需进入「更多 → 历史页面」单独浏览。'

/** 顶栏任务 pill */
export const WIKI_TASK_PILL_TOOLTIP =
  '查看后台任务进度：索引重建、综述生成、重新编目、知识图谱抽取等。'

/** 收件箱视图说明 */
export const WIKI_INBOX_INTRO =
  '新资料会先出现在收件箱。未开启「更多 → AI 自动分类」时会一直留在此；开启后导入/上传会尝试自动归档，拿不准的仍在此。可勾选后「批量归档到…」。'

/** 从文件夹导入按钮 */
export const WIKI_FOLDER_IMPORT_TOOLTIP =
  '选择本地文件夹，将其中的文件批量登记到 Wiki（引用原路径，不移动文件）。是否 AI 自动分类取决于「更多 → AI 自动分类」开关。'

/** 更多菜单各项（补充 WikiMoreMenu 内 description） */
export const WIKI_MORE_MENU_TOOLTIPS: Record<string, string> = {
  autoClassify:
    '开启后：从文件夹导入、聊天上传等新资料会由 AI 自动归档到目录；关闭则只进「收件箱」，需手动批量归档或重试。',
  reclassifyAll:
    '让 AI 扫描已归档文件并给出目录调整建议。只生成预览，你勾选接受后才会改动，不会静默修改。',
  editTopicTree: '增删改各分区下的小类名称。分区对应 workspace/wiki/ 下的文件夹结构。',
  history: '早期自动生成的摘要页面（只读）。新资料请用左侧分类目录浏览原始文件。',
  cleanup: '扫描重复内容、失效引用、长期未用资料，并给出归档或删除建议。',
  synthesis: '从多篇资料生成主题综述草稿，确认后才会写入资料库。',
  rebuild: '重新建立全文检索索引。搜索异常或大量导入后可尝试。',
}
