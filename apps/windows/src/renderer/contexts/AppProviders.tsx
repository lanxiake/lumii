/**
 * AppProviders - 所有 Context Provider 的包装器
 *
 * 将应用所需的所有上下文提供者集中管理，简化 App.tsx 的结构
 */

import React from 'react'
import { AuthProvider } from './AuthContext/AuthContext'
import { ThemeProvider } from './ThemeContext/ThemeContext'
import { SettingsProvider } from './SettingsContext/SettingsContext'
import { SkillsProvider } from './SkillsContext/SkillsContext'
import { PluginsProvider } from './PluginsContext/PluginsContext'
import { ToastProvider } from '../components/ui/Toast/ToastContainer'

interface AppProvidersProps {
  children: React.ReactNode
}

/**
 * 应用上下文提供者组合
 * 按照依赖顺序排列：Auth -> Settings -> Theme -> Skills -> Toast
 */
export const AppProviders: React.FC<AppProvidersProps> = ({ children }) => {
  return (
    <AuthProvider>
      <SettingsProvider>
        <ThemeProvider>
          <SkillsProvider>
            <PluginsProvider>
              <ToastProvider>
                {children}
              </ToastProvider>
            </PluginsProvider>
          </SkillsProvider>
        </ThemeProvider>
      </SettingsProvider>
    </AuthProvider>
  )
}

export default AppProviders
