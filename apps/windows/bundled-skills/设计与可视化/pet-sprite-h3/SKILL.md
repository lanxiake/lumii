---
name: pet-sprite-h3
description: 用 ComfyUI 的 MiniMax H3 视频模型生成宠物精灵图动作帧（含侧身走动/攀爬/爬行），打包并安装进客户端。当需要给桌宠换素材、补动作组、或为新角色做整套精灵图时使用。
when_to_use: 用户说"给桌宠加个动作 / 补上走路和爬墙 / 换个宠物形象 / 重新出一套精灵图 / 这只宠物动作不对"时。
---

# H3 精灵图生成（pet-sprite-h3）

用 **MiniMax H3 视频模型**出动作帧，再归一化成客户端能加载的图集。
**权威外部参考是 `fmmix/sprite_h3`（MIT）**——本项目的方法学全部学自它，别自己调参。

## 一、能力边界（先说清楚做不到的）

| 做得到 | 做不到 |
| --- | --- |
| 单个动作出一张 8 格横排精灵表，**首尾闭合可循环** | 一次出整套动作（一个动作一次生成） |
| 正面 / 侧身两种视角 | 任意视角（侧身要靠"先出一张姿势图"两段式） |
| 任何画布比例、任何角色 | 像素风整数网格对齐（那是后处理的事） |

**H3 是音视频联合模型**：提示词里不写静音，它会自己配环境音（对精灵图毫无意义且拖慢生成）。

## 二、前置条件

1. **ComfyUI 可达**，且装了 `minimax_h3_fl2va_pruned_int8_convrot` 这套模型。
   地址取 `~/.claude.json` 的 `mcpServers['comfyui-remote'].env.COMFYUI_URL`，
   或用环境变量 `COMFYUI_URL` 覆盖。本机 8188 不通，走的是 cpolar 隧道，**请求要带重试**。
2. **Node 环境能解析 `sharp`**（脚本要做像素运算）。从仓库内跑最省事；
   搬走的话先 `npm i sharp`。
3. 客户端在跑（只有「安装」这一步需要——它经 `/pet/asset` 控制口走技能链）。

## 三、流水线

```
立绘 ──stage-frame──▶ staged/<角色>.png ──h3-motion sheet──▶ 精灵表 ──install-pet──▶ 客户端
                          （生成画布上的首帧）      （生成+抠底+抽帧+拼条一次出）
```

侧面视角要**多一段**：管线只有正面立绘，而走动/攀爬/爬行要侧身。

```
正面立绘 ──h3-motion pose（尾帧自由）──▶ 姿势图 ──stage-frame --keep-scale──▶ staged/<角色>-<姿势>.png
                                                                                    │
                                                          再拿它去跑上面那条循环 ◀──┘
```

**为什么非要两段**：管线的首帧同时当首帧和尾帧（FL2VA），用正面立绘直接生成侧身循环，
末帧会被**强制拉回正面**，循环里出现"转过去→被拉回来"的鬼畜。姿势图那一轮**不接尾帧**，
角色才能真正转过去；循环闭合交给下一轮。

## 四、九条硬规则（每条都是实测换来的，别推翻）

1. **循环闭合靠 FL2VA，不是靠提示词求。** 把**同一张图**同时接给 `first_frame` 和 `last_frame`。
   只在提示词里写"请回到起始姿势"模型可以不理（实测末尾手臂一直举着）。
   ⚠ **姿势图那一轮反过来——必须不接尾帧**，否则转过去会被钉回来，**而出图看着完全正常**，
   只有量宽高比才发现没转过去。两条路的 `freeEnd` 别接反。

2. **首帧必须先 staging，它是机位标定。** H3 保持首帧里角色的大小、位置、朝向。
   参数照搬 sprite_h3：角色高 = `canvas_h × ratio`、脚底落在 `round(baseline × canvas_h) − 1`、水平居中。

3. **底色用「颜色名 + hex」写进提示词**（如 `cyan (#00CCFF)`），只给 hex 是弱信号。
   抠底后用**精确纯色**重铺一层——源图那层"纯色底"带渐变和噪声（实测四角从 28,220,227 飘到 51,202,216）。
   抠底走 **`ColorToMask` 色键**，不用 BiRefNet：底色是自己铺的精确色、模型也守着它，色键更准且不吃显存。
   ⚠ ComfyUI 的 mask 语义**三套并存**，只能跑一次看 alpha 占比，推不出来。

4. **`--ratio` 不是"留白"旋钮，`--baseline` 才是。** 客户端的 normalize 按帧尺寸分组、
   **组内共用一个倍率**（`scale = canvas.h × 0.94 / 组内最高的包围盒`）——压低 ratio 只会让这一组
   **整体变小**（实测跳起来会比别的动作小 11%）。要给跳跃/立起来留头顶空间，把角色在画面里**下移**
   （抬 `--baseline`），像素高度不变。

