# fy-code-animation

把中文文案、画风提示词和声音做成**前后连贯的代码动画**（Remotion / Canvas / HTML）的 DeepSeek Harness 技能。

> 免费分享，欢迎免费使用、免费分享；请不要包装成付费课程、付费 skills 或收费资料出售。详见 [LICENSE.md](./LICENSE.md)。

## 它解决什么

做中文动画最容易做成「逐句贴卡的 PPT」：一句话一张图、图标加淡入、每镜时长平均。这个技能把「意思的变化」拆成可执行的流程——读懂全文 → 语义分镜 → 选画风 → 镜头/转场/动作/字体/声音 → Remotion 落地 → 检查返修。

## 包含什么

| 目录 | 内容 |
| --- | --- |
| `SKILL.md` | 总入口：创作顺序、能力路由、质量底线 |
| `modules/` | 方法与判断：语义、风格、字体、背景、运动、镜头、风格分支、影像、产品、音乐、实现、交接、质量 |
| `recipes/` | 具体配方：叙事、气势词、活的背景、群体翻面、镜头运动、转场、接缝、角色、纸偶、风格化、图片快闪、图表地图、音乐音效、UI 16 式 |
| `implementations/` | 可复用源码：motion-core、canvas 契约、Remotion kit、相机/角色/转场/背景/中文文字/数据 UI、specimen 实验场 |
| `adapters/` | 外部对接：341 风格库、Remotion、ACE-Step 本机音乐 |
| `templates/` | 任务卡、分镜表、音乐方案、返修表 |
| `examples/` | 7 个完整任务卡与演练 |
| `scripts/` | `doctor.py` 自检、`style_library.py` 风格库索引、`validate_task.py` 任务卡校验、`glyph_outline.py` 字形轮廓 |
| `tests/` | 逻辑、Canvas 契约、任务卡契约测试 |
| `LICENSES/` | 第三方来源与许可 |

## 安装

把整个 `fy-code-animation/` 目录复制进你的 DSH 技能目录即可，包内全是相对路径、不依赖本机绝对路径：

```sh
git clone https://github.com/Akillll-DuoHe/fy-code-animation.git
cp -r fy-code-animation ~/.dsh/skills/    # 按你的技能目录位置调整
```

国内网络可直接用 Gitee 镜像：https://gitee.com/Akillll-DuoHe/fy-code-animation

## 第一次使用

1. **341 风格库已随技能内置**（`references/代码动画/`），开箱即用，不需要另找库路径。想换成自己整理的库，改 `adapters/style-library.config.json` 的 `root` 或设环境变量即可。
2. 先跑一次自检：

   ```sh
   python scripts/doctor.py
   ```

3. 之后按 `SKILL.md` 的创作顺序调用；只交任务卡时不生成任何媒体。

## 要求

- Python 3.10+（脚本与契约测试）
- Node 20+（`tests/test_logic.mjs`、`tests/test_canvas_contract.mjs`）
- Remotion / Canvas / HTML 任选其一落地，依赖按项目自带

## 测试

```sh
python scripts/doctor.py          # 核心文件与风格库自检
python tests/test_contracts.py    # 13 个任务卡契约用例
node tests/test_logic.mjs         # 12 个运动/时间逻辑用例
node tests/test_canvas_contract.mjs
```

## 下载

- Release 附件 `fy-code-animation-v1.0.0.zip`（GitHub 与 Gitee 都放了）
- 也可以直接用源码：整个目录复制即安装

## 许可

见 [LICENSE.md](./LICENSE.md)。包内第三方内容保留各自原有许可，来源、版权与许可声明记录在 [LICENSES/README.md](./LICENSES/README.md)。
