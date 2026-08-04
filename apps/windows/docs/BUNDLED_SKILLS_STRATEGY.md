# Windows 客户端内置技能部署策略

## 当前架构分析

### 技能加载机制

Windows 客户端当前支持三种技能来源（优先级从高到低）:

```typescript
// apps/windows/src/main/skill-command-handler.ts
const MTBOT_HOME = path.join(os.homedir(), '.mtbot')
const MANAGED_SKILLS_DIR = path.join(MTBOT_HOME, 'skills')  // 1. 托管技能
const workspaceSkillsDir = path.join(workspaceDir, 'skills') // 2. 工作空间技能
const bundledDir = resolveBundledSkillsDir()                 // 3. 内置技能
```

#### 1. 托管技能 (Managed Skills)
- **位置**: `~/.mtbot/skills/`
- **用途**: 用户通过 Gateway 或客户端 UI 安装的技能
- **管理**: 由 `LocalSkillStore` 管理，支持安装/卸载/更新

#### 2. 工作空间技能 (Workspace Skills)
- **位置**: `<workspace>/skills/`
- **用途**: 项目特定的技能
- **管理**: 由 `SkillWatcher` 监控文件变化

#### 3. 内置技能 (Bundled Skills)
- **位置**:
  - 环境变量 `MTBOT_BUNDLED_SKILLS_DIR` 指定的目录
  - 或可执行文件同目录的 `skills/` 文件夹
- **用途**: 随客户端分发的预装技能
- **管理**: 只读，不可修改

### 技能存储结构

```typescript
// apps/windows/src/main/skill-store.ts
class LocalSkillStore {
  private readonly skillsDir: string        // ~/.mtbot/skills/
  private readonly indexPath: string        // ~/.mtbot/skills/index.json

  // 技能目录结构
  // ~/.mtbot/skills/
  // ├── index.json                          # 技能索引
  // ├── file-organizer/                     # 技能目录
  // │   ├── SKILL.md                        # 技能元数据
  // │   ├── skill.json                      # 清单文件
  // │   └── index.js                        # 入口文件
  // └── system-cleaner/
  //     ├── SKILL.md
  //     ├── skill.json
  //     └── index.js
}
```

### 技能安装流程

```typescript
// apps/windows/src/main/skill-importer.ts
class SkillImporter {
  async importSkill(ocskillPath: string) {
    // 1. 解压 .ocskill 文件到临时目录
    // 2. 验证 ocskill.json 元数据
    // 3. SHA-256 完整性校验
    // 4. 调用 skillStore.installFromDirectory()
    // 5. 复制到 ~/.mtbot/skills/<skill-name>/
    // 6. 更新 index.json
  }
}
```

## 问题分析

### 您提出的方案

> 将推荐给 Windows 客户端安装的技能，移动到 `apps/windows` 适当的目录下，需要将这些技能打包到 Windows 客户端中，在 Windows 客户端首次安装或者运行的时候，将技能放置到指定目录。

### 方案评估

#### ❌ 不推荐：复制到 `~/.mtbot/skills/`

**问题**：
1. **版本冲突**: 用户可能已经安装了同名技能的不同版本
2. **更新困难**: 内置技能更新需要重新安装客户端
3. **磁盘浪费**: 每个用户都复制一份相同的技能文件
4. **权限问题**: 首次运行时可能没有写入 `~/.mtbot/` 的权限

#### ✅ 推荐：使用 Bundled Skills 机制

**优势**：
1. **只读分发**: 技能随客户端安装包分发，不占用用户目录
2. **版本一致**: 所有用户使用相同版本的内置技能
3. **易于更新**: 客户端更新时自动更新内置技能
4. **无权限问题**: 不需要写入用户目录

## 推荐方案

### 方案 A: 使用 Electron `extraResources` (推荐)

#### 1. 目录结构

```
apps/windows/
├── bundled-skills/              # 新建目录
│   ├── file-organizer/
│   │   ├── SKILL.md
│   │   ├── skill.json
│   │   └── index.js
│   ├── system-cleaner/
│   │   ├── SKILL.md
│   │   ├── skill.json
│   │   └── index.js
│   ├── wacli/                   # Windows 推荐技能
│   │   └── SKILL.md
│   ├── github/
│   │   └── SKILL.md
│   └── coding-agent/
│       └── SKILL.md
├── electron-builder.json
└── src/
    └── main/
        └── skill-command-handler.ts
```

#### 2. 修改 `electron-builder.json`

```json
{
  "extraResources": [
    {
      "from": "assets",
      "to": "assets",
      "filter": ["**/*"]
    },
    {
      "from": "config",
      "to": "config",
      "filter": ["server-config.json"]
    },
    {
      "from": "bundled-skills",
      "to": "skills",
      "filter": ["**/*"]
    }
  ]
}
```

