# Wiki 主题层级化改造设计

> 日期：2026-08-27
> 状态：设计定稿（待实施）— **v4**（一/二/三期完整规格）
> 前置：[2026-08-25-wiki-design-p0p1p2.md](./2026-08-25-wiki-design-p0p1p2.md)（P0/P1 已实现）
> 目标：将 Wiki 从「按来源分类的资料库」改造为「按用途层级组织的文件目录」
> 当前 schema 版本：V21（本设计一次迁到 V22，三期共用，不再为图谱另开版本）
> 原型：[2026-08-27-wiki-topic-hierarchy-prototype-full.html](./2026-08-27-wiki-topic-hierarchy-prototype-full.html)

**相对 v2 的关键修正**（实施以本文为准）：

1. 分类轴从「领域主题」改为「文件用途」；口诀写入分类器。
2. AI 全程不得新建大类/小类、不得写临时存放；拿不准留待整理。
3. 主题落库为 `topic_category` + `topic_subtopic` 两列（小类名可含 `/`）。
4. 三条路径：系统队列 / 用户直写 / AI 候选，互不交叉。
5. 一、二、三期在本文一次性设计完整；分期只约束**实现顺序**，不留「以后再想」的规格空洞。

**目录**：§0 问题与分类法 → §1 目录模型 → §2–§4 数据与归档（一期核心）→ §5–§7 检索/前端/并发 → §8–§12 二期（改树、重编目、笔记、综述、清理）→ §13 三期图谱 → §14–§19 流程、命令、分期、迁移、成功标准、不做。

---

## 0. 问题诊断

### 0.1 用户真实需求

> "我想要的 wiki 是可以把我上传的文件和文档、AI 生成的文档和文件，按照主题整理归纳成类似于书本目录一样的东西。我想看原始资料的时候可以检索和打开对应的资料。"

此处「主题」按**用途**理解，不是按学科领域理解。同一份「机器学习 PDF」可能是教材、项目产物或计划草案，应进不同目录。

核心诉求：

1. **两级目录**——大类 / 小类，不是按「资料是什么形态」（文档 vs 多媒体）分栏
2. **点目录直接看文件**——小类是叶子；点大类则列出该大类下全部文件
3. **列表项直接打开原文件**——不经过摘要页、不经过卡片
4. **聊天消息不纳入**——Agent 对话不进 Wiki；用户上传的会议纪要 / 聊天导出文件仍按用途归档

v1 的「编目卡摘要页」已移除：目录到文件之间不要额外卡片实体。

### 0.2 现状与根因

当前实现（P0/P1）的六个顶层分类：

```
sources/    文档类资料（默认落点）
media/      多媒体资料索引
inbox/      待整理
concepts/   概念页（UI 不可见）
entities/   实体页（UI 不可见）
syntheses/  综述页（只在综述视图可见）
```

**根因**：这六个分类是**来源类型**，不是用途。同一用途的 PDF 与截图会被拆到两个分区。

分类器提示词硬写死 `<分类>/<单层slug>`，AI 从未按用途树归档。左栏是扁平常量导航。打开原文件的链路断在：归档页不带 `sourceRef`，renderer 未接 `shell.openPath`。

与刚落地的 [设置页 UI 重设计](./2026-08-27-wiki-settings-ui-redesign.md) 的关系：本设计**替换**其「资料 / 多媒体」一级分区和「详情侧滑」；任务 pill、任务中心、更多菜单壳体保留。

### 0.3 设计原则

1. **按用途归档，不按领域、不按文件形态**：先用口诀定大类，再在该大类已有小类里选；`media_type` 只做列表筛选标签
2. **骨架用户可改、AI 不可发明**：默认六大类 + 预设小类；用户可增删改名合并；AI 只能选当前树里已有的节点
3. **目录即终点，不设摘要卡**：小类下直接是文件列表；综述接受后也落成一份普通文件，不写编目卡
4. **三条操作路径互不交叉**：系统未处理完 → 待整理；用户知道去哪 → 目录选择器直写；用户要 AI 建议 → 重新编目候选
5. **聊天消息不摄入**：切断 `item_type=chat` 入口；会议纪要等**文件**仍可进「做事记录 / 会议聊天记录」
6. **临时存放仅用户可写**：AI 永不写入；无小类层；不进主题树 JSON
7. **结构边廉价、语义边昂贵**：三期图谱用用途树动态推导结构，ERO 只在邻域抽取
8. **一次 schema，三期共用**：V22 把主题列、资料 FTS、ERO 的 `source_id` 一次加齐；未做的期次列可空、命令可后挂

### 0.4 默认分类法（用途轴）

正式大类 **不含**「临时存放」。临时存放是系统常量 `PARKING_CATEGORY`，不进 `topic_categories`。

主题树用**有序数组**（二期要排序），不用对象 key（ES 插入序不可作为产品契约）：

