# pet-motion —— 团子的动作源素材（H3 生成）

`install-pet.mjs --dir <本目录>` 的输入。**24MB，不是"一条命令能重建"的那类东西**，
所以入库（对比 `verify/pet-sprite/review/assets/` 那条排除：那些确实一条命令能重建，这些不能——
每张表是一次 5 分钟的模型生成，而且挑帧是人工判断）。

## 目录约定

`install-pet.mjs` 按 `<角色>-<动作>-sheet/` 找表，所以**目录名不能改**。

```
staged/                     各动作的首帧（生成时的「机位标定」）
  <角色>.png                正面站立立绘（Idle/Wave/Nod/Shake/Picked/Land/PlayBall 的共同首帧）
  <角色>-hop.png            跳跃专用的压低版首帧（头顶要留出跳起来的空间）
  <角色>-side.png           侧身站立（Walk 的首帧，也是各侧身姿势的出发点）
  <角色>-cling.png          攀爬姿势
  <角色>-creep.png          爬行低伏姿势
  <角色>-falling.png        下落姿势
  <角色>-sitting.png        正面坐姿
  *.json                    每个首帧的元数据：画布、图高比、基线、源图与包围盒
                            （`figureHeightPx` 是后续 frame-0 snap 的参考值，别丢）

<角色>-<动作>-sheet/f0000.png   8 格横排动作表（一张图 = 一个动作组）
```

## 怎么用

```bash
# 装进客户端（客户端**必须在运行**——这一步经 /pet/asset 控制口走技能链）
node verify/pet-sprite/characters/install-pet.mjs --id demo_cartoon_cat \
  --dir verify/pet-sprite/sources/pet-motion --canvas 560x448 --bg 00ccff
```

⚠ **`crawl/` 里那张表是"正"的（脚朝下），装的时候才翻成倒挂**——`install-pet.mjs` 的
`ACTIONS.crawl` 标了 `invertY`。别把它当成"素材装错了"去手工换图：
这一行只在天花板上播，倒挂是它的正确形态（详见 SKILL.md 硬规则 8）。

⚠ **`--canvas` 别照抄 560**，它是量出来的：

```bash
node verify/pet-sprite/characters/sheet-canvas.mjs \
  --dir verify/pet-sprite/sources/pet-motion --char tuanzi --canvas 560x448
```

换角色、加动作都要重新量——归一化按「组内最高包围盒」算，**加一个更高的动作会让整组
变小、所需宽度反而变窄**；报 `⚠ 只差 Npx 就贴边` 时也换宽一点的值。

## 这些是怎么来的

方法与七条硬规则见技能 [`apps/windows/bundled-skills/设计与可视化/pet-sprite-h3/SKILL.md`](../../../../apps/windows/bundled-skills/设计与可视化/pet-sprite-h3/SKILL.md)，
交付经过与判据见 [`docs/plans/客户端UI/2026-09-22-H3精灵图动作组与桌宠行为补全实施记录.md`](../../../../docs/plans/客户端UI/2026-09-22-H3精灵图动作组与桌宠行为补全实施记录.md)。

一句话：**非正面姿势走两段**——先用 I2VA（尾帧自由）出一张姿势图，挑一帧摆正，
再拿它当首帧跑 FL2VA 循环（首尾同图，闭合由条件强制）。

## 没入库的东西

| 没进来 | 为什么 | 要的话 |
| --- | --- | --- |
| `~/.lumii/workspace/outputs/pet-motion/tuanzi-pose-*/`（~110MB） | 旧 `gen` 路径的 56 帧原始 dump，只有 `f0050.png`（下落姿势的来源）被引用 | 重跑 `pose` 命令 |
| `~/.lumii/pet-models/demo_cartoon_cat/`（16MB） | 装好的成品，`install-pet` 能重建 | 或直接从源机器拷 |
| `~/.lumii/pet-models/registry.json` | 客户端 install 时自己写 | 或从源机器拷（**注意它每进程只读一次**） |
| `staged/` 里各首帧的**姿势拼条** | 挑帧是人工判断，但**结果已经在 `staged/` 里了** | 不需要 |

⚠ 所以：**这份素材足以重装（`install-pet`）**，但如果要**改挑帧**（换一个姿势帧），
得重新跑 `pose` 命令生成拼条——拼条本身没入库。
