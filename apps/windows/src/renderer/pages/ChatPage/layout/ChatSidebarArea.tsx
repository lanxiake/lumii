import React from 'react'
import { createPortal } from 'react-dom'
import { ChatSidebar } from '../components/ChatSidebar'

type SidebarProps = React.ComponentProps<typeof ChatSidebar>

export interface ChatSidebarAreaProps extends SidebarProps {
  slot: HTMLElement | null
}

/** Renders the chat session list into the application's outer sidebar slot. */
export const ChatSidebarArea: React.FC<ChatSidebarAreaProps> = ({ slot, ...sidebarProps }) => {
  if (!slot) return null
  return createPortal(<ChatSidebar {...sidebarProps} />, slot)
}
