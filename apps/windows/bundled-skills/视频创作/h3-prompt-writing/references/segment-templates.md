# 3 秒分段时间轴模板库

## 一、一镜到底提示词总模板（I2VA）

```
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, phone-front-camera selfie style, the 19-year-old Chinese girl shown in <Picture 1> keeps her appearance, {服装描述}, loose black long hair, and seat position {位置描述}, {道具/手势描述}.
[0s-{A}s] {首帧锚定段：看向镜头/开场动作/第一句}
[{A}s-{B}s] {动作延续段：动作延续/下一句}
[{B}s-{C}s] {情绪推进段：表情变化/镜头极轻推近}
[{C}s-{D}s] {副歌/高潮段：幅度变化/继续演唱}
[{D}s-{E}s] {收尾锚定段：收尾动作/表情定格/声音收束}
The bedroom stays consistent throughout: bookshelf with warm lamp on the left, bed with off-white sheets behind her on the right, soft mixed window light from the left, slight natural grain, no cuts, no camera movement except the gentle handheld sway.

overall_soundscape: {环境音 + 动作音 + 非语言人声，1-4句}

non_diegetic_music: {背景音乐：乐器/速度/节奏/动态，1-3句}
```

## 二、常用承接语（一镜到底连续性）

- 动作自然延续（the motion continues naturally）
- 镜头保持不动（the camera holds a static shot）
- 身体随节拍继续摆动（she keeps swaying with the beat）
- 表情从X过渡到Y（her expression softens from X to Y）
- 声音无缝衔接（the vocals carry over seamlessly）

## 三、四要素检查清单（每段必查）

- [ ] 动作：这段她在做什么？
- [ ] 表情：这段她的情绪/面部状态？
- [ ] 声音：这段唱哪句歌词/什么声音？
- [ ] 镜头：固定/推近/晃动状态？

## 四、双模式参数速查

| 项 | 快速模式 | 质量模式 |
|----|---------|---------|
| ResolutionSelector.megapixels | 0.15 | 0.6 |
| BasicScheduler.steps | 20 | 20 |
| ResolutionSelector.aspect_ratio | 2:3 (Portrait Photo) | 2:3 (Portrait Photo) |
| SaveVideo.filename_prefix | ..._fast_ | ..._final_ |
| 预计耗时(15s) | 5-10 分钟 | 40-70 分钟 |

> ⚠️ 画面比例一律 **2:3**（原图比例），禁止 9:16（会拉伸变形）。0.9/1.0 超高画质仅限 ≤10s。

## 五、时长-分段速查

| 目标时长 | 帧数(17n+5) | 分段建议 |
|---------|------------|---------|
| 5s | 121 | [0-2s]+[2-5s] |
| 10s | 245 | [0-2s]+[2-5s]+[5-8s]+[8-10s] |
| 15s | 362 | [0-3s]+[3-6s]+[6-9s]+[9-12s]+[12-15s] |
| 20s | 485 | 每段4s×5 |
| 30s | 725 | 每段5s×6 |

帧数公式：`max(5, round(秒*24)) + (5 - (max(5, round(秒*24)) % 17)) % 17`
