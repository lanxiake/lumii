# 小红书定时发布策略

## 通用黄金时段

| 时段 | 时间 | 适合内容 |
| --- | --- | --- |
| 早高峰 | 07:00–09:00 | 干货、职场技巧、学习方法、早餐/穿搭轻量图文 |
| 午休 | 12:00–14:00 | 美食测评、娱乐八卦、搞笑段子 |
| 晚间巅峰 | 19:00–23:00 | 深度干货、开箱测评、剧情 Vlog、情感故事 |

## 分类型策略

### 干货类 (`knowledge`)

- **工作日**：08:00（通勤充电）、20:00–22:00（睡前学习）
- **周末**：15:00–17:00（整块时间读长文，收藏率高）

### 美食/探店类 (`food`)

- **工作日**：12:00（午休干饭）、18:00（下班纠结吃什么）
- **周末**：周五 20:00 发周边游攻略；周六/日 10:00 发 brunch 推荐

### 美妆/穿搭类 (`beauty`)

- **日常**：每日 19:00–21:00（休闲放松，颜值内容吸引力强）
- **节日/季节限定**：提前 1–2 周布局（如圣诞妆容 12 月初、夏季防晒 5 月预热）

### 情感/生活类 (`lifestyle`)

- **工作日**：22:00–01:00（深夜树洞，情感共鸣）
- **周末**：14:00–16:00（生活碎片、治愈系 Vlog）

## 内容类型映射

Step 1 澄清时的「内容目标」可映射为 `content_type`：

| 用户说的目标 | content_type |
| --- | --- |
| 干货 / 教程 / 职场 / 学习 | `knowledge` |
| 美食 / 探店 / 测评 | `food` |
| 种草 / 美妆 / 穿搭 | `beauty` |
| 情感 / 生活 / Vlog | `lifestyle` |
| 活动 / 招聘 / 其他 | `general` |

## 工具用法

### 获取推荐时段

```powershell
cd sub-skills/05-publish/post-to-xhs/scripts

# 按类型推荐（人类可读）
python schedule_advisor.py --type 干货

# JSON 输出（供 Agent 解析）
python schedule_advisor.py --type knowledge --json

# 黄金时段摘要
python schedule_advisor.py --summary
```

### 写入发布配置

在笔记目录创建 `publish-options.json`：

```json
{
  "content_type": "knowledge",
  "schedule": "2026-06-13 20:00",
  "publish_mode": "image-text"
}
```

### CDP 定时发布

填表完成后，发布前设置定时：

```powershell
# 仅设置定时（不点发布）
python cdp_publish.py set-schedule --schedule "2026-06-13 20:00"

# 设置定时并点击发布
python cdp_publish.py click-publish --schedule "2026-06-13 20:00"

# Pipeline 一步完成
python publish_pipeline.py --headless --title-file title.txt --content-file body.txt `
  --images img1.png --auto-publish --schedule "2026-06-13 20:00"
```

### 统一分发入口

```powershell
# 推荐时段
python xhs_publish.py --article-dir "<笔记目录>" --recommend-schedule

# 按 publish-options.json 发布
python xhs_publish.py --article-dir "<笔记目录>"
```

### sau CLI（可选）

若使用 `xiaohongshu-upload`，传 `--schedule "YYYY-MM-DD HH:MM"` 即可定时发布。

## 工作流集成

1. Step 1 澄清内容目标 → 确定 `content_type`
2. Step 6 生成 `publish-options.json`，运行 `schedule_advisor.py` 向用户展示 3–5 个推荐时段
3. 用户选定时段后写入 `schedule` 字段
4. Step 7 发布时传 `--schedule` 或读取 `publish-options.json`
5. `publish-report.md` 记录定时时间与实际状态