```json
{
  "version": 1,
  "categories": [
    { "name": "做事记录", "subtopics": ["项目/任务资料", "会议聊天记录", "汇报总结文稿", "规则制度文档", "数据统计报表", "对外沟通材料"] },
    { "name": "学习资料", "subtopics": ["课堂&课程笔记", "读书摘抄整理", "调研搜集材料", "考试备考资料", "知识思维导图", "行业专题材料"] },
    { "name": "计划与复盘", "subtopics": ["目标规划方案", "日程待办清单", "风险预案", "收支预算测算", "经历复盘总结", "备选方案记录"] },
    { "name": "证件凭据", "subtopics": ["合同协议文件", "证件扫描副本", "票据收据凭证", "保险相关资料", "个人履历档案", "申请证明材料"] },
    { "name": "模板参考", "subtopics": ["各类文档模板", "PPT与表单素材", "范文案例参考", "图片媒体素材", "工具使用参考", "文案脚本素材"] },
    { "name": "随笔创作", "subtopics": ["原创作品底稿", "灵感随手记录", "爱好相关笔记", "生活感悟随笔", "作品修改草稿"] }
  ]
}
```

落库存展示名（个人库体量可接受改名级联）。分类器与 UI 只见 `name`。

#### 快速归类口诀（分类器与用户共用）

- 事情做完留下的结果 → **做事记录**
- 用来学习吸收知识 → **学习资料**
- 打算做什么、做完反思 → **计划与复盘**
- 可以当证据凭证 → **证件凭据**
- 拿来复制修改参考 → **模板参考**
- 自己随心写的爱好作品 → **随笔创作**
- 没想好放哪里，先放这里 → **临时存放**（仅用户；AI 不得选用）

#### 易混规则（写入分类器）

- 先定大类，再选小类；同一学科内容可以进不同大类
- 填好的计划 / 预算 / OKR → 计划与复盘；空白可套用的 → 模板参考
- 项目交付物、需求文档、会议纪要文件 → 做事记录；同一主题的教材 / 摘抄 / 调研 → 学习资料
- 证件扫描、合同、发票、保单 → 证件凭据，即使内容也关联某项目
- Agent 对话消息不归档；用户上传的会议纪要、聊天导出 → `做事记录` / `会议聊天记录`
- 拿不准 → 不归档，留待整理，不要猜，不要写临时存放
- 一份文件只挂一处

「临时存放」口诀里的「待整理文件、没写完的草稿…」是**举例**，不是真实小类。

---

## 1. 目录模型

### 1.1 概念对应

```
概念            Lumii                              落在哪
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
大类            用途白名单（有序）                 topic_categories.categories[].name
小类            该大类下的二级目录（叶子）         categories[].subtopics[]
文件            一份资料一条记录                   wiki_sources 一行
笔记            用户新建的本地 md（二期）          也是 wiki_sources，mime=text/markdown
综述            用户触发、接受后的一份新文件（二期） wiki_sources + outputs 落盘
待整理          系统尚未归档完成                   wiki_inbox；外加 topic 为空的存量 sources
临时存放        用户主动搁置                       topic_category='临时存放' 且 subtopic 为空
实体/观察/关系  三期二次加工                       wiki_entities / observations / relations
历史页面        P0/P1 摘要页与旧手写页             wiki_pages，只读入口
```

**相对 v1**：没有编目卡。主题目录由 `wiki_sources` 的用途两列构成。

`wiki_pages` 不再是 AI 归档或综述的默认产物。存量页进「⋯ 更多 → 历史页面」。二期「新建笔记」写本地 md + `wiki_sources`，不复活 wiki_pages 作为目录节点。

### 1.2 存储结构（不用拼接 path）

小类名允许含 `/`（「项目/任务资料」）、`&`（「课堂&课程笔记」）。**禁止**用 `大类/小类` 单字符串当主键或查询键，否则 `split('/')` 会把「项目/任务资料」拆错。

```
正式归档：topic_category = 做事记录, topic_subtopic = 项目/任务资料
临时存放：topic_category = 临时存放, topic_subtopic = NULL
未归档：  两列皆 NULL（inbox 未 organized，或存量待补分）
```

界面展示用 `大类 · 小类` 或 `大类 / 小类`（两侧空格），仅用于显示，不用于解析。

约束：

- 大类：必须是 `categories[].name`，或系统常量 `临时存放`
- 小类：正式归档时非空；长度 ≤ 32；不可为 `临时存放`；必须命中**当前树**该大类的 `subtopics`（含用户后加的）
- AI 不能新建大类、不能新建小类、不能写入临时存放；用户可以（§8）

### 1.3 待整理 vs 临时存放

| | 待整理 | 临时存放 |
|---|---|---|
| 谁写入 | 系统（摄入后尚未合法归档） | 仅用户 |
| 语义 | 刚进来，归档未完成或失败 | 你自己先搁这儿，不进正式目录 |
| 数据 | `wiki_inbox` 未 organized | 已是 `wiki_sources`，主题为临时存放 |
| 用户下一步 | 等 AI / 重试 / 丢弃 / **手动选目录归档** | 打开 / **选目录移出** |

左栏文案必须能让新用户在 5 秒内分清这两项，不要再用「未分类」第三入口。

### 1.4 三条操作路径（全文档共用）

