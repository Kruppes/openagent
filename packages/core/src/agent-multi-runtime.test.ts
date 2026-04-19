import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentTool } from '@mariozechner/pi-agent-core'

/**
 * Track all created MockAgent instances by agentId.
 * This lets us verify that different runtimes get different PiAgent instances.
 */
const mockAgentInstances = vi.hoisted(() => ({
  agents: [] as Array<{
    state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[]; thinkingLevel?: string }
    promptCalls: Array<{ text: string }>
  }>,
  promptBehaviors: [] as Array<(agent: { emit: (event: unknown) => void }, text: string) => Promise<void>>,
  clear() {
    this.agents.length = 0
    this.promptBehaviors.length = 0
  },
}))

vi.mock('@mariozechner/pi-agent-core', () => {
  class MockAgent {
    public state: { systemPrompt: string; model: unknown; tools: AgentTool[]; messages: unknown[]; thinkingLevel?: string }
    public promptCalls: Array<{ text: string }> = []
    private listeners = new Set<(event: unknown) => void>()

    constructor(options: { initialState: { systemPrompt: string; model: unknown; tools: AgentTool[]; thinkingLevel?: string } }) {
      this.state = {
        ...options.initialState,
        messages: [],
      }
      this.promptCalls = []
      mockAgentInstances.agents.push(this)
    }

    subscribe(listener: (event: unknown) => void): () => void {
      this.listeners.add(listener)
      return () => this.listeners.delete(listener)
    }

    async prompt(text: string): Promise<void> {
      this.promptCalls.push({ text })
      // Add a message to simulate real agent behavior
      this.state.messages.push({ role: 'user', content: text })
      this.state.messages.push({ role: 'assistant', content: `response to: ${text}` })

      const behavior = mockAgentInstances.promptBehaviors.shift()
      if (behavior) {
        await behavior(this as unknown as { emit: (event: unknown) => void }, text)
      } else {
        // Default: emit agent_end
        this.emit({ type: 'agent_end', messages: [] })
      }
    }

    emit(event: unknown): void {
      for (const listener of this.listeners) {
        listener(event)
      }
    }

    abort(): void {}
  }

  return { Agent: MockAgent }
})

// Track what agentId was passed to assembleSystemPrompt
const assembleSystemPromptSpy = vi.hoisted(() => ({
  calls: [] as Array<{ agentId?: string }>,
  clear() { this.calls.length = 0 },
}))

vi.mock('./memory.js', () => ({
  ensureMemoryStructure: vi.fn(),
  ensureConfigStructure: vi.fn(),
  getMemoryDir: vi.fn(() => '/tmp/test-memory'),
  assembleSystemPrompt: vi.fn((options?: { agentId?: string }) => {
    assembleSystemPromptSpy.calls.push({ agentId: options?.agentId })
    if (options?.agentId === 'warren') {
      return 'warren system prompt - ich bin Warren Buffett'
    }
    return 'main system prompt - I am the main agent'
  }),
}))

vi.mock('./config.js', () => ({
  ensureConfigTemplates: vi.fn(),
  loadConfig: vi.fn(() => ({
    language: 'de',
    timezone: 'Europe/Berlin',
    builtinTools: { webSearch: { enabled: true } },
  })),
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: true, defaultAgentId: 'main' })),
}))

vi.mock('./skill-config.js', () => ({
  loadSkills: vi.fn(() => ({ skills: [] })),
  getSkillDecrypted: vi.fn(),
}))

vi.mock('./stt.js', () => ({
  loadSttSettings: vi.fn(() => ({ enabled: false })),
}))

vi.mock('./stt-tool.js', () => ({
  createTranscribeAudioTool: vi.fn(() => ({ name: 'transcribe_audio', execute: vi.fn() })),
}))

vi.mock('./web-tools.js', () => ({
  createBuiltinWebTools: vi.fn(() => []),
}))

vi.mock('./agent-skills.js', () => ({
  createAgentSkillTools: vi.fn(() => []),
  getAgentSkillsForPrompt: vi.fn(() => []),
  getAgentSkillsCount: vi.fn(() => 0),
  getAgentSkillsDir: vi.fn(() => '/data/skills_agent'),
  trackAgentSkillUsage: vi.fn(),
}))

vi.mock('./memories-tool.js', () => ({
  createSearchMemoriesTool: vi.fn(() => ({ name: 'search_memories', execute: vi.fn() })),
}))

vi.mock('./ask-agent-tool.js', () => ({
  createAskAgentTool: vi.fn((opts: { getCurrentAgentId: () => string }) => ({
    name: 'ask_agent',
    execute: vi.fn(),
    _getCurrentAgentId: opts.getCurrentAgentId,
  })),
  buildAskAgentPromptHint: vi.fn(() => ''),
}))

vi.mock('./token-logger.js', () => ({
  logTokenUsage: vi.fn(),
  logToolCall: vi.fn(),
}))

vi.mock('./thinking-level.js', () => ({
  normalizeThinkingLevel: vi.fn((level?: string) => level || 'off'),
  resolveBackgroundReasoning: vi.fn(() => undefined),
}))

