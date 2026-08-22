/**
 * 处理来自 Gateway 的技能安装推送：解码 base64 包 → 校验 SHA-256 → 解压 → 安装 → 重新加载。
 */

import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { LocalSkillStore, SkillManifest } from './skill-store'
import { createLogger } from './logger'

const log = createLogger('SkillRuntime')

/** 技能包最大大小（50MB），防止 DoS 攻击 */
const MAX_PACKAGE_SIZE = 50 * 1024 * 1024

export interface SkillInstallPushRequest {
  requestId: string
  skillId: string
  version: string
  packageBase64: string
  packageHash: string
  manifest: SkillManifest
}

export interface SkillInstallPushDeps {
  skillStore: LocalSkillStore | null
  reloadExternalSkills: () => Promise<void>
}

/**
 * 处理来自 Gateway 的技能安装推送
 *
 * 解码 base64 包 → 校验 SHA-256 → 解压 → 安装 → 重新加载
 *
 * @param request - 安装推送请求
 * @param deps - 技能存储与重新加载回调
 * @returns 安装结果
 */
export async function handleSkillInstallPush(
  request: SkillInstallPushRequest,
  deps: SkillInstallPushDeps,
): Promise<{ success: boolean; error?: string }> {
  log.info('收到技能安装推送', {
    requestId: request.requestId,
    skillId: request.skillId,
    version: request.version,
  })

  const tempDir = path.join(os.tmpdir(), `skill-install-${request.skillId}-${Date.now()}`)

  try {
    // 1. 验证 base64 大小（防止 DoS 攻击）
    // Base64 编码后大小约为原始大小的 4/3，所以用 0.75 估算原始大小
    const estimatedSize = request.packageBase64.length * 0.75
    if (estimatedSize > MAX_PACKAGE_SIZE) {
      log.error('技能包过大', {
        skillId: request.skillId,
        estimatedSize,
        maxSize: MAX_PACKAGE_SIZE,
      })
      return {
        success: false,
        error: `技能包过大（${(estimatedSize / 1024 / 1024).toFixed(2)}MB），最大允许 ${MAX_PACKAGE_SIZE / 1024 / 1024}MB`,
      }
    }

    // 2. base64 解码
    const packageBuffer = Buffer.from(request.packageBase64, 'base64')

    // 3. SHA-256 校验
    const actualHash = crypto.createHash('sha256').update(packageBuffer).digest('hex')
    if (actualHash !== request.packageHash) {
      log.error('技能包哈希校验失败', {
        skillId: request.skillId,
        expected: request.packageHash,
        actual: actualHash,
      })
      return { success: false, error: '包完整性校验失败：SHA-256 不匹配' }
    }

    // 4. 解压到临时目录
    await fs.mkdir(tempDir, { recursive: true })
    const archivePath = path.join(tempDir, `${request.skillId}.tgz`)
    await fs.writeFile(archivePath, packageBuffer)

    // 使用 tar 解压
    const tar = await import('tar')
    await tar.x({ file: archivePath, cwd: tempDir })

    // 5. 找到包含 skill.json 的子目录
    const entries = await fs.readdir(tempDir, { withFileTypes: true })
    const skillSubDir = entries.find((e) => e.isDirectory())
    if (!skillSubDir) {
      return { success: false, error: '解压后未找到技能目录' }
    }
    const skillDir = path.join(tempDir, skillSubDir.name)

    // 6. 通过 LocalSkillStore 安装
    if (!deps.skillStore) {
      return { success: false, error: '技能存储未初始化' }
    }
    const installResult = await deps.skillStore.installFromDirectory(skillDir)
    if (!installResult.success) {
      return { success: false, error: installResult.error || '安装失败' }
    }

    // 7. 重新加载外部技能
    await deps.reloadExternalSkills()

    log.info('技能安装推送完成', {
      skillId: request.skillId,
      version: request.version,
    })

    return { success: true }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err)
    log.error('技能安装推送失败', {
      skillId: request.skillId,
      error: errorMessage,
    })
    return { success: false, error: errorMessage }
  } finally {
    // 清理临时目录
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
