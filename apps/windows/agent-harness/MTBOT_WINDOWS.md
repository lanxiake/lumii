# MtBot Windows CLI Harness SOP

## 软件背景

MtBot Windows 是一个基于 Electron + React 的桌面 AI 助手客户端，职责包括：
- 管理主窗口与系统托盘
- 通过 WebSocket 连接到 MtBot Gateway
- 运行本地 Agent Runtime 与技能
- 管理设备配对、记忆、文件、语音通话等

## CLI Harness 定位

本 CLI harness 是 MtBot Windows 的命令行控制接口，用于：
1. 启动/停止 Electron 应用
2. 检查应用与 Gateway 状态
3. 通过 Gateway 协议管理对话和技能
4. 将应用状态持久化到 JSON 会话文件

## 架构映射

| GUI 操作 | CLI 命令 | 后端实现 |
|----------|----------|----------|
| 打开应用 | `app start` | 启动 Electron 进程 |
| 关闭应用 | `app stop` | 终止 Electron 进程 |
| 查看连接状态 | `gateway status` | GatewayClient WebSocket 状态 |
| 发送聊天消息 | `conversation send` | Gateway RPC `chat.send` |
| 执行技能 | `skills execute` | Gateway RPC `skills.executeLocal` |
| 查看已安装技能 | `skills list` | Gateway RPC `skills.listLocalInstalled` |

## 后端调用方式

1. **应用生命周期**：直接调用 Electron 可执行文件或 `node_modules/.bin/electron`。
2. **Gateway 通信**：使用 `websocket-client` 库实现 MtBot 协议握手与 RPC 调用。
3. **状态持久化**：使用 `core/session.py` 维护 JSON 会话文件，支持 undo/redo。

## 限制

- 必须先启动 Gateway 服务才能使用 `conversation`、`skills` 等命令。
- Electron 应用必须在当前环境可找到（开发模式或已打包安装）。
- 部分 Gateway RPC 方法名称需与实际 Gateway 协议对齐。

## 扩展指南

新增命令：
1. 在 `core/` 下添加新的功能模块。
2. 在 `mtbot_windows_cli.py` 中注册新的 Click 命令组。
3. 更新 `README.md` 和 `SKILL.md`。
4. 在 `tests/test_core.py` 中添加单元测试。