```
① 系统还没分完
   上传 / 任务产物 / 网页搜索 → inbox → 抽取 → AI 只从**当前树**已有节点里选
   成功 → 写 category+subtopic，inbox organized
   非法、不确定、调用失败 → 留在待整理（failed 或 pending），不写主题

② 用户知道去哪（确定性，跳过候选态）
   待整理「归档到…」 / 列表「移动」 / 临时存放「移出」
   → 目录选择器 → wiki:source:update-topic 或 wiki:inbox:organize
   「存到临时存放」→ wiki:source:move-to-parking

③ 用户要 AI 再想想（候选态）
   小类「重新编目本小类」/ 更多「全库重新编目」
   → wiki:reclassify:* ，用户接受后才改主题
```

一期「移动」只走 ②。二期选择器增加次要动作「让 AI 建议」，走 ③ 的 `scope=source`。小类/全库重新编目只走 ③。

---

## 2. 数据层设计

### 2.1 Schema 变更（V22，三期一次加齐）

当前 `SCHEMA_VERSION = 21`，本设计只迁 **V22**。三期列一并建好，未实现的功能保持 NULL / 不写。

```sql
-- 用途主题（一/二期）
ALTER TABLE wiki_sources ADD COLUMN topic_category TEXT;
ALTER TABLE wiki_sources ADD COLUMN topic_subtopic TEXT;
CREATE INDEX IF NOT EXISTS idx_wiki_sources_topic
  ON wiki_sources (agent_id, user_id, topic_category, topic_subtopic);

ALTER TABLE wiki_sources ADD COLUMN last_used TEXT;
ALTER TABLE wiki_sources ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;

-- 资料层 FTS（一期检索主入口）
CREATE VIRTUAL TABLE wiki_sources_fts USING fts5(
  title_tokens,
  content_tokens,
  content='wiki_sources',
  content_rowid='rowid'
);

-- ERO 挂到资料（三期用；一期可空）
ALTER TABLE wiki_entities ADD COLUMN source_id TEXT;
ALTER TABLE wiki_observations ADD COLUMN source_id TEXT;
ALTER TABLE wiki_relations ADD COLUMN source_id TEXT;
CREATE INDEX IF NOT EXISTS idx_wiki_entities_source ON wiki_entities (source_id);
CREATE INDEX IF NOT EXISTS idx_wiki_observations_source ON wiki_observations (source_id);
```

- 正式归档：两列都有值
- 临时存放：`topic_category = '临时存放'` 且 `topic_subtopic IS NULL`
- 未归档：两列皆 NULL
- 旧 `page_id` / `source_page_id` 保留，服务历史页面；新抽取写 `source_id`

不新增 `wiki_page_sources`。资料与用途多对一。

分词仍用现有 bigram，语料 `title` + `extracted_text`。搜索主结果为资料层；`wiki_pages_fts` 只服务「历史页面」。

向量索引（二期对齐）：重建任务改为对 `wiki_sources.extracted_text` 建派生向量；关闭或失败时退回 FTS，界面明示，无静默降级。

#### wiki_index_meta

| 键前缀 | 用途 | 写入时机 |
|---|---|---|
| `fts_tokenizer` | FTS 分词器实际生效类型 | 索引重建时 |
| `vector_model` | 向量模型标识 | 向量索引构建时 |
| `topic_categories` | §0.4 有序 JSON（**不含**临时存放） | 首次启动 / 主题树变更 |
| `reclassify_run` | 当前编目批次（同时只允许一个） | 重新编目 |
| `graph_extract_cursor` | 三期 ERO 增量抽取游标 | 抽取任务 |

`PARKING_CATEGORY = '临时存放'` 为代码常量，不入库 JSON。

### 2.2 主题树读写

```ts
export interface WikiTopicTree {
  version: 1;
  categories: Array<{ name: string; subtopics: string[] }>;
}

export interface WikiTopicTreeGetCommand {
  type: 'wiki:topic:tree:get';
  agentId: string;
  userId: string;
}

/** 整树替换：默认树、测试夹具、导入备份。日常编辑走 wiki:topic:mutate（§8）。 */
export interface WikiTopicTreeSetCommand {
  type: 'wiki:topic:tree:set';
  agentId: string;
  userId: string;
  tree: WikiTopicTree;
}
```

`tree:set` 校验（一期即生效）：

1. `version === 1`，至少 1 个正式大类
2. 大类名唯一、非空、长度 ≤ 20、无控制字符，不得为 `临时存放`
3. 每组小类无重复；每项非空、长度 ≤ 32、无控制字符；允许 `/`、`&`
4. 替换后若产生孤儿 `(category, subtopic)`：拒绝（日常删除必须走 §8 mutate 并带 disposition）

首次 `tree:get` 键不存在则写入 §0.4 默认树。

---

## 3. 分类器改造

### 3.1 提示词注入用途树与口诀

```ts
export async function buildClassifyPrompt(
  items: InboxItemForClassify[],
  topicTree: WikiTopicTree  // 当前整树，含用户后加的小类
): Promise<string>
```

提示词结构：

