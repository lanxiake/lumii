---
name: h3-drama-director
description: MiniMax H3 短剧多镜头编导专家。将剧本分解为分镜序列，规划角色/场景/声音一致性策略，选择 FL2VA/Ref2VA 模式，管理批量生成队列。需要搭配 h3-workflow-designer 和 h3-video-editor 使用。
---

# H3 短剧多镜头编导

## 核心策略

短剧 = 多个独立镜头视频顺序拼接。H3 本身不支持跨镜头记忆，一致性靠以下三个手段实现：

| 一致性类型 | 策略 | 使用模式 |
|-----------|------|---------|
| **角色外貌一致** | 每个镜头都注入同一套参考图（正面/侧面/特写） | Ref2VA |
| **画面连续衔接** | 上一镜末帧作为下一镜首帧 | FL2VA |
| **声音风格一致** | 固定 overall_soundscape 模板 + 可选参考音频 | Ref2VA/I2VA 均可 |

---

## 工作流程（六步）

### 步骤 0：接收剧本，拆分分镜

将剧本转换为分镜表，每行一个镜头：

```
镜号 | 时长 | 景别 | 动作/内容 | 角色 | 声音 | 衔接方式
-----|------|------|---------|------|------|--------
1   | 5s   | 全景  | 女主走进咖啡馆，环顾四周 | 女主 A | 咖啡馆背景音 | 开场（Ref2VA）
2   | 5s   | 中景  | 女主落座，望向窗外 | 女主 A | 椅子声、轻音乐 | 接上一镜（FL2VA）
3   | 5s   | 特写  | 女主微笑，拿起咖啡杯 | 女主 A | 瓷杯碰撞声 | 接上一镜（FL2VA）
4   | 5s   | 中景  | 男主推门而入，眼神相遇 | 男主 B | 推门声 | 场景切换（Ref2VA）
```

**拆分原则：**
- 同一角色连续动作 → 优先 FL2VA（首尾帧衔接）
- 场景切换 / 跳跃剪辑 → 改用 Ref2VA（重新锚定角色）
- 每个镜头 5~10s（4060Ti 推荐 ≤5s/镜提高出片速度）

---

### 步骤 1：准备参考素材

**角色参考图（Ref2VA 专用）**

每个主要角色准备 2~4 张参考图：

| 图片 | 内容要求 | 文件命名 |
|------|---------|---------|
| 正面全身 | 站立、自然光、清晰服装 | `charA_front.jpg` |
| 侧面/半身 | 侧45°或半身 | `charA_side.jpg` |
| 面部特写 | 正面面部，表情自然 | `charA_face.jpg` |
| 服装细节（可选） | 服装特写，便于 H3 记忆 | `charA_outfit.jpg` |

**参考音频（可选，声音引导）**

如需保持角色声音风格一致：
- 录制或找到角色声音样本（5~15s，干净无噪）
- 命名：`charA_voice.mp3`
- 在 Ref2VA 工作流中接入 `ref_audio_0`

**末帧提取（FL2VA 用）**

每次镜头生成完毕后，立即提取最后一帧备用：
```bash
ffmpeg -sseof -0.1 -i shot01.mp4 -frames:v 1 shot01_last.jpg
```

---

### 步骤 2：生成分镜工作流队列

为每个镜头确定工作流类型：

**Ref2VA 工作流（角色锚定镜头）**

- UNETLoader：`minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- mode：`Ref2VA`
- LoRA：bypass（Ref2VA 不支持 turbo LoRA）
- 连线：LoadImage × 2~4 → `ref_image_0/1/2/3`
- 提示词中引用：`<Picture 1>` = ref_image_0，`<Picture 2>` = ref_image_1

**FL2VA 工作流（连续动作镜头）**

- UNETLoader：`minimax_h3_fl2va_int8_convrot.safetensors`（与 I2VA 相同）
- mode：`FL2VA`
- 连线：`LoadImage_first` → `first_frame`，`LoadImage_last` → `last_frame`
- 上一镜末帧 → 本镜首帧；本镜期望末帧（可选）→ 本镜 last_frame

详细节点配置见 `../references/workflow-reference.md` 第八章。

---

### 步骤 3：🔴 参数确认（每镜头独立确认）

每个镜头提交前，展示参数表：

```
📋 镜头 #N 生成参数

| 参数 | 值 | 说明 |
|------|----|------|
| 镜号 | Shot 2/8 | 共8个镜头 |
| 模式 | FL2VA | 接 Shot 1 末帧 |
| 首帧文件 | shot01_last.jpg | Shot 1 末帧 ✅ |
| 尾帧文件 | （不设定） | 让模型自由生成 |
| 时长 | 5s | 帧数 124 |
| megapixels | 0.15 | 快速验证 |
| 采样步数 | 8 | 快速验证 |
| noise_seed | 43 | 递增，便于复现 |
| filename_prefix | drama_ep1_shot2_ | 镜号标识 |

