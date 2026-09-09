/**
 * ExperimentalSection - 实验功能设置
 *
 * 自主进化页面入口。工具进化已移至「工具」菜单（含功能开关与审批管理）。
 */

import React from 'react'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './ExperimentalSection.module.css'

export function ExperimentalSection() {
  return (
    <div className={styles.wrap}>
      <div className={settingsStyles['autonomous-embed']}>
        <AutonomousPage embedded />
      </div>
    </div>
  )
}
