# 宠物开发规范

**状态**：已确认（2026-09-24）。宠物实验线收口时把散在各处的约定固化成这一份。

> **读者有两个，同一份内容要同时服务他们**：
>
> - **人**（维护者 / 想加一只宠物的人）：从这里开始，往下钻到设计文档与代码。
> - **客户端自己**（Agent 经技能自我开发）：`bundled-skills/` 下的 `SKILL.md` 才是**可执行正本**，
>   本文是它的**人类可读索引与契约说明**。两者冲突时**以 SKILL.md 为准**——那份跟代码一起改、一起发布。
>
> 相关文档：[`宠物系统需求分析`](../design/客户端UI/2026-09-21-宠物系统需求分析.md)（要什么）、
> [`虚拟人精灵图渲染后端设计`](../design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md)（渲染契约）、
> [`宠物包规范设计`](../design/客户端UI/2026-09-21-宠物包规范设计.md)（合格线与命名约定的来源）、
> [`宠物创作平台预留设计`](../design/客户端UI/2026-09-21-宠物创作平台预留设计.md)（事件与特效的格式来源）、
> [`Agent状态可见化设计`](../design/客户端UI/2026-09-21-Agent状态可见化设计.md)（行为调制与降级）。

---

## 一、先选路线：两条生成线，别混

「做一只宠物」有两条**互不替代**的路线。选错的表现是**素材过不了闸门或动作读不顺**，而不是报错。

| | **A · AI 直出图集**（`pet-creator`） | **B · 视频模型出运动帧**（`pet-sprite-h3`） |
| --- | --- | --- |
| 一句话 | 一个动作一批、一批一张多格网格图，**格子的阅读顺序就是时间顺序** | 一张首帧图喂给视频模型，**抽帧**成精灵表 |
| 出图模型 | `gpt-image-2.5`（经 rightapi）等生图模型 | MiniMax H3（ComfyUI，`minimax_h3_fl2va_pruned_int8_convrot`） |
| 单动作帧数 | 4~6 格（再多模型就画成别的动作） | 8~16 帧（抽帧数可控） |
| 动作质量 | 一致性靠**单次生成**天然保证；帧少，"读成一段动作"难 | **帧间连续**，能做出真走路/攀爬/下落 |
| 视角 | 任意姿态，但**每批各自独立**，尺度不保证一致 | 首帧是**机位标定**；换视角要**两段式**（见 §六.2） |
| 成本 | 一批一张图，分钟级 | 一个动作一次 5 分钟生成 + 人工挑帧 |
| 适用 | 像素风、道具层、表情差分、单次小动作、**用户自助创作** | 补齐行为组（走/爬/落/坐）、要求动作真的连贯 |

> ⚠ **不要用链式图生图做序列帧**。实测相邻一跳剪影 IoU 91–93%，**相隔三跳降到 73%**，
> 且**参考图会压过文字提示**（要求"回到站立"，模型仍保持参考帧的坐姿）。
> 见 [`宠物自制系统技术验证报告`](../test/pet-sprite/验证报告.md) 验证点 D。

**路线 B 的方法学全部学自 `fmmix/sprite_h3`（MIT），别自己调参**——
十七条硬规则每一条都是实测换来的，见 §八。

---

## 二、宠物包：一个目录 + 三份文件

```
<id>/
├── manifest.json   清单（渲染契约，见下）
├── atlas.png       图集（所有帧打在一张贴图上）
├── atlas.json      图集索引（帧名 → 区域）
└── pet.json        作者信息（名字、缩略图……）
```

落点有两处，**同 id 时用户目录优先**（`mergePetRegistries`）：

| 位置 | 谁写 |
| --- | --- |
| `apps/windows/resources/pet-models/` | 随包（要重新打包才生效） |
| `<数据根>/pet-models/`（默认 `~/.lumii/pet-models/`） | `pet-asset install` / 技能安装 |

### 2.1 清单字段与合格线