```
你是个人资料归档助手。按「文件拿来干什么」分类，不要按学科领域分类。

## 口诀
- 事情做完留下的结果 → 做事记录
- 用来学习吸收知识 → 学习资料
- 打算做什么、做完反思 → 计划与复盘
- 可以当证据凭证 → 证件凭据
- 拿来复制修改参考 → 模板参考
- 自己随心写的爱好作品 → 随笔创作

## 易混
- 填好的计划/预算 → 计划与复盘；空白模板 → 模板参考
- 项目交付与会议纪要文件 → 做事记录；教材/摘抄/调研 → 学习资料
- 合同/证件/发票/保单 → 证件凭据
- 用户上传的会议纪要、聊天导出 → 做事记录 / 会议聊天记录
- 对话消息本身不要归档（本批若像聊天记录而无文件用途，输出 skip）

## 可选目录（只能从这里选，禁止自造大类或小类）
${渲染 topicTree}

## 规则
- 一份资料只归一个大类+小类
- 没有合适项时 category、subtopic 留空，skip=true，reason 说明
- 不要使用「临时存放」「其他」「未分类」

## 待整理资料
${itemLines}

## 输出
仅 JSON 数组:
{"id":"<inboxId>","category":"<大类或空>","subtopic":"<小类或空>","skip":false,"reason":""}
```

不生成 `title` / `summaryMd`。展示标题用 `wiki_inbox.title`（文件名）。

### 3.2 返回结构

```ts
export interface ClassifiedItem {
  inboxId: string;
  category: string | null;
  subtopic: string | null;
  skip?: boolean;
  reason?: string;
  degraded?: true;
  degradeReason?: string;
}
```

`skip`、非法大类/小类、模型漏答、调用失败 → `degraded: true`，**不写** `wiki_sources` 主题，inbox 保持可重试（沿用现有失败 / 降级记账，落点从 `inbox/` 页改为「待整理未归档」）。

### 3.3 校验

替代 `validateWikiPath` / `AI_WRITABLE_CATEGORIES` 的 AI 写入侧：

1. `category` 必须是当前树 `categories[].name`（不是临时存放）
2. `subtopic` 必须是该大类 `subtopics` 的精确匹配
3. 否则整条 skip / degraded，留待整理

用户手动写入另走 §3.5，允许写临时存放。

### 3.4 移入临时存放

```ts
export interface WikiSourceMoveToParkingCommand {
  type: 'wiki:source:move-to-parking';
  agentId: string;
  userId: string;
  sourceId: string;
}
```

`UPDATE wiki_sources SET topic_category='临时存放', topic_subtopic=NULL`。不经分类器、不经候选态。

### 3.5 目录选择器（确定性写入）

```ts
export interface WikiSourceUpdateTopicCommand {
  type: 'wiki:source:update-topic';
  agentId: string;
  userId: string;
  sourceId: string;
  category: string;          // 正式大类或「临时存放」
  subtopic: string | null;   // 临时存放必须为 null；正式大类必须是该大类已有小类
}

export interface WikiInboxOrganizeCommand {
  type: 'wiki:inbox:organize';
  agentId: string;
  userId: string;
  inboxId: string;
  category: string;
  subtopic: string;
}
```

现有 `wiki:inbox:organize` 改为接收用途二元组，直写 sources 主题并标记 organized。校验与 `update-topic` 相同（organize 不允许写临时存放——搁置应先归档再移入，或单独命令；第一期待整理只提供「归档到正式目录 / 丢弃 / 重试」）。

UI：两级选择（先大类后小类）。选项 = 当前树，不可自由输入。用户要加小类走 §8 编辑主题树，不是在选择器里发明。

二期选择器增加次要按钮「让 AI 建议」（§9 `scope=source`）。

---

## 4. 归档流水线

### 4.1 流程

```
摄入（仅三路：上传 / 任务产物 / 网页搜索）
  → 拒绝或忽略 item_type=chat（入口切断，不建 inbox 行）
  → 提取正文（仅供 FTS / 分类特征，不生成摘要页）
  → 读 topic_categories
  → 批量分类（口诀 + 封闭小类）
  → 成功：写 topic_category/subtopic，inbox organized，upsert wiki_sources_fts
  → skip/失败：inbox 留待整理，主题两列保持 NULL
```

归档 = 给资料贴用途标签。不再写编目卡、不再写 `wiki_page_sources`、新归档默认不写 `wiki_pages`。

### 4.2 列表呈现

一行：**类型图标 + 文件名 + 相对时间 + 打开 + 移动 + 存到临时存放**。无 AI 正文。

打开失败（文件不在磁盘、`openPath` 非 0）：行内或 toast 提示「无法打开原文件」，不静默失败。

### 4.3 多份资料同小类

常态。无匹配/合并。每份独立一行。

---

## 5. 检索与打开原文（一期）

### 5.1 检索

一期：FTS bigram，语料 `wiki_sources.title` + `extracted_text`，结果为文件名 + `大类 / 小类` + 打开。点结果直接 `openPath`。

二期：若向量层已存在，RRF 融合改为资料层向量；关闭或失败退回 FTS，界面明示。打开原文件、检索命中时更新 `wiki_sources.last_used` / `use_count`（与 wiki_pages 脱钩）。