5. **姿势图要 `--keep-scale`，不能按 `--ratio` 重摆。** 同一角色的所有动作都从**同一张首帧**生成，
   **本来共用一个尺度**。强行把每张都摆成同样高度 = 把矮姿势放大（实测下落 388 vs 站立 472，放大 21%），
   切动作时肉眼可见地跳。

6. **每个动作的首帧必须是它自己的姿势。** 抽帧沿整段均匀取、**含第 0 帧**，而第 0 帧就是输入图。
   爬行一度从侧身**站立**首帧生成，循环每转一圈都会在格 0 闪一下站姿。

7. **出图闸门（S1/S2/S4/S6/S8）拦下的批次不要放宽判据去凑，重出。**
   最常撞的两条：
   - **S1 角色越出格线**——头顶出框是**信息已经丢了**，后期缩放救不回来 → 抬 baseline 重出。
   - **S8 底色离角色色太近**（安全线 150）——抠底容差会逼近这个距离、穿过描边漏进角色内部。
     让模型画的道具**颜色写死**（实测写 "bright red ball" 后色距从 99 回到 252）。

8. **`Crawl` 那一行必须倒挂，而且是"谁装谁翻"**（2026-09-23）。它只在天花板上播
   （`PetWanderDriver` 里 `onActivity('crawl')` 只有"沿上边缘爬行"一处），所以素材得是
   **脚朝上、头朝下**。Shimeji 那套的作者就是那么画的，**而 H3 出的这一行是正的**
   （`POSES.creep` 写的是"趴在地上"，模型照做）。不在 `install-pet.mjs` 的 `ACTIONS` 里
   标 `invertY: true` 会怎样：**宠物头朝上吊在天花板上**——用户的原话是
   「反了，应该底部朝上，头部朝下」。⚠ 反过来也不行：给本来就倒挂的素材再翻一次，
   同样头朝上（`import-shimeji.mjs` 里记着一次）。**朝向只能由生产侧声明**——
   归一化把内容底边对齐到锚点，装完之后翻与不翻的包围盒**一模一样**，量不出来。

9. **装完必须写 `perchGaps`，不写就是静默用 Shimeji 的数**（2026-09-23）。
   `pet-core` 的攀附几何只有两个数：锚点到**墙面**、到**天花板**的距离 ÷ 画布高。
   兜底值 `0.43 / 0.99` 是 Shimeji 那套素材量出来的，成立前提是"CLIMB 内容贴着格的
   墙侧边、CRAWL 内容贴着格的顶边"——**H3 出的素材按重心对齐、内容在格中央**，
   同一组比例套上去：实测团子**离墙 47px、离天花板 108px**，看着不是"贴着墙爬"
   而是"悬在那儿被电梯带上去"（用户原话「就像坐电梯一样」）。
   `install-pet.mjs` 装完会调 `lib/perch-gaps.mjs` 从**装好的图集**量出来补进清单
   （量装好的而不是源表：倍率是 `canvas.h × 0.94 / 组内最高包围盒`，源表上算等于把
   `computeNormalize` 抄一遍）。团子实测 `{ wall: 0.2478, ceiling: 0.5625 }`。


## 五、画布尺寸怎么定

**客户端 normalize 按高度归一**：`targetH = canvas.h × 0.94`，宽度跟着高度走。

```
画布宽 ≥ canvas.h × 0.94 × 所有动作里最大的宽高比
```

侧身四足是**宽>高**（实测走路 1.19、下落 1.33、低伏爬行 1.75），正面角色是**高>宽**（0.74）。
超过就会**横向裁掉**，而 `pet-creator/run.ts` 只记一条 `clipped` 警告、**不报错**。

⚠ **这个数不能靠推——量。** 归一化倍率的分母是**「组内最高包围盒」**，不是这一帧自己的高：

```
归一化后宽度 = 该帧包围盒宽 × (canvas.h × 0.94 / 组内最高包围盒)
```

而「组」= **帧尺寸相同的一组**（同一批出图切出来的格一样大 → 同一组）。由此：

- 矮姿势**不会**被补到和别人一样高——它跟着组里最高的那个走。这是刻意的：
  逐帧各自撑满会把蹲下的帧放大到和站直一样高，切动作看起来像在抽搐。
- **往组里加一个更高的动作，整组会变小、所需宽度反而变窄。** 所以拿单个姿势的
  宽高比乘 421 是**错的**（偏大，而且随批次变动）——这条我先写错过一次。
- 正面表与侧身表出图宽度不同（576 vs 768），切出来的格尺寸不同 → 天然分两组，
  各自归一。

用 `sheet-canvas.mjs` 量**所有已出的表**：

