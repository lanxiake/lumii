import React from 'react'
import { ConfirmationDialog } from '../../../components/ConfirmationDialog'
import { InterruptBanner } from '../components/InterruptBanner'
import { VoiceCallPanel } from '../components/VoiceCallPanel'
import styles from '../ChatPage.module.css'

type VoiceCallPanelProps = React.ComponentProps<typeof VoiceCallPanel>

export interface ChatBottomOverlayProps {
  permission?: {
    description: string
    toolName: string
    timeoutMs?: number
  }
  permissionSessionKey?: string | null
  currentSessionKey: string | null
  onAllowOnce: () => void
  onAllowAlways: () => void
  onDeny: () => void
  interruptedSessionKey?: string | null
  onContinue: (sessionKey: string) => void | Promise<void>
  onDismiss: (sessionKey: string) => void | Promise<void>
  voice?: VoiceCallPanelProps
  input: React.ReactNode
}

export const ChatBottomOverlay: React.FC<ChatBottomOverlayProps> = ({
  permission,
  permissionSessionKey,
  currentSessionKey,
  onAllowOnce,
  onAllowAlways,
  onDeny,
  interruptedSessionKey,
  onContinue,
  onDismiss,
  voice,
  input,
}) => (
  <div className={styles['chat-overlay-bottom']}>
    {permission ? (
      <div className={styles['chat-inline-approval']}>
        <ConfirmationDialog
          open
          description={permission.description}
          toolName={permission.toolName}
          timeoutMs={permission.timeoutMs ?? 0}
          sessionHint={permissionSessionKey && permissionSessionKey !== currentSessionKey ? `来自后台会话：${permissionSessionKey}` : undefined}
          onAllowOnce={onAllowOnce}
          onAllowAlways={onAllowAlways}
          onDeny={onDeny}
        />
      </div>
    ) : null}
    {interruptedSessionKey ? (
      <InterruptBanner
        sessionKey={interruptedSessionKey}
        onContinue={(sessionKey) => Promise.resolve(onContinue(sessionKey))}
        onDismiss={onDismiss}
      />
    ) : null}
    {voice ? <VoiceCallPanel {...voice} /> : input}
  </div>
)