历史页面检索不进主搜索框；只在「历史页面」视图内搜 `wiki_pages_fts`。

### 5.2 列表与打开

```ts
{
  type: 'wiki:source:list';
  agentId: string;
  userId: string;
  category?: string;     // 仅大类：该大类下全部
  subtopic?: string;     // 与 category 联用：一个叶子
  parking?: boolean;     // true → 临时存放
  unfiled?: boolean;     // true → topic 两列皆 NULL 的存量待补分
  mediaType?: WikiMediaType;
}
```

「打开」→ `shell.openPath`。失败提示「无法打开原文件」。不再依赖 `wiki:page:get` 带 sources。

待整理主区两段：**队列**（inbox 未 organized）+ **待补分**（已是 sources 但主题为空）。角标 = 两段条数之和。

---

## 6. 一期前端

### 6.1 左栏

```
🔍 搜索
────────────────
待整理 (n)          ← 队列 + 待补分；警示色角标
知识图谱            ← 一期可进现有图（仍以历史页为节点）；三期换数据源
临时存放 (n)
────────────────
做事记录 (12)       ← 点标题列出该大类全部；chevron 只折叠
 ├ 项目/任务资料 (5)
 └ …
────────────────
⋯ 更多
```

- 空小类也显示，可点，空状态：「这个小类下还没有文件」
- 点小类 → 主区文件列表（不用详情侧滑）
- 树顺序 = `WikiTopicTree.categories` 数组序；只渲染树里的小类，无幽灵节点
- 计数按两列分组；临时存放单独计

### 6.2 更多菜单（壳体三期共用，按期亮入口）

| 项 | 一期 | 二期 | 三期 |
|---|---|---|---|
| 全库重新编目 | 隐藏 | 启用 | 启用 |
| 编辑主题树 | 隐藏 | 启用 | 启用 |
| 重建索引 | 启用 | 启用（含资料向量） | 启用 |
| 清理 | 启用（现有扫描，动作对齐主题列） | 增加「移到临时存放」 | 同左 |
| 历史页面 | 启用，只读 wiki_pages | 同左 | 同左 |
| 从当前目录生成综述 | 隐藏 | 启用 | 启用 |

### 6.3 主区文件列表

- 面包屑：`做事记录` 或 `做事记录 / 项目/任务资料`
- 芯片：全部 / 文档 / 图片 / 音视频
- 行：图标 + 文件名 + 相对时间 + 打开 / 移动 / 存到临时存放
- 待整理：处理中无操作；失败：重试 / 丢弃；待处理与失败均可「归档到…」；待补分段同样
- 临时存放：打开 / 移出（选择器）
- 副文案：待整理 = 「系统还在归档或无法自动归类的文件」；临时存放 = 「你主动搁置、暂不进入正式目录的文件」
- 二期附加：多选、新建笔记、重新编目本小类、生成综述

### 6.4 与设置页 UI

保留顶栏搜索、任务 pill、任务中心。替换左栏分区与资料详情侧滑。图谱仍占左栏一级。

---

## 7. 一期并发

inbox 整理队列与重新编目互斥：`reclassify_run.status=running` 时暂停自动 organize（新文件仍进 inbox pending，不丢）。二期状态机见 §9；一期无 reclassify 时本条为空操作。

---

## 8. 二期：主题树编辑

用户改骨架；AI 永不改树。改完后分类器读新树，仍禁止自造节点。

### 8.1 操作集

```ts
type FileDisposition =
  | { type: 'parking' }
  | { type: 'move'; category: string; subtopic: string };

type WikiTopicMutation =
  | { op: 'addCategory'; name: string; index?: number }
  | { op: 'renameCategory'; from: string; to: string }
  | { op: 'deleteCategory'; name: string; disposition: FileDisposition }
  | { op: 'reorderCategories'; names: string[] }
  | { op: 'addSubtopic'; category: string; name: string; index?: number }
  | { op: 'renameSubtopic'; category: string; from: string; to: string }
  | { op: 'deleteSubtopic'; category: string; name: string; disposition: FileDisposition }
  | { op: 'moveSubtopic'; fromCategory: string; name: string; toCategory: string; index?: number }
  | { op: 'mergeSubtopic'; fromCategory: string; fromName: string; toCategory: string; toName: string };

export interface WikiTopicMutateCommand {
  type: 'wiki:topic:mutate';
  agentId: string;
  userId: string;
  mutation: WikiTopicMutation;
}
```

单事务：先改 JSON，再按需 `UPDATE wiki_sources`。失败整单回滚。

### 8.2 规则

| 操作 | 规则 |
|---|---|
| 增 | 名称校验同 §2.2；同级重名拒绝 |
| 改名 | 级联更新展示名；目标名已存在拒绝。交换两名须在同一事务用中间名，不暴露半态 |
| 删大类 | 不可删最后一个大类。有文件必须 `disposition`，否则拒绝并返回 `fileCount` |
| 删小类 | 该大类至少保留 1 个小类。有文件必须 disposition |
| 移动小类 | 目标大类下重名拒绝；文件只改 `topic_category`，小类名不变 |
| 合并 | `from` 全部文件改为 `to` 的两列，再从树删除 `from`；二者不得相同 |
| 排序 | `names` 必须与现有大类集合相等 |

