# 来源与许可边界

本包已为有权许可的原创内容与整理成果指定 [使用与分享说明](../LICENSE.md)：免费使用、免费分享，不要重新包装成付费课程、付费 skills 或收费资料出售。本包采用的第三方内容仍按各自原许可执行，原始声明随所用部分保留。本次仅整理许可说明，未发布、安装或收费。

| 采用部分 | 来源与快照 | 保留声明 |
|---|---|---|
| `implementations/specimen/`、`implementations/craft/` 中选定组件、`scripts/glyph_outline.py` | renoise-ai/renoise-skills，3d82d8df22a4e4d942c317fb13264d4a8eb046a6 | [Renoise MIT](renoise-MIT.txt) |
| `references/motion-craft/` 的导演、模式与参数参考 | LottieFiles/motion-design-skill，f9a8a041b85185ee4881b3471d3415e939aac772 | [LottieFiles MIT](LottieFiles-MIT.txt) |
| `recipes/ui-16-recipes.md` | charlie947/motion-graphics-skills，229022ebca76972e119e36ada23a1648d51665ab | [Charlie Hills MIT](CharlieHills-MIT.txt) |
| `recipes/paper-performance.md`、`recipes/formation-and-mosaic.md` 的完整选定章节 | klsoen/opus-js-animations，be8d5792ffff563c9dc62933bbe5627ac41a89e0 | [klsoen MIT](klsoen-MIT.txt) |
| `recipes/seams-and-seek.md` 中接缝代码/参数参考与修改 | heygen-com/hyperframes，e1a8c7f1730149a81d5aa5863b963487a2e3955e | [HeyGen Apache 2.0](HeyGen-Apache-2.0.txt)；Copyright 2026 HeyGen, Inc. |

改动及精确文件来源见 [所选来源映射](selected-sources.json)。修订后的文档/代码属于适配复用，不能称为原封不动的上游实现。Apache来源的接缝配方已重新组织中文说明、纠正总时长与导数、改为显式变量并补充时间接口。其仓库根无NOTICE；搜到的测试媒体/GSAP资产NOTICE属于未采用资产。GSAP本身未分发。

341风格库只附编号、名称、相对路径和哈希索引，不附原提示词全文、预览或demo。调用者必须提供可访问的原库，遵守原库的免费使用/分享、禁止包装收费产品等约定。索引并不替每条素材授予额外许可。

onetake的PolyForm非商业原文和实现未并入候选；仅作通用时序原理比较。其他未复制仓库的链接与方法判断不意味着携带其许可证下的完整产品。字体、品牌Logo、照片、声音、三维模型、地图数据与依赖库均须在实际选用时核其各自来源；本包不附这些外部资源，也不将代码许可套到素材。

`motion-core.mjs`、`canvas-contract.mjs`、`implementations/craft/motion.ts`、检索与任务校验脚本为本次项目新写；`specimen/StudioEnv.tsx` 是从Renoise选定文件抽取的适配。静态校验通过不改变版权归属或代表运行保证。

## v2.1补全

本次新增transitions、camera、type-cn、backgrounds、remotion-kit、data-ui、character、audio-sync为独立编写的实现或对包内已保留组件的薄包装，不复制未许可官方技能代码。Decode.tsx沿用Renoise适配基础，新增alphabet/seed与约束，原MIT声明继续保留。新增配方按主题重新组织，研究依据和读取边界见包外研究与验收/v2.1补读；学习通用方法不代表原实现已经全读或运行。本包原创内容与整理成果的使用和分享按 [使用与分享说明](../LICENSE.md) 执行，不把整包宣称为单一MIT产品，也不以作者说明替换第三方许可。旧验证陈述仅历史，本次未测试。