| 级别 | 字段 | 缺失后果 |
| --- | --- | --- |
| **必需** | `id` / `rendererType` / `canvas` / `anchor` / `atlas` / `atlasJson` | `validate` 拒绝安装 |
| **必需** | `animations` 至少一个 `kind: "loop"` 的待机组 | 没有待机就没有"活着"的基线 |
| 推荐 | `slots.face`（表情层，`kind: "layered"`） | Agent 情绪透不出来 |
| 推荐 | `emotionMap` 含**语义键**（§三.3） | 同上 |
| 推荐 | `mouthLevels`（≥2 档） | 说话嘴不动 |
| 推荐 | `hitAreas`（至少覆盖身体） | **点击无回应** |
| 推荐 | `animations` 含 `Idle` 与 `Talk` 组名 | 编排器默认按这两个名字找组 |
| 可选 | `params`（呼吸/眨眼等程序化原语） | 静止，但不是坏的 |
| 可选 | `slots.fx`（特效层，见 §五） | 角色没有自带视觉反馈 |
| 可选 | `perchGaps: { wall, ceiling }` | **静默沿用兜底值**，贴墙/天花板的位置不对（§八 硬规则 9） |

完整的字段定义在 [`packages/pet-core/src/model/sprite-manifest.ts`](../../packages/pet-core/src/model/sprite-manifest.ts)。
**清单是数据不是代码**——只接受枚举与字面量，不接受表达式（这是安全边界，别放宽）。

### 2.2 canvas 与 scale：屏幕上的大小

宠物的观感大小 = `canvas.h × scale`。想让宠物更大就改这两个之一，**别改出图分辨率**
（出图统一 1024，由切分与缩放落到画布）。

| 风格 | 画布 | 注册表 `scale` | 屏幕高度 |
| --- | --- | --- | --- |
| 像素风 | 48×56 | 2 | ≈112px |
| 2D 高清 | 144×168 | 0.65 | ≈109px |
| 2D 高清（H3 线） | 560×448 | 0.2437 | ≈109px |

⚠ 换算 `scale` 时按**高度**换算（`scale × 旧画布高 / 新画布高`），**按宽度算会让宠物凭空缩小**。

---

## 三、命名契约（三套，混了不报错）

**这一节是踩坑最密集的地方**：三套命名都对不上时报错的地方，只会**静默降级**。

### 3.1 动作组名：仓库里有**两套「九个动作」**

| 规范 | 组 |
| --- | --- |
| **交互** | `Idle` `Talk` `Jump` `Wave` `Nod` `Shake` `Picked` `Land` `PlayBall` |
| **行为** | `Idle` `Walk` `Sit` `Talk` `Fall` `Picked` `Jump` `Climb` `Crawl` |

外加一组**环境动作**（自主行为按状态随机播的一次性动作）：
`Yawn` `Stretch` `Scratch` `Dodge` `Cheer` `Droop` `Look` `Purr`。

上面三张表去重之后是 **22 组**（`Idle` `Talk` `Wave` `Jump` `Nod` `Shake` `Picked` `Land`
`PlayBall` `Walk` `Fall` `Climb` `Crawl` `Sit` `Yawn` `Stretch` `Scratch` `Dodge` `Cheer`
`Droop` `Look` `Purr`）。

⚠ **完整的权威清单在 `pet-sprite-h3/characters/install-pet.mjs` 的 `ACTIONS`**——
一张表就是全集，20 个具名组 + `Idle`/`Talk`（`group: null` 走 base 槽，由技能从 base 帧自动补）。
**数"还差多少组"要去读它，不能拿现有产物反推**：产物里没有只说明"还没做"，
不代表"不需要做"；也不代表"没做过"（可能做过又跑完了）。
⚠ 名字还有一处错位：`h3-motion.mjs` 里的键叫 **`hop`**，映射到的组名是 **`Jump`**——
两个词指同一个动作。

⚠ **缺组不报错**：`PetOrchestrator.resolveAmbientGroup` 找不到组时**静默回落到基础待机**，
表现为宠物**一边平移一边播呼吸**（像在滑行）。

**判据**：日志搜 `[setAmbientActivity]`，打 `→ 组 "(基础待机)"` 而姿态不是 stand/sit 就是缺组。

⚠ `Walk` / `Climb` / `Crawl` / `Fall` **必须是 `kind: "loop"`**：驱动会在同一姿态上停几十秒
（实测一次攀爬 30 秒），`once` 会让动作放完就僵住。

