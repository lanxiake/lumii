# 第 3 片 · Wiki 类名归属对照表（可执行规格）

> 生成：2026-09-12，由审计脚本从源码解析生成（非手工转录）
> 上位文档：[03-Wiki样式归位.md](./03-Wiki样式归位.md)
> 数据口径：WikiTab.css(2598 行) + WikiSourceMeta.css(69 行) + WikiHelpDrawer.css(180 行) = 310 个类；18 个组件文件 325 处字面引用

## 一、总账

| 类别 | 数量 | 处置 |
|---|---|---|
| 单文件归属 | 227 | 迁入该组件自己的 .module.css |
| 共享（≥2 文件） | 5 | 迁入 wiki-shared.module.css |
| 动态模板覆盖 | 20 | 改为显式映射表查 styles[...] |
| 死类名（全仓零引用） | 58 | 删除（B0，附证据） |
| 无样式类名（tsx 用了但无任何 CSS） | 19 | 登记，本轮不动 |

## 二、单文件归属（迁移主清单）

### WikiFileList.tsx → WikiFileList.module.css（27 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-file-list-header | WikiTab.css:1988 |  |
| wiki-file-list-select-all | WikiTab.css:2133 |  |
| wiki-file-list-chips | WikiTab.css:603 |  |
| wiki-file-list-chip | WikiTab.css:609 |  |
| wiki-file-list-chip--active | WikiTab.css:623 |  |
| wiki-file-list-header-actions | WikiTab.css:1996 |  |
| wiki-file-list-items | WikiTab.css:629 |  |
| wiki-file-list-title | WikiTab.css:685 |  |
| wiki-file-list-title--link | WikiTab.css:694 |  |
| wiki-file-list-item | WikiTab.css:638 |  |
| wiki-file-list-item--highlight | WikiTab.css:653 |  |
| wiki-file-list-icon | WikiTab.css:658 |  |
| wiki-file-list-main | WikiTab.css:677 |  |
| wiki-file-list-title-row | WikiTab.css:750 |  |
| wiki-file-list-path-prefix | WikiTab.css:760 |  |
| wiki-file-list-term | WikiTab.css:769 |  |
| wiki-file-list-subtopic-prefix | WikiTab.css:820 |  |
| wiki-file-list-summary-tooltip-content | WikiTab.css:740 |  |
| wiki-file-list-summary-tooltip | WikiTab.css:735 |  |
| wiki-file-list-ext-badge | WikiTab.css:664 |  |
| wiki-file-list-tags-inline | WikiTab.css:785 |  |
| wiki-file-list-tag-chip | WikiTab.css:795 |  |
| wiki-file-list-topic | WikiTab.css:728 |  |
| wiki-file-list-time | WikiTab.css:714 |  |
| wiki-file-list-actions | WikiTab.css:838 |  |
| wiki-file-list-action-btn | WikiTab.css:847 |  |
| wiki-file-list-sentinel | WikiTab.css:2275 |  |

### WikiSourceDetailDrawer.tsx → WikiSourceDetailDrawer.module.css（20 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-source-web-preview-host | WikiTab.css:2189 |  |
| wiki-source-web-preview-error | WikiTab.css:2401 |  |
| wiki-source-web-preview-error-title | WikiTab.css:2415 |  |
| wiki-source-web-preview-error-hint | WikiTab.css:2422 |  |
| wiki-source-web-preview | WikiTab.css:2391 |  |
| wiki-detail-overlay | WikiTab.css:1503 |  |
| wiki-detail-overlay--fixed | WikiTab.css:1509 |  |
| wiki-detail-overlay--centered | WikiTab.css:1515 |  |
| wiki-detail-mask | WikiTab.css:1523 |  |
| wiki-source-detail-modal | WikiTab.css:1528 |  |
| wiki-source-detail-header | WikiTab.css:2163 |  |
| wiki-source-detail-heading | WikiTab.css:2173 |  |
| wiki-source-detail-title | WikiTab.css:2290 |  |
| wiki-source-detail-url | WikiTab.css:2178 |  |
| wiki-source-detail-header-actions | WikiTab.css:2297 |  |
| wiki-source-detail-close | WikiTab.css:2304 |  |
| wiki-source-detail-body | WikiTab.css:1543 |  |
| wiki-source-detail-loading | WikiTab.css:2329 |  |
| wiki-source-detail-error | WikiTab.css:2335 |  |
| wiki-source-detail-summary | WikiTab.css:2342 |  |

