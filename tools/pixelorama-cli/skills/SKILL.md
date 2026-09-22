---
name: pixelorama
description: |
  用 Pixelorama 把 AI 出的精灵图整成可用的帧序列：抠底、按内容切片、归一化对齐。
  Use when: (1) 拿到一张 AI 生成的精灵图/图集，要切成独立帧，
  (2) 需要给没有透明通道的图抠底，
  (3) 帧尺寸不一、脚底不齐，要统一画布。
  NOT for: 生成图片（用 image_generate）、程序化动画（运行时原语）、
  单纯的图集打包（那是 pet-creator 的 build 步骤）。
metadata:
  {
    "mtbot":
      {
        "emoji": "🎨",
        "requires": { "anyBins": ["node"] },
      },
  }
---

# Pixelorama 精灵图处理（pixelorama-cli）

把 AI 出的那张"看着像精灵图"的图，变成**真正能播的帧序列**。

## 一、先判断该不该用它

| 你的处境 | 用什么 |
| --- | --- |
| 要从零造一只桌宠（出图 + 打包 + 安装） | **pet-creator**（它内部已经调了这个工具） |
| 手上已有一张图，要切成干净帧 | **本技能** |
| 只想出图，不处理 | `image_generate` |
| 想在 Pixelorama 界面里手工修 | 打开 Pixelorama GUI，本工具不管这个 |

**别用它做的事**：生成图片、程序化动画、打包成宠物包。

## 二、命令

全部支持 `--json`。**Agent 一律加 `--json`**。

```bash
pixelorama probe                              环境自检，先跑这个
pixelorama analyze <file> --json              看清这张图的实际状况
pixelorama clean   <file> --out-dir <dir> --json   一步到位（常用）
```

辅助：

```bash
pixelorama slice  <file> --mode auto|grid --json   只报告切出哪些区域，不落盘
pixelorama cutout <file> --out <path> --json       只抠底
```

### 路径

脚本位置：`tools/pixelorama-cli/bin/pixelorama.mjs`（用 `node` 跑）。

```bash
node <lumii 仓库>/tools/pixelorama-cli/bin/pixelorama.mjs clean <图> --out-dir <目录> --json
```

## 三、标准流程

### 第 1 步：自检（别跳过）

```bash
pixelorama probe --json
```

`ok: false` 时把 `error` 原样告诉用户——通常是 Godot 或 Pixelorama 没装。
**注意**：装了 Godot 还不够，Pixelorama 源码目录还要先做过一次 `--import`，
否则运行时报一堆资源加载失败。

### 第 2 步：先看再切

```bash
pixelorama analyze sheet.png --json
```

看三个数：

| 字段 | 怎么读 |
| --- | --- |
| `has_alpha` | `false` ⇒ 必须抠底，切片才可能对 |
| `distinct_colors` | 几万 ⇒ 这是照片感的图，不是像素画（想变像素画得另做量化） |
| `box` | 等于整图尺寸 ⇒ 内容撑满了，角色很可能**越界** |

### 第 3 步：clean

```bash
pixelorama clean sheet.png --out-dir ./frames --json
```

返回里看这些：

| 字段 | 含义 |
| --- | --- |
| `count` | 切出几帧 |
| `removed_pct` | 抠掉多少（背景占比） |
| `canvas` | 归一化后的统一画布 |
| `source_rects` | 每帧在原图上的位置，**顺序即时间顺序** |
| `frames[]` | 落盘的帧文件 |

## 四、怎么读结果（这里是判断力）

### `count` 不等于你预期的格数，通常**不是**工具的错

AI 出的图经常"角色撑破格子"，四格连成一片。
这时 SmartSlicer 会如实报告 `count: 1`——它是**对的**，那张图真的只有一个连通区域。

**判据**：`count` 明显偏少、且 `source_rects[0]` 接近整图尺寸 ⇒ 角色连成一片。
处置顺序：

1. 先用 `--mode grid --cols 2 --rows 2` 硬切，看每帧是不是残缺的
   （残缺 = 确认了连成一片，硬切救不回来）
2. **重出那张图**，提示词里强调"四格之间必须有明显间隙、角色不得触碰格子边界"
3. 别在工具上调参数硬凑——切坏了比切不开更糟

### `removed_pct` 多少算正常

背景占比。2×2 四格通常 70–80%。
- **> 95%**：容差太大，把角色也吃掉了 → 调小 `--tol`（默认 60）
- **< 40%**：背景没抠干净，或这图本来就不是"角色占小部分"的构图

### 抠底质量可以交叉验证

`analyze` 报的 `content_pct` 与 `clean` 的 `100 - removed_pct` 应该很接近。
实测一组：27.53% vs 27.55%。两者算法独立（色距 vs 泛洪），吻合即为抠对了。

## 五、常见坑

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `Godot 没有返回结果标记` | 执行器编译失败 | 看 `godot_output_tail`，多半是执行器引用了带 autoload 的类 |
| `抠底后没找到任何内容` | 容差过大 | 调小 `--tol`，或用 `--bg R,G,B` 显式指定底色 |
| `尺寸不能被 N×M 整除` | grid 模式硬要求 | 换 `--mode auto`，或改用能整除的行列数 |
| 命令很慢（3.7s 起步） | Godot 冷启动 | 正常。优先用 `clean` 一步到位，别拆成多次调用 |

## 六、调用开销（影响你怎么组织步骤）

**每次调用 = Godot 冷启动约 3.7 秒**（命令本身执行接近 0ms）。

所以要连做几步时：
- ✅ `clean` 一次做完（抠底+切片+归一化+导出）
- ❌ `cutout` → `slice` → 再导出（三次启动 ≈ 11 秒）

## 七、和 pet-creator 的关系

`pet-creator` 是**完整造宠**流程（出图 → 处理 → 打包 → 安装），
它自己的 `run.ts` 用 sharp 做像素处理。

本工具是**同一步骤的一个更强的替代**：切片走 Pixelorama 的 SmartSlicer，
能按真实内容边界切、而不是按固定网格。

两者不冲突。手上有现成的图要处理时用本工具；要造一只完整的宠物用 `pet-creator`。
