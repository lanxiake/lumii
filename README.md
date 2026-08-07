# 灵栖 Lumii

本地优先的 AI 桌面伙伴 —— 开源独立版。

Lumii 是一个 Windows 桌面 AI 助手：对话、技能执行、定时任务、语音、Live2D 桌宠、浏览器自动化，全部运行在本地。无需自建后端、无需登录，直接在客户端配置模型服务商即可使用。

## 特性

- **本地优先**：对话历史、记忆、配置、Agent 定义全部存储在本机（`~/.mtbot-client/`），不依赖任何远程服务。
- **直连模型**：在客户端配置 OpenAI / Anthropic / 兼容 OpenAI 协议的服务商，直接调用（direct-stream），无中转。
- **Agent 与技能**：内置 Agent 运行时，支持自定义 Agent、技能（Skills）执行、子 Agent 派生。
- **定时任务**：本地 cron 调度，支持 at / every / cron 表达式，可驱动 Agent 或发系统通知。
- **多渠道接入**：飞书、企业微信、微信 IM（可选，需各平台登录）。
- **语音与桌宠**：Edge TTS 流式语音、Live2D 桌宠陪伴。

## 环境要求

- Windows 10/11 (x64)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/) 10+

## 开发

```bash
pnpm install          # 安装依赖（会自动为 Electron 重建原生模块）
pnpm dev              # 启动开发模式
pnpm typecheck        # 类型检查
```

## 打包

```bash
pnpm dist             # 打包 Windows 安装包（NSIS + portable + zip）
```

产物输出到 `apps/windows/release/`。

单独目标：

```bash
cd apps/windows
pnpm package:nsis     # 仅 NSIS 安装器（x64 + ia32）
pnpm package:portable # 仅便携版
pnpm package:zip      # 仅 zip
```

## 配置

首次启动后，在应用内「设置」中配置模型服务商（API Key 与地址）。所有配置保存在：

- `~/.mtbot-client/config/` —— 服务商、Agent 配置
- `~/.mtbot-client/data/` —— 人格（soul.md）、个人记忆、对话数据

Web 搜索为可选功能，可在 `apps/windows/.env` 或用户数据目录下的 `.env` 配置 `SEARXNG_BASE_URL` 或 `LANGSEARCH_API_KEY`。核心对话与 Agent 不依赖网关 / API Server。

## 许可

[MIT](./LICENSE) © 2026 Lumii
