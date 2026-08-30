import React, { useCallback, useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HelpCircle, X } from 'lucide-react'
import { Button } from '../../../components/ui/Button/Button'
import './WikiHelpDrawer.css'

interface WikiHelpDrawerProps {
  readonly open: boolean
  readonly onClose: () => void
}

type HelpTab = 'quick' | 'manual'

const QUICK_SECTIONS = [
  {
    title: '资料库是什么',
    body: 'Wiki 是你的个人资料库：文件、网页链接、笔记集中存放，可搜索、可预览。与「工作记忆」「个人记忆」不同，这里存的是真实资料和正文。',
  },
  {
    title: '资料怎么进来',
    body: '聊天里上传附件、保存网页链接、任务产物会自动进入「待整理」。默认只建立引用，不会移动或删除原文件；网页链接默认只存网址，需要正文时在预览里点「保存网页内容」。',
  },
  {
    title: '从文件夹导入',
    body: '待整理页右上角「从文件夹导入」：选一个目录（如 outputs/ 下的任务文件夹），系统会预览可导入文件数量，确认后批量收进 Wiki。原文件保留在原处，Wiki 只建立引用。是否在导入后 AI 自动分类，由左栏「⋯ 更多 → AI 自动分类」开关决定（默认关闭）。',
  },
  {
    title: '让 Agent 帮忙整理',
    body: '在聊天中说「帮我把 outputs/某目录整理到 Wiki」即可。Agent 会通过 lumii-ui 扫描并导入；若你已在 Wiki 开启「AI 自动分类」，导入后会尝试 AI 归档，拿不准的条目仍留在待整理，你可批量归档或重试。',
  },
  {
    title: '待整理怎么用（推荐流程）',
    body: '1. 左栏点「待整理」查看新资料\n2. 勾选多条 →「批量归档到…」一次放入同一分类\n3. 失败或「待人工归档」的条目 →「全部重试」或逐条「归档到…」\n4. 「待补分」是已入库但未分类的文件，同样支持批量归档\n5. 拿不准分类可暂时留在待整理，没有对错',
  },
  {
    title: '分类怎么选',
    body: '工作：项目/会议/汇报 · 学习：笔记/课程/资料 · 生活：证件/家庭/随笔 · 收藏：链接/模板/参考 · 归档：暂时不用。归档时可点「让 AI 建议」参考分类，采纳与否由你决定。',
  },
  {
    title: '入口在哪里',
    body: '工作空间文件面板顶部的「资料库」、聊天工具栏书本图标、输入框「+」菜单「打开资料库」，以及 设置 → 记忆 → Wiki。',
  },
  {
    title: '高级功能（⋯ 更多）',
    body: 'AI 自动分类（开关）、整合长文、综述合成、知识图谱、清理、重建索引、编辑主题树、全库重新编目。日常整理用不到时可忽略；鼠标悬停各菜单项可查看简要说明。',
  },
  {
    title: '文件存在哪',
    body: '资料文件夹：<工作空间>/wiki/（可在资源管理器直接查看）。索引与任务记录在 ~/.lumii 本地数据库。',
  },
] as const

/**
 * Wiki 应用内操作指引抽屉（快速指引 + 内置完整手册）
 */
export const WikiHelpDrawer: React.FC<WikiHelpDrawerProps> = ({ open, onClose }) => {
  const [tab, setTab] = useState<HelpTab>('quick')
  const [manualMd, setManualMd] = useState<string | null>(null)
  const [manualError, setManualError] = useState<string | null>(null)
  const [manualLoading, setManualLoading] = useState(false)

  /**
   * 打开「完整手册」时从内置 extraResources 加载 Markdown。
   */
  const loadManual = useCallback(async () => {
    setManualLoading(true)
    setManualError(null)
    try {
      const api = window.electronAPI?.userGuides
      if (!api?.read) {
        setManualError('当前环境无法读取内置手册')
        setManualMd(null)
        return
      }
      const content = await api.read('wiki')
      setManualMd(content.markdown)
    } catch (err) {
      setManualError(err instanceof Error ? err.message : '加载手册失败')
      setManualMd(null)
    } finally {
      setManualLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    if (tab === 'manual' && manualMd === null && !manualLoading && !manualError) {
      void loadManual()
    }
  }, [open, tab, manualMd, manualLoading, manualError, loadManual])

  useEffect(() => {
    if (!open) {
      setTab('quick')
    }
  }, [open])

  if (!open) return null

  return (
    <div className="wiki-help-overlay" role="presentation" onClick={onClose}>
      <aside
        className="wiki-help-drawer"
        role="dialog"
        aria-label="Wiki 使用指引"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="wiki-help-header">
          <h2>
            <HelpCircle size={18} aria-hidden />
            Wiki 使用指引
          </h2>
          <button type="button" className="wiki-help-close" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </header>

        <div className="wiki-help-tabs" role="tablist" aria-label="指引类型">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'quick'}
            className={tab === 'quick' ? 'wiki-help-tab wiki-help-tab--active' : 'wiki-help-tab'}
            onClick={() => setTab('quick')}
          >
            快速指引
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'manual'}
            className={tab === 'manual' ? 'wiki-help-tab wiki-help-tab--active' : 'wiki-help-tab'}
            onClick={() => setTab('manual')}
          >
            完整手册
          </button>
        </div>

        <div className="wiki-help-body">
          {tab === 'quick' ? (
            <>
              {QUICK_SECTIONS.map((section) => (
                <section key={section.title} className="wiki-help-section">
                  <h3>{section.title}</h3>
                  <p>
                    {section.body.split('\n').map((line, i) => (
                      <React.Fragment key={i}>
                        {i > 0 && <br />}
                        {line}
                      </React.Fragment>
                    ))}
                  </p>
                </section>
              ))}
              <p className="wiki-help-footnote">完整版见「完整手册」标签（随应用安装包内置，离线可用）。</p>
            </>
          ) : manualLoading ? (
            <p className="wiki-help-loading">正在加载内置手册…</p>
          ) : manualError ? (
            <p className="wiki-help-error" role="alert">
              {manualError}
            </p>
          ) : manualMd ? (
            <article className="wiki-help-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{manualMd}</ReactMarkdown>
            </article>
          ) : null}
        </div>

        <footer className="wiki-help-footer">
          <Button variant="primary" size="sm" onClick={onClose}>
            知道了
          </Button>
        </footer>
      </aside>
    </div>
  )
}

export default WikiHelpDrawer