### WikiMigrateReviewView.tsx → WikiMigrateReviewView.module.css（18 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-migrate-review-empty | WikiTab.css:2489 |  |
| wiki-migrate-review | WikiTab.css:2458 |  |
| wiki-migrate-review-progress | WikiTab.css:2494 |  |
| wiki-migrate-review-hint | WikiTab.css:2483 |  |
| wiki-migrate-review-error | WikiTab.css:2499 |  |
| wiki-migrate-review-header | WikiTab.css:2464 |  |
| wiki-migrate-review-count | WikiTab.css:2472 |  |
| wiki-migrate-review-actions | WikiTab.css:2477 |  |
| wiki-migrate-review-table | WikiTab.css:2504 |  |
| wiki-migrate-review-row--ignored | WikiTab.css:2585 |  |
| wiki-migrate-review-row--conflict | WikiTab.css:2589 |  |
| wiki-migrate-review-folder | WikiTab.css:2524 |  |
| wiki-migrate-review-ignored-label | WikiTab.css:2593 |  |
| wiki-migrate-review-target | WikiTab.css:2529 |  |
| wiki-migrate-review-approve | WikiTab.css:2544 |  |
| wiki-migrate-review-target-preview | WikiTab.css:2552 |  |
| wiki-migrate-review-reason | WikiTab.css:2557 |  |
| wiki-migrate-review-status | WikiTab.css:2563 |  |

### WikiReclassifyView.tsx → WikiReclassifyView.module.css（17 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-reclassify-empty | WikiTab.css:2119 |  |
| wiki-reclassify | WikiTab.css:2003 |  |
| wiki-reclassify-progress | WikiTab.css:2112 |  |
| wiki-reclassify-error | WikiTab.css:2125 |  |
| wiki-reclassify-header | WikiTab.css:2009 |  |
| wiki-reclassify-count | WikiTab.css:2016 |  |
| wiki-reclassify-actions | WikiTab.css:2021 |  |
| wiki-reclassify-list | WikiTab.css:2026 |  |
| wiki-reclassify-item | WikiTab.css:2035 |  |
| wiki-reclassify-body | WikiTab.css:2044 |  |
| wiki-reclassify-title | WikiTab.css:2049 |  |
| wiki-reclassify-decided-by | WikiTab.css:2059 |  |
| wiki-reclassify-move | WikiTab.css:2068 |  |
| wiki-reclassify-target | WikiTab.css:2086 |  |
| wiki-reclassify-rename | WikiTab.css:2077 |  |
| wiki-reclassify-reason | WikiTab.css:2100 |  |
| wiki-reclassify-item-actions | WikiTab.css:2106 |  |

### WikiInboxPanel.tsx → WikiInboxPanel.module.css（16 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-inbox-toolbar | WikiTab.css:468 |  |
| wiki-inbox-select-all | WikiTab.css:478 |  |
| wiki-inbox-batch-count | WikiTab.css:488 |  |
| wiki-inbox-item | WikiTab.css:1202 |  |
| wiki-inbox-item-row | WikiTab.css:493 |  |
| wiki-inbox-checkbox | WikiTab.css:504 |  |
| wiki-inbox-item-main | WikiTab.css:499 |  |
| wiki-inbox-item-header | WikiTab.css:1212 |  |
| wiki-inbox-item-type | WikiTab.css:1219 |  |
| wiki-inbox-item-title | WikiTab.css:1227 |  |
| wiki-inbox-item-title--link | WikiTab.css:2439 |  |
| wiki-inbox-item-status | WikiTab.css:1238 |  |
| wiki-inbox-item-preview | WikiTab.css:1280 |  |
| wiki-inbox-item-hint | WikiTab.css:1296 |  |
| wiki-inbox-item-error | WikiTab.css:1289 |  |
| wiki-inbox-item-actions | WikiTab.css:1302 |  |

