/**
 * Wiki 界面元素悬停说明文案
 */

/**
 * 左栏分区 Tooltip。
 *
 * 键是系统分区 id 或 v2 树的大类名。用户自建大类没有预置文案，取不到就不显示 tooltip
 * ——故这里用普通 Record<string, string> 而非穷举联合类型。
 */
export const WIKI_NAV_TOOLTIPS: Record<string, string> = {
  inbox:
    '新上传的文件、保存的链接、任务产物会先出现在这里。选中多条后可批量归档到同一分类，或一键全部重试。',
  工作: '与上班、项目、会议、汇报相关的资料。归档时选「工作」及其小类（项目/例行/对外）。',
  学习: '读书、课程、教程、考试等学习材料。在学的放「在学」，学过留着以后翻的放「参考」。',
  生活: '私人生活相关：证件票据（凭据）、家庭事务账单（家事）、随笔日记创作（自留）。',
  收藏: '长期参考的链接、模板、素材。先存以后看的放「待读」，可套用的放「可复用」。',
  archived: '暂时不用但仍需保留的资料。可从归档恢复回活跃目录。',
  unfiled: '已入库但尚未指定分类的资料，会出现在「收件箱」中，可补选目录。',
}

/** 左栏「更多」按钮 */
export const WIKI_MORE_TOOLTIP =
  '高级功能：清理重复资料、综述合成、重建搜索索引、编辑分类结构、全库 AI 重新编目、历史页面等。'

/** 左栏固定入口（临时存放） */
export const WIKI_LEFT_FIXED_TOOLTIPS = {
  parking: '暂存尚未决定去向的资料。从文件列表「存到临时存放」后，可在此统一查看与移出。',
} as const

/** 顶栏搜索框 */
export const WIKI_SEARCH_TOOLTIP =
  '搜索已入库资料的正文与标题。历史摘要页面需进入「更多 → 历史页面」单独浏览。'

/** 顶栏任务 pill */
export const WIKI_TASK_PILL_TOOLTIP =
  '查看后台任务进度：索引重建、综述生成、重新编目等。'

/** 收件箱视图说明 */
export const WIKI_INBOX_INTRO =
  '新资料会先出现在收件箱。未开启「更多 → AI 自动分类」时会一直留在此；开启后导入/上传会尝试自动归档，拿不准的仍在此。可勾选后「批量归档到…」。'

/** 从文件夹导入按钮 */
export const WIKI_FOLDER_IMPORT_TOOLTIP =
  '选择本地文件夹，将其中的文件批量登记到 Wiki（引用原路径，不移动文件）。是否 AI 自动分类取决于「更多 → AI 自动分类」开关。'

/** 更多菜单各项（补充 WikiMoreMenu 内 description） */
export const WIKI_MORE_MENU_TOOLTIPS: Record<string, string> = {
  autoClassify:
    '开启后：从文件夹导入、聊天上传等新资料会由 AI 自动归档到目录；已在收件箱里的文件也会随后分类。关闭则只进「收件箱」，可勾选后点「让 AI 分类」。',
  reclassifyAll:
    '让 AI 扫描已经进工作/学习/生活/收藏的文件并给出调整建议。收件箱里的未分类文件不会被编目，请用「让 AI 分类」。建议需勾选接受后才生效。',
  editTopicTree: '增删改各分区下的小类名称。分区对应 workspace/wiki/ 下的文件夹结构。',
  history: '早期自动生成的摘要页面（只读）。新资料请用左侧分类目录浏览原始文件。',
  cleanup: '扫描重复内容、失效引用、长期未用资料，并给出归档或删除建议。',
  rebuild: '重新建立全文检索索引。搜索异常或大量导入后可尝试。',
}
