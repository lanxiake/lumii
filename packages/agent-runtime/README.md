# @mtbot/agent-runtime

客户端 Agent Runtime：在本地驱动 pi-agent-core、工具链与本地 SQLite 存储。

## 本地 SQLite 备份与恢复

- **主库路径（Windows 桌面端默认）**：`%USERPROFILE%\.mtbot-client\data\agent-runtime.db`
- **自动备份目录**：与主库同级的 `backups\`，文件名为 `agent-runtime_YYYY-MM-DD_HH-mm-ss.db.bak`
- **策略**：默认在每日本地时间 **凌晨 3:00** 执行备份，最多保留 **最近 10 次**；主进程在打开数据库成功后可选择 **立即备份一次**（`backupOnOpen`）
- **损坏恢复**：打开后执行 `PRAGMA integrity_check`；若失败，会尝试用 `backups` 目录中 **修改时间最新** 的 `.bak` 覆盖主库文件并重新打开（最多尝试一次）

若需手动恢复：退出应用，将 `backups` 中合适的 `.bak` 复制为 `agent-runtime.db`（先备份当前损坏文件），再启动应用。

## 大文件压缩

当主库文件超过 **100MB** 时，初始化阶段可能触发 `VACUUM`（见 `maybeRunAutoVacuumSync`）。
