---
name: post-to-douyin
description: 抖音 CDP 浏览器自动化发布。通过 Chrome DevTools 填充创作者中心草稿（图文/视频），支持合集、自主声明、定时发布、封面、平台音乐，停在预览待人工确认。触发词：发抖音、填充抖音草稿、抖音 CDP 发布、创作者中心上传。
---

# 抖音 CDP 发布

通过 CDP 连接本机 Chrome，在 [抖音创作者中心](https://creator.douyin.com) 填充完整发布草稿，输出 `DRAFT_STATUS: READY_TO_REVIEW` 后**由用户人工确认发布**。

> 安全边界：绝不自动点击最终发布。

## 四种发布方式

| mode | 通道 | 形态 | 入口 |
|------|------|------|------|
| `cdp-image` | CDP | 图文 | `douyin_cdp_publish.py fill-image` |
| `cdp-video` | CDP | 视频 | `douyin_cdp_publish.py fill-video` |
| `sau-image` | sau CLI | 图文 | `sau douyin upload-note` |
| `sau-video` | sau CLI | 视频 | `sau douyin upload-video` |

统一分发：`douyin_publish.py --article-dir <笔记目录>`（读取 `publish-options.json` 的 `mode`）。

## 支持的发布选项

通过 `publish-options.json` 或 CLI 参数配置：

| 字段 | 说明 |
|------|------|
| `title` / `publish-title.txt` | 作品标题 |
| `content` / `publish-desc.txt` | 作品简介 |
| `collection` | 添加到合集（下拉选择） |
| `declaration` | 自主声明（如「个人观点，仅供参考」） |
| `schedule` | 定时发布 `YYYY-MM-DD HH:MM`，空=立即发布 |
| `cover` | 自定义封面图路径 |
| `music.keyword` | 平台曲库搜索词（图文必选能力；视频页若展示曲库同样适用） |
| `music.pick_index` | 曲库搜索结果序号 |
| `bgm` | 视频合成时混入的背景音乐（见 compose-douyin-video） |
| `tags` | 话题标签（sau CLI 使用） |
| `account` | Chrome Profile / sau 账号名 |

示例：`scripts/publish-options.example.json`

## 依赖

```powershell
python -m pip install requests websockets
```

## 账号管理

```powershell
cd sub-skills/05-publish/post-to-douyin/scripts
python account_manager.py list
python douyin_cdp_publish.py login
python douyin_cdp_publish.py check-login
```

## 图文图集（CDP）

```powershell
python douyin_cdp_publish.py fill-image `
  --options "<笔记目录>/publish-options.json" `
  --title-file "<笔记目录>/publish-title.txt" `
  --content-file "<笔记目录>/publish-desc.txt" `
  --images "<笔记目录>/images/01-cover.png" "<笔记目录>/images/02-content-1.png" `
  --collection "K8s架构师速通" `
  --declaration "个人观点，仅供参考" `
  --cover "<笔记目录>/images/01-cover.png" `
  --music-keyword "轻音乐"
```

## 视频（CDP）

```powershell
python douyin_cdp_publish.py fill-video `
  --options "<笔记目录>/publish-options.json" `
  --video "<笔记目录>/video/final.mp4" `
  --collection "K8s架构师速通" `
  --declaration "个人观点，仅供参考" `
  --schedule "2026-06-13 18:00" `
  --cover "<笔记目录>/images/01-cover.png" `
  --music-keyword "科技"
```

## 统一发布入口

```powershell
# 按 publish-options.json 的 mode 自动分发
python douyin_publish.py --article-dir "<笔记目录>"

# 覆盖为 CDP 图文
python douyin_publish.py --article-dir "<笔记目录>" --mode cdp-image

# 发布前先合成配音视频（含 BGM）
python douyin_publish.py --article-dir "<笔记目录>" --mode cdp-video --prepare-video
```

## 视频 BGM（合成阶段）

平台音乐在发布页选择；视频文件内背景音乐在合成时混入：

```powershell
python sub-skills/04-visuals/compose-douyin-video/scripts/compose_douyin_video_with_voice.py `
  --narration "<笔记目录>/video/narration.json" `
  --output "<笔记目录>/video/final.mp4" `
  --bgm "assets/bgm/your-track.mp3" `
  --bgm-volume 0.15
```

## 发布后留档

写 `publish-report.md`，更新合集 `00-series-outline.md`。

## 故障排查

| 现象 | 处理 |
|------|------|
| 标题未填入 | 确认已跳转到 `/content/post/image` 或 `/video` 编辑页 |
| 合集/声明未选中 | 检查合集名称是否与账号内已有合集完全一致 |
| 音乐未选中 | 曲库弹层改版时更新 `douyin_ui.py` |
| 定时发布未生效 | 确认 `--schedule` 格式为 `YYYY-MM-DD HH:MM` |
