# 消息气泡 + 审批卡 + 后台任务仪式化

> 日期：2026-11-08

## 范围

- ChatMessage：用户/助手气泡、代码块、行内代码、引用
- ConfirmationDialog / PermissionCard：审批卡光晕与按钮
- BackgroundTaskCard / TaskProgressBar：运行态青琥珀

## 原则

默认干净；关键态（审批等待、任务运行、代码 hover）才放青琥珀光。审批语义色仍用 warning，叠加仪式外晕。
