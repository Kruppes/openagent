import type { Component } from 'vue'

export interface OpenAgentFrontendPlugin {
  /** Unique identifier for the plugin (used for enable/disable state) */
  id: string
  name: string
  version?: string
  description?: string
  /** Whether this plugin has a settings modal (shows gear icon on /plugins page) */
  configurable?: boolean
  slots: Partial<{
    /** Components rendered next to the send button in the chat input area */
    'chat-input-actions': Component
  }>
}