⚠ **一次性（`once`）动作的时长必须 < 2.6 秒**。编排器播这类动作前会先按住自主行为，
而让位是**定时放开**的（`ONE_SHOT_AMBIENT_HOLD_MS = 2600`，`PetOrchestrator.ts:90`）。
动画更长 → 让位在播到一半时解除 → 宠物**一边平移一边演**。
现有各组 8fps×16 帧 = 2.00s，余量最小 600ms。**要更长的动作去把 hold 调长，别只降 fps 顶上去**。

### 3.2 命中区 id ↔ `tapMotions` key

**`hitAreas[].id` 就是 `tapMotions` 的 key**。sprite 身体区用 **`HitAreaBody`**、头部用 **`HitAreaHead`**
（与 `packages/pet-asset/src/hit-areas.ts` 的自动生成器保持一致）。

⚠ 历史坑：客户端在命中区缺失时传字面量 `'body'`，而注册表写的是 `HitAreaBody`，**两者永不相等**。
"统一改名成 `body`"这条**不要执行**——那会把刚修好的链路重新打断。

### 3.3 表情语义键 ↔ `emotionMap`

`emotionMap` 是**代码与素材之间唯一的翻译层**（每个模型在注册表里自己定义）。
必须包含语义键：`neutral`（基线）、`joy`、`sadness`、`surprise`、`sleepy`（打盹，闲置感知用）。

**为什么必须是语义键**：让代码去猜素材叫什么（`eye_happy` / `exp_01`），
就是把翻译责任推给了最不该承担的一方。实测代码候选名对素材名的命中率 **0/5**。

⚠ **键数是声明量，索引数才是表现量**。`xiaomai` 有 14 个键但**全部指向索引 0**——只有一张脸。
判据用"能解析出几个不同索引"，见
[`packages/pet-core/src/model/expression-capability.ts`](../../packages/pet-core/src/model/expression-capability.ts)。
按键数判会把它算成"表情丰富"因而不补幅度，用户看到的是"我心情这么差它一点反应都没有"。

---

## 四、事件 → 表现：`interactions[]`（**已设计，未接线**）

> ⚠ **状态要说清楚**：这套格式在 [`宠物创作平台预留设计`](../design/客户端UI/2026-09-21-宠物创作平台预留设计.md)
> §3.2 里定义完整，但 **Windows 端一个都没用**——现在跑的还是 `PetOrchestrator` 里
> 一组布尔标志 + 硬编码 switch。**别照着手写清单就以为它会生效。**

```jsonc
"interactions": [
  {
    "id": "tap-body",                                   // 可选，供编辑器引用
    "on": { "type": "tap", "hitArea": "body" },
    "do": [
      { "type": "motion", "group": "Wave" },
      { "type": "effect", "name": "sparkle", "at": "pointer" }
    ]
  },
  {
    "on": { "type": "agent", "event": "tool:end", "isError": true },
    "when": { "activity": "working" },
    "do": [{ "type": "expression", "name": "sadness" }]
  }
]
```

**触发器全集**（`on.type`）：`tap` / `drag:start` / `drag:end` / `hover:enter` / `hover:leave` /
`wheel` / `timer` / `state` / `agent` / `mouth`。

**动作全集**（`do[].type`）：`motion` / `expression` / `effect` / `bubble` / `modulation` / `scale`。

**条件**（`when`）刻意保持贫弱、防图灵完备：只支持**键值匹配**与 `$lt` / `$gt`，
键限定为 `activity` / `mood.energy` / `mood.valence` / `mood.arousal` / `idleStage` / `dialogue`。

**两条设计原则别推翻**：
1. **触发器是枚举，不是自由文本**——枚举可校验、可穷举、可在编辑器里下拉选择。
2. **只接受数据，不接受表达式**——放宽到字符串表达式 = 开放任意代码执行面。

### 4.1 现在真正生效的"事件 → 表现"在哪

