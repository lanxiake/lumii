import React, { createContext, useContext } from 'react'
import { usePlugins } from '../../hooks/business/usePlugins/usePlugins'
import type { UsePluginsResult } from '../../hooks/business/usePlugins/usePlugins'

const PluginsContext = createContext<UsePluginsResult | null>(null)

export const PluginsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const plugins = usePlugins()
  return <PluginsContext.Provider value={plugins}>{children}</PluginsContext.Provider>
}

export function usePluginsContext(): UsePluginsResult {
  const ctx = useContext(PluginsContext)
  if (!ctx) throw new Error('usePluginsContext must be used within PluginsProvider')
  return ctx
}
