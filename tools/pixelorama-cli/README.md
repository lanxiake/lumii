# pixelorama-cli

用 [Pixelorama](https://github.com/Orama-Interactive/Pixelorama) 处理像素精灵图的命令行工具。
**面向 AI Agent**：每条命令都支持 `--json`，一次调用返回结构化结果，不弹窗、不进 REPL。

## 它解决什么

AI 生图模型直出的"精灵图"有一组结构性缺陷（详见 `pet-creator` 技能）：

| 缺陷 | 后果 |
| --- | --- |
| 输出无透明通道 | 没有 alpha，必须抠底 |
| 无像素网格概念 | 抗锯齿、几万种颜色，不是像素画 |
| 格子边界不可信 | 角色撑破格子、几格连成一片 |
| 帧间尺寸不一 | 播起来角色一跳一跳 |

这个 CLI 把那张图变成**一组干净、同尺寸、脚底对齐的帧**：

```
AI 出图 ──► 抠底 ──► 切片 ──► 归一化 ──► 帧序列
```

其中**切片用的是 Pixelorama 自己的 SmartSlicer**（`addons/SmartSlicer`），
不是自己重写的固定网格切法——它会按**真正的空白**找角色边界，
所以角色撑破格子时它能如实报告"这是一个整体"，而不是假装切好了。

## 前置

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Godot | **4.7.x** | Pixelorama v1.2.3 要求 4.7.2，旧版打不开 |
| Pixelorama | v1.2.3 源码 | 需要含 `project.godot` 的**源码目录**，不是安装好的应用 |
| Node.js | ≥ 18 | 本工具的运行环境（不需要 Python） |

安装 Godot 后**必须先导入一次资源**，否则运行时的资源全是空的：

```bash
godot --headless --path <Pixelorama 目录> --import
```

这一步会生成 `.godot/`（该目录已在 Pixelorama 的 `.gitignore` 里）。只需做一次。

> ⚠️ **首次 import 会重写 Pixelorama 仓库里的 `.import` 文件**——实测 224 个，
> 全是**行尾符**差异（Godot 写成 LF，而仓库是 autocrlf=true），内容一个字节都没变。
> 这是**一次性**的：清掉之后，后续每次运行都不会再改。
> 要清就跑 `git status --short | awk '{print $2}' | xargs git checkout --`。
> 恢复 `.import` 不影响运行——实测恢复前后 `clean` 的结果逐字节相同。

路径发现按这个顺序：

- Godot：`$PIXELORAMA_GODOT` → `~/.lumii/tools/godot/Godot_v*_console.exe`（取版本号最大的）
- Pixelorama：`$PIXELORAMA_SRC` → `C:/myself/projects/open-source/Pixelorama` → `~/Pixelorama` 等常见位置

用 `pixelorama probe` 自检。

## 命令

```
pixelorama probe                              环境自检
pixelorama analyze <file>                     尺寸 / 背景色 / 内容包围盒 / 颜色数
pixelorama slice   <file> [--mode auto|grid]  切片，只报告不落盘
pixelorama cutout  <file> [--out path]        抠背景
pixelorama clean   <file> --out-dir <dir>     一步到位：抠底→切片→归一化→导出
```

加 `--json` 走机器可读输出。

### `clean` —— 常用的就是它

```bash
pixelorama clean sheet.png --out-dir ./frames --json
```

实测（一张 1024×1024 的 AI 出图，2×2 四格）：

```
抠掉 791264 px (75.46%)  背景 rgb(7,247,252)
切出 4 帧  →  446×388 画布
  frame_00.png   446×388   (源 446×370 @ 34,84)
  frame_01.png   446×388   (源 428×380 @ 540,76)
  frame_02.png   446×388   (源 400×388 @ 48,582)
  frame_03.png   446×388   (源 342×352 @ 566,606)
```

源区域大小不一是**正常的**——AI 画的动作本来就有伸缩。
归一化按最大宽高建统一画布，每帧水平居中、**底边对齐**（脚踩同一条线）。

## 设计取舍（都是实测换来的）

### 为什么不给 Pixelorama 加子命令

上游 `src/Main.gd` 里的 CLI（`args_list`）是**纯导出导向**的：
打开文件 → 导出 png/spritesheet。没有编辑能力，也没有切片。
要加就得改上游源码，升级即冲突。

本工具改走 `--script`：实测**可以用绝对路径指到项目外的 .gd 文件**，
所以整个执行器活在上游仓库之外，升级 Pixelorama 不受影响。

### 为什么只能复用「零 autoload 依赖」的类

`--script` 模式下 autoload 虽然会 ready，但它们假设 `Main.tscn` 的节点树存在，
于是刷屏报 `theme is null` / `find_child on null`。
**纯算法类不受影响**，但判据不只是"引用了多少次 `Global.`"：

> 把该类的 `.gd` 里出现的**每一个** autoload 标识符都查一遍。
> 本项目的 12 个：`Global, Import, OpenSave, DrawingAlgos, Tools, Html5FileExchange,`
> `Export, Palettes, Keychain, ExtensionsApi, Themes, Applinks`

踩过两次：`ImageExtended` 和 `FloodFillObject` 都看着"很纯"
（后者一处 `Global.` 都没有），却在别处用了 `DrawingAlgos`，
结果 `Identifier not found` + `Failed to compile depended scripts`
——**整个执行器加载失败**，不是"这个类不能用"而已，报错还很长很难定位。

目前通过这条判据的只有 `RegionUnpacker`（SmartSlicer 的切图器）。

### 为什么抠底在切片之前

`RegionUnpacker` 判空用的是 `get_pixelv(p).a > 0`（源码实测），
而 AI 出的图整张不透明——**没抠底就切，整张图会被当成一个连通区域**。
抠底把背景变成 `alpha=0`，它才能按真正的空白找到每个角色。

### 为什么抠底从四边泛洪，而不是"删掉所有接近背景色的像素"

后者会把角色**内部**与背景色相近的区域也挖空（白猫身上的白）。
泛洪只吃掉"和画布边缘连得通"的那片，被描边围住的同色区域保得住。

四条边**全部**入栈，不只取四角——AI 出的图四角常被噪点污染，只取角会漏掉整条边。

### 背景色自动估计，不按声明的值

实测：提示词里写 `#00ffff`，产出的实际底色是 `rgb(5,251,254)`。
判据取**最外圈像素的逐通道中位数**。
（别改成四角：四角能取到四个互不相同的值，此时"多数派"退化成"第一个"，
整格会被误判成内容。这是 `cells-quality.mjs` 踩过的坑。）

## 调用开销

**Godot 冷启动约 3.7 秒，而命令本身执行 0ms。**

实测：`耗时: 执行 0ms · 含启动 3715ms`

所以一次 `--json` 调用就是 3.7 秒起步。要连做几步时，
**优先用 `clean`**（它内部一次做完抠底+切片+归一化），而不是 `cutout` 再 `slice` 再导出——
后者是三次进程启动，十一秒。

## 目录

```
bin/pixelorama.mjs      CLI 入口（参数解析、输出）
src/godot.mjs           路径发现 + 进程调用 + 结果提取
gd/pixelorama_cli.gd    跑在 Pixelorama 里的命令执行器
dev/look.mjs            开发用：把图合成到白底再画 ASCII
```

## 已知限制

- **不做调色板量化**。Pixelorama 的 `PalettizeDialog` 走 GPU shader，
  而 headless 用的是 dummy 渲染后端，跑不了 shader。
  真要量化得用 GDScript 重写最近邻颜色匹配。
- **一次只处理一张图**。多图批处理要靠调用方循环（或将来扩成任务数组）。
- **`grid` 模式不做内容校验**。它按 `w/cols` 硬切，
  尺寸不能整除时直接报错而不是猜。
