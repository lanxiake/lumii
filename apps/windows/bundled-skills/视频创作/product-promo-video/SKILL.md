---
name: product-promo-video
description: 用截图/图表/PIL 卡片拼装产品宣传视频（1920×1080 MP4），支持真实截图演示 + 动态标注、Plotly 数据可视化、纯文字卡片三种素材。当用户要求「给产品做个宣传视频 / 演示视频 / 数据可视化短片」时使用。
metadata:
  {
    "mtbot": { "emoji": "🎬", "requires": { "bins": ["python", "ffmpeg"] } }
  }
---

# 产品宣传视频（product-promo-video）

把「截图 + 图表 + 文案卡片」切成时间线，用 PIL 出帧、ffmpeg 编码，产出一个可直接发的 MP4。
**无外部 API、无 ComfyUI、无 MoviePy**——只有 Pillow 与 ffmpeg 两个确定性的依赖。

需要「录真实操作过程」的教程视频请用 `screen-tutorial-pipeline`；需要 AI 生成画面的创意视频请用
`video-creation-pipeline`。

## 一、怎么跑

脚本：`scripts/generate.py`，一次 `execute_skill` 调用完成全部工作。

```
execute_skill({
  id: "product-promo-video",
  params: {
    config: { ...见下方 config 结构... },
    selfcheck: false        // 第一次先传 true：只验证配置与首帧，不出视频
  }
})
```

返回 `{ ok, outputPath, bytes, message }`；失败返回 `{ ok: false, error }`。
`ok: false` 就如实把 `error` 转述给用户，**不要**自己编一个成功结果。

命令行等价（调试用）：

```bash
python scripts/generate.py config.json [--selfcheck]
```

`SKILL_PARAMS` 是技能运行时的参数通道；命令行模式下走 `argv[1]` 指定的 JSON 文件。

## 二、config 结构

完整可跑样例见 `scripts/example-config.json`。核心字段：

```jsonc
{
  "style": "product-demo",          // 仅作标记，不影响渲染逻辑
  "intro":  { "title": "...", "subtitle": "...", "seconds": 4 },
  "sections": [
    {
      "title": "小标题", "subtitle": "可选", "seconds": 2,   // 有小标题就先插一张卡片
      "items": [
        {
          "screenshot": "C:/abs/path/shot.png",
          "caption": "底部说明文字",
          "annotation": "highlight_top",   // highlight_top | highlight_center | arrow_down
          "seconds": 5
        },
        {
          "seconds": 8,
          "chart": {                       // 图表走 Plotly
            "type": "indicator",           // indicator | bar | sankey
            "metrics": [
              { "label": "MCP 工具", "value": 30, "suffix": "+" },
              { "label": "数据外传", "value": 0 }
            ]
          }
        }
      ]
    }
  ],
  "outro":  { "title": "...", "subtitle": "...", "seconds": 5 },
  "output": { "dir": "./out", "filename": "product-promo.mp4" }
}
```

约定：

- **单位是秒**，脚本按 30fps 换算成帧；总时长就是各段 `seconds` 之和。
- `screenshot` **必须给绝对路径**（相对路径按脚本工作目录解析，容易踩空）。
- `annotation` 只在截图段生效，会按片段内进度（0.2–0.8 / 0.3–0.7）淡入动态标注；
  给错了不报错，只是不画。
- 每段首尾 10% 自动做亮度渐变，片段之间不会硬切。
- `chart` 依赖 `plotly` + `kaleido`；**缺了不会失败**——日志报一行 warn，自动降级成文字卡片。
  所以可视化段可以不装 Plotly 先跑通全片。
- 输出目录不存在会自动创建；帧序列落在系统临时目录，编码完立即删除（3600 帧≈数 GB，别想着留）。

三种图表形状：

| type | 必填字段 |
|---|---|
| `indicator` | `metrics: [{label, value, suffix?}]`，最多 4 个，自动排 1×1 / 2×1 / 2×2 |
| `bar` | `bars: [{label, value}]`，可选 `title` |
| `sankey` | `nodes: [{label}]` + `links: [{from, to, value}]`，可选 `title` |

## 三、踩过的坑（都已在脚本里处理，别改回去）

| 坑 | 处理 |
|---|---|
| Plotly 出图是 **RGBA**，PIL 画布是 RGB，直接合成报 `operands could not be broadcast` | `_render_chart_png` 用 alpha 通道 paste 到 RGB 画布 |
| 逐帧重读截图，120 秒视频光 IO 就拖垮 | `_screenshot_cache` 按路径缓存，一组截图只解码一次 |
| MoviePy 2.x 模块路径全变（`concatenate` / `fadein` 都搬过家） | **不用 MoviePy**。PIL 出帧 + ffmpeg 拼，零版本依赖 |
| Windows 控制台 GBK，打印 `✓` 直接 `UnicodeEncodeError` | 脚本不打印任何非 ASCII 以外还会炸的符号；运行时已设 `PYTHONIOENCODING=utf-8` |
| 字体路径写死 | `FONT_CANDIDATES` 覆盖 Windows 雅黑 / Linux Noto / macOS PingFang，全找不到才退默认字体 |

## 四、编辑节奏

1. **先 `selfcheck: true`**：它会把每个片段的第 0 帧真渲一遍并断言尺寸/色彩模式，
   几十秒内暴露路径错、图表配置错、字体缺失。**不要跳过这一步直接出片**。
2. 按 `seconds` 控节奏：标题卡 2–4 秒，截图演示 4–6 秒，图表 8–12 秒，结尾 4–5 秒。
   产品宣传片舒适区间 60–120 秒。
3. 出片耗时约「成片时长 × 1.8」（20 秒片≈36 秒 wall clock），超过 3 分钟说明机器在打颤，
   先看是不是截图尺寸过大。
4. 交付时给**绝对路径 + 文件大小 + 时长**，不要只说「生成了」。

## 五、素材与隐私（硬约束）

- 只使用**公开 README 内容**与**产品界面截图**；截图里的真实会话/联系人必须换成演示数据或打码。
- **禁止**为做视频去读用户真实聊天库、导出真实联系人。视频素材只能来自用户明确提供的路径。
- 数据含他人隐私：全程本地处理，不外传。

## 六、封面/卡片观感

脚本内建的视觉语言是「深色底 + 40px 网格 + 青色主标题 + 底部黑条字幕」。
想换风格就改脚本顶部的 `BG_COLOR` / `ACCENT_COLOR` / `TEXT_COLOR` 三个常量，
**不要**在 config 里加配色字段——那会变成每个用户都要配一遍的东西。
