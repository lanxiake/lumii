/**
 * AppProviders - 所有 Context Provider 的包装器
 *
 * 将应用所需的所有上下文提供者集中管理，简化 App.tsx 的结构
 */

import React from 'react'
import { ThemeProvider } from './ThemeContext/ThemeContext'
import { SettingsProvider } from './SettingsContext/SettingsContext'
import { SkillsProvider } from './SkillsContext/SkillsContext'
import { PluginsProvider } from './PluginsContext/PluginsContext'
import { AppFontScaleProvider } from './AppFontScaleContext/AppFontScaleContext'
import { ToastProvider } from '../components/ui/Toast/ToastContainer'
import { SettingsHubProvider } from '../components/SettingsHub'

interface AppProvidersProps {
  children: React.ReactNode
}

/**
 * 应用上下文提供者组合
 * 按照依赖顺序排列：Settings -> Theme -> FontScale -> Skills -> Toast -> SettingsHub
 */
export const AppProviders: React.FC<AppProvidersProps> = ({ children }) => {
  return (
    <SettingsProvider>
      <ThemeProvider>
        <AppFontScaleProvider>
          <SkillsProvider>
            <PluginsProvider>
              <ToastProvider>
                <SettingsHubProvider>
                  {children}
                </SettingsHubProvider>
              </ToastProvider>
            </PluginsProvider>
          </SkillsProvider>
        </AppFontScaleProvider>
      </ThemeProvider>
    </SettingsProvider>
  )
}

export default AppProviders