删/并完成后不自动全库编目。确认框可选「重新编目受影响小类」，默认否。

### 8.3 编辑器 UI

弹层：左列大类可拖拽，右列当前大类的小类可拖拽。行内重命名；删除先出去向框（临时存放 / 另一小类 / 合并到另一小类）。底栏添加大类、添加小类。不展示临时存放。每次操作立刻 `mutate`，不要本地攒整树再 `set`（避免孤儿）。

### 8.4 刷新

mutate 成功后 `tree:get` 刷新左栏、选择器、分类提示词。用户新加的小类，下一轮归档即可被选中。

---

## 9. 二期：重新编目

只覆盖路径 ③。

### 9.1 范围

| scope | 输入 | 扫描集 |
|---|---|---|
| `source` | `sourceId` | 该文件（选择器「让 AI 建议」） |
| `subtopic` | `category` + `subtopic` | 该叶子全部正式归档文件 |
| `all` | 无 | 所有正式归档（主题非空且 ≠ 临时存放） |

不扫描：inbox 未完成、待补分、临时存放。待补分走路径 ②。

`to` 必须是当前树已有节点。建议自造 → 丢弃该条并计入 `droppedInvalid`。与 from 相同 → 不进候选列表。

### 9.2 状态机

每 agent+user **同时一个** `reclassify_run`：

```
idle → running → review → applying → idle
                ↘ failed → idle（可按同一 scope retry）
         review → discarded → idle
```

- `running` 时禁止再 run；进度走任务 pill
- 已有 `review` 时新 run 须先确认丢弃旧批次
- `running` 期间暂停自动 organize（§7）
- `apply` 可按 `candidateIds` 部分接受；全部 applied/ignored 后批次结束
- 接受时若目标小类已被删：该条失败留在 review，其余继续

存储键 `reclassify_run`（覆盖式，不按 runId 堆 kv）：

```json
{
  "runId": "...",
  "status": "running | review | applying | failed | discarded",
  "scope": "source | subtopic | all",
  "scopeRef": { "sourceId": null, "category": null, "subtopic": null },
  "total": 80,
  "processed": 80,
  "droppedInvalid": 2,
  "unchanged": 50,
  "candidates": [
    {
      "id": "c1",
      "sourceId": "...",
      "title": "2027年度OKR草案.docx",
      "fromCategory": "做事记录",
      "fromSubtopic": "项目/任务资料",
      "toCategory": "计划与复盘",
      "toSubtopic": "目标规划方案",
      "reason": "内容是未执行的规划草案而非交付物",
      "decision": "pending | applied | ignored"
    }
  ],
  "error": null,
  "createdAt": "...",
  "updatedAt": "..."
}
```

提示词与归档同一套口诀 + 当前树；额外给出「当前大类/小类」，只在确有更好用途时输出新节点。批切分沿用现有 classify batch。

### 9.3 命令

| 命令 | 职责 |
|---|---|
| `wiki:reclassify:run` | 启动，返回 runId，异步 |
| `wiki:reclassify:get` | 读当前批次（含进度） |
| `wiki:reclassify:apply` | `{ candidateIds: string[] }` 写两列并标 applied |
| `wiki:reclassify:ignore` | 单项标 ignored |
| `wiki:reclassify:discard` | 整批丢弃 |

### 9.4 UI

全库 / 小类候选用**主区列表**（任务中心可点入），不用右下角 toast。顶栏：N 条建议 · 接受已选 · 全部接受 · 全部忽略。行：文件名、from → to、理由、接受/忽略。

单文件建议嵌在选择器内：「AI 建议：计划与复盘 / 目标规划方案」+ 采用。

叶子顶栏「重新编目本小类」。更多「全库重新编目」二次确认：「将扫描 N 个已归档文件，不会改临时存放」。

---

## 10. 二期：新建笔记

小类（或大类聚合列表）顶栏「新建笔记」：

1. 在用户数据目录写入 `wiki-notes/<safeCategory>/<timestamp>-untitled.md`（目录名做文件系统安全化，不用带 `/` 的小类名当文件夹）
2. 插入 `wiki_sources`：`title=未命名笔记`，`source_path` 指向该文件，`media_type=document`，`mime_type=text/markdown`，主题两列为当前目录（大类视图须先选小类，或默认该大类第一个小类）
3. 列表出现新行；「打开」仍 `openPath`。不写 `wiki_pages`

重命名 = 改 `title`（可选同时 rename 磁盘文件）。删除与现有删资料一致，不另做回收站。

---

## 11. 二期：综述合成

沿用 `wiki_syntheses` 候选态（显式触发、引用保真、用户接受才落库）。**产出改为普通资料文件**，`accept()` 不再写 `wiki_pages`。

### 11.1 触发

- 列表多选 →「生成本组综述」
- 当前小类 / 大类 →「综述本目录」（条数 > 40 须确认或改多选）
- 输入为空拒绝

### 11.2 流水线

