# 客户端优化（renderer）· 切片计划

> 创建：2026-09-12
> 范围：`apps/windows/src/renderer`（222 个 TSX / 53171 行 + 134 个 CSS）
> 关联：[代码重构瘦身](../代码重构瘦身/README.md)（本计划是其「批次 2/3」在客户端一侧的重新排期）

---

## 一、为什么改为切片推进

原「批次 2 · 抽象落地」按"抽象原语"横向铺开（先造基类/门面，再全仓替换），批次粒度大、周期长、验证面宽；实际上一次性的全仓重构在上一轮已经出过问题（拆完没有门禁，文件涨回去）。

本计划改为**纵向切片**：每一片是一个**可独立提交、独立验证、可单独回滚**的完整改善，做完一片结算一片。不追求一次性还清技术债。

## 二、切片总表

| 片 | 范围 | 体量 | 风险 | 状态 |
|---|---|---|---|---|
| **1 · 样式地基** | tokens.css 死定义清理 + ChatPage.global.css 越界/死代码退场 + 未定义变量补齐 | 纯 CSS，2–3 文件 | 低 | **已完成**（2026-09-12）→ [实施计划](./01-样式地基.md) · [变量对照表](./01c-未定义变量对照表.md) |
| 2 · ui 组件库收敛 | 6 个零引用 ui 组件逐个复核后清理、桶导出处理、补 IconButton/Tabs 场景，按页替换标准按钮 | 组件层，可多次提交 | 低 | **已完成**（2026-09-12）→ [实施计划](./02-ui组件库收敛.md)；按钮替换试点已回退（见文档"试点结论"） |
| 3 · Wiki 样式归位 | 3 个全局样式文件 2847 行 / 310 个类 → 19 个 module.css，消除 18 文件 × 325 处字面类名耦合；含 58 个死类名 496 行退场（B0） | 大但机械 | 中 | **已完成**（2026-09-12，9 个提交）→ [实施计划](./03-Wiki样式归位.md) · [类名归属对照表](./03a-Wiki类名归属对照表.md) |
| 4 · ChatPage 结构 | 21 个 props 穿透收敛（引 Chat 会话 Context）+ 删除与 ui/Toast 重复的本地 Toast | 中 | 中 | 未开始 |
| 5 · 数据层规范 | 16 个 hook 迁移到 useQuery/useAsync；pages/components 中 169 处直调 electronAPI 收敛到 services | 大，可再细分 | 中 | 未开始 |

## 三、切片依据（体检结论摘要，证据均为 file:line）

### 样式体系

| 问题 | 关键数据 |
|---|---|
| `styles/tokens.css` 两个 `:root` 块自我覆盖 | 块1(:9-292) 中 **66 个定义**被块2(:302-399) 映射层压掉；头部 "Generated from TypeScript tokens" 是失真注释（生成源 2026-08-25 已删） |
| `pages/ChatPage/ChatPage.global.css` 越界 + 死代码 | `*` / `*:focus-visible` / `input,textarea` 无差别命中全应用；与 `global.css` 重复定义滚动条（8px vs 6px）与 `::selection`，且随 ChatPage 懒加载**动态覆盖** |
| 未定义变量 | **63 个**被引用但从未定义（另有 8 个是 JS 运行时注入的正确用法），累计 200+ 次引用；反向 tokens.css/design-system.css 中 164 个定义零引用 |
| 硬编码 | 颜色 1315 处、font-size 694 处；z-index 26 个不同数值（最高 100000，token 上限 12000） |
| 全局巨表 | `WikiTab.css` 2597 行；`@keyframes` 撞名（spin ×6 / pulse ×5，Vite 会 localize，属坏味道非 bug） |

### 组件与数据

| 问题 | 关键数据 |
|---|---|
| ui 基础组件库"建而不用" | 505 处原生控件 vs 44 处 Button；**6 个 ui 组件全仓零引用**（Avatar/Divider/Radio/Responsive/Skeleton/Table）；`ui/index.ts` 桶导出 0 消费者 |
| Toast 双实现 | ChatPage 本地版（43 行）仅 1 处使用；ui/Toast 被 19 个文件使用 |
| props 穿透 | ChatPage → ChatContainer 传 21 个 props；`onReviewFileChanges` 穿 4 层 |
| hook 手写样板 | 16 个 hook 手写 loading/error；仅 4 个用 `useQuery` 家族 |
| services 破口 | pages/components 中 169 处直调 `window.electronAPI`（54 文件） |

## 四、执行原则

1. **每片独立提交**，提交信息含验证结果；验证不过不进入下一片。
2. **改前先证明安全**：涉及"删除看似无用代码"时必须给出零变更论证（级联规则、引用计数复核、构建产物比对），不凭"看起来没人用"下手。
3. **视觉变更必须显式登记**：凡预期出现像素级变化的项，在计划里列清单，交付时逐项说明。
4. 不做"顺手"改动：单片范围外的发现只登记不处理。