### WikiTaskCenter.tsx → WikiTaskCenter.module.css（16 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-task-center-detail | WikiTab.css:1470 |  |
| wiki-task-center-detail-item | WikiTab.css:1460 |  |
| wiki-task-center-detail-heading | WikiTab.css:1412 |  |
| wiki-task-center-item | WikiTab.css:1388 |  |
| wiki-task-center-item-heading | WikiTab.css:1412 |  |
| wiki-task-center-status | WikiTab.css:1436 |  |
| wiki-task-center-message | WikiTab.css:1460 |  |
| wiki-task-center-error | WikiTab.css:1450 |  |
| wiki-task-center-actions | WikiTab.css:1412 |  |
| wiki-task-center-overlay | WikiTab.css:1310 |  |
| wiki-task-center-mask | WikiTab.css:1316 |  |
| wiki-task-center-drawer | WikiTab.css:1326 |  |
| wiki-task-center-header | WikiTab.css:1339 |  |
| wiki-task-center-content | WikiTab.css:1364 |  |
| wiki-task-center-empty | WikiTab.css:1370 |  |
| wiki-task-center-section | WikiTab.css:1376 |  |

### WikiHelpDrawer.tsx → WikiHelpDrawer.module.css（14 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-help-overlay | WikiHelpDrawer.css:1 |  |
| wiki-help-drawer | WikiHelpDrawer.css:10 |  |
| wiki-help-header | WikiHelpDrawer.css:20 |  |
| wiki-help-close | WikiHelpDrawer.css:123 |  |
| wiki-help-tabs | WikiHelpDrawer.css:38 |  |
| wiki-help-tab | WikiHelpDrawer.css:45 |  |
| wiki-help-tab--active | WikiHelpDrawer.css:55 |  |
| wiki-help-body | WikiHelpDrawer.css:140 |  |
| wiki-help-section | WikiHelpDrawer.css:146 |  |
| wiki-help-footnote | WikiHelpDrawer.css:165 |  |
| wiki-help-loading | WikiHelpDrawer.css:62 |  |
| wiki-help-error | WikiHelpDrawer.css:62 |  |
| wiki-help-markdown | WikiHelpDrawer.css:72 |  |
| wiki-help-footer | WikiHelpDrawer.css:173 |  |

### WikiTopicTreeEditor.tsx → WikiTopicTreeEditor.module.css（14 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-tree-editor-input | WikiTab.css:1026 |  |
| wiki-tree-editor-hint | WikiTab.css:943 |  |
| wiki-tree-editor-error | WikiTab.css:949 |  |
| wiki-tree-editor-columns | WikiTab.css:958 |  |
| wiki-tree-editor-column | WikiTab.css:964 |  |
| wiki-tree-editor-row | WikiTab.css:975 |  |
| wiki-tree-editor-name | WikiTab.css:981 |  |
| wiki-tree-editor-name--active | WikiTab.css:1006 |  |
| wiki-tree-editor-icon | WikiTab.css:1010 |  |
| wiki-tree-editor-add | WikiTab.css:1036 |  |
| wiki-tree-editor-disposition | WikiTab.css:1054 |  |
| wiki-tree-editor-radio | WikiTab.css:1069 |  |
| wiki-tree-editor-select | WikiTab.css:1026 |  |
| wiki-tree-editor-disposition-actions | WikiTab.css:1079 |  |

### WikiTopBar.tsx → WikiTopBar.module.css（13 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-top-bar | WikiTab.css:242 |  |
| wiki-top-bar-search | WikiTab.css:253 |  |
| wiki-search-input-cluster | WikiTab.css:280 |  |
| wiki-search-chip | WikiTab.css:290 |  |
| wiki-search-chip-text | WikiTab.css:304 |  |
| wiki-search-chip-remove | WikiTab.css:310 |  |
| wiki-top-bar-clear | WikiTab.css:328 |  |
| wiki-top-bar-heading | WikiTab.css:337 |  |
| wiki-top-bar-actions | WikiTab.css:421 |  |
| wiki-top-bar-help | WikiTab.css:428 |  |
| wiki-top-bar-tasks | WikiTab.css:415 |  |
| wiki-task-pill | WikiTab.css:522 |  |
| wiki-task-pill-dot | WikiTab.css:536 |  |

