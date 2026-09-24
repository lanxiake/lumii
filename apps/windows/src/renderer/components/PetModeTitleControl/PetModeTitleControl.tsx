/**
 * PetModeTitleControl — 标题栏上的宠物模式开关（放在「录屏」旁边）
 *
 * 为什么放这儿：进出宠物模式原先只有三个入口——设置页的按钮、托盘菜单、Ctrl+Shift+P，
 * 三个都不在视线里。想开宠物得先想起「去设置页里翻」，而它明明是个**开着还是关着**的
 * 状态，不是一次性的动作。标题栏是常驻的，状态与开关放一起最省事。
 *
 * ## 状态是主进程的，这里只是镜像
 *
 * 权威值在 `pet:mode`。挂载时 `getMode()` 取一次，之后靠 `pet-mode-changed` 广播跟进
 * ——托盘、快捷键、控制坞、设置页都会触发那条广播。不订阅的话，用 Ctrl+Shift+P 开的
 * 宠物模式，这个按钮会一直显示「打开」，成了个骗人的指示器。
 *
 * 点击后不再自己猜结果：`switchMode` 返回成功就乐观地翻一下（免得按钮比广播慢半拍），
 * 真正的值仍由广播纠正。
 */
import React, { useCallback, useEffect, useState } from 'react'
import { PawPrint } from 'lucide-react'
import { useToast } from '../ui/Toast/useToast'
import { useFeatureAvailability } from '../../hooks/business/useFeatureAvailability'
import { getPetMode, switchPetMode, subscribePetModeChanged } from '../../services/pet-service'
import styles from './PetModeTitleControl.module.css'

export const PetModeTitleControl: React.FC = () => {
  const toast = useToast()
  const { isAvailable, blockMessage } = useFeatureAvailability()
  // 屏蔽平台（pet:* handler 未注册）必须给出原因，不能点了才发现（D4）。
  // 只判 blocked、不等 ready：先亮后灰无害，反之会闪出没有原因的灰按钮。
  const blocked = !isAvailable('petMode')
  const [active, setActive] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void getPetMode().then((mode) => {
      if (alive && mode) setActive(mode === 'pet')
    })
    // 订阅本身返回退订函数，直接当 cleanup
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => subscribePetModeChanged((mode) => setActive(mode === 'pet')), [])

  const toggle = useCallback(async () => {
    if (blocked || busy) return
    setBusy(true)
    const target = active ? 'desktop' : 'pet'
    const verb = active ? '关闭' : '打开'
    try {
      const r = await switchPetMode(target)
      if (!r) {
        toast.error(`宠物模式接口不可用，无法${verb}`)
        return
      }
      if (!r.success) {
        toast.error(`${verb}宠物模式失败：${r.error ?? '未知错误'}`)
        return
      }
      setActive(target === 'pet')
    } catch (err) {
      toast.error(`${verb}宠物模式失败：${(err as Error).message}`)
    } finally {
      setBusy(false)
    }
  }, [active, blocked, busy, toast])

  const title = blocked
    ? (blockMessage('petMode') ?? '当前环境不支持宠物模式')
    : `${active ? '关闭' : '打开'}宠物模式（Ctrl+Shift+P）`

  return (
    <button
      type="button"
      className={`${styles.petBtn} ${active ? styles.petBtnOn : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={active}
      data-pet-mode={active ? 'on' : 'off'}
      disabled={blocked}
      onClick={() => void toggle()}
    >
      {/*
        图标用爪印而不是宠物头像：标题栏这个尺寸（14px）下，头像会糊成一团，
        而爪印的轮廓即使很小也认得出。开启时靠颜色区分（见 .petBtnOn），
        不额外加圆点——录屏按钮的计时文字已经是这一带的视觉重心了。
      */}
      <PawPrint size={14} strokeWidth={1.8} />
    </button>
  )
}