1. 用所选 `extracted_text` 分块（无正文的媒体只用 title + media_meta）
2. 写 `wiki_syntheses` 候选，进度进任务中心
3. 预览 Markdown + 来源列表
4. 接受：落盘 `outputs/wiki-syntheses/<id>-<slug>.md` → 插入 `wiki_sources` → 目录选择器（默认：来源众数大类下的「汇报总结文稿」若存在，否则该大类第一个小类；来源跨大类则默认「做事记录 / 汇报总结文稿」）
5. 拒绝：现有 reject，不落盘

溯源继续存在 `wiki_syntheses` 的 source id 列表；正文末列来源文件名。数字/日期须能在来源中验证——沿用现有 synthesizer 约束。

---

## 12. 二期：清理对齐

三条规则保留（失效 > 重复 > 长期未用）：

- 长期未用看 `wiki_sources.last_used` / `use_count`（一期打开/检索即写入）
- 批量动作增加「移到临时存放」
- 已在临时存放且长期未用：建议删除，不再移一次
- 清单展示当前 `大类 / 小类`

---

## 13. 三期：知识图谱

替换「页面 + 双链」为「资料 + 用途结构 + 实体关系」。历史页双链图层默认关闭。

### 13.1 节点

| kind | 来源 | 占 50 上限 |
|---|---|---|
| `category` / `subtopic` | 主题树 | 否（分组容器） |
| `source` | `wiki_sources` | 是 |
| `entity` | `wiki_entities` | 是，source 占满后剩余名额 |

### 13.2 边

| kind | 语义 | 落库 | 绘制 |
|---|---|---|---|
| `belongs_to` | source → subtopic → category | 否，现推 | 必画 |
| `sibling` | 同小类资料 | 否 | 该小类 source ≤ 8 画完全图，否则不画，只靠 belongs_to 汇聚 |
| `relation` | 实体 → 实体 | 是，ERO | 两端都在子图内才画 |
| `mentioned_in` | entity → source | 否，由 `source_id` 现推 | 实体层开启时画 |
| `wikilink` | 历史页之间 | 是，旧表 | 默认关 |

### 13.3 子图构建

```ts
{
  type: 'wiki:graph:data';
  agentId: string;
  userId: string;
  centerSourceId?: string;
  category?: string;
  subtopic?: string;
  radius?: 0 | 1;     // 默认 1：当前小类 + 同大类其他小类
  limit?: number;     // 默认 50，只限制 source+entity
  layers?: Array<'structure' | 'entities' | 'history'>;
}
```

中心缺省：用户正在浏览的小类；否则「做事记录」。

- radius=1：中心所在小类 ∪ 同一大类其余小类
- radius=0：仅当前小类
- 不按跳数跨大类扩圈；跨大类只靠同名实体 `mentioned_in` 桥接

截断：邻域 source 按 `use_count` desc、`last_used` desc 截取，再填 entity。`truncated: true` 时顶栏「仅显示最常用 N 个文件」。

### 13.4 ERO 抽取

输入 `extracted_text`，写 `source_id`，不为新资料建 page。

```ts
{
  type: 'wiki:ero:extract';
  agentId: string;
  userId: string;
  category?: string;
  subtopic?: string;
  sourceIds?: string[];
}
```

- 仅用户点「从本目录抽取实体」（图谱顶栏或小类菜单）
- 归档成功后**不**自动抽取
- 实体按 `(agent, user, name, entity_type)` upsert；观察带 `source_id`；关系重复用现有概率并集
- 增量：`graph_extract_cursor` 记 sourceId + content_hash，正文未变则跳过
- 按文件失败跳过，任务中心列错误，不回滚已成功实体

不引入双时态、模糊合并、多跳问答。

### 13.5 UI

图层：`结构` / `实体关系` / `全部`（取代「仅页面双链」）。结构边蓝色，关系边主色。xyflow + dagre LR 保留；大类/小类用 parent node 分组。

- 点 source → 打开原文件；次要动作「在目录中显示」
- 点 entity → 右侧栏：类型、观察（5 条 + 展开）、出现于哪些资料
- 点 subtopic 容器 → 切到该叶子列表
- 抽取走任务 pill；图上轻量「抽取中」

一期若三期未做：旧图可开，空状态写明「新资料请用目录浏览；实体图后续挂到文件上」，不要假装已按用途连边。

---

## 14. 端到端流程

```
摄入(上传/产物/搜索) ─禁止chat─► 待整理
        │                         ├ AI 选当前树节点 ─成功► 正式目录
        │                         ├ skip/失败 ──────────► 留待整理
        │                         └ 用户「归档到」──────► 正式目录
正式目录 ─打开► openPath
        ├ 移动 / 移出临时存放 ──► 选择器直写
        ├ 存到临时存放 ─────────► parking
        ├ 新建笔记(二期) ───────► md 文件 + sources
        ├ 多选综述(二期) ───────► 候选 ─接受► 新 md 进指定目录
        ├ 重新编目(二期) ───────► 候选 ─接受► 改两列
        └ 抽取实体(三期) ───────► ERO ─► 图谱结构+关系
编辑主题树(二期) ─mutate► 级联文件 ─可选► 重编受影响小类
清理 ─扫描► 归档/删除/移入临时存放
搜索 ─FTS(+向量)► 资料行 ─打开► openPath
```