### WikiTab.tsx → WikiTab.module.css（12 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-tab | WikiTab.css:3 |  |
| wiki-reclassify-rename-toggle | WikiTab.css:2090 |  |
| wiki-tab-right | WikiTab.css:23 |  |
| wiki-tab-content | WikiTab.css:31 |  |
| wiki-loading | WikiTab.css:39 |  |
| wiki-open-error | WikiTab.css:593 |  |
| wiki-search-degrade | WikiTab.css:1893 |  |
| wiki-inbox-view-header | WikiTab.css:446 |  |
| wiki-inbox-intro | WikiTab.css:458 |  |
| wiki-file-list-batch-count | WikiTab.css:2133 |  |
| wiki-category-view | WikiTab.css:2250 |  |
| wiki-subtopic-bar | WikiTab.css:2258 |  |

### WikiGraphView.tsx → WikiGraphView.module.css（10 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-graph-view | WikiTab.css:1881 |  |
| wiki-graph-layer-chips | WikiTab.css:1908 |  |
| wiki-graph-layer-chip | WikiTab.css:1915 |  |
| wiki-graph-layer-chip--active | WikiTab.css:1929 |  |
| wiki-graph-body | WikiTab.css:1936 |  |
| wiki-graph-canvas | WikiTab.css:1942 |  |
| wiki-graph-entity-sidebar | WikiTab.css:1947 |  |
| wiki-graph-entity-sidebar-header | WikiTab.css:1956 |  |
| wiki-graph-entity-sidebar-close | WikiTab.css:1971 |  |
| wiki-graph-entity-type | WikiTab.css:1981 |  |

### WikiSourceMeta.tsx → WikiSourceMeta.module.css（9 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-source-meta | WikiSourceMeta.css:3 |  |
| wiki-source-meta-path | WikiSourceMeta.css:19 |  |
| wiki-source-meta-label | WikiSourceMeta.css:12 |  |
| wiki-source-meta-separator | WikiSourceMeta.css:35 |  |
| wiki-source-meta-segment | WikiSourceMeta.css:26 |  |
| wiki-source-meta-tags | WikiSourceMeta.css:41 |  |
| wiki-source-meta-tag | WikiSourceMeta.css:48 |  |
| wiki-source-meta-description | WikiSourceMeta.css:58 |  |
| wiki-source-meta-description-text | WikiSourceMeta.css:64 |  |

### WikiTopicPicker.tsx → WikiTopicPicker.module.css（9 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-topic-picker-item | WikiTab.css:869 |  |
| wiki-topic-picker-hint | WikiTab.css:921 |  |
| wiki-topic-picker-error | WikiTab.css:936 |  |
| wiki-topic-picker-suggestion | WikiTab.css:927 |  |
| wiki-topic-picker-section | WikiTab.css:875 |  |
| wiki-topic-picker-heading | WikiTab.css:879 |  |
| wiki-topic-picker-options | WikiTab.css:896 |  |
| wiki-topic-picker-option | WikiTab.css:902 |  |
| wiki-topic-picker-option--active | WikiTab.css:916 |  |

### CleanupView.tsx → CleanupView.module.css（8 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-cleanup-filters | WikiTab.css:1738 |  |
| wiki-cleanup-filter-chip | WikiTab.css:1745 |  |
| wiki-cleanup-filter-chip--active | WikiTab.css:1759 |  |
| wiki-cleanup-toolbar | WikiTab.css:1765 |  |
| wiki-cleanup-item | WikiTab.css:1779 |  |
| wiki-cleanup-item-title | WikiTab.css:1790 |  |
| wiki-cleanup-item-topic | WikiTab.css:1796 |  |
| wiki-cleanup-item-reason | WikiTab.css:1802 |  |

### WikiLeftNav.tsx → WikiLeftNav.module.css（8 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-left-nav-item | WikiTab.css:54 |  |
| wiki-left-nav-item--active | WikiTab.css:73 |  |
| wiki-left-nav-label | WikiTab.css:564 |  |
| wiki-left-nav-count | WikiTab.css:79 |  |
| wiki-left-nav-count--warn | WikiTab.css:146 |  |
| wiki-left-nav | WikiTab.css:11 |  |
| wiki-left-nav-primary | WikiTab.css:45 |  |
| wiki-left-nav-footer | WikiTab.css:90 |  |

