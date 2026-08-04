# K8s修仙传 · 漫画视频工作流

## 单集目录

`articles/<slug>/comic/`

## 生图（LLM-Link · `douyin-images/generate_image.py`）

配置：`douyin-content-pipeline/sub-skills/04-visuals/douyin-images/config.json`  
（可与 `xiaohongshu-content-pipeline/.../baoyu-xhs-images/config.json` 共用同一 key）

```powershell
$comic = "...\articles\01-container-intro\comic"
$imgScript = "...\douyin-content-pipeline\sub-skills\04-visuals\douyin-images\scripts\generate_image.py"
Set-Location (Split-Path $imgScript)

foreach ($pair in @(
  @("cover","01-cover.png"),@("panel-1","02-panel-1.png"),@("panel-2","03-panel-2.png"),
  @("panel-3","04-panel-3.png"),@("panel-4","05-panel-4.png"),@("panel-5","06-panel-5.png"),
  @("panel-6","07-panel-6.png")
)) {
  python .\generate_image.py --prompt-file "$comic\images\prompts.md" --section $pair[0] `
    --output "$comic\images\$($pair[1])" --size 1080x1920
}
```

## 配音合成

```powershell
python ...\compose_douyin_video_with_voice.py `
  --narration "$comic\video\narration.json" `
  --output "$comic\video\final.mp4"
```

## 发布草稿

```powershell
python ...\douyin_publish.py --article-dir $comic
```
