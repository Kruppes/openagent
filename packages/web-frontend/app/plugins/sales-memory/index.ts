import type { OpenAgentFrontendPlugin } from '~/utils/pluginTypes'

const salesMemoryPlugin: OpenAgentFrontendPlugin = {
  id: 'sales-memory',
  name: 'SalesMemory',
  version: '1.0.0',
  description: 'Persistent memory with FTS5 search and LLM-powered recall. Automatically injects relevant context from past conversations.',
  configurable: true,
  slots: {},
}

export default salesMemoryPlugin
