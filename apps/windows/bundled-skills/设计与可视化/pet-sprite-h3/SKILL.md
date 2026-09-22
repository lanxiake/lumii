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

## 四、七条硬规则（每条都是实测换来的，别推翻）

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

## 五、画布尺寸怎么定

**客户端 normalize 按高度归一**：`targetH = canvas.h × 0.94`，宽度跟着高度走。

```
画布宽 ≥ canvas.h × 0.94 × 所有动作里最大的宽高比
```

侧身四足是**宽>高**（实测走路 1.19、下落 1.33、低伏爬行 1.75），正面角色是**高>宽**（0.74）。
超过就会**横向裁掉**，而 `pet-creator/run.ts` 只记一条 `clipped` 警告、**不报错**。

⚠ **别用「感觉够宽」定这个数**——`canvas.h = 448` 时归一化后角色高固定 `448 × 0.94 = 421`px，
所以每个姿势要的宽度就是 `421 × 该姿势宽高比`，直接量出来：

| 姿势 | 宽高比 | 需要画布宽 ≥ | 448 宽装得下吗 |
| --- | --- | --- | --- |
| 正面（已装图集实测） | 0.74 | 313px | ✅ |
| 侧身走动 | 1.19 | 503px | ❌ 两侧各裁 ~27px |
| 侧身下落 | 1.33 | 560px | ❌ |
| 低伏爬行 | 1.75 | 736px | ❌ |

**所以团子的画布是 `768×448`，不是 `448×448`**——宽度是整个模型一个值，
得按**最宽的那个姿势**（低伏爬行）定。宽度多开是免费的（观感大小只由高度决定），
开窄了是把爪子裁掉且没人告诉你。

宽度从哪来：拿每个姿势的拼条过一遍

```bash
node <技能>/characters/pose-pick.mjs <姿势拼条.png> --cols 16 --pick desc
```

它逐格量包围盒宽高比。**取所有姿势里最大的那个**再乘 421 定画布。

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

# 1b) 动作表（生成+抠底+8 帧抽帧+拼条，一次出图）
node <技能>/characters/h3-motion.mjs sheet --char <角色> --action <动作>
node <技能>/characters/h3-motion.mjs batch --jobs "<角色>:walk,<角色>:climb" --sheet

# 2) 装进客户端（12 组：8 正面 + Walk/Climb/Crawl/Fall）
#    ⚠ 画布宽按最宽姿势定（见第五节）：有侧身四足动作就**不是** 448 宽
node <技能>/characters/install-pet.mjs --id <客户端目录名> --dir <动作表根目录> --canvas 768x448 --bg 00ccff
```

经 `run.ts`（它自己定位仓库根，参数走 `SKILL_PARAMS`）：

```bash
SKILL_PARAMS='{"op":"batch","jobs":"tuanzi:walk,tuanzi:climb,tuanzi:crawl,tuanzi:fall"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"pose","char":"tuanzi","action":"side"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"pick","dir":"<拼条.png>","cols":16,"pick":"desc"}' node <技能>/run.ts
SKILL_PARAMS='{"op":"install","id":"demo_cartoon_cat","dir":"<动作表根目录>","canvas":"768x448"}' node <技能>/run.ts
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
