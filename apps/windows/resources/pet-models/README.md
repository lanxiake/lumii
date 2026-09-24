# 随包宠物模型

`registry.json` 是客户端启动时读的注册表，`mergePetRegistries` 会把它与
`<数据根>/pet-models/registry.json`（用户自建/安装的）合并，同 id 用户优先。

## 两类模型

| 目录 | 类型 | 来源 |
| --- | --- | --- |
| `mao_pro/` `ug_official/` `xiaomai/` | Live2D | 见 `LICENSE`：**仅限开发测试** |
| `demo_cartoon_cat/` | 精灵图（AI 生成） | 见下 |

**已清理（2026-09-24）**：`demo_anime_girl`（樱桃）、`demo_mecha_gundam`（钢羽）、
`demo_shimeji_*`（五只 Shimeji 猫）与 `_variants/`（P0-b 三方案夹具）随宠物实验线收口一并移除。
前两者是 P1 生成线的示范模型，后者是第三方素材与测试夹具。
**变体夹具没删**——它搬到了
[`../../src/renderer/pet/renderer/sprite/fixtures/variants/`](../../src/renderer/pet/renderer/sprite/fixtures/variants/)，
仍由 `sprite-assets.test.ts` 与 `pnpm lab` 使用。

## 团子（`demo_cartoon_cat`）

### ⚠ 随包这份是**旧版**，与实机在跑的不是同一套

| | 画布 / scale | 动作组 | 装在哪 |
| --- | --- | --- | --- |
| **随包**（本目录） | 144×168 / 0.65 | Idle、Talk、Wave（共 3 组） | `resources/pet-models/` |
| **实机**（H3 版） | 560×448 / 0.65 | 22 组（见下） | `<数据根>/pet-models/` |

用户数据目录那份优先，所以本机跑的是 H3 版；**新装的机器拿到的是旧版**——
表现为缺组降级（`PetOrchestrator.resolveAmbientGroup` 找不到组时静默回落到基础待机，
宠物会一边平移一边播呼吸）。补上实机那套的办法见
[`verify/pet-sprite/sources/pet-motion/README.md`](../../../../verify/pet-sprite/sources/pet-motion/README.md)。

H3 版的动作组：

```
Idle Talk Wave Jump Nod Shake Picked Land PlayBall      ← 交互九组
Walk Fall Climb Crawl Sit                               ← 行为五组
Yawn Stretch Scratch Dodge Cheer Droop Look Purr        ← 环境八组
```

### 随包这份是怎么来的

- **模型**：`gpt-image-2.5`（经 rightapi），2026-09-21
- **做法**：一个动作一批、一批一张网格图，格子的阅读顺序就是时间顺序。
  提示词由 `packages/pet-asset/src/sheet-prompt.ts` 的 `buildSheetPlan` 生成，
  出图后过 `sheetcheck` 闸门，再走 `pet-creator` 的 `run.ts` 流水线
  （抠底 → 切格 → 归一化 → 差分取层 → 打包 → 校验 → 安装）
- **可复现的脚本**：`verify/pet-sprite/characters/`（`plan-characters.mjs` 出计划、
  `drive-gen.mjs` 驱动真实 Agent 轮次出图、`build.mjs` 走流水线、`registry.mjs` 改注册表）
- **原始出图记录**：`verify/pet-sprite/characters/generated.json` 记着每批出图实际落在
  workspace 的哪个文件，便于追溯
- **可复现的是流程，不是像素**：扩散模型两次生成不会逐像素一致，
  重跑得到的是另一只同设定的角色

H3 版走的是**另一条路**（视频模型出运动帧，不是"一批一张网格图"）——
方法与硬规则见
[`bundled-skills/设计与可视化/pet-sprite-h3/SKILL.md`](../../bundled-skills/设计与可视化/pet-sprite-h3/SKILL.md)。

**授权**：当初从 Live2D 转精灵图，起因就是 Live2D 那几个模型仅限开发测试。
AI 生成图随仓库分发同样要看上游条款（生成服务的使用条款），**落地分发前需单独确认**。