```bash
node <技能>/characters/sheet-canvas.mjs --dir <动作表根目录> --char <角色> --canvas 448x448
```

它按格尺寸分组、算出每组倍率与所需宽度；给了 `--canvas` 时还会逐个动作报
「会被裁掉多少 px」（超了就退出码 1）。⚠ **等动作表出齐再量最后一次**——
少一个最高的动作，算出来的数会偏宽。

⚠ 动作表目录名是 `<角色>-<动作>-sheet`，**不含视角**：换视角重出会**覆盖**同一个
目录。于是重出失败时旧素材会留在原地冒充新素材被装进去。**出图前先把旧目录挪走**
（改名成不以 `-sheet` 结尾），别让它在测量和安装里混过去——这条是实测踩到的
（正面版的 `fall` 表就差点被当成侧身版装进去）。

⚠ **`canvas.h` 不能动**——宠物在屏幕上的观感大小 = `canvas.h × scale`。
换算 scale 时按**高度**换算（`scale × 旧画布高 / 新画布高`），按宽度算会在改比例时让宠物凭空缩小。

量宽高比用 `pose-pick.mjs`：它逐帧量**包围盒宽高比**（正面基准 0.78、侧身 >1），
并推荐该开多大画布。**判据别用镜像不对称度**——跨角色比会重叠（团子正面素材 24~36% 与
Shimeji 侧身行 34~60% 撞在一起，因为尾巴和抬起的手臂本来就打破对称）。

## 六、命令速查

两种用法等价，挑一种：**直接调**（路径相对本技能目录，`<技能>` = 本文件所在目录），
或**经 `run.ts`**（`SKILL_PARAMS` 传参，见文末协议）。⚠ 两者都**必须在仓库树内运行**——
工具脚本要 `import sharp`，而 ESM 的裸模块是从脚本位置向上找 `node_modules`；
技能被投放到 `~/.lumii/workspace/skills/` 后那条路径上没有 sharp（实测 MODULE_NOT_FOUND）。
`run.ts` 就是替你把位置找对的。

```bash
# 0) 摆首帧（生成画布上的机位标定）
node <技能>/characters/stage-frame.mjs <立绘.png> <staged/角色.png> \
  --canvas 576x672 --ratio 0.70 --baseline 0.856 --bg 00ccff --meta <staged/角色.json>

# 1a) 侧身姿势图（尾帧自由；跑完用 pose-pick 挑帧）
node <技能>/characters/h3-motion.mjs pose --char <角色> --action side   # side / cling / creep / falling
node <技能>/characters/pose-pick.mjs <拼条.png> --cols 16 --pick desc   # asc=取最窄高（贴墙）
node <技能>/characters/stage-frame.mjs <挑中的帧.png> <staged/角色-姿势.png> \
  --canvas 768x672 --keep-scale --baseline 0.93 --meta <staged/角色-姿势.json>

# 1a-2) 全部动作出齐后量画布该开多宽（归一化按「组内最高包围盒」算，推不出来）
node <技能>/characters/sheet-canvas.mjs --dir <动作表根目录> --char <角色> --canvas 448x448

# 1b) 动作表（生成+抠底+8 帧抽帧+拼条，一次出图）
node <技能>/characters/h3-motion.mjs sheet --char <角色> --action <动作>
node <技能>/characters/h3-motion.mjs batch --jobs "<角色>:walk,<角色>:climb" --sheet

# 2) 装进客户端（12 组：8 正面 + Walk/Climb/Crawl/Fall）
#    ⚠ 画布宽**必须先用 sheet-canvas.mjs 量**（见第五节）：有侧身动作时 ≠ 384
#    装完会自动量好 perchGaps 补进清单（硬规则 9）；Crawl 行按 ACTIONS 的 invertY 翻转
node <技能>/characters/install-pet.mjs --id <客户端目录名> --dir <动作表根目录> \
  --canvas <量出来的宽>x448 --bg 00ccff
```

### 出了图但"看着不对"时怎么取证

**本机 `Read` 读不了图**（png/jpg 一律 `[Unsupported Image]`），所以"头朝哪、
脚够不够得到墙"这类判断必须落到字符或数字上。四件套：

```bash
# 看单张图（抠底过的帧走包围盒 + --alpha；浅色角色压在浅色底上加 --auto）
node <技能>/characters/pixel-ascii.mjs <图.png> 72 --alpha
# 从装好的图集里抠出某一格（先看 atlas.json 里的条目名，如 cat_crawl_00）
node <技能>/characters/atlas-cell.mjs <宠物包目录> <输出目录> cat_crawl_00
# 按客户端真实的摆位公式，把贴墙/贴天花板合成出来看
node <技能>/characters/mock-perch.mjs <宠物包目录> /tmp/mock.png --view -16,0,340,300 --zoom 3
node <技能>/characters/pixel-ascii.mjs /tmp/mock.png 100 --auto
# 抓运行中的宠物窗口（**唯一能看见真机的一路**）
node scripts/lumii-cdp.mjs shot '?mode=pet' /tmp/pet.png     # 需 start-dev.ps1 -RemoteDebug 9222
node <技能>/characters/shot-probe.mjs /tmp/pet.png           # 找出宠物在哪
node <技能>/characters/pixel-ascii.mjs /tmp/pet.png 64 --crop x,y,w,h --auto
```