### WikiBreadcrumb.tsx → WikiBreadcrumb.module.css（6 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-breadcrumb | WikiTab.css:361 |  |
| wiki-breadcrumb-list | WikiTab.css:365 |  |
| wiki-breadcrumb-item | WikiTab.css:375 |  |
| wiki-breadcrumb-sep | WikiTab.css:382 |  |
| wiki-breadcrumb-link | WikiTab.css:387 |  |
| wiki-breadcrumb-current | WikiTab.css:405 |  |

### WikiSubtopicPanel.tsx → WikiSubtopicPanel.module.css（6 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-subtopic-panel-intro | WikiTab.css:2195 |  |
| wiki-subtopic-chips | WikiTab.css:2215 |  |
| wiki-subtopic-chip-tooltip | WikiTab.css:864 |  |
| wiki-subtopic-chip | WikiTab.css:2224 |  |
| wiki-subtopic-chip--active | WikiTab.css:2244 |  |
| wiki-subtopic-chip-count | WikiTab.css:2280 |  |

### WikiMoreMenu.tsx → WikiMoreMenu.module.css（4 类）

| 类名 | CSS 行 | 动态模板覆盖 |
|---|---|---|
| wiki-more-menu | WikiTab.css:151 |  |
| wiki-more-menu-item | WikiTab.css:164 |  |
| wiki-more-menu-divider | WikiTab.css:208 |  |
| wiki-more-menu-toggle | WikiTab.css:214 |  |

## 三、共享类 → wiki-shared.module.css

| 类名 | 使用文件 | CSS 行 | 说明 |
|---|---|---|---|
| wiki-cleanup-header | CleanupView.tsx + WikiGraphView.tsx | WikiTab.css:1731 |  |
| wiki-empty-hint | CleanupView.tsx + WikiFileList.tsx + WikiGraphView.tsx + WikiInboxPanel.tsx + WikiSourceDetailDrawer.tsx + WikiSubtopicPanel.tsx + WikiTab.tsx | WikiTab.css:575 |  |
| wiki-cleanup-actions | CleanupView.tsx + WikiGraphView.tsx | WikiTab.css:1773 |  |
| wiki-tooltip-below | WikiFileList.tsx + WikiSubtopicPanel.tsx | WikiTab.css:860 |  |
| wiki-reclassify-hint | WikiReclassifyView.tsx + WikiTab.tsx | WikiTab.css:2119 |  |

> 附加：`wiki-file-list-header`（单归属 WikiFileList）与其复合规则 2266 一并移入共享模块；2266 的复合选择器须与 `wiki-category-view` 同文件。

## 四、动态模板类（改为映射表）

| 文件 | 现模板 | 取值域（= CSS 中已有变体） | 涉及类 |
|---|---|---|---|
| CleanupView.tsx | `wiki-cleanup-item-reason--${s.reason}` | stale / broken_source / duplicate_content | `wiki-cleanup-item-reason--stale` `wiki-cleanup-item-reason--broken_source` `wiki-cleanup-item-reason--duplicate_content` |
| WikiInboxPanel.tsx | `wiki-inbox-item-status--${row.item.status}` | pending / processing / failed / organized / discarded | `wiki-inbox-item-status--pending` `wiki-inbox-item-status--processing` `wiki-inbox-item-status--failed` `wiki-inbox-item-status--organized` `wiki-inbox-item-status--discarded` |
| WikiMigrateReviewView.tsx | `wiki-migrate-review-status--${m.status}` | ok / conflict / needContent | `wiki-migrate-review-status--ok` `wiki-migrate-review-status--conflict` `wiki-migrate-review-status--needContent` |
| WikiTaskCenter.tsx | `wiki-task-center-item--${task.phase} / wiki-task-center-status--${task.phase}` | running / failed / succeeded | `wiki-task-center-item--running` `wiki-task-center-item--failed` `wiki-task-center-item--succeeded` `wiki-task-center-status--running` `wiki-task-center-status--failed` `wiki-task-center-status--succeeded` |
| WikiTopBar.tsx | `wiki-task-pill--${pillTone}` | running / success / error / idle(无样式) | `wiki-task-pill--running` `wiki-task-pill--success` `wiki-task-pill--error` |

> 迁移后形态：显式常量映射表（`Record<取值, string>`），值取 `styles['...']`，消除字符串拼接。
## 五、死类名删除清单（B0 批次，58 个）

