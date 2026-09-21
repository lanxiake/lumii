# 随包宠物模型

`registry.json` 是客户端启动时读的注册表，`mergePetRegistries` 会把它与
`<数据根>/pet-models/registry.json`（用户自建/安装的）合并，同 id 用户优先。

## 三类模型

| 目录 | 类型 | 来源 |
| --- | --- | --- |
| `mao_pro/` `ug_official/` `xiaomai/` | Live2D | 见 `LICENSE`：**仅限开发测试** |
| `demo_anime_girl/` `demo_cartoon_cat/` `demo_mecha_gundam/` | 精灵图（AI 生成） | 见下 |
| `_variants/` | 精灵图（合成夹具） | P0-b 三方案对比用的测试夹具，不在注册表里 |

## 三只示范模型是 AI 生成的

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

| 模型 | canvas / scale | 动作组 | 表情层 |
| --- | --- | --- | --- |
| 樱桃（二次元少女） | 144×168 / 0.65 | Idle、Talk、Wave | 4 档眼睛 |
| 团子（卡通猫咪） | 144×168 / 0.65 | Idle、Talk、Wave | 无（差分取层未达标，见计划 §6.3） |
| 钢羽（3D 机甲） | 144×168 / 0.65 | Idle、Talk、Wave | 无（同上） |

**授权**：当初从 Live2D 转精灵图，起因就是 Live2D 那几个模型仅限开发测试。
AI 生成图随仓库分发同样要看上游条款（生成服务的使用条款），**落地分发前需单独确认**。