测**交互**（拖动夹取、贴边吸附、抛掷）要合成一次拖拽——它自己拍帧找宠物再派发：

```bash
node <技能>/characters/drag-pet.mjs 0 1400     # 拖到屏幕左缘；判据看日志
```

⚠ `drag-pet.mjs` 头部记着两个必踩的坑：速度要落在 `isThrowable`（320px/s）之下，
以及**真鼠标的移动会打断合成拖拽**（它带 `buttons: 0`，而画布把它当"左键已松开"）。


⚠ 宠物窗口是**全透明**的，截出来整幅 alpha=0（看着全黑）。往页面里注入
`#root>div{background:#f2f2f7 !important}` **能生效**，但注入 `html,body{...}` 不行
（`getComputedStyle` 仍是 `rgba(0,0,0,0)`）；CDP 的
`Emulation.setDefaultBackgroundColorOverride` 实测**不生效**。细节见
`shot-probe.mjs` 顶部。


经 `run.ts`（它自己定位仓库根，参数走 `SKILL_PARAMS`）：

```bash
SKILL_PARAMS='{"op":"batch","jobs":"tuanzi:walk,tuanzi:climb,tuanzi:crawl,tuanzi:fall"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"pose","char":"tuanzi","action":"side"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"pick","dir":"<拼条.png>","cols":16,"pick":"desc"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"sheetcanvas","dir":"<动作表根目录>","char":"tuanzi","canvas":"448x448"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"install","id":"demo_cartoon_cat","dir":"<动作表根目录>","canvas":"<量出来的宽>x448"}' node <技能>/run.ts
```

结果以 `__SKILL_RESULT__:{json}` 打到 stdout。

⚠ **别把长跑命令接 `| head`**：`head` 读够就关管道，进程再写日志拿到 EPIPE 被杀，
**而退出码仍是 0、日志停在中间**，看起来像生成失败。看进度用重定向到文件 + `tail`。
`batch` 全程 15~30 分钟/动作，放后台跑。

## 七、目录与产物

| 路径 | 是什么 |
| --- | --- |
| `~/.lumii/workspace/outputs/pet-motion/staged/` | 首帧（`<角色>.png` + 同名 json 元数据） |
| `~/.lumii/workspace/outputs/pet-motion/<角色>-<动作>-sheet/` | 精灵表落点（`install-pet` 按这个约定找） |
| `~/.lumii/workspace/outputs/pet-motion/<角色>-pose-<姿势>/` | 姿势图拼条 |
| `~/.claude.json` → `mcpServers['comfyui-remote'].env.COMFYUI_URL` | ComfyUI 地址 |

## 八、动作组名是契约（缺组不报错）

仓库里有**两套「九个动作」**，混了不会报错——客户端 `PetOrchestrator.resolveAmbientGroup`
找不到组时**静默回落到基础待机**，表现为宠物一边平移一边播呼吸（像在滑行）。

| 规范 | 组 |
| --- | --- |
| **交互** | Idle / Talk / Jump / Wave / Nod / Shake / Picked / Land / PlayBall |
| **行为** | Idle / Walk / Sit / Talk / Fall / Picked / Jump / Climb / Crawl |

`Walk / Climb / Crawl / Fall` **必须是 `kind: "loop"`**：驱动会在同一姿态上停几十秒（实测一次攀爬 30 秒），
`once` 会让动作放完就僵住。判据：日志搜 `[setAmbientActivity]`，打 `→ 组 "(基础待机)"` 就是缺组。

## 九、配套的 ComfyUI 工作流

同名图已存在 ComfyUI 用户库里，可在网页界面直接打开（用 Queue/History 的 **Load** 还原；
纯 API 格式的画布打不开）：

- `宠物精灵图-H3-动作表-FL2VA-8帧.json` —— 生成 → 抠底 → 抽 8 帧 → 拼条
- `宠物精灵图-H3-姿势图-I2VA-自由尾帧.json` —— 同上但**不接尾帧**、抽 16 帧
- `宠物精灵图-H3-原始帧序列.json` —— 纯出帧，要中间帧时用

本仓库的 API 格式导出件在 `verify/pet-sprite/refs/pet-sprite-h3-*.api.json`。
