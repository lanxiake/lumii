# 云同步传输进度（设置页）

**日期**：2026-10-27  
**范围**：仅设置页「同步状态」；方案 C（真 git 进度 + 大文件队列 ETA）

## 目标

同步进行中展示：方向（上/下载）、阶段、百分比、已传/总体积、速度、预计剩余时间。

## 数据

`SyncStatus.transfer?`：

- `direction`: `download` | `upload`
- `phase`: git 阶段文案（Receiving objects 等）
- `percent?` / `transferredBytes?` / `totalBytes?` / `speedBytesPerSec?` / `etaSeconds?`

同步结束（idle/error/conflict）清空 `transfer`。

## 主进程

1. `runGit` 增加可选 `onStderrChunk`（按 `\r`/`\n` 拆行）。
2. 解析 git `--progress` 英文行（进程已 `LC_ALL=C`）。
3. `nativeFetch` / `nativePush` 回调进度 → `CloudSyncManager` 写入 status 并 `emit`；**500ms 节流**；不写同步日志。
4. 阶段二 `LargeQueueStats` 增加近期速度与 ETA（按批完成字节/耗时）。

## UI

设置页在 `status.transfer` 存在时多一行人类可读文案；大文件队列在 `pumping` 时附 ETA。

## 非目标

角标、独立进度条、历史曲线、iso 回退路径的细粒度进度。
