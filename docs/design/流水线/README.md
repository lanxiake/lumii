# 流水线（Pipeline）

确定性流水线：把「长且步骤可枚举」的自动化从模型自由循环降级为「代码执行一份声明式 spec」。

| 文档 | 状态 |
|---|---|
| [`2026-10-29-确定性流水线设计.md`](2026-10-29-确定性流水线设计.md) | 设计待评审 |
| [`prototype/pipeline-ui.html`](prototype/pipeline-ui.html) | 前端原型（单文件可交互，含深浅主题） |

实施计划在 [`../../plans/流水线/`](../../plans/流水线/)（评审通过后再写）。

## 一句话

剧本给 LLM，执行给代码，时间戳给系统，LLM 只在出错时被叫回来一次。

## 与既有工作的关系

- 取代 `bundled-skills/视频创作/screen-tutorial-pipeline/SKILL.md` 里的「执行」职责；该技能降级为作者态（探路 / 写 spec）。
- 不动 `录屏与教程/` 的采集、narrate 融合、字幕烧录。
- 引擎作为插件 `com.lumii.pipeline` 交付；流水线本身是数据（`{workspace}/pipelines/<id>/spec.json`），不是插件。
- spec 随工作区走 git + 云同步（`workspace/pipelines/`），换设备可直接用；`runs/` 进 VCS 忽略清单。

## 原型怎么看

```bash
start docs/design/流水线/prototype/pipeline-ui.html
```

四节：流水线管理页 / 对话时间线卡三态 / 槽位落点 / 与 skill 的成本对照。左栏可点，右上角切深浅主题。
截图：`prototype/preview-dark.png`、`prototype/preview-light.png`。