| 通道 | 落点 | 触发 |
| --- | --- | --- |
| Agent 活动状态 | `packages/pet-core/src/state/agent-activity.ts` | 回合开始/工具调用/等待确认 → 姿态调制 |
| 通知与审批 | `packages/pet-core/src/state/notice.ts` | 分档 `ambient` / `report` / `action`，含销账与预算 |
| 表情策略 | `packages/pet-core/src/expression/state-expression-policy.ts` | 9 态 → `{ emotion, motionGroup }` |
| 信号映射 | `packages/pet-core/src/mapping/agentSignalMapper.ts` | `AgentSignal` → `PetEvent` |
| 环境动作 | `PetOrchestrator.playOneShotMotion()`（`PetOrchestrator.ts:1656`） | 见下表 |

| 环境组 | 什么时候播 | 代码位置 |
| --- | --- | --- |
| `Yawn` | 闲置进入 `drowsy` | `PetOrchestrator.ts:1834` |
| `Stretch` | 闲置阶段推进 | `PetOrchestrator.ts:1813` |
| `Scratch` | `activity === 'blocked'`（Agent 卡住） | `PetOrchestrator.ts:603` |
| `Look` | 注意力事件 | `PetOrchestrator.ts:1685` |
| `Cheer` / `Droop` | 心情上/下移 | `PetOrchestrator.ts:473` |
| `Dodge` | 点击时"躲开"（不播点击动作、不放烟花） | `PetCanvas.tsx:1131` |
| `Purr` | 长按摸头期间**循环**，松手还原 | `PetOrchestrator.startPurrMotion()` `:1713` |

> `Purr` / `Dodge` **不走 `playOneShotMotion`**：前者是 `loop`（按住期间一直播），
> 后者由点击那条路自己带着让位。加新动作时先看它属于哪一类。

---

## 五、特效：**主力是图集，不是代码**

> 这条修正了一个初版设计的偏差：特效不一定是额外写的代码粒子，
> 更多时候它就是**角色图集里的一组图片**——星星、爱心、汗滴、闪光、怒气符号。

### 路线一：图集特效（**现有机制已支持，零改动**）

特效 = 一个普通的 `layered` 槽位。`buildLayers` 对**任意** slot 名一视同仁，
唯一的特殊化是 `bindMouthAndExpression` 去"认"哪个槽是嘴/眼。

```jsonc
"slots": {
  "face": { "kind": "layered", "at": [0, 0],    "parts": { "eyes": ["eye_open", "eye_happy"] } },
  "fx":   { "kind": "layered", "at": [0, -12],  "parts": { "aura": ["fx_star_00", "fx_star_01", "fx_star_02"] } }
},
"animations": [
  { "group": "Sparkle", "kind": "once", "fps": 8, "next": "Idle",
    "frames": [
      { "fx": { "aura": "fx_star_00" } },
      { "fx": { "aura": "fx_star_01" } },
      { "fx": { "aura": "fx_star_02" } },
      { "fx": {} }                                   // 增量语义：不写 = 沿用，写空 = 隐藏
    ] }
]
```

**三个直接结论**：
1. **零预留成本**——用的是和表情层完全相同的机制，**不需要新增 `effect` 动作类型**，
   播特效就是播一个动作组。
2. **创作平台的"特效"主要落在素材生成上**，不是运行时机制——出一批特效图即可
   （与表情批同构：同机位、透明底、逐格变化）。
3. `at` 让特效位置**相对角色固定**（头顶、脚边、周身），这正是图集特效的适用范围。

### 路线二：代码特效（补充，用于"位置动态"的场景）

`pet-particles.ts` 那类与角色无关、**位置由事件决定**的效果（点在哪儿就在哪儿炸），
图集做不到。可选参数化为清单里的 `effects: { <name>: { kind: "particles", count, gravity, ... } }`。

| | 图集特效 | 代码特效 |
| --- | --- | --- |
| 位置 | 相对角色固定（`at`） | 动态（事件坐标） |
| 素材成本 | 需出图 | 零 |
| 用户可创作 | ✅ 画/生成即可 | ⚠️ 要调参数 |
| 状态 | **已支持** | 现有硬编码，可选参数化 |

> ⚠ 粒子的 `PALETTE` / `SPARKLE_PALETTE` **刻意不接主题令牌**——
> 理由是"每帧随机取色不能读令牌"。用户自定义调色板与这条不冲突，**别顺手改成读令牌**。

