import React from 'react'
import { Toast } from '../components/Toast'

type ToastProps = Omit<React.ComponentProps<typeof Toast>, 'onClose'>

export interface FloatingOverlaysProps {
  toast: ToastProps | null
  onCloseToast: () => void
}

/** Groups page-level notifications and modal dialogs outside the chat surface. */
export const FloatingOverlays: React.FC<FloatingOverlaysProps> = ({
  toast,
  onCloseToast,
}) => (
  <>
    {toast ? <Toast {...toast} onClose={onCloseToast} /> : null}
  </>
)