#### 3. 修改技能加载逻辑

```typescript
// apps/windows/src/main/skill-command-handler.ts

function resolveBundledSkillsDir(): string | undefined {
  const override = process.env.MTBOT_BUNDLED_SKILLS_DIR?.trim()
  if (override) {
    return override
  }

  // 开发模式：使用源码目录
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../bundled-skills')
    if (fs.existsSync(devPath)) {
      return devPath
    }
  }

  // 生产模式：使用 extraResources
  const resourcesPath = process.resourcesPath
  const bundledPath = path.join(resourcesPath, 'skills')

  if (fs.existsSync(bundledPath)) {
    log.info('找到内置技能目录', { bundledPath })
    return bundledPath
  }

  log.warn('未找到内置技能目录')
  return undefined
}
```

#### 4. 技能选择建议

**Windows 客户端推荐内置的技能**：

```yaml
# 通用工具类
- file-organizer      # 文件整理 (已有)
- system-cleaner      # 系统清理 (已有)

# 开发工具类
- github              # GitHub CLI 集成
- coding-agent        # 代码助手
- tmux                # 终端会话管理 (WSL)

# 通讯类
- wacli               # WhatsApp CLI (需要手机配对)

# 笔记类
- obsidian            # Obsidian 仓库管理

# 媒体类
- openai-whisper      # 本地语音转文字

# 系统控制类
- 1password           # 密码管理
```

**不推荐内置的技能**：
- macOS 专属技能 (`apple-notes`, `imsg`, `bear-notes` 等)
- 需要特定硬件的技能 (`openhue`, `sonoscli` 等)
- 需要云服务 API Key 的技能 (应由网关提供)

### 方案 B: 首次运行时安装 (备选)

如果必须将技能安装到 `~/.mtbot/skills/`，可以采用以下策略：

#### 1. 创建安装脚本

```typescript
// apps/windows/src/main/bundled-skills-installer.ts

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { LocalSkillStore } from './skill-store'

const INSTALL_MARKER = path.join(app.getPath('userData'), '.bundled-skills-installed')

export async function installBundledSkills(skillStore: LocalSkillStore): Promise<void> {
  // 检查是否已安装
  if (fs.existsSync(INSTALL_MARKER)) {
    console.log('[BundledSkills] 内置技能已安装，跳过')
    return
  }

  console.log('[BundledSkills] 开始安装内置技能')

  const bundledDir = resolveBundledSkillsDir()
  if (!bundledDir) {
    console.warn('[BundledSkills] 未找到内置技能目录')
    return
  }

  const entries = fs.readdirSync(bundledDir, { withFileTypes: true })
  let installedCount = 0

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillDir = path.join(bundledDir, entry.name)
    const skillMdPath = path.join(skillDir, 'SKILL.md')

    if (!fs.existsSync(skillMdPath)) continue

    try {
      // 检查是否已存在
      const installed = await skillStore.listInstalled()
      const exists = installed.some(s => s.id === entry.name)

      if (exists) {
        console.log(`[BundledSkills] 技能 ${entry.name} 已存在，跳过`)
        continue
      }

      // 安装技能
      const result = await skillStore.installFromDirectory(skillDir)
      if (result.success) {
        console.log(`[BundledSkills] 成功安装技能: ${entry.name}`)
        installedCount++
      } else {
        console.error(`[BundledSkills] 安装技能失败: ${entry.name}`, result.error)
      }
    } catch (error) {
      console.error(`[BundledSkills] 安装技能异常: ${entry.name}`, error)
    }
  }

  // 创建安装标记
  fs.writeFileSync(INSTALL_MARKER, new Date().toISOString())
  console.log(`[BundledSkills] 内置技能安装完成，共安装 ${installedCount} 个技能`)
}

function resolveBundledSkillsDir(): string | undefined {
  // 同方案 A
}
```

#### 2. 在主进程初始化时调用

```typescript
// apps/windows/src/main/index.ts

async function initSkillRuntime(): Promise<void> {
  log.info('初始化技能运行时')

  const mtbotDataDir = process.env.MTBOT_DATA_DIR || join(os.homedir(), '.mtbot')
  const defaultWorkspaceBase = join(mtbotDataDir, 'workspace')
  const configuredWorkspace = configManager?.getAppConfig().workspaceDirectory
  const skillsBaseDir = configuredWorkspace || defaultWorkspaceBase
  const skillsDir = join(skillsBaseDir, 'skills')
  const skillLogsDir = join(mtbotDataDir, 'logs', 'skills')

  await skillRuntime.initialize(skillsDir, false, skillLogsDir)

  // 首次运行时安装内置技能
  await installBundledSkills(skillRuntime.getSkillStore())

  if (gatewayClient) {
    gatewayClient.setSkillRuntime(skillRuntime)
  }

  log.info('技能运行时初始化完成')
}
```

