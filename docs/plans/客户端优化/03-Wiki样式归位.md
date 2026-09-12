# 第 3 片 · Wiki 样式归位 — 实施计划

> 创建：2026-09-12 · 状态：**已确认，执行中**（决策记录见文末）
> 上位文档：[客户端优化切片计划](./README.md)
> 规格数据：[03a-Wiki类名归属对照表.md](./03a-Wiki类名归属对照表.md)（由脚本从源码解析生成）
> 复核方式：脚本解析 CSS 选择器与全部 ts/tsx 字面量（含模板字符串）+ git 历史 -S 探针 + 全仓 CSS 交叉扫描

---

## 一、审计结论（修正 README 的旧数据）

README 切片总表记录「WikiTab.css 2597 行按 13 个子组件切 module.css，消除 21 个文件 × 359 处字面类名耦合」。实测修正：

| 项 | README 旧数据 | 实测 |
|---|---|---|
| 样式规模 | WikiTab.css 2597 行 | **3 个文件 2847 行**（WikiTab.css 2598 + WikiHelpDrawer.css 180 + WikiSourceMeta.css 69） |
| 类名总数 | — | **310 个**（287 + 14 + 9） |
| 耦合文件数 | 21 个文件 | **18 个 ts/tsx**（另 2 个是测试与 hook 误计） |
| 字面引用数 | 359 处 | **325 处** |

结构上好消息（降低了迁移风险）：

- **零元素级/通配符规则、零 @keyframes、零变量定义**——三个文件是纯类选择器样式，迁移到 CSS Modules 无全局泄漏面。
- 类名冲突面小：**227 个单文件归属 + 5 个共享 + 20 个动态模板覆盖 + 58 个死类名 = 310**。
- 跨模块复合选择器只有 **2 处**（见下），其余多类选择器都在同一组件内。

本次审计还发现两类存量问题（均非旧结论，属新发现）：

1. **死样式 68 条规则 = 412 行**（58 个类名全仓零引用）：主力是「页面/编辑/历史」系功能的遗留——git 证据 `bddda73`（2026-09-01 remove history-page UI）、`484ee60`（2026-08-30 simplified left nav）移除 UI 时只删了 JSX，样式原样残留。附 4 条混合规则需就地改写：
   - `828` `.wiki-file-list-title-cluster .wiki-file-list-title--link`（cluster 已死）
   - `855` `.wiki-file-list-action-btn .btn-content`——`btn-content` 是 `ui/Button` 的**模块哈希类**，该后代规则永远匹配不上（历史遗留的失效规则）
   - `1606-1621` @media 中的 `.wiki-detail-drawer`、`2342` h3 组合规则中的 link/preview 两段
2. **19 处无样式类名**：tsx 里用了、任何 CSS 都没定义（如 `wiki-cleanup-view`、`wiki-topic-picker-input`）。删除属 JSX 清理，非本片范围，**登记不动**。

## 二、技术方案

### 2a · 切分原则

1. 每个组件一个 `X.module.css`，类名保持原样（`styles['wiki-xxx']` 访问方式与仓库现有 module 用法一致）。
2. 共享类入 `wiki-shared.module.css`（`wiki-empty-hint` 被 7 个文件用、`wiki-cleanup-header/actions`、`wiki-tooltip-below`、`wiki-reclassify-hint`）。
3. **2266 复合规则** `.wiki-category-view .wiki-file-list-header` 跨 WikiTab/WikiFileList 两文件——把两个类名连同该规则一并放共享模块（CSS Modules 要求复合选择器两端在同文件）。
4. **2452 逗号规则** `.wiki-file-list-title--link:hover, .wiki-inbox-item-title--link:hover` 跨两文件——拆成两条同内容规则，各归各模块。
5. **动态模板**（5 处，覆盖 20 个类）改为显式映射表：`const STATUS_CLS: Record<Status, string> = { pending: styles['wiki-inbox-item-status--pending'], ... }`。
6. **3 个 @media 块**：`557-573` 需拆两块（左栏规则→LeftNav 模块、顶栏规则→TopBar 模块）；`1604-1621` 需拆两块（TaskCenter / SourceDetailDrawer）；`814-818` 单模块直接搬。
7. `--wiki-subtopic-bar-height` 是运行时注入到 `documentElement` 的变量（WikiTab.tsx:502），模块化后继续生效，无需处理。

### 2b · 迁移安全机制（每批必做）

- **逐字搬移**：规则声明原文复制，不改任何字面值。
- **等价性脚本**：对每批迁移的类，`git show HEAD:` 旧 WikiTab.css 提取声明块 vs 新 module.css，规范化后比对，必须完全一致。
- **残留扫描**：批内文件不再出现白名单外的字面 `wiki-*` 类名。
- **转换窗口安全性**：迁移期全局规则与模块规则并存，但每个元素的 className 同一时刻只可能是一种形态（字面量 or 哈希），不产生双重命中；跨模块组合规则按 2a-3/4 一次性处理。
- `pnpm typecheck` + `pnpm build` 每批必过。

## 三、批次（每批独立提交、独立验证、可单独回滚）

| 批次 | 内容 | 验证 |
|---|---|---|
| B0 | 死样式退场：68 条规则 412 行 + 4 处就地改写 | 引用复扫归零 + build + 视觉冒烟 |
| B1 | WikiLeftNav + WikiTopBar + WikiMoreMenu + WikiBreadcrumb | 等价性脚本 + 残留扫描 + build |
| B2 | WikiFileList + WikiInboxPanel + WikiSubtopicPanel + wiki-shared 建立（含 2266/2452 处理、动态映射 1 处） | 同上 |
| B3 | WikiGraphView + CleanupView | 同上 |
| B4 | WikiTaskCenter + WikiSourceDetailDrawer（@media 拆分） | 同上 |
| B5 | WikiReclassifyView + WikiTopicPicker + WikiTopicTreeEditor + WikiMigrateReviewView | 同上 |
| B6 | WikiTab.tsx 布局余类 + 删除 WikiTab.css（2598 行） | 同上 + 全仓复扫 |
| B7 | WikiHelpDrawer.css / WikiSourceMeta.css 转 module | 同上 |

收尾：README 切片表数据更正 + 03 文档执行记录 + 记忆更新；临时审计脚本删除。

## 四、明确不做

- 19 处无样式类名（登记，见 03a 第六节）
- `ui/Button` 的任何改动（WikiFileList 的 `wiki-file-list-action-btn` 作为 className 传递的用法保留）
- 组件逻辑、JSX 结构、props 的调整（本片只动样式与 className 取法）
- 其他页面的类似问题（切片 4/5 范围）

## 五、风险与对策

| 风险 | 对策 |
|---|---|
| 迁移期视觉回归 | B0 后与全部完成后人工冒烟；其余批次等价性脚本保证声明零变化 |
| 复合选择器拆错 | 22 条多类选择器已全部列出行号，逐条核对归属 |
| vite 对 module.css 处理差异 | 与仓库既有 300+ 个 module.css 同构，无特殊配置 |
| 遗漏动态类名 | 5 个模板位点已定位到行号；迁移时以显式映射表替换，编译期即可发现遗漏 |

## 六、决策记录（2026-09-12 已确认）

1. **B0 死样式退场：执行**。迁移面从 310 类缩至 252 类。
2. **批次粒度：B0-B7 八个独立提交**，每批独立验证、可单独回滚。
3. **HelpDrawer/SourceMeta 一并转 module**（B7），完成后 Wiki 模块无全局样式文件。
4. **19 处无样式类名：只登记不处理**（03a 第六节），遵循"不做顺手改动"原则。