💡 建议：
- Shot 2 与 Shot 1 场景相同，FL2VA 可保持画面流畅
- 建议先出 Shot 1（Ref2VA）确认角色外貌后再排队其余镜头

输入"确认/可以/OK"提交此镜头。
```

---

### 步骤 4：批量排队生成

所有镜头确认后，按顺序逐一提交（不必等上一个完成）：

```
排队策略：
1. Ref2VA 镜头（角色锚定）先提交，作为参照基准
2. FL2VA 镜头需等前一镜末帧，按顺序提交
3. 同一剧集的镜头用 seed 递增：shot1=42, shot2=43...
4. 记录表格保存 prompt_id + seed + 文件名前缀
```

**镜头生成记录表（建议维护）：**

```
镜号 | prompt_id | seed | 文件 | 状态 | 末帧文件
-----|-----------|------|------|------|--------
1   | abc123    | 42   | drama_ep1_shot1_00001_.mp4 | ✅完成 | shot1_last.jpg
2   | def456    | 43   | drama_ep1_shot2_00001_.mp4 | ⏳生成中 | -
```

---

### 步骤 5：结果验收

每个镜头完成后按以下标准验收：

| 检查项 | Ref2VA 镜头 | FL2VA 镜头 |
|-------|-------------|-----------|
| 角色外貌 | 与参考图一致？ | 与前一镜一致？ |
| 动作连贯 | 动作是否自然 | 接续前一镜是否流畅？ |
| 画面质量 | 快速验证清晰度可接受？ | 同左 |
| 时长正确 | 目标秒数？ | 同左 |

出现问题 → 调用 `h3-quality-optimizer` 诊断。

---

### 步骤 6：剪辑合成（交棒 h3-video-editor）

所有镜头验收通过后，交给 `h3-video-editor` 完成最终合成：

```bash
# 拼接所有镜头（同编码参数时用 concat demuxer）
# 创建 shots_list.txt:
# file 'drama_ep1_shot1_00001_.mp4'
# file 'drama_ep1_shot2_00001_.mp4'
# ...

ffmpeg -f concat -safe 0 -i shots_list.txt -c copy drama_ep1_full.mp4
```

如各镜头编码参数不一致，使用重编码方式拼接（见 h3-video-editor 操作 2）。

---

## 一致性快速参考

### 角色外貌漂移的处理

| 症状 | 原因 | 修复 |
|------|------|------|
| 同一角色在不同镜头中脸型变化 | Ref2VA 参考图数量不足或质量差 | 增加参考图数量（2→4张），确保正面清晰 |
| FL2VA 镜头角色与前一镜不匹配 | 首帧文件用错 | 确认 first_frame 是前一镜的真实末帧 |
| 中间某个镜头角色"跑偏" | seed 影响 | 换 seed 重试，或改用 Ref2VA 重新锚定 |

### 声音风格不统一的处理

在所有镜头的 `overall_soundscape` 中使用相同的环境音模板，只改内容细节：

```
# 模板（咖啡馆场景）
overall_soundscape: Quiet café ambiance with gentle background chatter, soft clinks of ceramic cups, and a subtle jazz piano playing in the background. All audio is natural and warm.

# 每个镜头只改角色动作声，环境音描述保持不变
```

### 快速验证到成片的升级路径

```
阶段 1：全镜快速验证（megapixels=0.15, steps=8）
  → 确认每个镜头的动作、角色、衔接点都满意
  → 约 3-8 分钟/镜（5s）

阶段 2：关键镜头普通模式（megapixels=0.6, steps=20）
  → 只重出验证满意的镜头，使用相同 seed
  → 约 15-25 分钟/镜

阶段 3：成片拼接
  → h3-video-editor 合成，加背景音乐/调色（可选）
```

---

## 短剧模板提示词

每个镜头提示词在三段式基础上增加「场景一致性锚定句」：

```
integrated_multimodal_description: [Shot N] <Picture 1> shows [角色描述，首镜必写].
[角色] [动作描述，3秒一段].
The setting remains [场景描述一致性锚定，与前镜相同场景时使用].
Camera [镜头运动描述]. No cuts.

overall_soundscape: [场景环境音模板，全剧统一] + [本镜特有声音]

non_diegetic_music: [全剧统一背景音乐风格，每镜相同]
```

> **关键**：在提示词首句中用 `<Picture 1>` 引用参考图，否则 Ref2VA 的参考图引导效果大打折扣。