证据：① 全 renderer 解析 import+字面量扫描零引用；② git 历史为已移除功能的遗留（2026-08-30 484ee60 简化左栏 / 2026-09-01 bddda73 移除 history-page UI 等）；③ 无测试按类名查询。

| 类名 | CSS 行 |
|---|---|
| wiki-left-nav-tree | WikiTab.css:97 |
| wiki-left-nav-group-header | WikiTab.css:106 |
| wiki-left-nav-chevron | WikiTab.css:112 |
| wiki-left-nav-item--group | WikiTab.css:128 |
| wiki-left-nav-subtopics | WikiTab.css:134 |
| wiki-left-nav-item--sub | WikiTab.css:141 |
| wiki-section-heading-hint | WikiTab.css:508 |
| wiki-section-subtitle | WikiTab.css:581 |
| wiki-section-heading | WikiTab.css:587 |
| wiki-file-list-meta | WikiTab.css:721 |
| wiki-file-list-title-cluster | WikiTab.css:828 |
| btn-content | WikiTab.css:855 |
| wiki-topic-picker-group | WikiTab.css:886 |
| wiki-topic-picker-group-title | WikiTab.css:890 |
| wiki-page-list-item | WikiTab.css:1087 |
| wiki-page-list-item--selected | WikiTab.css:1113 |
| wiki-page-list-heading | WikiTab.css:1118 |
| wiki-page-list-title | WikiTab.css:1125 |
| wiki-page-list-category | WikiTab.css:1132 |
| wiki-page-list-path | WikiTab.css:1141 |
| wiki-page-list-snippet | WikiTab.css:1148 |
| wiki-page-view | WikiTab.css:1160 |
| wiki-page-view-header | WikiTab.css:1166 |
| wiki-page-title-input | WikiTab.css:1173 |
| wiki-page-view-actions | WikiTab.css:1184 |
| wiki-page-view-meta | WikiTab.css:1190 |
| wiki-page-view-editor | WikiTab.css:1196 |
| wiki-detail-drawer | WikiTab.css:1558 |
| wiki-page-sidebar | WikiTab.css:1578 |
| wiki-page-sidebar-summary | WikiTab.css:1583 |
| wiki-page-sidebar-content | WikiTab.css:1600 |
| wiki-sidebar-section | WikiTab.css:1623 |
| wiki-backlink-item | WikiTab.css:1635 |
| wiki-backlink-title | WikiTab.css:1652 |
| wiki-backlink-path | WikiTab.css:1657 |
| wiki-revision-item | WikiTab.css:1662 |
| wiki-revision-item-main | WikiTab.css:1669 |
| wiki-revision-version | WikiTab.css:1687 |
| wiki-revision-editor | WikiTab.css:1692 |
| wiki-revision-time | WikiTab.css:1696 |
| wiki-diff-view | WikiTab.css:1701 |
| wiki-diff-lines | WikiTab.css:1707 |
| wiki-diff-line | WikiTab.css:1716 |
| wiki-diff-line--add | WikiTab.css:1720 |
| wiki-diff-line--remove | WikiTab.css:1725 |
| wiki-page-view-editor--dragover | WikiTab.css:1829 |
| wiki-link-autocomplete | WikiTab.css:1835 |
| wiki-link-autocomplete-item | WikiTab.css:1848 |
| wiki-link-autocomplete-path | WikiTab.css:1865 |
| wiki-link-autocomplete-dismiss | WikiTab.css:1870 |
| wiki-status-candidates | WikiTab.css:1887 |
| wiki-search-mode | WikiTab.css:1902 |
| wiki-source-detail-drawer | WikiTab.css:2157 |
| wiki-subtopic-group | WikiTab.css:2202 |
| wiki-subtopic-group-title | WikiTab.css:2206 |
| wiki-source-detail-link | WikiTab.css:2342 |
| wiki-source-detail-preview | WikiTab.css:2342 |
| wiki-source-file-preview-host | WikiTab.css:2429 |

**需就地改写（混合规则，只删死类名部分）**：

