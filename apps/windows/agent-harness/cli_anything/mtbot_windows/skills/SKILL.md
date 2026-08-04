---
name: "cli-anything-mtbot-windows"
description: "MtBot Windows 桌面客户端的命令行控制 harness，支持应用生命周期管理、Gateway 连接、对话与技能操作。"
---

# cli-anything-mtbot-windows

MtBot Windows 桌面客户端的命令行接口。通过 CLI 启动/停止 Electron 应用、连接 MtBot Gateway、管理对话与技能。

## 安装

```bash
pip install cli-anything-mtbot-windows
```

**前置条件：**
- Python 3.10+
- MtBot Windows 应用已构建或已安装

## 用法

### 基本命令

```bash
# 显示帮助
cli-anything-mtbot-windows --help

# 进入交互式 REPL
cli-anything-mtbot-windows

# 启动应用（隐藏窗口，测试模式）
cli-anything-mtbot-windows app start --hidden --wait-ready

# 检查 Gateway 健康状态
cli-anything-mtbot-windows gateway health

# 连接 Gateway
cli-anything-mtbot-windows gateway connect
```

### JSON 输出（供 AI Agent 使用）

所有命令都支持 `--json`：

```bash
cli-anything-mtbot-windows --json app status
cli-anything-mtbot-windows --json conversation list
cli-anything-mtbot-windows --json skills list
```

### 自动保存与 --dry-run

使用 `--project` 指定会话文件时，一次性命令退出前会自动保存会话状态。使用 `--dry-run` 禁止保存：

```bash
cli-anything-mtbot-windows --project session.json app start --hidden
cli-anything-mtbot-windows --project session.json --dry-run app start --hidden
```

## 命令组

### `project`

项目/会话文件管理。

| 命令 | 说明 |
|------|------|
| `project new -o PATH` | 创建新会话文件 |
| `project info` | 查看当前会话信息 |
| `project save` | 保存会话 |

### `app`

应用生命周期。

| 命令 | 说明 |
|------|------|
| `app start` | 启动 Electron 应用 |
| `app stop` | 停止应用 |
| `app status` | 查看应用状态 |
| `app reset` | 重置客户端数据（危险） |

### `gateway`

Gateway WebSocket 连接。

| 命令 | 说明 |
|------|------|
| `gateway connect` | 连接 Gateway |
| `gateway disconnect` | 断开连接 |
| `gateway status` | 查看连接状态 |
| `gateway health` | TCP 端口健康检查 |
| `gateway call METHOD [PARAMS]` | 调用 Gateway RPC |

### `conversation`

对话会话。

| 命令 | 说明 |
|------|------|
| `conversation list` | 列出会话 |
| `conversation create` | 创建会话 |
| `conversation send --session-key KEY --message TEXT` | 发送消息 |
| `conversation abort --session-key KEY` | 中断生成 |

### `skills`

技能管理。

| 命令 | 说明 |
|------|------|
| `skills list` | 列出已安装技能 |
| `skills install DIRECTORY` | 从目录安装技能 |
| `skills execute SKILL_ID` | 执行技能 |
| `skills enable SKILL_ID` | 启用技能 |
| `skills enable SKILL_ID --disable` | 禁用技能 |

### `system`

| 命令 | 说明 |
|------|------|
| `system info` | 查看系统/环境信息 |

## 示例工作流

```bash
# 1. 启动应用
cli-anything-mtbot-windows app start --hidden --wait-ready

# 2. 等待 Gateway 就绪
cli-anything-mtbot-windows gateway health --timeout 30

# 3. 连接 Gateway
cli-anything-mtbot-windows gateway connect

# 4. 列出对话
cli-anything-mtbot-windows --json conversation list

# 5. 发送消息
cli-anything-mtbot-windows conversation send --session-key user@default --message "你好"

# 6. 停止应用
cli-anything-mtbot-windows app stop
```

## AI Agent 使用指南

1. **始终使用 `--json`** 获取可解析输出
2. **先 `app start` 再使用 Gateway 相关命令**
3. **使用 `gateway health` 检查 Gateway 是否可连接**
4. **所有文件路径使用绝对路径**
5. **操作完成后调用 `app stop` 释放资源**

## 环境变量

| 变量 | 说明 |
|------|------|
| `MTBOT_WINDOWS_APP` | 应用目录 |
| `MTBOT_WINDOWS_EXE` | 可执行文件路径 |
| `MTBOT_CLIENT_DATA_DIR` | 客户端数据目录 |
| `MTBOT_GATEWAY_URL` | 默认 Gateway URL |

## 更多信息

- 测试报告：`cli_anything/mtbot_windows/tests/TEST.md`
- 详细 SOP：`MTBOT_WINDOWS.md`
- cli-anything 方法论：`HARNESS.md`

## 版本

1.0.0