---

## 15. 命令总表

| 命令 | 期 | 说明 |
|---|---|---|
| `wiki:topic:tree:get` | 1 | 读有序树 |
| `wiki:topic:tree:set` | 1 | 默认树/导入；禁孤儿 |
| `wiki:topic:mutate` | 2 | 日常增删改并排 |
| `wiki:source:list` | 1 | 按大类/小类/parking/unfiled |
| `wiki:source:update-topic` | 1 | 路径 ② |
| `wiki:source:move-to-parking` | 1 | 路径 ② |
| `wiki:inbox:organize` | 1 | 改为用途二元组 |
| `wiki:source:create-note` | 2 | 新建笔记 |
| `wiki:reclassify:run/get/apply/ignore/discard` | 2 | 路径 ③ |
| `wiki:synthesis:create` 等 | 2 | 入参 sourceIds；accept 写 sources |
| `wiki:graph:data` | 3 | 新中心/图层；一期可仍走旧参数 |
| `wiki:ero:extract` | 3 | 按目录或 id 列表 |
| inbox / cleanup / index | 1 | 清理对齐主题；index 含 sources_fts |

跨层：main handler、preload `ElectronAPI`、renderer 同步加。

---

## 16. 分期（只排实现顺序）

规格已在上文闭合。实现切分：

### 第一期 — 目录出形

V22 全列（含可空 `source_id`、`last_used`、`use_count`）+ 默认用途树 + FTS 资料层 + 分类器口诀封闭小类 + 切断 chat + 列表/打开/选择器/待补分 + 左栏树 + 清理/历史/重建。

**交付：归档 → 找到 → 打开。**

### 第二期 — 编目质量与合成

mutate 编辑器、重新编目状态机与主区 UI、选择器「让 AI 建议」、新建笔记、综述改写 sources、清理「移到临时存放」、资料层向量 RRF、多选。

### 第三期 — 二次加工

`graph:data` 新模型、结构/实体图层、`ero:extract` 按资料、实体侧栏、`mentioned_in`。旧双链默认关。

依赖：二期不依赖三期。三期依赖一期主题列，不依赖综述。向量失败不影响一期 FTS。

---

## 17. 迁移

1. V22：§2.1（含 `last_used` / `use_count`）
2. 写入默认有序 `topic_categories`
3. 回填 `wiki_sources_fts`
4. 存量主题两列空 → 待整理「待补分」；不保留 sources/media 主分栏
5. `wiki_pages` 不删，只读「历史页面」；新归档/新综述不写摘要页
6. 已有 ERO `page_id` 保留；三期新抽取走 `source_id`

### 风险

| 风险 | 缓解 |
|---|---|
| 用途分类被做成领域分类 | 口诀 + 易混 + 封闭节点 + skip |
| 小类名含 `/` | 两列存储 |
| 改名/删除产生孤儿 | mutate 事务 + disposition 强制 |
| 编目候选与自动归档互踩 | running 时暂停 organize |
| 全库建议过多 | 只列出变更项；主区列表非 toast |
| sibling 边爆炸 | ≤8 才画完全图 |
| 综述写错知识 | 仍候选接受；落成普通文件可再移动 |
| 抽取费用 | 仅手动；hash 增量跳过 |
| 设置页侧滑冲突 | 一期替换主交互，保留任务中心 |
| 旧图与新图并存 | 一期标明旧图范围；三期换数据源 |

---

## 18. 成功标准

### 一期

- 能按口诀理解六大类；待整理 ≠ 临时存放
- 会议纪要文件进入 `做事记录 / 会议聊天记录` 并能打开
- AI 拿不准 → 待整理，绝不进临时存放或虚构类
- 搜索正文能命中并打开
- 移动 / 搁置后树计数正确

### 二期

- 改名大类后面包屑与文件一起变，无孤儿
- 删除有文件的小类必须选去向，取消则树不变
- 全库编目只出现「建议变更」项，接受后立即反映在树上
- 新建笔记出现在当前小类，磁盘有 md
- 综述接受后是目录里的一份新文件，不是摘要页
- 用户新增小类后，下一份上传可以被分进去

### 三期

- 从「项目/任务资料」打开图谱，能看到该小类文件挂在用途容器下
- 手动抽取后，实体侧栏能跳到来源文件
- 同小类文件很多时界面不卡（sibling 被抑制）
- 关闭实体层只剩结构树，仍能点到文件

---

## 19. 不做

- 编目卡摘要页；AI 自动综述
- 聊天消息摄入（含手工收藏对话进 Wiki）
- 主题树自动重构；AI 新建大类/小类
- 跨用途多重上架
- 「其他」「未分类」正式大类
- 实体模糊合并、双时态、多跳问答
- Wiki / 记忆 / MemPalace 三域混合检索
- 音视频自动转录（仍元数据 + 来源上下文）
- 把 wiki_pages 重新变成目录一等公民
