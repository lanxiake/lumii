/**
 * 流水线插件的渲染层半边：侧栏导航 + 整页视图。
 *
 * 路由用 `plugin:pipeline` 寻址（与 autonomous 同形）。插件停用后导航与页面一起消失，
 * 不会留一个点进去全报错的入口。
 */
import { Workflow } from 'lucide-react'
import type { RendererPlugin } from '../../api'
import { PipelinePage } from './ui/PipelinePage'

const VIEW_ID = 'pipeline'

export const pipelineRenderer: RendererPlugin = {
  id: 'com.lumii.pipeline',
  setup(api) {
    const offNav = api.registerSlot('app.nav', {
      id: 'builtin.pipeline',
      order: 80,
      component: ({ activeView, onViewChange, collapsed, classNames }: {
        activeView: string
        onViewChange: (v: string) => void
        collapsed: boolean
        classNames: { item: string; active: string; icon: string; label: string }
      }) => {
        const active = activeView === `plugin:${VIEW_ID}`
        return (
          <button
            type="button"
            className={[classNames.item, active ? classNames.active : ''].join(' ')}
            onClick={() => onViewChange(`plugin:${VIEW_ID}`)}
            title="确定性流水线"
          >
            <span className={classNames.icon}>
              <Workflow size={18} aria-hidden />
            </span>
            {!collapsed && <span className={classNames.label}>流水线</span>}
          </button>
        )
      },
    })
    const offView = api.registerSlot('app.view', {
      id: VIEW_ID,
      order: 80,
      component: () => (
        <div style={{ height: '100%', padding: 16, minHeight: 0 }}>
          <PipelinePage />
        </div>
      ),
    })
    return () => {
      offNav()
      offView()
    }
  },
}
