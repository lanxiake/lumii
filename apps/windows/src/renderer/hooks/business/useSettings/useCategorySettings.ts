/**
 * useCategorySettings - Category-level settings save hook
 * 
 * Provides independent save state management for each settings category
 */
import { useState, useCallback, useMemo } from 'react'

interface UseCategorySettingsOptions<T> {
  /** Category name (for logging) */
  category: string
  /** Get current value */
  getCurrentValue: () => T
  /** Get saved value */
  getSavedValue: () => T
  /** Save callback */
  onSave: (value: T) => Promise<void>
}

interface UseCategorySettingsReturn {
  /** Has unsaved changes */
  hasChanges: boolean
  /** Is saving */
  isSaving: boolean
  /** Save status */
  saveStatus: 'idle' | 'saved' | 'error'
  /** Save function */
  save: () => Promise<void>
}

export function useCategorySettings<T>(
  options: UseCategorySettingsOptions<T>
): UseCategorySettingsReturn {
  const { category, getCurrentValue, getSavedValue, onSave } = options
  
  const [isSaving, setIsSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  
  // Calculate if there are changes
  const hasChanges = useMemo(() => {
    const current = JSON.stringify(getCurrentValue())
    const saved = JSON.stringify(getSavedValue())
    return current !== saved
  }, [getCurrentValue, getSavedValue])
  
  // Save function
  const save = useCallback(async () => {
    console.log(`[useCategorySettings] Saving ${category} settings`)
    setIsSaving(true)
    setSaveStatus('idle')
    
    try {
      const value = getCurrentValue()
      await onSave(value)
      setSaveStatus('saved')
      console.log(`[useCategorySettings] ${category} settings saved successfully`)
      
      // Reset status after 2 seconds
      setTimeout(() => {
        setSaveStatus('idle')
      }, 2000)
    } catch (err) {
      console.error(`[useCategorySettings] ${category} settings save failed:`, err)
      setSaveStatus('error')
      
      // Reset status after 3 seconds
      setTimeout(() => {
        setSaveStatus('idle')
      }, 3000)
    } finally {
      setIsSaving(false)
    }
  }, [category, getCurrentValue, onSave])
  
  return {
    hasChanges,
    isSaving,
    saveStatus,
    save,
  }
}