---

## 六、素材生产流程

### 6.1 路线 A（`pet-creator`）：四步

```
问清楚 ─▶ 定画布 ─▶ 设计出图批次 ─▶ plan 取提示词 ─▶ image_generate ─▶ build 流水线
```

1. **问清楚**：风格（像素 / 2D 高清）、配色、名字。用户说清楚了的别追问。
2. **定画布**：先定画布再定出图（表见 §2.2）。
3. **设计批次**——**一批 = 一个动作组，格 = 这段动作的关键帧**。
   每批必须给**动作名**（`action`）与**动作经过**（`motion`，按时间顺序写）。
   ⚠ 只给名字（「挥手」）模型会自由发挥成四个**看着像**挥手的姿势；
   ⚠ **四个姿势不等于一段动作**（实测产出的 `real_dog` 就是这样，
   待机循环里会冒出抬爪和低头）。
4. **提示词不要自己写**，用 `action: "plan"` 让工具链渲染。
   **`background` 别自己指定**——它按 `characterColors` 算出来，
   见 §八「能算的题别肉眼估」。

**表情/口型批**要给 `kind: "expression"` + `part` + `variants`：
它们出的不是"一段动作"，而是**并列的几款差分**（同姿势同机位、只某部位不同）。

**贯穿全部批次的一条**：每批都要**重新完整描述角色**（种类、配色、风格、描边），
不要只说"同上"——不同批次之间没有记忆，一致性靠复述。

### 6.2 路线 B（`pet-sprite-h3`）：两段式

```
立绘 ──stage-frame──▶ staged/<角色>.png ──h3-motion sheet──▶ 精灵表 ──install-pet──▶ 客户端
```

**侧面视角要多一段**：

```
正面立绘 ──h3-motion pose（尾帧自由）──▶ 姿势图 ──pose-pick──▶ 挑一帧
   └─▶ stage-frame --keep-scale ──▶ staged/<角色>-<姿势>.png ──▶ 再跑上面那条循环
```

**为什么非要两段**：管线的首帧同时当首帧和尾帧（FL2VA），用正面立绘直接生成侧身循环，
末帧会被**强制拉回正面**，循环里出现"转过去→被拉回来"的鬼畜。
姿势图那一轮**不接尾帧**，角色才能真正转过去；循环闭合交给下一轮。

### 6.2.1 ⚠ 批量出组时的流程纪律：**边跑边装，别攒到全齐**

一个角色要出十几二十组时，**每跑完几张表就装一次包**，不要等全部生成完再一次性验收装包。

**为什么**（2026-09-25 月兔小仙 22 组实测）：

- **「全齐」是个脆门槛。** 那一夜客户端被重启**两次**、打断 Agent **两轮**——
  「全齐」随时可能永远等不到。
- **坑会在第一张表就暴露，而不是三小时后。** 那批**提前装**当场撞出四个，
  全是"一次性装到最后"永远不会暴露的（因为那时条件已经齐了）：
  1. **fx 光环从来没真进过包**——拼条 alpha 全是 255、92% 是纯绿，**根本没抠底**；
     而且软光晕 + 绿幕天生冲突（渐变每一级都要路过绿色）
  2. **`install-pet` 在 `Crawl` 缺席时会把 `perchGaps` 抹平**（`{wall:0.317}` → `undefined`）
     ——它只在同时有 Climb + Crawl 时才写这条
  3. **`--fx-dir` 漏一次，fx 就静默消失**（历史上它就是这么没的）
  4. **并发**：两个全量重装共用一个写死的 `<id>-work` 中间目录，互相删对方的文件
     （`ENOTEMPTY`）
- 反过来，随时打开客户端都能看到"又多了几个动作"，而不是等三小时一次性到账。

**前提（先验再依赖）**：

- **交付步骤必须幂等。** `install-pet` 是**全量重装**（每次把 `--dir` 下所有
  `<角色>-*-sheet` 装一遍），所以随时装都安全、不会丢已有的组。
  换成"追加式写库/写文件"，重复执行会产生重复项——那时得先补幂等，否则增量会制造新问题。
