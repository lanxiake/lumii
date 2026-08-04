# 数据目录规范（扁平结构 · 一篇一目录 · 进度留存）

所有抖音创作产出**统一**放在本 `data/` 目录下，结构对齐 `xiaohongshu-content-pipeline` 与 `wechat-content-pipeline`，
便于跨平台系列内容并行管理。

## 目录结构

```
data/
├── README.md                          ← 本文件
└── <topic-collection>/                ← 主题合集（kebab-case，如 k8s-douyin-series）
    ├── 00-series-outline.md           ← ⭐ 合集大纲 + 进度追踪表（每次接手必读）
    ├── samples/                        ← 样板成品（参考，可空）
    └── articles/
        └── <YYYYMMDD-slug>/            ← 单条内容目录（日期 + 短标题）
            ├── research.md            ← 研究材料（主题/受众/核心观点/参考/差异化/禁区）
            ├── brief.md               ← 知识猫图解 STEP 1（分类/认知颠覆点/反直觉金句）
            ├── outline.md             ← 分镜大纲（通用钩子结构 或 知识猫图解模块链）
            ├── series-plan.md         ← 知识猫图解 STEP 4（系列规划表/模块依据/平台适配）
            ├── final.md               ← ⭐ 口播脚本 + 字幕文案 + 发布描述 + 标签
            ├── images/                ← 01-cover.png / prompts.md（图集模式）
            ├── video/                 ← final.mp4（图转视频或实拍）
            ├── publish.md             ← 发布版（标题/描述/素材清单/类型）
            ├── publish-options.json   ← 发布选项（合集/声明/定时/封面/音乐/mode）
            ├── publish-title.txt      ← CDP/CLI 发布用标题
            ├── publish-desc.txt       ← CDP/CLI 发布用描述
            └── publish-report.md      ← 发布结果留档（账号/模式/时间/状态）
```

> 与小红书流水线一致点：合集大纲 `00-series-outline.md`、研究 `research.md`、大纲 `outline.md`、
> 正文 `final.md`、单篇 `articles/<日期-slug>/`、`samples/` 留样板。
> 抖音特有点：`video/` 目录替代小红书的 `images/`，以及视频专用的 `publish-report.md`。

## 命名规则

- **合集 slug**：主题英文 kebab-case，2-4 词。例：「K8s 系列」→ `k8s-douyin-series`
- **单条目录**：`<YYYYMMDD>-<slug>`，日期为创作日。例：`20260606-kubectl-internals`
  - 同日同主题冲突时追加序号：`20260606-kubectl-internals-2`
- **视频文件**：`video/final.mp4` 为默认待发布成片；原始素材可用 `video/raw.mp4`

## 进度管控：`00-series-outline.md` 追踪表

每个合集的 `00-series-outline.md` 必须含一张进度表，AI 每次接手前先读、完成阶段后更新：

| 编号 | 标题 | slug | 状态 | 发布日期 |
|------|------|------|------|---------|
| 1 | 示例标题 | 20260606-example | 待写 | - |

**状态取值**：`待写` → `已写脚本` → `已生图` → `已剪辑` → `待发布` → `已发布`

## 历史留存：`publish-report.md`

每次真实发布后，在该单条目录写 `publish-report.md` 留档：

```markdown
# 发布记录
- 账号: <account name>
- 发布类型: 视频 / 图文
- 发布模式: 无头 / 有窗口
- 发布时间: 2026-06-06 14:30
- 状态: 已发布 / 仅填表未发布
- 备注: <如重发/失败原因等>
```

## 与子技能产出的对应关系

| 阶段 | 子技能 | 产出文件 |
|------|--------|---------|
| 定位 | social-content（跨流水线） | 写入 `research.md` 受众/目标段 |
| 研究 | content-engine / crawling-social-media | `research.md` |
| 大纲 | douyin-script | `outline.md` |
| 脚本 | douyin-script | `final.md` |
| 生图 | douyin-images | `images/prompts.md` + `images/*.png`（通用 9:16 或知识猫图解 3:4） |
| 知识猫图解大纲 | knowledge-cat-illustrated | `brief.md` + `outline.md` + `series-plan.md`（见 `themes/knowledge-cat-illustrated/AGENT-PROMPT.md`） |
| 合成视频 | compose-douyin-video | `video/final.mp4` |
| 实拍 | 用户自备 | `video/final.mp4` |
| 发布 | post-to-douyin / douyin-upload | `publish.md` + `publish-report.md` |
