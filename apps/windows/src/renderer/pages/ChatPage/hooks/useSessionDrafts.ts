import { useCallback, useState } from 'react'
import type { FileReference } from '../components/ChatInput'

/** Keeps message drafts and file references scoped to the active conversation. */
export function useSessionDrafts(sessionKey: string | null) {
  const [draftsBySession, setDraftsBySession] = useState<Record<string, string>>({})
  const [globalDraft, setGlobalDraft] = useState('')
  const [fileReferencesBySession, setFileReferencesBySession] = useState<Record<string, FileReference[]>>({})
  const fileReferenceKey = sessionKey ?? '__global__'

  const persistDraftForSession = useCallback((targetSessionKey: string | null, nextValue: string) => {
    if (!targetSessionKey) {
      setGlobalDraft((previous) => (previous === nextValue ? previous : nextValue))
      return
    }
    setDraftsBySession((previous) => (
      previous[targetSessionKey] === nextValue ? previous : { ...previous, [targetSessionKey]: nextValue }
    ))
  }, [])

  const setInputValue = useCallback((nextValue: string) => {
    persistDraftForSession(sessionKey, nextValue)
  }, [persistDraftForSession, sessionKey])

  const clearCurrentInputState = useCallback((targetSessionKey: string | null = sessionKey) => {
    const referenceKey = targetSessionKey ?? '__global__'
    if (!targetSessionKey) {
      setGlobalDraft('')
    } else {
      setDraftsBySession((previous) => ({ ...previous, [targetSessionKey]: '' }))
    }
    setFileReferencesBySession((previous) => ({ ...previous, [referenceKey]: [] }))
  }, [sessionKey])

  const addFileReference = useCallback((reference: FileReference) => {
    const referenceKey = sessionKey ?? '__global__'
    setFileReferencesBySession((previous) => {
      const references = previous[referenceKey] ?? []
      if (references.some((item) => item.absolutePath === reference.absolutePath)) return previous
      return { ...previous, [referenceKey]: [...references, reference] }
    })
  }, [sessionKey])

  const removeFileReference = useCallback((absolutePath: string) => {
    const referenceKey = sessionKey ?? '__global__'
    setFileReferencesBySession((previous) => ({
      ...previous,
      [referenceKey]: (previous[referenceKey] ?? []).filter((reference) => reference.absolutePath !== absolutePath),
    }))
  }, [sessionKey])

  return {
    inputValue: sessionKey ? (draftsBySession[sessionKey] ?? '') : globalDraft,
    activeFileReferences: fileReferencesBySession[fileReferenceKey] ?? [],
    setDraftsBySession,
    persistDraftForSession,
    setInputValue,
    clearCurrentInputState,
    addFileReference,
    removeFileReference,
  }
}