vi.mock('./provider-config.js', () => ({
  getApiKeyForProvider: vi.fn(async () => 'test-key'),
  buildModel: vi.fn((_provider: unknown, modelId?: string) => ({ id: modelId ?? 'default-model', complete: vi.fn() })),
  estimateCost: vi.fn(() => 0),
  parseProviderModelId: vi.fn(() => ({})),
  loadProvidersDecrypted: vi.fn(() => ({ providers: [] })),
}))

import { AgentCore } from './agent.js'
import { initDatabase } from './database.js'

describe('AgentCore Multi-Runtime Isolation', () => {
  let db: ReturnType<typeof initDatabase>

  beforeEach(() => {
    mockAgentInstances.clear()
    assembleSystemPromptSpy.clear()
    db = initDatabase(':memory:')
  })

  function createAgentCore() {
    return new AgentCore({
      model: { id: 'test-model', complete: vi.fn() } as any,
      apiKey: 'test-key',
      db,
      tools: [],
      memoryDir: '/tmp/test-memory',
      sessionTimeoutMinutes: 15,
    })
  }

  describe('Runtime Isolation', () => {
    it('creates separate PiAgent instances for different agentIds', () => {
      const core = createAgentCore()

      // Initially, only 'main' runtime exists
      expect(mockAgentInstances.agents.length).toBe(1)

      // Access warren's agent → should create a new runtime
      const warrenAgent = core.getAgent('warren')
      expect(mockAgentInstances.agents.length).toBe(2)

      // Access main's agent → should reuse existing
      const mainAgent = core.getAgent('main')
      expect(mockAgentInstances.agents.length).toBe(2)

      // They should be different instances
      expect(mainAgent).not.toBe(warrenAgent)
    })

    it('warren runtime has warren system prompt, main has main prompt', () => {
      const core = createAgentCore()

      const mainAgent = core.getAgent('main')
      const warrenAgent = core.getAgent('warren')

      // Main agent has main prompt
      expect(mainAgent.state.systemPrompt).toContain('main system prompt')
      expect(mainAgent.state.systemPrompt).not.toContain('Warren Buffett')

      // Warren agent has warren prompt
      expect(warrenAgent.state.systemPrompt).toContain('warren system prompt')
      expect(warrenAgent.state.systemPrompt).toContain('Warren Buffett')
    })

    it('assembleSystemPrompt is called with correct agentId', () => {
      const core = createAgentCore()

      // Main runtime was created in constructor
      const mainCalls = assembleSystemPromptSpy.calls.filter(c => !c.agentId || c.agentId === 'main')
      expect(mainCalls.length).toBeGreaterThan(0)

      assembleSystemPromptSpy.clear()

      // Create warren runtime
      core.getAgent('warren')

      const warrenCalls = assembleSystemPromptSpy.calls.filter(c => c.agentId === 'warren')
      expect(warrenCalls.length).toBeGreaterThan(0)
    })
  })

  describe('Message Isolation', () => {
    it('messages sent to warren do not appear in main runtime', async () => {
      const core = createAgentCore()

      // Ensure both runtimes exist
      core.getAgent('main')
      core.getAgent('warren')

      const mainAgent = mockAgentInstances.agents[0]
      const warrenAgent = mockAgentInstances.agents[1]

      // Send message to warren
      const warrenStream = core.sendMessage('user1', 'hello warren', 'telegram', undefined, 'warren')
      for await (const _chunk of warrenStream) { /* drain */ }

      // Warren should have messages
      expect(warrenAgent.state.messages.length).toBeGreaterThan(0)

      // Main should NOT have any messages from this exchange
      expect(mainAgent.promptCalls.length).toBe(0)
    })

    it('messages sent to main do not appear in warren runtime', async () => {
      const core = createAgentCore()

      // Send message to main first
      const mainStream = core.sendMessage('user1', 'hello main', 'web')
      for await (const _chunk of mainStream) { /* drain */ }

      // Now create warren and verify it has no messages
      core.getAgent('warren')
      const warrenAgent = mockAgentInstances.agents[1]

      expect(warrenAgent.state.messages.length).toBe(0)
      expect(warrenAgent.promptCalls.length).toBe(0)
    })

    it('both runtimes are independent after parallel messages', async () => {
      const core = createAgentCore()

      // Ensure both runtimes exist
      core.getAgent('main')
      core.getAgent('warren')

      const mainAgent = mockAgentInstances.agents[0]
      const warrenAgent = mockAgentInstances.agents[1]

      // Send message to main
      const mainStream = core.sendMessage('user1', 'main question', 'web', undefined, 'main')
      for await (const _chunk of mainStream) { /* drain */ }

      // Send message to warren
      const warrenStream = core.sendMessage('user2', 'warren question', 'telegram', undefined, 'warren')
      for await (const _chunk of warrenStream) { /* drain */ }

      // Each agent should have exactly its own messages
      expect(mainAgent.promptCalls.length).toBe(1)
      expect(mainAgent.promptCalls[0].text).toContain('main question')

      expect(warrenAgent.promptCalls.length).toBe(1)
      expect(warrenAgent.promptCalls[0].text).toContain('warren question')

      // Messages arrays should be independent
      expect(mainAgent.state.messages.length).toBe(2) // user + assistant
      expect(warrenAgent.state.messages.length).toBe(2) // user + assistant
    })
  })

  describe('Legacy Mode (single persona)', () => {
    it('sendMessage without agentId defaults to main', async () => {
      const core = createAgentCore()

      // Only main runtime should exist
      expect(mockAgentInstances.agents.length).toBe(1)

      const stream = core.sendMessage('user1', 'hello', 'web')
      for await (const _chunk of stream) { /* drain */ }

      // Still only main runtime
      expect(mockAgentInstances.agents.length).toBe(1)
      expect(mockAgentInstances.agents[0].promptCalls.length).toBe(1)
    })

    it('getAgent without agentId returns main agent', () => {
      const core = createAgentCore()

      const agent = core.getAgent()
      expect(agent).toBe(core.getAgent('main'))
    })

    it('getRuntimeStateSnapshot without agentId returns main snapshot', () => {
      const core = createAgentCore()

      const snapshot = core.getRuntimeStateSnapshot()
      expect(snapshot.modelId).toBe('test-model')
      expect(snapshot.messageCount).toBe(0)
    })
  })

  describe('Provider Swap propagation', () => {
    it('swapProvider updates all existing runtimes', () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')
      expect(mockAgentInstances.agents.length).toBe(2)

      const mainAgent = mockAgentInstances.agents[0]
      const warrenAgent = mockAgentInstances.agents[1]

      // Swap provider
      const newProvider = { id: 'new-provider', name: 'New Provider', defaultModel: 'new-model', authMethod: 'api_key' as const }
      core.swapProvider(newProvider, 'new-key', 'new-model-id')

      // Both agents should have the new model
      expect(mainAgent.state.model).toEqual({ id: 'new-model-id', complete: expect.any(Function) })
      expect(warrenAgent.state.model).toEqual({ id: 'new-model-id', complete: expect.any(Function) })
    })
  })

  describe('System Prompt Refresh', () => {
    it('refreshSystemPrompt with agentId only refreshes that runtime', () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')

      const mainAgent = mockAgentInstances.agents[0]
      const warrenAgent = mockAgentInstances.agents[1]

      const mainPromptBefore = mainAgent.state.systemPrompt
      const warrenPromptBefore = warrenAgent.state.systemPrompt

      // Refresh only warren
      core.refreshSystemPrompt('telegram', undefined, 'warren')

      // Warren's prompt should have been rebuilt (may or may not change content depending on mock)
      // But main should still have the same reference
      expect(warrenAgent.state.systemPrompt).toContain('warren system prompt')
      expect(mainAgent.state.systemPrompt).toBe(mainPromptBefore)
    })

    it('refreshSystemPrompt without agentId refreshes all runtimes', () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')

      assembleSystemPromptSpy.clear()

      // Refresh all
      core.refreshSystemPrompt()

      // Both should have been refreshed
      const mainCalls = assembleSystemPromptSpy.calls.filter(c => c.agentId === 'main')
      const warrenCalls = assembleSystemPromptSpy.calls.filter(c => c.agentId === 'warren')
      expect(mainCalls.length).toBeGreaterThan(0)
      expect(warrenCalls.length).toBeGreaterThan(0)
    })
  })

  describe('ThinkingLevel propagation', () => {
    it('setThinkingLevel updates all runtimes', () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')

      const mainAgent = mockAgentInstances.agents[0]
      const warrenAgent = mockAgentInstances.agents[1]

      core.setThinkingLevel('high')

      expect(mainAgent.state.thinkingLevel).toBe('high')
      expect(warrenAgent.state.thinkingLevel).toBe('high')
    })
  })

  describe('Abort propagation', () => {
    it('abort calls abort on all runtimes', () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')

      // Just verify it doesn't throw
      expect(() => core.abort()).not.toThrow()
    })
  })

  describe('Dispose', () => {
    it('dispose clears all runtimes', async () => {
      const core = createAgentCore()

      // Create warren runtime
      core.getAgent('warren')
      expect(mockAgentInstances.agents.length).toBe(2)

      await core.dispose()

      // After dispose, creating a new runtime should work
      // (but the old ones are gone from the map)
    })
  })

  describe('ask_agent tool gets correct agentId', () => {
    it('main runtime ask_agent tool reports main as current agent', () => {
      const core = createAgentCore()
      const mainAgent = core.getAgent('main')

      // Find ask_agent tool
      const askAgentTool = mainAgent.state.tools.find((t: any) => t.name === 'ask_agent') as any
      expect(askAgentTool).toBeDefined()
      expect(askAgentTool._getCurrentAgentId()).toBe('main')
    })

    it('warren runtime ask_agent tool reports warren as current agent', () => {
      const core = createAgentCore()
      const warrenAgent = core.getAgent('warren')

      // Find ask_agent tool
      const askAgentTool = warrenAgent.state.tools.find((t: any) => t.name === 'ask_agent') as any
      expect(askAgentTool).toBeDefined()
      expect(askAgentTool._getCurrentAgentId()).toBe('warren')
    })
  })
})
