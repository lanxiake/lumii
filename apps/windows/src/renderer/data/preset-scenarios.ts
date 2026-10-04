import {
  Mail, ClipboardList, BarChart2, Calendar, FileText, Target,
  Briefcase, PenLine, MessageSquare, Video, Newspaper,
  Mic, BookOpen, Search, GraduationCap, Languages, Lightbulb,
  Bug, Zap, Terminal, Layers, TestTube, RefreshCw, Globe, GitBranch, Cpu,
  UtensilsCrossed, Plane, PiggyBank, Dumbbell, Gift, Smartphone,
  FilePenLine as FileUser, Handshake, TrendingUp, Presentation, Bot, Clock,
  FolderOpen, Users, Plug, SlidersHorizontal, Pin, Image, Music,
  Archive, Brain, ListChecks, KeyRound, Inbox, Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * 预置场景清单（内容数据，非组件）。
 *
 * 单一数据源，三处消费：新建会话空态（随机取 6 个）、概览页「场景推荐」（精选子集）、
 * 「全部场景」弹窗（分组 + 搜索）。
 *
 * **分类维度：一级 = 触发方式，二级 = 领域标签**
 *
 * 一级按触发方式而不是按领域，是因为这个客户端最不可替代的地方恰恰是「不用开口它也会跑」
 * ——`cron_create` 能建定时任务、`spawn_agent` 能派子 Agent 长期干活。按领域分（GPT Store /
 * 提示词库那套）会把这条差异化埋进一堆「写邮件」里，用户看不出它能自己做事。
 * 领域因此降级成卡片上的一枚标签：一条场景**只归一个触发组**，分类互斥才找得到。
 *
 * - `now`       现在就做：说一句，它现在替你做完
 * - `scheduled` 定时自动：设定一次，以后按点自己跑
 * - `standing`  长期设定：设定一次，长期生效（记忆 / 技能 / 渠道 / 形象）
 */
export type ScenarioGroupId = 'now' | 'scheduled' | 'standing'

export interface ScenarioGroup {
  readonly id: ScenarioGroupId
  readonly label: string
  /** 一句话说明这组「什么时候用」，显示在组标题右侧 */
  readonly hint: string
}

/** 分组元信息；数组顺序即界面展示顺序 */
export const SCENARIO_GROUPS: readonly ScenarioGroup[] = [
  { id: 'now', label: '现在就做', hint: '说一句，它现在替你做完' },
  { id: 'scheduled', label: '定时自动', hint: '设定一次，以后按点自己跑' },
  { id: 'standing', label: '长期设定', hint: '设定一次，长期生效' },
]

export interface ScenarioItem {
  icon: LucideIcon
  label: string
  prompt: string
  /** 领域标签（二级）：工作 / 写作 / 开发 / 生活 … */
  category: string
  /** 触发方式（一级分组） */
  group: ScenarioGroupId
}

export const ALL_SCENARIOS: ScenarioItem[] = [
  // 工作效率
  {
    icon: Mail, label: '写工作邮件', category: '工作', group: 'now',
    prompt: '帮我写一封专业的工作邮件。\n\n收件人：产品团队\n主题：下周产品评审会议安排\n要点：\n- 会议时间：周四下午3点\n- 地点：3楼会议室\n- 请各负责人提前准备本模块进展',
  },
  {
    icon: ClipboardList, label: '整理会议纪要', category: '工作', group: 'now',
    prompt: '帮我整理以下会议内容，提炼关键决策和行动项：\n\n会议主题：Q2 产品规划\n参与人：产品、研发、设计\n讨论内容：\n- 确定了新版本上线时间为5月底\n- 设计需在4月20日前完成原型\n- 研发评估工作量后反馈排期\n- 下次会议定在下周三',
  },
  {
    icon: BarChart2, label: '数据分析报告', category: '工作', group: 'now',
    prompt: '帮我分析以下数据，生成一份简洁的分析报告：\n\n本月用户数据：\n- 新增用户：12,450（环比+18%）\n- 活跃用户：38,200（环比+5%）\n- 付费转化率：3.2%（环比-0.4%）\n- 平均使用时长：8.5分钟\n\n请分析趋势、找出问题并给出建议。',
  },
  {
    icon: Calendar, label: '制定工作计划', category: '工作', group: 'now',
    prompt: '帮我制定本周工作计划，优先级排序并分配时间：\n\n待办事项：\n- 完成Q2需求文档\n- 与3个客户做产品访谈\n- 修复线上反馈的2个bug\n- 准备周五的团队分享\n- 回复积压的20封邮件',
  },
  {
    icon: FileText, label: '写工作总结', category: '工作', group: 'now',
    prompt: '帮我写一份月度工作总结：\n\n本月完成：\n- 上线了用户画像功能，DAU提升12%\n- 主导完成竞品分析报告\n- 推动解决了3个跨部门协作问题\n\n遇到的挑战：需求变更频繁，排期压力大\n下月计划：推进数据看板项目',
  },
  {
    icon: Target, label: '制定 OKR', category: '工作', group: 'now',
    prompt: '帮我制定季度 OKR，要求目标明确、可量化：\n\n我的角色：产品经理\n业务方向：提升用户留存\n现状：次日留存率42%，7日留存率18%\n资源：1名设计师，2名前端，1名后端\n\n请制定1个O和3-4个KR。',
  },
  {
    icon: Briefcase, label: '商业计划书', category: '工作', group: 'now',
    prompt: '帮我写一份商业计划书大纲：\n\n项目：面向中小企业的AI客服SaaS平台\n目标市场：电商、零售行业\n核心功能：智能问答、工单管理、数据分析\n商业模式：按坐席订阅收费\n\n请包含市场分析、竞争优势、财务预测等章节。',
  },

  // 内容创作
  {
    icon: PenLine, label: '写公众号文章', category: '写作', group: 'now',
    prompt: '帮我写一篇公众号文章：\n\n主题：为什么越来越多的人开始用 AI 助手处理工作\n目标读者：职场白领\n风格：轻松有趣，有数据支撑\n字数：1500字左右\n结构：开头钩子 + 3个核心观点 + 行动号召',
  },
  {
    icon: MessageSquare, label: '写小红书文案', category: '写作', group: 'now',
    prompt: '帮我写一条小红书种草文案：\n\n产品：降噪耳机\n卖点：主动降噪、续航30小时、轻量设计\n目标用户：通勤族、学生\n风格：真实体验感，带emoji，适合年轻人\n\n需要标题、正文和5个相关话题标签。',
  },
  {
    icon: Video, label: '短视频脚本', category: '写作', group: 'now',
    prompt: '帮我写一个60秒短视频脚本：\n\n主题：3个让工作效率翻倍的AI工具\n平台：抖音/视频号\n风格：干货分享，节奏快\n\n请包含：开场钩子（前3秒）、内容分段、结尾引导关注。',
  },
  {
    icon: Newspaper, label: '新闻稿撰写', category: '写作', group: 'now',
    prompt: '帮我写一篇产品发布新闻稿：\n\n事件：MtBot 2.0 正式发布\n核心亮点：支持多 Agent 协作、本地隐私部署、跨平台同步\n发布时间：2025年5月\n目标媒体：科技媒体、AI 垂直媒体\n\n格式：标准新闻稿，500字以内。',
  },
  {
    icon: Mic, label: '播客提纲', category: '写作', group: 'now',
    prompt: '帮我写一期播客的提纲和开场白：\n\n主题：AI 如何改变普通人的工作方式\n时长：30分钟\n嘉宾：一位使用AI工具1年以上的产品经理\n\n请包含：开场白（2分钟）、5个讨论问题、结尾总结。',
  },

  // 学习研究
  {
    icon: Search, label: '解释技术概念', category: '学习', group: 'now',
    prompt: '用简单易懂的方式解释"向量数据库"：\n\n- 它是什么，解决什么问题\n- 和传统数据库有什么区别\n- 举一个生活中的类比\n- 适合什么场景使用\n\n我有编程基础但没接触过 AI 开发。',
  },
  {
    icon: GraduationCap, label: '制定学习计划', category: '学习', group: 'now',
    prompt: '帮我制定一个学习计划：\n\n目标：3个月内掌握 Python 数据分析\n现状：有基础编程经验，没学过 Python\n每天可用时间：1.5小时\n学习目标：能独立完成数据清洗和可视化\n\n请按周拆分，推荐具体学习资源。',
  },
  {
    icon: Languages, label: '翻译并润色', category: '学习', group: 'now',
    prompt: '请将以下英文翻译成流畅的中文，并适当润色：\n\n"The key to building great products is not just understanding what users say they want, but deeply observing what they actually do. The gap between stated preferences and revealed preferences is where the real insights live."',
  },
  {
    icon: Lightbulb, label: '头脑风暴', category: '学习', group: 'now',
    prompt: '帮我头脑风暴：如何提升一款笔记应用的用户留存率\n\n背景：\n- 用户注册后7日留存仅20%\n- 主要流失节点：注册后第3天\n- 竞品：Notion、Obsidian\n\n请从产品功能、运营策略、用户引导3个维度各给5个创意。',
  },
  {
    icon: BookOpen, label: '总结文章要点', category: '学习', group: 'now',
    prompt: '帮我总结以下文章的核心观点，并给出我的行动建议：\n\n[请粘贴文章内容]\n\n输出格式：\n1. 核心论点（3条）\n2. 关键数据/案例\n3. 对我的启发和可行动建议',
  },

  // 编程开发
  {
    icon: Bug, label: '调试代码', category: '开发', group: 'now',
    prompt: '帮我找出以下代码的问题并修复：\n\n```javascript\nasync function fetchUserData(userId) {\n  const res = await fetch(`/api/users/${userId}`)\n  const data = res.json()\n  return data.user\n}\n```\n\n报错：TypeError: Cannot read properties of undefined (reading \'name\')',
  },
  {
    icon: Zap, label: '优化代码性能', category: '开发', group: 'now',
    prompt: '帮我优化以下代码的性能：\n\n```javascript\nfunction findDuplicates(arr) {\n  const duplicates = []\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = i + 1; j < arr.length; j++) {\n      if (arr[i] === arr[j] && !duplicates.includes(arr[i])) {\n        duplicates.push(arr[i])\n      }\n    }\n  }\n  return duplicates\n}\n```\n\n当前 O(n³)，请优化到 O(n) 并解释思路。',
  },
  {
    icon: Terminal, label: '写自动化脚本', category: '开发', group: 'now',
    prompt: '帮我写一个 Node.js 脚本：\n\n功能：批量重命名文件夹中的图片\n规则：将 IMG_001.jpg 格式改为 2025-05-01_001.jpg（日期取文件修改时间）\n要求：支持子目录递归、跳过非图片文件、操作前预览变更',
  },
  {
    icon: Layers, label: '系统架构设计', category: '开发', group: 'now',
    prompt: '帮我设计一个系统架构：\n\n需求：实时聊天应用\n规模：预计10万并发用户\n功能：私聊、群聊、消息已读、文件传输\n技术栈偏好：Node.js + React\n\n请给出架构图描述、技术选型理由、关键设计决策。',
  },
  {
    icon: TestTube, label: '写单元测试', category: '开发', group: 'now',
    prompt: '帮我为以下函数写完整的单元测试（使用 Jest）：\n\n```typescript\nexport function parseAmount(input: string): number {\n  const cleaned = input.replace(/[,$]/g, \'\')\n  const num = parseFloat(cleaned)\n  if (isNaN(num)) throw new Error(`Invalid amount: ${input}`)\n  return Math.round(num * 100) / 100\n}\n```\n\n覆盖正常值、边界值、异常情况。',
  },
  {
    icon: RefreshCw, label: '重构代码', category: '开发', group: 'now',
    prompt: '帮我重构以下代码，提升可读性和可维护性：\n\n```javascript\nfunction p(u, t, a) {\n  if (u && t && a) {\n    if (t === \'admin\') {\n      if (a === \'delete\' || a === \'edit\') return true\n    } else if (t === \'user\') {\n      if (a === \'read\') return true\n    }\n  }\n  return false\n}\n```\n\n请重命名变量、拆分逻辑、添加类型注解。',
  },

  // 生活助手
  {
    icon: UtensilsCrossed, label: '菜谱推荐', category: '生活', group: 'now',
    prompt: '我冰箱里有这些食材，帮我推荐3道菜并给出做法：\n\n食材：鸡蛋3个、西红柿2个、豆腐1块、青椒1个、大蒜、生姜\n要求：\n- 30分钟内能做完\n- 适合2人份\n- 有一道下饭菜',
  },
  {
    icon: Plane, label: '旅行规划', category: '生活', group: 'now',
    prompt: '帮我规划一次旅行：\n\n目的地：日本京都\n时间：5天4晚\n出发城市：上海\n人数：2人\n预算：人均1.5万元\n偏好：文化历史、美食、避开人多景点\n\n请给出每日行程、住宿建议、必吃美食清单。',
  },
  {
    icon: PiggyBank, label: '理财方案分析', category: '生活', group: 'now',
    prompt: '帮我分析理财方案：\n\n基本情况：\n- 月收入：2万元\n- 月支出：1.2万元\n- 现有存款：15万元\n- 风险偏好：中等\n- 目标：3年后首付买房（需50万）\n\n请给出资产配置建议和具体操作步骤。',
  },
  {
    icon: Dumbbell, label: '健身计划', category: '生活', group: 'now',
    prompt: '帮我制定健身计划：\n\n基本情况：\n- 性别：男，28岁\n- 目标：增肌减脂\n- 现状：体重75kg，体脂约22%\n- 可用时间：每周3次，每次1小时\n- 设备：健身房（有器械）\n\n请给出训练计划和饮食建议。',
  },
  {
    icon: Gift, label: '礼物推荐', category: '生活', group: 'now',
    prompt: '帮我推荐礼物：\n\n对象：女朋友，25岁，设计师\n场合：生日\n预算：500-1000元\n她的喜好：插画、咖啡、旅行、极简风格\n已有：AirPods、kindle\n\n请推荐5个选项，说明推荐理由。',
  },
  {
    icon: Smartphone, label: '产品选购对比', category: '生活', group: 'now',
    prompt: '帮我对比以下两款产品，给出购买建议：\n\n产品A：MacBook Air M3 13寸\n产品B：MacBook Pro M3 14寸\n\n我的使用场景：\n- 主要用途：写代码、视频剪辑\n- 经常外出携带\n- 预算：1.5万以内\n- 不玩游戏',
  },

  // 职场发展
  {
    icon: FileUser, label: '优化简历', category: '职场', group: 'now',
    prompt: '帮我优化以下简历中的工作经历描述，使其更有说服力：\n\n原文：\n"负责产品需求分析和文档编写，与研发团队沟通协调，推动项目按时上线"\n\n目标职位：高级产品经理\n公司规模：500人以上互联网公司\n\n请用 STAR 法则重写，突出量化成果。',
  },
  {
    icon: Handshake, label: '面试准备', category: '职场', group: 'now',
    prompt: '帮我准备面试：\n\n职位：字节跳动 产品经理\n面试轮次：二面（产品总监面）\n我的背景：3年电商产品经验\n\n请给出：\n1. 可能被问到的5个核心问题\n2. 每个问题的回答框架\n3. 我应该主动问面试官的2个问题',
  },
  {
    icon: TrendingUp, label: '职业规划', category: '职场', group: 'now',
    prompt: '帮我分析职业发展路径：\n\n现状：\n- 岗位：前端工程师，工作3年\n- 技术栈：React、TypeScript、Node.js\n- 目前月薪：2.5万\n- 困惑：是继续深耕技术还是转型全栈/管理\n\n请分析两条路径的优劣和建议。',
  },
  {
    icon: Presentation, label: '演讲稿撰写', category: '职场', group: 'now',
    prompt: '帮我写一篇演讲稿：\n\n场合：公司年会，部门代表发言\n时长：5分钟\n主题：回顾过去一年团队的成长与收获\n风格：真诚、有温度，适当幽默\n亮点：团队从5人扩展到15人，完成了3个重要项目',
  },

  // ── 客户端能力：它能操作界面、操作浏览器、录屏、读你的本地资料 ──
  {
    icon: GitBranch, label: '深入调研这个代码库', category: '开发', group: 'now',
    prompt: '派一个子 Agent 深入读一遍这个代码库，别只看目录就下结论：\n\n仓库路径：~/projects/my-app\n我想知道：\n- 整体分层与模块调用关系，关键数据流怎么走\n- 真正的主流程入口在哪\n- 哪些代码已经没人用了\n\n最后给我一份带「文件路径 + 行号」的结构说明。',
  },
  {
    icon: Cpu, label: '交给灵栖开发修 bug', category: '开发', group: 'now',
    prompt: '把下面这个 bug 交给灵栖开发跟进：\n\n项目：~/projects/my-app\n现象：设置页关掉某个开关，重开应用又变回原样\n复现：打开设置 → 关掉开关 → 退出重开 → 开关又是开的\n怀疑方向：读写不一致，但没定位到具体位置\n\n请先复现，再给出根因和最小修复，修完把相关测试跑一遍。',
  },
  {
    icon: Plug, label: '找找有没有现成技能', category: '系统', group: 'now',
    prompt: '我想批量处理一批 PPTX（统一模板、替换里面的公司名），先别急着写脚本：\n\n先搜一下有没有现成的技能能直接做这件事。\n有就告诉我它叫什么、能做什么、怎么用；没有再说用别的方式怎么做。',
  },
  {
    icon: SlidersHorizontal, label: '改一个客户端设置', category: '系统', group: 'now',
    prompt: '帮我改一下客户端设置：\n\n把「思考级别」调到 high；再把回复字体调大一档。\n改完告诉我改了哪几项、现在的值分别是多少。',
  },
  {
    icon: Pin, label: '截图并标出按钮位置', category: '系统', group: 'now',
    prompt: '截一张当前界面的图，并标出下面这些控件的位置：\n\n- 新建会话按钮\n- 输入框\n- 发送按钮\n\n每处画个圈、编上号，再按编号逐条说明它叫什么、点了会发生什么。',
  },
  {
    icon: Video, label: '录一段操作教程', category: '系统', group: 'now',
    prompt: '录一段操作教程，带我走一遍「新建会话并发出第一条消息」：\n\n- 全屏录制，鼠标操作放慢一点\n- 每一步配一句旁白，说清在点哪里、为什么\n- 录完导出视频文件，并告诉我存在哪个目录',
  },
  {
    icon: Globe, label: '去网页里帮我抓数据', category: '自动化', group: 'now',
    prompt: '帮我从这个网页把数据抓下来：\n\n地址：https://example.com/list\n要抓：每一行的名称、价格、更新时间\n要求：翻完所有分页，最后整理成一张表贴给我，并附上抓取时间。\n如果页面要登录或有验证码，先停下来告诉我，别硬试。',
  },
  {
    icon: Image, label: '生成一张配图', category: '写作', group: 'now',
    prompt: '给这篇文章生成一张封面配图：\n\n主题：为什么本地优先的软件正在回来\n风格：极简、冷色调、留白多，画面里不要出现文字\n尺寸：16:9\n\n先给我 2-3 个不同方向的描述让我挑，我说好再出图。',
  },
  {
    icon: Music, label: '用我的声音念这段稿', category: '写作', group: 'now',
    prompt: '用我克隆好的声音，把下面这段稿子念出来并导出音频：\n\n[粘贴要念的文本]\n\n语气口语化一点、语速正常，遇到逗号自然停顿。',
  },
  {
    icon: FolderOpen, label: '整理工作目录里的文件', category: '系统', group: 'now',
    prompt: '帮我整理工作目录：\n\n目录：~/Documents/meetings\n任务：按项目名分组归档，每个项目生成一份摘要文档\n要求：\n- 先列出「将要移动哪些文件、移到哪里」，等我确认再动手\n- 重名文件不要覆盖，单独列出来\n- 最后输出一份整理报告',
  },
  {
    icon: Bot, label: '设计 AI 工作流', category: '团队', group: 'now',
    prompt: '帮我设计一个多 Agent 协作工作流：\n\n任务：自动化处理客户反馈\n流程：\n1. 收集各渠道反馈（邮件、微信、表单）\n2. 自动分类和优先级排序\n3. 生成每日摘要报告\n4. 高优先级问题自动通知负责人\n\n请给出 Agent 分工和协作方案。',
  },
  {
    icon: Globe, label: '网页内容提取', category: '资料', group: 'now',
    prompt: '帮我浏览并分析这个网页的内容：\nhttps://example.com\n\n需要：\n- 提取核心信息和关键数据\n- 总结主要观点（300字以内）\n- 列出值得关注的细节',
  },

  // ── 定时自动：一次设定，以后按点自己跑（多会落到 cron_create）──
  {
    icon: Newspaper, label: '每天早上搜集 AI 资讯', category: '资讯', group: 'scheduled',
    prompt: '/cron 每天早上 8:30 帮我搜集并汇总 AI 领域的最新资讯：\n\n- 挑 8-10 条有实质信息量的（具体的事件、数字、结论）\n- 每条一句话摘要 + 来源链接\n- 只保留我关心的方向：大模型、Agent、端侧推理；过滤纯观点和标题党\n- 抓完直接写进概览页的资讯卡片，不用再单独通知我',
  },
  {
    icon: Clock, label: '设置定时提醒', category: '工作', group: 'scheduled',
    prompt: '/cron 每天早上 9:00 提醒我：\n1. 查看今日待办事项\n2. 检查昨日未回复的消息\n3. 确认今日会议安排',
  },
  {
    icon: Calendar, label: '每天早上播报今日安排', category: '工作', group: 'scheduled',
    prompt: '/cron 每天早上 8:00 用几行话说清今天的安排：\n\n- 今天有哪些定时任务要跑、大概几点\n- 昨天有没有没跑完或跑失败的\n- 今天我需要特别留意的 1-2 件事\n\n控制在 3 行以内，说重点，别写客套话。',
  },
  {
    icon: Inbox, label: '每天汇总各渠道消息', category: '通知', group: 'scheduled',
    prompt: '/cron 每天 18:00 把今天的渠道消息汇总一遍：\n\n- 飞书 / 企微 / 微信里今天收到的消息\n- 按「需要我回复的」「只是知会」「可忽略」分三堆\n- 需要我回复的，给出建议回复草稿\n- 只列要点，不要原文刷屏',
  },
  {
    icon: TrendingUp, label: '每周复盘这周做了什么', category: '工作', group: 'scheduled',
    prompt: '/cron 每周日 20:00 帮我复盘这一周：\n\n- 这周我的时间主要花在哪（从会话与任务记录里提炼，别编）\n- 有哪些事反复出现、其实可以固化成一个定时任务\n- 下周值得优先做的 3 件事\n\n写成一段给我，不要做成表格。',
  },
  {
    icon: FileText, label: '每周生成工作周报', category: '工作', group: 'scheduled',
    prompt: '/cron 每周五 17:30 生成这周的工作周报：\n\n- 从工作记忆和会话记录里捞出这周实际做完的事\n- 按「已完成 / 进行中 / 卡住的」分组，每项带上关键结果\n- 卡住的项要写清卡在哪，不要只罗列\n- 生成完存一份到工作目录，再发一份到飞书给我',
  },
  {
    icon: ListChecks, label: '每周做一次资产体检', category: '系统', group: 'scheduled',
    prompt: '/cron 每周一 10:00 给这台机器做一次体检：\n\n- 工作记忆有没有重复、互相矛盾的条目\n- 资料库有没有长期没人看、可以归档的\n- 定时任务有没有一直失败、或早就不需要的\n- 磁盘和内存有没有异常\n\n结论要具体到条目，并和上一期对比，只报变化，别每次都念一遍全量。',
  },
  {
    icon: Archive, label: '每月整理记忆并归档', category: '记忆', group: 'scheduled',
    prompt: '/cron 每月 1 号 10:00 整理我的记忆：\n\n- 合并重复条目；冲突的以最近一条为准\n- 30 天没用到的降到冷存储\n- 一定保留：项目约定、我的偏好、还在进行的任务\n- 整理完给我一份「删了什么、合并了什么、留了什么」的清单过目',
  },
  {
    icon: Archive, label: '每天定时备份工作区', category: '系统', group: 'scheduled',
    prompt: '/cron 每天 23:30 备份工作区：\n\n- 把工作目录增量备份到 D:/backup/workspace\n- 保留最近 30 天，更早的按周保留\n- 备份失败、或体积突然异常增大时立刻通知我，别默默失败',
  },
  {
    icon: Globe, label: '盯着某个网页的变化', category: '自动化', group: 'scheduled',
    prompt: '/cron 每天早上 9:00 检查这个页面有没有更新：\n\n地址：https://example.com/changelog\n\n只看「新增了什么」，没变化就别打扰我。\n有更新就抓出变更要点发给我，附上链接。',
  },

  // ── 长期设定：一次设定，长期生效 ──
  {
    icon: Brain, label: '记住我的项目约定', category: '记忆', group: 'standing',
    prompt: '记住这条项目约定，以后别再问：\n\n项目：lumii\n约定：包管理用 pnpm（不是 npm）；提交信息用中文；改完代码要跑 typecheck。\n\n记完之后用一句话复述给我确认。',
  },
  {
    icon: PenLine, label: '记住我的写作偏好', category: '记忆', group: 'standing',
    prompt: '记住我的写作偏好，以后所有产出都按这个来：\n\n- 中文优先，少用「赋能」「闭环」这类词\n- 短句为主，不要三段式排比\n- 结论放前面，解释放后面\n\n记完复述一遍让我确认。',
  },
  {
    icon: ListChecks, label: '教它我的代码审查清单', category: '开发', group: 'standing',
    prompt: '记住我的代码审查清单，以后我说「按我的清单过一遍」就用它：\n\n1. 有没有把失败静默吞掉的 catch\n2. 有没有只在这台机器上成立的绝对路径\n3. 有没有为了兼容已经不存在的旧版本而留的分支\n4. 新增的对外行为有没有对应的测试\n\n记完复述一遍让我确认。',
  },
  {
    icon: BookOpen, label: '把常用资料存进资料库', category: '资料', group: 'standing',
    prompt: '把这些资料收进我的资料库，并做好索引：\n\n[待入库的文件 / 链接]\n\n- 每份给一个能一眼认出的标题和一句话摘要\n- 打上主题标签，方便以后按主题翻\n- 入库后告诉我一共收了几份、按标签各多少',
  },
  {
    icon: KeyRound, label: '接上我的 MCP 服务', category: '系统', group: 'standing',
    prompt: '帮我把这个 MCP 服务接上：\n\n服务：[名称 / 地址]\n用途：让我以后能直接读里面的内容\n\n接完先做个最小验证（列出能用的工具、试读一条），把结果给我看，别只说「配置好了」。',
  },
  {
    icon: Inbox, label: '把结果推送到飞书', category: '通知', group: 'standing',
    prompt: '以后凡是这类结果，直接推到飞书给我，不用我每次交代：\n\n- 定时任务的产出\n- 超过 3 分钟的长任务做完\n- 需要我拍板的事\n\n普通问答不要推。如果飞书渠道还没配好，先带我把渠道接上。',
  },
  {
    icon: Clock, label: '设置每天的安静时段', category: '系统', group: 'standing',
    prompt: '设定一条长期规则：\n\n每天 23:00 - 次日 8:00 不要主动找我。\n这段时间定时任务照常跑，但不要推通知；攒到早上 8:00 一起汇总给我。',
  },
  {
    icon: Users, label: '组建一支常驻团队', category: '团队', group: 'standing',
    prompt: '帮我组建一支常驻团队来做内容运营：\n\n目标：每周产出 3 篇公众号文章\n需要：选题、写稿、配图、校对\n\n- 先给我一份角色分工和协作流程，我确认后再建\n- 每个角色要说清职责边界和产出物\n- 建好后告诉我在哪里能看到它们、怎么派活',
  },
  {
    icon: Sparkles, label: '给我换个宠物形象', category: '系统', group: 'standing',
    prompt: '帮我换个桌面宠物形象：\n\n- 先列出我本地已有的形象让我挑，别自己决定\n- 我想要偏安静、不抢视线的风格\n- 换完之后把「怎么关掉它」也一并告诉我',
  },
]

export function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

/** 概览页「场景推荐」精选：挑能体现客户端能力的几条，顺序即展示顺序 */
export const FEATURED_LABELS = [
  '设置定时提醒',
  '深入调研这个代码库',
  '改一个客户端设置',
  '每周做一次资产体检',
  '记住我的项目约定',
  '把结果推送到飞书',
]

export function getFeaturedScenarios(): ScenarioItem[] {
  return FEATURED_LABELS.map((label) => ALL_SCENARIOS.find((s) => s.label === label)).filter(
    (s): s is ScenarioItem => Boolean(s),
  )
}

/**
 * 按触发方式分组（一级维度）。空组不返回；组内保持 ALL_SCENARIOS 的原始顺序
 * ——顺序就是编辑时定下的推荐次序，不要在这里再排序。
 */
export function groupScenarios(
  items: readonly ScenarioItem[] = ALL_SCENARIOS,
): ReadonlyArray<{ group: ScenarioGroup; items: readonly ScenarioItem[] }> {
  return SCENARIO_GROUPS.map((group) => ({
    group,
    items: items.filter((s) => s.group === group.id),
  })).filter((g) => g.items.length > 0)
}