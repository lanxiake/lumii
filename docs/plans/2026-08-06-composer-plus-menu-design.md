# Composer「+」菜单设计

**日期：** 2026-08-06  
**状态：** 已批准

## 目标

优化聊天输入框：合并附件入口，用左侧「+」统一承载附件 / 技能 / MCP / Agent，并贴合现有玻璃态设计（不照搬原型）。

## 决策

| 项 | 选择 |
|----|------|
| Agent 入口 | 迁入「+」菜单，工具栏去掉 Agent 下拉 |
| 技能 / MCP 开关 | 全局（与技能中心一致） |
| 菜单项 | 附件、技能、MCP、切换 Agent；子面板底栏「管理」跳转 |

## 架构

- 新增 `ComposerPlusMenu`：主菜单 + 三级子面板（技能 / MCP / Agent）
- `ChatInput`：左侧「+」，合并单一 file input；工具栏仅保留模型 / 思考 / 压缩 / 帮助 / 语音 / 发送
- 数据：`useSkills`、`useToolSearch`、现有 Agent props；导航经 `onViewChange` + `mtbot:open-skills-tab` 事件

## 交互

1. 点击「+」→ 主菜单（向上弹出）
2. 「添加文件或图片」→ 统一文件选择器
3. 「技能 / MCP / 切换 Agent」→ 子面板（搜索 + 列表 + Switch / 选择）
4. 「管理技能 / 管理 MCP / 管理 Agent」→ 对应页面
