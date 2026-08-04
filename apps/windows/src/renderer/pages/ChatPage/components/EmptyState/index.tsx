import React, { useMemo } from 'react'
import {
  Mail, ClipboardList, BarChart2, Calendar, FileText, Target,
  FileSignature, Briefcase, PenLine, MessageSquare, Video, Newspaper,
  Mic, BookOpen, ShoppingBag, Search, GraduationCap, Languages,
  Lightbulb, Bug, Zap, Terminal, Layers, TestTube, RefreshCw, Globe,
  UtensilsCrossed, Plane, PiggyBank, Dumbbell, Gift, Home, Smartphone,
  Heart, FilePenLine as FileUser, Handshake, TrendingUp, Presentation, Bot, Clock,
  FolderOpen, Users,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import styles from './EmptyState.module.css'

interface EmptyStateProps {
  onSuggestionClick?: (suggestion: string) => void
}

interface ScenarioItem {
  icon: LucideIcon
  label: string
  prompt: string
  category: string
}

const ALL_SCENARIOS: ScenarioItem[] = [
  // 工作效率
  {
    icon: Mail, label: '写工作邮件', category: '工作效率',
    prompt: '帮我写一封专业的工作邮件。\n\n收件人：产品团队\n主题：下周产品评审会议安排\n要点：\n- 会议时间：周四下午3点\n- 地点：3楼会议室\n- 请各负责人提前准备本模块进展',
  },
  {
    icon: ClipboardList, label: '整理会议纪要', category: '工作效率',
    prompt: '帮我整理以下会议内容，提炼关键决策和行动项：\n\n会议主题：Q2 产品规划\n参与人：产品、研发、设计\n讨论内容：\n- 确定了新版本上线时间为5月底\n- 设计需在4月20日前完成原型\n- 研发评估工作量后反馈排期\n- 下次会议定在下周三',
  },
  {
    icon: BarChart2, label: '数据分析报告', category: '工作效率',
    prompt: '帮我分析以下数据，生成一份简洁的分析报告：\n\n本月用户数据：\n- 新增用户：12,450（环比+18%）\n- 活跃用户：38,200（环比+5%）\n- 付费转化率：3.2%（环比-0.4%）\n- 平均使用时长：8.5分钟\n\n请分析趋势、找出问题并给出建议。',
  },
  {
    icon: Calendar, label: '制定工作计划', category: '工作效率',
    prompt: '帮我制定本周工作计划，优先级排序并分配时间：\n\n待办事项：\n- 完成Q2需求文档\n- 与3个客户做产品访谈\n- 修复线上反馈的2个bug\n- 准备周五的团队分享\n- 回复积压的20封邮件',
  },
  {
    icon: FileText, label: '写工作总结', category: '工作效率',
    prompt: '帮我写一份月度工作总结：\n\n本月完成：\n- 上线了用户画像功能，DAU提升12%\n- 主导完成竞品分析报告\n- 推动解决了3个跨部门协作问题\n\n遇到的挑战：需求变更频繁，排期压力大\n下月计划：推进数据看板项目',
  },
  {
    icon: Target, label: '制定 OKR', category: '工作效率',
    prompt: '帮我制定季度 OKR，要求目标明确、可量化：\n\n我的角色：产品经理\n业务方向：提升用户留存\n现状：次日留存率42%，7日留存率18%\n资源：1名设计师，2名前端，1名后端\n\n请制定1个O和3-4个KR。',
  },
  {
    icon: Briefcase, label: '商业计划书', category: '工作效率',
    prompt: '帮我写一份商业计划书大纲：\n\n项目：面向中小企业的AI客服SaaS平台\n目标市场：电商、零售行业\n核心功能：智能问答、工单管理、数据分析\n商业模式：按坐席订阅收费\n\n请包含市场分析、竞争优势、财务预测等章节。',
  },

  // 内容创作
  {
    icon: PenLine, label: '写公众号文章', category: '内容创作',
    prompt: '帮我写一篇公众号文章：\n\n主题：为什么越来越多的人开始用 AI 助手处理工作\n目标读者：职场白领\n风格：轻松有趣，有数据支撑\n字数：1500字左右\n结构：开头钩子 + 3个核心观点 + 行动号召',
  },
  {
    icon: MessageSquare, label: '写小红书文案', category: '内容创作',
    prompt: '帮我写一条小红书种草文案：\n\n产品：降噪耳机\n卖点：主动降噪、续航30小时、轻量设计\n目标用户：通勤族、学生\n风格：真实体验感，带emoji，适合年轻人\n\n需要标题、正文和5个相关话题标签。',
  },
  {
    icon: Video, label: '短视频脚本', category: '内容创作',
    prompt: '帮我写一个60秒短视频脚本：\n\n主题：3个让工作效率翻倍的AI工具\n平台：抖音/视频号\n风格：干货分享，节奏快\n\n请包含：开场钩子（前3秒）、内容分段、结尾引导关注。',
  },
  {
    icon: Newspaper, label: '新闻稿撰写', category: '内容创作',
    prompt: '帮我写一篇产品发布新闻稿：\n\n事件：MtBot 2.0 正式发布\n核心亮点：支持多 Agent 协作、本地隐私部署、跨平台同步\n发布时间：2025年5月\n目标媒体：科技媒体、AI 垂直媒体\n\n格式：标准新闻稿，500字以内。',
  },
  {
    icon: Mic, label: '播客提纲', category: '内容创作',
    prompt: '帮我写一期播客的提纲和开场白：\n\n主题：AI 如何改变普通人的工作方式\n时长：30分钟\n嘉宾：一位使用AI工具1年以上的产品经理\n\n请包含：开场白（2分钟）、5个讨论问题、结尾总结。',
  },

  // 学习研究
  {
    icon: Search, label: '解释技术概念', category: '学习研究',
    prompt: '用简单易懂的方式解释"向量数据库"：\n\n- 它是什么，解决什么问题\n- 和传统数据库有什么区别\n- 举一个生活中的类比\n- 适合什么场景使用\n\n我有编程基础但没接触过 AI 开发。',
  },
  {
    icon: GraduationCap, label: '制定学习计划', category: '学习研究',
    prompt: '帮我制定一个学习计划：\n\n目标：3个月内掌握 Python 数据分析\n现状：有基础编程经验，没学过 Python\n每天可用时间：1.5小时\n学习目标：能独立完成数据清洗和可视化\n\n请按周拆分，推荐具体学习资源。',
  },
  {
    icon: Languages, label: '翻译并润色', category: '学习研究',
    prompt: '请将以下英文翻译成流畅的中文，并适当润色：\n\n"The key to building great products is not just understanding what users say they want, but deeply observing what they actually do. The gap between stated preferences and revealed preferences is where the real insights live."',
  },
  {
    icon: Lightbulb, label: '头脑风暴', category: '学习研究',
    prompt: '帮我头脑风暴：如何提升一款笔记应用的用户留存率\n\n背景：\n- 用户注册后7日留存仅20%\n- 主要流失节点：注册后第3天\n- 竞品：Notion、Obsidian\n\n请从产品功能、运营策略、用户引导3个维度各给5个创意。',
  },
  {
    icon: BookOpen, label: '总结文章要点', category: '学习研究',
    prompt: '帮我总结以下文章的核心观点，并给出我的行动建议：\n\n[请粘贴文章内容]\n\n输出格式：\n1. 核心论点（3条）\n2. 关键数据/案例\n3. 对我的启发和可行动建议',
  },

  // 编程开发
  {
    icon: Bug, label: '调试代码', category: '编程开发',
    prompt: '帮我找出以下代码的问题并修复：\n\n```javascript\nasync function fetchUserData(userId) {\n  const res = await fetch(`/api/users/${userId}`)\n  const data = res.json()\n  return data.user\n}\n```\n\n报错：TypeError: Cannot read properties of undefined (reading \'name\')',
  },
  {
    icon: Zap, label: '优化代码性能', category: '编程开发',
    prompt: '帮我优化以下代码的性能：\n\n```javascript\nfunction findDuplicates(arr) {\n  const duplicates = []\n  for (let i = 0; i < arr.length; i++) {\n    for (let j = i + 1; j < arr.length; j++) {\n      if (arr[i] === arr[j] && !duplicates.includes(arr[i])) {\n        duplicates.push(arr[i])\n      }\n    }\n  }\n  return duplicates\n}\n```\n\n当前 O(n³)，请优化到 O(n) 并解释思路。',
  },
  {
    icon: Terminal, label: '写自动化脚本', category: '编程开发',
    prompt: '帮我写一个 Node.js 脚本：\n\n功能：批量重命名文件夹中的图片\n规则：将 IMG_001.jpg 格式改为 2025-05-01_001.jpg（日期取文件修改时间）\n要求：支持子目录递归、跳过非图片文件、操作前预览变更',
  },
  {
    icon: Layers, label: '系统架构设计', category: '编程开发',
    prompt: '帮我设计一个系统架构：\n\n需求：实时聊天应用\n规模：预计10万并发用户\n功能：私聊、群聊、消息已读、文件传输\n技术栈偏好：Node.js + React\n\n请给出架构图描述、技术选型理由、关键设计决策。',
  },
  {
    icon: TestTube, label: '写单元测试', category: '编程开发',
    prompt: '帮我为以下函数写完整的单元测试（使用 Jest）：\n\n```typescript\nexport function parseAmount(input: string): number {\n  const cleaned = input.replace(/[,$]/g, \'\')\n  const num = parseFloat(cleaned)\n  if (isNaN(num)) throw new Error(`Invalid amount: ${input}`)\n  return Math.round(num * 100) / 100\n}\n```\n\n覆盖正常值、边界值、异常情况。',
  },
  {
    icon: RefreshCw, label: '重构代码', category: '编程开发',
    prompt: '帮我重构以下代码，提升可读性和可维护性：\n\n```javascript\nfunction p(u, t, a) {\n  if (u && t && a) {\n    if (t === \'admin\') {\n      if (a === \'delete\' || a === \'edit\') return true\n    } else if (t === \'user\') {\n      if (a === \'read\') return true\n    }\n  }\n  return false\n}\n```\n\n请重命名变量、拆分逻辑、添加类型注解。',
  },

  // 生活助手
  {
    icon: UtensilsCrossed, label: '菜谱推荐', category: '生活助手',
    prompt: '我冰箱里有这些食材，帮我推荐3道菜并给出做法：\n\n食材：鸡蛋3个、西红柿2个、豆腐1块、青椒1个、大蒜、生姜\n要求：\n- 30分钟内能做完\n- 适合2人份\n- 有一道下饭菜',
  },
  {
    icon: Plane, label: '旅行规划', category: '生活助手',
    prompt: '帮我规划一次旅行：\n\n目的地：日本京都\n时间：5天4晚\n出发城市：上海\n人数：2人\n预算：人均1.5万元\n偏好：文化历史、美食、避开人多景点\n\n请给出每日行程、住宿建议、必吃美食清单。',
  },
  {
    icon: PiggyBank, label: '理财方案分析', category: '生活助手',
    prompt: '帮我分析理财方案：\n\n基本情况：\n- 月收入：2万元\n- 月支出：1.2万元\n- 现有存款：15万元\n- 风险偏好：中等\n- 目标：3年后首付买房（需50万）\n\n请给出资产配置建议和具体操作步骤。',
  },
  {
    icon: Dumbbell, label: '健身计划', category: '生活助手',
    prompt: '帮我制定健身计划：\n\n基本情况：\n- 性别：男，28岁\n- 目标：增肌减脂\n- 现状：体重75kg，体脂约22%\n- 可用时间：每周3次，每次1小时\n- 设备：健身房（有器械）\n\n请给出训练计划和饮食建议。',
  },
  {
    icon: Gift, label: '礼物推荐', category: '生活助手',
    prompt: '帮我推荐礼物：\n\n对象：女朋友，25岁，设计师\n场合：生日\n预算：500-1000元\n她的喜好：插画、咖啡、旅行、极简风格\n已有：AirPods、kindle\n\n请推荐5个选项，说明推荐理由。',
  },
  {
    icon: Smartphone, label: '产品选购对比', category: '生活助手',
    prompt: '帮我对比以下两款产品，给出购买建议：\n\n产品A：MacBook Air M3 13寸\n产品B：MacBook Pro M3 14寸\n\n我的使用场景：\n- 主要用途：写代码、视频剪辑\n- 经常外出携带\n- 预算：1.5万以内\n- 不玩游戏',
  },

  // 职场发展
  {
    icon: FileUser, label: '优化简历', category: '职场发展',
    prompt: '帮我优化以下简历中的工作经历描述，使其更有说服力：\n\n原文：\n"负责产品需求分析和文档编写，与研发团队沟通协调，推动项目按时上线"\n\n目标职位：高级产品经理\n公司规模：500人以上互联网公司\n\n请用 STAR 法则重写，突出量化成果。',
  },
  {
    icon: Handshake, label: '面试准备', category: '职场发展',
    prompt: '帮我准备面试：\n\n职位：字节跳动 产品经理\n面试轮次：二面（产品总监面）\n我的背景：3年电商产品经验\n\n请给出：\n1. 可能被问到的5个核心问题\n2. 每个问题的回答框架\n3. 我应该主动问面试官的2个问题',
  },
  {
    icon: TrendingUp, label: '职业规划', category: '职场发展',
    prompt: '帮我分析职业发展路径：\n\n现状：\n- 岗位：前端工程师，工作3年\n- 技术栈：React、TypeScript、Node.js\n- 目前月薪：2.5万\n- 困惑：是继续深耕技术还是转型全栈/管理\n\n请分析两条路径的优劣和建议。',
  },
  {
    icon: Presentation, label: '演讲稿撰写', category: '职场发展',
    prompt: '帮我写一篇演讲稿：\n\n场合：公司年会，部门代表发言\n时长：5分钟\n主题：回顾过去一年团队的成长与收获\n风格：真诚、有温度，适当幽默\n亮点：团队从5人扩展到15人，完成了3个重要项目',
  },

  // MtBot 特色功能
  {
    icon: Bot, label: '设计 AI 工作流', category: '智能体',
    prompt: '帮我设计一个多 Agent 协作工作流：\n\n任务：自动化处理客户反馈\n流程：\n1. 收集各渠道反馈（邮件、微信、表单）\n2. 自动分类和优先级排序\n3. 生成每日摘要报告\n4. 高优先级问题自动通知负责人\n\n请给出 Agent 分工和协作方案。',
  },
  {
    icon: Clock, label: '设置定时提醒', category: '智能体',
    prompt: '/cron 每天早上 9:00 提醒我：\n1. 查看今日待办事项\n2. 检查昨日未回复的消息\n3. 确认今日会议安排',
  },
  {
    icon: Globe, label: '网页内容提取', category: '智能体',
    prompt: '帮我浏览并分析这个网页的内容：\nhttps://example.com\n\n需要：\n- 提取核心信息和关键数据\n- 总结主要观点（300字以内）\n- 列出值得关注的细节',
  },
  {
    icon: FolderOpen, label: '批量处理文件', category: '智能体',
    prompt: '帮我处理工作目录中的文件：\n\n任务：整理本月的会议记录\n要求：\n- 扫描 ~/Documents/meetings/ 目录\n- 按项目名称分类归档\n- 为每个项目生成一份摘要文档\n- 输出整理报告',
  },
  {
    icon: Users, label: '组建 AI 团队', category: '智能体',
    prompt: '帮我组建一个 AI 研究团队来完成以下任务：\n\n任务：对"国内短视频市场"做一份完整的竞品分析报告\n\n请规划：\n- 需要哪些专业 Agent（研究员、分析师、撰写者）\n- 每个 Agent 的职责分工\n- 协作流程和最终输出格式',
  },
]

function pickRandom<T>(arr: T[], n: number): T[] {
  return [...arr].sort(() => Math.random() - 0.5).slice(0, n)
}

const EmptyState: React.FC<EmptyStateProps> = ({ onSuggestionClick }) => {
  const displayed = useMemo(() => pickRandom(ALL_SCENARIOS, 6), [])

  return (
    <div className={styles['empty-state']}>
      <div className={styles['empty-icon-large']}>
        <Bot size={40} strokeWidth={1.5} />
      </div>
      <h3 className={styles['empty-title']}>有什么我可以帮你的？</h3>
      <p className={styles['empty-description']}>
        选择一个场景快速开始，或直接输入你的需求
      </p>

      <div className={styles['empty-suggestions']}>
        {displayed.map((item, index) => {
          const Icon = item.icon
          return (
            <button
              key={index}
              className={styles['suggestion-btn']}
              onClick={() => onSuggestionClick?.(item.prompt)}
              title={item.category}
            >
              <span className={styles['suggestion-icon']}>
                <Icon size={15} strokeWidth={1.8} />
              </span>
              <span className={styles['suggestion-text']}>{item.label}</span>
              <span className={styles['suggestion-category']}>{item.category}</span>
            </button>
          )
        })}
      </div>

      <div className={styles['empty-shortcuts']}>
        <div className={styles['shortcut-hint']}>
          <kbd>Ctrl</kbd> + <kbd>N</kbd> <span>新建对话</span>
        </div>
        <div className={styles['shortcut-hint']}>
          <kbd>Enter</kbd> <span>发送消息</span>
        </div>
        <div className={styles['shortcut-hint']}>
          <kbd>/</kbd> <span>斜杠命令</span>
        </div>
      </div>
    </div>
  )
}

export default EmptyState
export { EmptyState }
