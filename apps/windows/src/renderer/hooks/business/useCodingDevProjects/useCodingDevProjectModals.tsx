/**
 * ACP 项目操作弹窗编排：新建名称 / 打开挂载名 / 移除确认。
 * 避免在 Electron 中使用 window.prompt/confirm。
 */
import React, { useCallback, useState } from 'react'
import { ConfirmModal } from '../../../components/ui/Modal/ConfirmModal'
import { PromptInputModal } from '../../../components/ui/Modal/PromptInputModal'
import {
  getRemoveProjectHint,
  type CodingDevProject,
  type UseCodingDevProjectsResult,
} from './useCodingDevProjects'

type NameDialog =
  | { kind: 'create' }
  | { kind: 'open'; targetPath: string; defaultName: string }
  | null

type RemoveDialog = { name: string; hint: string } | null

export type CodingDevProjectModalsApi = {
  /** 打开「新建项目」名称弹窗 */
  beginCreate: () => void
  /** 选目录后打开「挂载名称」弹窗 */
  beginOpen: () => Promise<void>
  /** 打开移除确认弹窗 */
  beginRemove: (name: string) => void
  /** 须挂载到 UI 树中的弹窗节点 */
  modals: React.ReactNode
}

/**
 * 为设置页 / 侧栏提供统一的项目名输入与移除确认弹窗。
 */
export function useCodingDevProjectModals(params: {
  api: UseCodingDevProjectsResult
  /** 新建或打开成功后回调 */
  onProjectReady?: (project: CodingDevProject) => void | Promise<void>
  /** 移除成功后回调 */
  onRemoved?: (name: string) => void | Promise<void>
}): CodingDevProjectModalsApi {
  const { api, onProjectReady, onRemoved } = params
  const [nameDialog, setNameDialog] = useState<NameDialog>(null)
  const [removeDialog, setRemoveDialog] = useState<RemoveDialog>(null)

  const beginCreate = useCallback(() => {
    setNameDialog({ kind: 'create' })
  }, [])

  const beginOpen = useCallback(async () => {
    const picked = await api.pickExistingDirectory()
    if (!picked) return
    setNameDialog({ kind: 'open', targetPath: picked.path, defaultName: picked.defaultName })
  }, [api])

  const beginRemove = useCallback((name: string) => {
    const project = api.projects.find((p) => p.name === name)
    setRemoveDialog({ name, hint: getRemoveProjectHint(project, name) })
  }, [api.projects])

  /**
   * 名称弹窗确认：新建或挂载。
   */
  const handleNameConfirm = useCallback(async (name: string) => {
    const dialog = nameDialog
    setNameDialog(null)
    if (!dialog) return
    const project =
      dialog.kind === 'create'
        ? await api.createProject(name)
        : await api.openProject(name, dialog.targetPath)
    if (project) await onProjectReady?.(project)
  }, [nameDialog, api, onProjectReady])

  /**
   * 移除确认。
   */
  const handleRemoveConfirm = useCallback(async () => {
    const dialog = removeDialog
    setRemoveDialog(null)
    if (!dialog) return
    await api.remove(dialog.name)
    await onRemoved?.(dialog.name)
  }, [removeDialog, api, onRemoved])

  const modals = (
    <>
      <PromptInputModal
        open={nameDialog?.kind === 'create'}
        title="新建项目"
        description="将在工作空间 projects/ 下创建目录，并设为 ACP 活动项目。"
        placeholder="项目名称"
        confirmText="创建"
        onConfirm={(v) => void handleNameConfirm(v)}
        onCancel={() => setNameDialog(null)}
      />
      <PromptInputModal
        open={nameDialog?.kind === 'open'}
        title="打开已有项目"
        description="在 projects/ 下创建链接名（junction），指向所选目录。"
        placeholder="项目名称（链接名）"
        defaultValue={nameDialog?.kind === 'open' ? nameDialog.defaultName : ''}
        confirmText="挂载"
        onConfirm={(v) => void handleNameConfirm(v)}
        onCancel={() => setNameDialog(null)}
      />
      <ConfirmModal
        open={Boolean(removeDialog)}
        title="移除项目"
        content={removeDialog?.hint ?? ''}
        confirmText="移除"
        confirmVariant="danger"
        onConfirm={() => void handleRemoveConfirm()}
        onCancel={() => setRemoveDialog(null)}
      />
    </>
  )

  return { beginCreate, beginOpen, beginRemove, modals }
}