- **并发装包要加锁。** 见上面第 4 条：全量重装的中间目录是共享资源。
- **判据不放松。** 宽容忍度（贴边不管、残留绿点不管、只有首尾跳变和身份画崩才判死）
  不会因为增量而变。

### 6.3 两条线共用的素材约束

1. **底色必须与角色所有颜色（尤其描边）保持足够距离**。抠底靠连通性 flood fill，
   容差一旦超过"描边色距底色的距离"就会**穿透描边漏进角色内部**——实测误差暴涨 300 倍。
   **这条已经交给代码**（列出 `characterColors`，出图计划算出离它们都最远的颜色当底色）。
2. **别把底色写死成精确值就当它会准**。实测提示词写 `#D9218F`，
   实际产出在 `#d11b89`–`#db1782` 之间波动。工具链会自动估计底色，**不要传 `--bg`**。
3. **每批的末格回到首格附近**，否则循环时有一次跳变。
4. **`idlePin: true`**（一次性动作该加）：把这一组的首末格**按名引用待机首帧**，
   "从待机进这个动作"和"播完接回 `next`"两头都是像素级相同。
   ⚠ **不要**指望"让模型把待机站姿画进第一格"——重画同一个姿势必然漂移，
   真正的无缝只有"端点就是同一张图"这一条路。只给**从哪来回哪去**的动作加。

---

## 七、验收：判据必须落到数字或字符上

**本机 `Read` 读不了图**（png/jpg 一律 `[Unsupported Image]`），所以
"头朝哪、脚够不够得到墙"这类判断**必须落到字符或数字上**。取证四件套：

```bash
# <技能> = apps/windows/bundled-skills/设计与可视化/pet-sprite-h3
node <技能>/characters/pixel-ascii.mjs <图.png> 72 --alpha          # 看单张图（抠底过的走包围盒 + --alpha）
node <技能>/characters/atlas-cell.mjs <宠物包目录> <输出目录> <帧名>   # 从装好的图集里抠某一格
node <技能>/characters/mock-perch.mjs <宠物包目录> /tmp/mock.png --view -16,0,340,300 --zoom 3
node <技能>/characters/shot-probe.mjs /tmp/pet.png                   # 抓运行中的宠物窗，找出宠物在哪
```

⚠ 四条通用陷阱：

1. **别量还在写的产物**——文件存在、大小稳定都**不等于写完**，判据必须等产出进程退出。
2. **别把长跑命令接 `| head`**——`head` 读够就关管道，进程再写日志拿到 EPIPE 被杀，
   **而退出码仍是 0、日志停在中间**，看起来像生成失败。看进度用重定向到文件 + `tail`。
3. **宠物窗口是全透明的**，截出来整幅 alpha=0（看着全黑）。往页面里注入
   `#root>div{background:#f2f2f7 !important}` **能生效**，注入 `html,body{...}` **不行**。
4. **屏幕睡着 / 主窗最小化时宠物窗根本拍不了**——rAF 被掐到 1fps，
   **宠物是 rAF 驱动的，屏幕不亮它一步不走**。判据：`[tick]` 日志同步断掉。

**装完的自检**（客户端必须在运行）：

```bash
node <技能>/characters/sheet-canvas.mjs --dir <动作表根目录> --char <角色> --canvas <W>x448
```

它报「会被裁掉多少 px」，**超了就退出码 1**。

**回归防线**（改完跑）：

```bash
pnpm --filter ./apps/windows test:all     # 含 pet-registry-assets（注册表 ↔ 磁盘一致性）
pnpm --filter ./packages/pet-core test
pnpm typecheck
```

> `apps/windows/src/main/pet/pet-registry-assets.test.ts` 是**资源守卫**：
> 注册表里写的东西磁盘上必须真的存在。实测踩过一次——目录写成 `demo-pixel-cat`（连字符）
> 而 `modelUrl` 用 `demo_pixel_cat/manifest.json`（下划线），客户端只在运行时报 404、
> 界面上一片空白。删模型时它会在 CI 上先红。

---

## 八、硬规则索引（**二十三条，每条都是实测换来的，别推翻**）