- `828-830`：`.wiki-file-list-title-cluster .wiki-file-list-title--link` 整个后代规则删（cluster 已死）
- `855-857`：`.wiki-file-list-action-btn .btn-content` 整条删（Button 的 `btn-content` 已是模块哈希类，该规则永远匹配不上）
- `1606-1621` @media：选择器列表中删除 `.wiki-detail-drawer`（保留 `.wiki-task-center-drawer` 等存活类）
- `2342-2348`：`h3` 组合规则中删除 `.wiki-source-detail-link, .wiki-source-detail-preview`（保留 `.wiki-source-detail-summary`）

## 六、无样式类名（登记，不处理）

这些类名在 tsx 中使用，但任何 CSS 都未定义 —— 删除属 JSX 清理，不属于本片样式迁移。登记备查：

- `wiki-cleanup-view` — pages/MemoriesPage/components/CleanupView.tsx:139
- `wiki-cleanup-item-action` — pages/MemoriesPage/components/CleanupView.tsx:211
- `wiki-file-list` — pages/MemoriesPage/components/WikiFileList.tsx:150
- `wiki-graph-entity-sources` — pages/MemoriesPage/components/WikiGraphView.tsx:500
- `wiki-graph-entity-source-list` — pages/MemoriesPage/components/WikiGraphView.tsx:507
- `wiki-graph-entity-source-item` — pages/MemoriesPage/components/WikiGraphView.tsx:509
- `wiki-inbox-list` — pages/MemoriesPage/components/WikiInboxPanel.tsx:191
- `wiki-subtopic-panel` — pages/MemoriesPage/components/WikiSubtopicPanel.tsx:112
- `wiki-subtopic-panel-intro--projects` — pages/MemoriesPage/components/WikiSubtopicPanel.tsx:165
- `wiki-search-results` — pages/MemoriesPage/components/WikiTab.tsx:1560
- `wiki-inbox-view` — pages/MemoriesPage/components/WikiTab.tsx:1580
- `wiki-archived-view` — pages/MemoriesPage/components/WikiTab.tsx:1622
- `wiki-parking-view` — pages/MemoriesPage/components/WikiTab.tsx:1655
- `wiki-topic-picker` — pages/MemoriesPage/components/WikiTopicPicker.tsx:132
- `wiki-topic-picker-input` — pages/MemoriesPage/components/WikiTopicPicker.tsx:205
- `wiki-topic-picker-hint-small` — pages/MemoriesPage/components/WikiTopicPicker.tsx:210
- `wiki-tree-editor` — pages/MemoriesPage/components/WikiTopicTreeEditor.tsx:228
- `wiki-disposition` — pages/MemoriesPage/components/WikiTopicTreeEditor.tsx:357
- `wiki-disposition` — pages/MemoriesPage/components/WikiTopicTreeEditor.tsx:366

## 七、执行批次

| 批次 | 内容 | 提交 |
|---|---|---|
| B0 | 死样式退场（68 条规则 412 行 + 4 处就地改写） | `refactor(wiki): 删除 58 个死类名的 412 行遗留样式` |
| B1 | WikiLeftNav + WikiTopBar + WikiMoreMenu + WikiBreadcrumb（含 @media 557-573 拆两块） | `refactor(wiki): 导航簇样式转 CSS Modules` |
| B2 | WikiFileList + WikiInboxPanel + WikiSubtopicPanel + wiki-shared.module.css（含 2452 拆分、动态映射×1） | `refactor(wiki): 文件列表簇样式转 CSS Modules` |
| B3 | WikiGraphView + CleanupView | `refactor(wiki): 图谱与清理视图样式转 CSS Modules` |
| B4 | WikiTaskCenter + WikiSourceDetailDrawer（含 @media 1604-1621 拆两块） | `refactor(wiki): 任务中心与资料抽屉样式转 CSS Modules` |
| B5 | WikiReclassifyView + WikiTopicPicker + WikiTopicTreeEditor + WikiMigrateReviewView | `refactor(wiki): 编目与主题簇样式转 CSS Modules` |
| B6 | WikiTab.tsx 布局余类 + 删除 WikiTab.css | `refactor(wiki): WikiTab 布局样式转 CSS Modules，删除 2598 行全局样式表` |
| B7 | WikiHelpDrawer.css / WikiSourceMeta.css 转 module | `refactor(wiki): 帮助抽屉与来源面板样式转 CSS Modules` |
