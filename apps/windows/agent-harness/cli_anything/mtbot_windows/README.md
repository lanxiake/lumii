# cli-anything-mtbot-windows

MtBot Windows 客户端的命令行 harness。通过 CLI 启动/停止 Electron 应用、连接 Gateway、管理对话与技能。

## 依赖

- Python 3.10+
- MtBot Windows 应用（Electron）已构建或已安装
- （可选）运行中的 MtBot Gateway 服务

## 安装

```bash
cd apps/windows/agent-harness
pip install -e .
```

安装后命令行可用：

```bash
cli-anything-mtbot-windows --help
```

## 快速开始

```bash
# 进入交互式 REPL
cli-anything-mtbot-windows

# 启动应用（测试模式，隐藏窗口）
cli-anything-mtbot-windows app start --hidden --wait-ready

# 检查 Gateway 是否可连接
cli-anything-mtbot-windows gateway health

# 连接 Gateway
cli-anything-mtbot-windows gateway connect

# 列出对话
cli-anything-mtbot-windows --json conversation list

# 向会话发送消息
cli-anything-mtbot-windows conversation send --session-key user@default --message "你好"

# 停止应用
cli-anything-mtbot-windows app stop
```

## 命令组

| 命令组 | 说明 |
|--------|------|
| `project` | 项目/会话文件管理 |
| `app` | 应用生命周期（启动、停止、状态、重置） |
| `gateway` | Gateway WebSocket 连接与 RPC 调用 |
| `conversation` | 对话会话管理 |
| `skills` | 技能列表、安装、执行、启用/禁用 |
| `system` | 系统信息 |

## JSON 输出

所有命令都支持 `--json` 标志，输出结构化 JSON 供 AI agent 消费：

```bash
cli-anything-mtbot-windows --json app status
```

## 自动保存与 --dry-run

当使用 `--project` 指定会话文件时，一次性命令会在退出前自动保存会话状态。
使用 `--dry-run` 可禁止保存：

```bash
cli-anything-mtbot-windows --project session.json app start --hidden
cli-anything-mtbot-windows --project session.json --dry-run app start --hidden
```

REPL 模式下不自动保存，需手动执行 `project save`。

| 变量 | 说明 |
|------|------|
| `MTBOT_WINDOWS_APP` | MtBot Windows 应用目录 |
| `MTBOT_WINDOWS_EXE` | Electron/打包后可执行文件路径 |
| `MTBOT_CLIENT_DATA_DIR` | 客户端数据目录 |
| `MTBOT_GATEWAY_URL` | 默认 Gateway URL |
| `CLI_ANYTHING_FORCE_INSTALLED` | 测试时强制使用已安装命令 |

## 测试

```bash
python -m pytest cli_anything/mtbot_windows/tests/ -v
```

## 设计说明

本 harness 遵循 [cli-anything](https://github.com/HKUDS/CLI-Anything) 方法论：
CLI 是真实 MtBot Windows 应用的命令行接口，通过启动 Electron 进程并与其后端 Gateway 通信完成操作，不替代应用本身的功能。