正本在 [`pet-sprite-h3/SKILL.md`](../../apps/windows/bundled-skills/设计与可视化/pet-sprite-h3/SKILL.md) §四。
按"什么时候会撞上"重排：

| 你要做的事 | 先读 |
| --- | --- |
| 让动作能循环闭合 | ① 循环闭合靠 FL2VA，不是靠提示词求；⚠ 姿势图那一轮**反过来必须不接尾帧**（接反了**出图看着完全正常**） |
| 摆首帧 | ② 首帧必须先 staging（它是机位标定）；④ **`--ratio` 不是留白旋钮，`--baseline` 才是**；⑤ 姿势图要 `--keep-scale` |
| 选底色 | ③ 底色用「颜色名 + hex」写进提示词，只给 hex 是弱信号；⑧ S8 底色离角色色太近（安全线 150） |
| 抽帧 / 定回放速度 | ⑩ 抽帧数与源片长**成对**改，只抬源片长是**把动画放快**；⑪ 回放帧率按动作挑，不都是 8 |
| 加动作组 | ⑥ 每个动作的首帧必须是它自己的姿势（抽帧**含第 0 帧**）；⑬ 循环动作用**独立姿势图**当首帧；⑭ 借用别的动作的机位用 `stage.from`，别复制文件 |
| 打包 / 装 | ⑫ 图集列数必须随帧数生长（超 8192 = **整张图集建不出纹理、宠物直接不显示**，不报错）；⑮ 拼条列数写进 `f0000.json` |
| 改画布 | ⑯ 新动作进了归一化组就可能**改整组的倍率**（宠物凭空缩水）；加完必须跟旧值对照 |
| 攀爬 / 天花板 | ⑧ `Crawl` 那一行必须倒挂，而且是**谁装谁翻**；⑨ 装完必须写 `perchGaps`，不写就是**静默用 Shimeji 的数** |
| 编排时序 | ⑰ 一次性动作时长必须 < 2.6 秒 |
| 加特效 / 粒子 | ⑱ **粒子不许画进动作帧**——模型画的底色跟精确底色对不上（实测差 26~80）、`threshold=30` 抠不掉，而且**只长在中间格**；位置时机也不归代码管。特效走 `slots` 非 base 批次（`install-pet --fx-dir`） |
| 清碎块 | ⑲ **两道拦截**：机位图一道（`--drop-debris`）+ **抠完底再一道**（中段的渣是视频播放中长出来的，机位图拦不住）。"离本体"**必须用像素距离**——按包围盒算时"花瓣飘在躯干正前方"间距是 0，实测 102 个非本体块会漏掉 96 个 |
| 做上升 / 飞行动作 | ⑳ 机位图那一步就要**留顶空**（`ratio ≤ 0.65` 才会换成"站在画面下半部"）；不留的话整批被 S1 拒（实测 16 格里 12 格切头）。⚠ 但留空只解决一半——另一半见 ㉒ |
| 做位移动作（跳 / 飞 / 爬） | ㉒ 画面内位移**必须有硬上限**，真正的位移归客户端：措辞写"大约十分之一、绝不超过"模型照样超（实测要 278px 余量只有 234px，**无解**）。`motionClassMap` 别用 `displacement`（那句"整个人可以在画面里升起"就是长途位移的邀请函），用 `riding`；⚠ 别写"待在画面下三分之二"——那是把底空删掉，下降段必然踩底边 |
| 抠完底发现边缘发绿 | ㉑ 抠底只管**透明不透明**，颜色要单独修一道。**压绿（clamp）是错的**：绿边变灰边，离角色本色从 150 **远到 171**。换色（recolor，从干净内部像素扩散）+ **保住自己的明度**才对。⚠ 半透明那圈（64≤alpha<250）**必须一起进刀口**——它占整圈绿色的一半，只管不透明像素等于白干一半 |
| 摆首帧（续） | ㉓ `--keep-scale` **必须配 `--src-h`**，不给就按**目标画布**算 → 小人缩一号（实测 0.44 vs 该有的 0.65）。摆完跟别的动作组对一遍尺寸 |