#### 3. 优缺点对比

**优点**：
- ✅ 用户可以卸载不需要的内置技能
- ✅ 用户可以更新内置技能到新版本

**缺点**：
- ❌ 首次启动时间变长
- ❌ 占用用户目录空间
- ❌ 可能遇到权限问题
- ❌ 版本管理复杂（用户安装的版本 vs 内置版本）

## 最佳实践建议

### 推荐：方案 A (Bundled Skills)

**理由**：
1. **符合 Electron 最佳实践**: 使用 `extraResources` 分发只读资源
2. **性能最优**: 不需要首次安装，启动即可用
3. **维护简单**: 客户端更新时自动更新技能
4. **用户体验好**: 零配置，开箱即用

### 实施步骤

#### Phase 1: 准备内置技能
```bash
# 1. 创建内置技能目录
mkdir -p apps/windows/bundled-skills

# 2. 从 skills/ 复制推荐技能
cp -r skills/builtin/file-organizer apps/windows/bundled-skills/
cp -r skills/builtin/system-cleaner apps/windows/bundled-skills/
cp -r skills/github apps/windows/bundled-skills/
cp -r skills/coding-agent apps/windows/bundled-skills/
cp -r skills/wacli apps/windows/bundled-skills/
cp -r skills/obsidian apps/windows/bundled-skills/

# 3. 验证每个技能都有 SKILL.md
find apps/windows/bundled-skills -name "SKILL.md"
```

#### Phase 2: 修改构建配置
```json
// apps/windows/electron-builder.json
{
  "extraResources": [
    // ... 现有配置
    {
      "from": "bundled-skills",
      "to": "skills",
      "filter": ["**/*"]
    }
  ]
}
```

#### Phase 3: 更新技能加载逻辑
```typescript
// apps/windows/src/main/skill-command-handler.ts
function resolveBundledSkillsDir(): string | undefined {
  // 开发模式
  if (!app.isPackaged) {
    const devPath = path.join(__dirname, '../../bundled-skills')
    if (fs.existsSync(devPath)) {
      return devPath
    }
  }

  // 生产模式
  const bundledPath = path.join(process.resourcesPath, 'skills')
  if (fs.existsSync(bundledPath)) {
    return bundledPath
  }

  return undefined
}
```

#### Phase 4: 测试验证
```bash
# 1. 开发模式测试
pnpm dev

# 2. 构建测试
pnpm build

# 3. 验证内置技能加载
# 在客户端中执行: skills.status
# 应该看到 bundled skills 列表
```

## 技能更新策略

### 内置技能版本管理

```typescript
// apps/windows/bundled-skills/manifest.json
{
  "version": "1.0.0",
  "skills": [
    { "id": "file-organizer", "version": "1.0.0" },
    { "id": "system-cleaner", "version": "1.0.0" },
    { "id": "github", "version": "2.1.0" },
    { "id": "coding-agent", "version": "3.0.0" }
  ]
}
```

### 用户安装技能优先级

```typescript
// 技能加载优先级 (从高到低)
1. ~/.mtbot/skills/<skill-name>        // 用户安装的版本
2. <workspace>/skills/<skill-name>     // 工作空间版本
3. <resources>/skills/<skill-name>     // 内置版本
```

**规则**：
- 如果用户安装了同名技能，优先使用用户版本
- 用户可以通过卸载来回退到内置版本
- 内置技能不可修改，保证稳定性

## 总结

### 推荐方案

✅ **使用 Electron `extraResources` 分发内置技能**

**优势**：
- 零配置，开箱即用
- 不占用用户目录空间
- 客户端更新时自动更新技能
- 符合 Electron 最佳实践

**实施成本**：
- 低：只需修改 `electron-builder.json` 和技能加载逻辑
- 无需数据库迁移或复杂的安装脚本

### 不推荐方案

❌ **首次运行时复制到 `~/.mtbot/skills/`**

**问题**：
- 版本冲突风险
- 首次启动时间长
- 占用用户目录空间
- 更新维护复杂

### 下一步行动

1. 创建 `apps/windows/bundled-skills/` 目录
2. 复制推荐的 Windows 技能
3. 修改 `electron-builder.json`
4. 更新技能加载逻辑
5. 测试验证

---

**相关文档**：
- [技能目录介绍](../../../skills/README.md)
- [多用户架构部署指南](../../../skills/ARCHITECTURE_GUIDE.md)
- [Electron Builder 文档](https://www.electron.build/configuration/contents#extraresources)
