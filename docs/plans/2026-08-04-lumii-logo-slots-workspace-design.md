# Lumii Logo / 能力槽 / 工作区 设计

**Goal:** 统一 Lumii 品牌；支持 chat/vision/image 独立 Provider 配置；修复首次工作区初始化错误。

**Architecture:** 本地 `provider.json` 升级为按模态槽（chat/vision/image）独立配置；UI 槽位卡片 + 复制/拉列表/测试；主进程补 subscription stub；`file:copy` 解引用 symlink 避免跨盘 EPERM。

**Slots:** chat / vision / image（ASR/TTS 本阶段不迁入）
**Provider per slot:** type, baseUrl, apiKey, modelId, enabled
**UX:** 从文本对话复制、获取模型列表、测试连接、未启用槽折叠

**Workspace:** stub `api:getSubscription*`；`fs.cp({ dereference: true })`；跳过 projects junction；独立版弱化 Gateway 报错；文案 MtBot→Lumii