**画布尺寸怎么定**（第五节）：**这个数不能靠推——量**。
归一化倍率的分母是**「组内最高包围盒」**，不是这一帧自己的高。
⚠ **`canvas.h` 不能动**——宠物在屏幕上的观感大小 = `canvas.h × scale`。

**出了图但"看着不对"**：先看 §七的取证四件套，别靠猜。
⚠ **出图闸门（S1/S2/S4/S6/S8）拦下的批次不要放宽判据去凑，重出。**

---

## 九、已知缺口（**别以为它已经能用**）

| 缺口 | 现状 | 影响 |
| --- | --- | --- |
| `interactions[]` 未接线 | 格式已定，Windows 端零消费者 | 手写进清单**不生效**（§四） |
| 三张"事件→表现"表零消费者 | `petStateMachine` / `state-expression-policy` / `agentSignalMapper` 只有导出与测试引用 | 现在跑的是 `PetOrchestrator` 的布尔标志 + switch，**两套最终要合一** |
| 随包团子是**旧版** | `resources/pet-models/demo_cartoon_cat/` 是 144×168 / 3 组；实机那套（560×448 / 22 组）装在 `~/.lumii/pet-models/` | **新装机器拿到旧版**，表现为缺组降级（一边平移一边播呼吸）。补法见 [`sources/pet-motion/README.md`](../../verify/pet-sprite/sources/pet-motion/README.md) |
| 两套后端能力不对等 | Live2D：无 `setGaze`、库自己循环待机；sprite：必须编排器主动启动 | **规则要声明能力前置条件**，别假设两端行为一致 |
| 授权 | Live2D 样本模型与 AI 生成图均**仅限开发测试**，发布前必须替换或确认 | 见 [`resources/pet-models/LICENSE`](../../apps/windows/resources/pet-models/LICENSE) |

---

## 十、地图：出问题去哪

| 我要… | 去哪 |
| --- | --- |
| 做一只新宠物（Agent 自助） | 技能 `pet-creator`（AI 直出图集）/ `pet-sprite-h3`（视频模型出帧）的 `SKILL.md` |
| 看渲染契约（清单字段、槽位、动作组语义） | [`虚拟人精灵图渲染后端设计`](../design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md) + [`packages/pet-core/src/model/`](../../packages/pet-core/src/model/) |
| 看行为怎么决策 | [`精灵宠物自主行为设计`](../design/客户端UI/2026-09-21-精灵宠物自主行为设计.md) + [`packages/pet-core/src/behavior/`](../../packages/pet-core/src/behavior/) |
| 看通知/审批怎么驱动宠物 | [`Agent通知与审批闭环设计`](../design/客户端UI/2026-09-22-Agent通知与审批闭环设计.md) |
| 查实测数据（抠底/切片/对齐/原语） | [`验证报告`](../test/pet-sprite/验证报告.md)，复现脚本 `verify/pet-sprite/check-*.mjs` + `fixtures/` |
| 给团子换素材 / 重装 | [`verify/pet-sprite/sources/pet-motion/README.md`](../../verify/pet-sprite/sources/pet-motion/README.md) |
| 看 H3 这条线交付了什么 | [`H3精灵图动作组与桌宠行为补全实施记录`](../plans/客户端UI/2026-09-22-H3精灵图动作组与桌宠行为补全实施记录.md) |
| 看工具链算子清单 | `packages/pet-asset/src/toolchain.ts`；控制口算子见 [`pet-asset-ipc.ts`](../../apps/windows/src/main/pet/pet-asset-ipc.ts) 的 `PetAssetOp`（`validate` `install` `cutout` `slice` `align` `normalize` `pack` `sheetPlan` `sheetCheck` `diffLayer` `hitAreas` `idlePin`） |
| 在浏览器里看效果 | `pnpm --filter ./apps/windows lab`（pet-lab，含三方案对比夹具） |

---

**前向引用**：`interactions[]` 接线（§四）与两套状态表达合一（§九）是下一阶段的事，
落地时把本文 §四 的状态从"未接线"改成"已接线"，并在
[`宠物创作平台预留设计`](../design/客户端UI/2026-09-21-宠物创作平台预留设计.md) §四 的 T1–T5 上标注完成。
