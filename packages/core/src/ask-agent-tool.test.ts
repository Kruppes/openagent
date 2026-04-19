import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

vi.mock('./config.js', () => ({
  loadMultiPersonaSettings: vi.fn(() => ({ enabled: true, defaultAgentId: 'main' })),
  loadConfig: vi.fn(() => ({})),
  getConfigDir: vi.fn(() => '/tmp/config'),
}))

import { completeSimple } from '@mariozechner/pi-ai'
import { createAskAgentTool, listAvailableAgents, buildAskAgentPromptHint } from './ask-agent-tool.js'
import type { AskAgentToolOptions } from './ask-agent-tool.js'

const mockCompleteSimple = vi.mocked(completeSimple)

function makeModel() {
  return {
    id: 'gpt-4o-mini',
    name: 'GPT-4o mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text' as const, 'image' as const],
    cost: { input: 0.15, output: 0.6, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  }
}

function makeResponse(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    usage: {
      input: 100,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 140,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    model: 'gpt-4o-mini',
    api: 'openai-completions' as const,
    provider: 'openai',
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

describe('ask-agent-tool', () => {
  let tmpDir: string
  let agentsDir: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `openagent-ask-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    agentsDir = path.join(tmpDir, 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    mockCompleteSimple.mockReset()
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function createOptions(overrides: Partial<AskAgentToolOptions> = {}): AskAgentToolOptions {
    return {
      getCurrentAgentId: () => 'main',
      getModel: () => makeModel(),
      getApiKey: () => 'test-key',
      ...overrides,
    }
  }

  describe('createAskAgentTool', () => {
    it('has correct name and description', () => {
      const tool = createAskAgentTool(createOptions())
      expect(tool.name).toBe('ask_agent')
      expect(tool.description).toContain('Ask another persona agent')
    })

    it('successfully queries a target agent with persona files', async () => {
      // Create a persona directory for "gekko"
      const gekkoDir = path.join(agentsDir, 'gekko')
      fs.mkdirSync(gekkoDir, { recursive: true })
      fs.writeFileSync(path.join(gekkoDir, 'SOUL.md'), '# Gekko\nYou are a financial trading expert.', 'utf-8')
      fs.writeFileSync(path.join(gekkoDir, 'IDENTITY.md'), 'I am Gekko, a Wall Street trader.', 'utf-8')

      // Set DATA_DIR for persona-loader
      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        mockCompleteSimple.mockResolvedValueOnce(makeResponse('NVDA looks strong. Buy signal based on RSI and MACD convergence.'))

        const tool = createAskAgentTool(createOptions())
        const result = await tool.execute('call-1', { agent_id: 'gekko', question: 'What do you think about NVDA?' })

        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining('NVDA looks strong'),
        })
        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining('[Response from gekko]'),
        })

        // Verify the LLM was called with persona-based system prompt
        const [, prompt] = mockCompleteSimple.mock.calls[0]
        expect(prompt.systemPrompt).toContain('financial trading expert')
        expect(prompt.systemPrompt).toContain('Gekko')
        expect(prompt.messages[0].content).toBe('What do you think about NVDA?')
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })

    it('returns error for non-existent agent', async () => {
      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        const tool = createAskAgentTool(createOptions())
        const result = await tool.execute('call-1', { agent_id: 'nonexistent', question: 'Hello?' })

        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining("Agent 'nonexistent' is not configured"),
        })
        expect(result.details).toEqual({ error: true, reason: 'not_found' })
        expect(mockCompleteSimple).not.toHaveBeenCalled()
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })

    it('returns error for self-query', async () => {
      const tool = createAskAgentTool(createOptions({
        getCurrentAgentId: () => 'warren',
      }))

      const result = await tool.execute('call-1', { agent_id: 'warren', question: 'Hello?' })

      expect(result.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining("Cannot ask yourself"),
      })
      expect(result.details).toEqual({ error: true, reason: 'self_query' })
      expect(mockCompleteSimple).not.toHaveBeenCalled()
    })

    it('returns error when call depth exceeds maximum', async () => {
      const tool = createAskAgentTool(createOptions({
        getCurrentAgentId: () => 'agent3',
        callChain: ['agent1', 'agent2'],
      }))

      const result = await tool.execute('call-1', { agent_id: 'agent4', question: 'Hello?' })

      expect(result.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('Maximum cross-agent call depth (3) exceeded'),
      })
      expect(result.details).toEqual({
        error: true,
        reason: 'max_depth',
        callChain: ['agent1', 'agent2', 'agent3'],
      })
    })

    it('returns error for circular calls (A→B→A)', async () => {
      const tool = createAskAgentTool(createOptions({
        getCurrentAgentId: () => 'warren',
        callChain: ['main'],
      }))

      const result = await tool.execute('call-1', { agent_id: 'main', question: 'Hello?' })

      expect(result.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining("Agent 'main' is already in the call chain"),
      })
      expect(result.details).toEqual({
        error: true,
        reason: 'circular',
        callChain: ['main', 'warren'],
      })
    })

    it('handles LLM errors gracefully', async () => {
      const gekkoDir = path.join(agentsDir, 'gekko')
      fs.mkdirSync(gekkoDir, { recursive: true })
      fs.writeFileSync(path.join(gekkoDir, 'SOUL.md'), '# Gekko', 'utf-8')

      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        mockCompleteSimple.mockRejectedValueOnce(new Error('API rate limited'))

        const tool = createAskAgentTool(createOptions())
        const result = await tool.execute('call-1', { agent_id: 'gekko', question: 'Test?' })

        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining("Error querying agent 'gekko': API rate limited"),
        })
        expect(result.details).toEqual({ error: true, targetAgentId: 'gekko' })
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })

    it('returns error for empty agent_id', async () => {
      const tool = createAskAgentTool(createOptions())
      const result = await tool.execute('call-1', { agent_id: '', question: 'Hello?' })

      expect(result.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('agent_id is required'),
      })
    })

    it('returns error for empty question', async () => {
      const tool = createAskAgentTool(createOptions())
      const result = await tool.execute('call-1', { agent_id: 'gekko', question: '' })

      expect(result.content[0]).toEqual({
        type: 'text',
        text: expect.stringContaining('question must be a non-empty string'),
      })
    })

    it('disables reasoning for cross-persona calls (reasoning=undefined)', async () => {
      const gekkoDir = path.join(agentsDir, 'gekko')
      fs.mkdirSync(gekkoDir, { recursive: true })
      fs.writeFileSync(path.join(gekkoDir, 'SOUL.md'), '# Gekko', 'utf-8')

      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        mockCompleteSimple.mockResolvedValueOnce(makeResponse('Test response'))

        const tool = createAskAgentTool(createOptions())
        await tool.execute('call-1', { agent_id: 'gekko', question: 'Test?' })

        // Verify reasoning is explicitly set to undefined (disabled)
        const [, , options] = mockCompleteSimple.mock.calls[0]
        expect(options).toBeDefined()
        expect(options!.reasoning).toBeUndefined()
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })

    it('falls back to thinking content when text blocks are empty', async () => {
      const gekkoDir = path.join(agentsDir, 'gekko')
      fs.mkdirSync(gekkoDir, { recursive: true })
      fs.writeFileSync(path.join(gekkoDir, 'SOUL.md'), '# Gekko', 'utf-8')

      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        // Simulate a reasoning model that only returns thinking blocks, no text
        mockCompleteSimple.mockResolvedValueOnce({
          role: 'assistant' as const,
          content: [
            { type: 'thinking' as const, thinking: 'The user asks about NVDA. Based on my analysis, NVDA looks bullish.' },
          ],
          usage: {
            input: 100,
            output: 40,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 140,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          model: 'claude-opus-4',
          api: 'anthropic' as const,
          provider: 'anthropic',
          stopReason: 'stop' as const,
          timestamp: Date.now(),
        })

        const tool = createAskAgentTool(createOptions())
        const result = await tool.execute('call-1', { agent_id: 'gekko', question: 'What about NVDA?' })

        // Should use thinking content as fallback
        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining('NVDA looks bullish'),
        })
        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining('[Response from gekko]'),
        })
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })

    it('returns empty response when both text and thinking are empty', async () => {
      const gekkoDir = path.join(agentsDir, 'gekko')
      fs.mkdirSync(gekkoDir, { recursive: true })
      fs.writeFileSync(path.join(gekkoDir, 'SOUL.md'), '# Gekko', 'utf-8')

      const originalDataDir = process.env.DATA_DIR
      process.env.DATA_DIR = tmpDir

      try {
        // Simulate completely empty response
        mockCompleteSimple.mockResolvedValueOnce({
          role: 'assistant' as const,
          content: [],
          usage: {
            input: 100, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 100,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          model: 'gpt-4o-mini',
          api: 'openai-completions' as const,
          provider: 'openai',
          stopReason: 'stop' as const,
          timestamp: Date.now(),
        })

        const tool = createAskAgentTool(createOptions())
        const result = await tool.execute('call-1', { agent_id: 'gekko', question: 'Hello?' })

        expect(result.content[0]).toEqual({
          type: 'text',
          text: expect.stringContaining('returned an empty response'),
        })
        expect(result.details).toEqual({ targetAgentId: 'gekko', empty: true })
      } finally {
        if (originalDataDir !== undefined) {
          process.env.DATA_DIR = originalDataDir
        } else {
          delete process.env.DATA_DIR
        }
      }
    })
  })

  describe('listAvailableAgents', () => {
    it('returns main when agents directory is empty', () => {
      const agents = listAvailableAgents(agentsDir)
      expect(agents).toEqual(['main'])
    })

    it('lists available agent directories', () => {
      fs.mkdirSync(path.join(agentsDir, 'warren'), { recursive: true })
      fs.mkdirSync(path.join(agentsDir, 'gekko'), { recursive: true })

      const agents = listAvailableAgents(agentsDir)
      expect(agents).toContain('main')
      expect(agents).toContain('warren')
      expect(agents).toContain('gekko')
    })

    it('ignores files (only directories)', () => {
      fs.mkdirSync(path.join(agentsDir, 'warren'), { recursive: true })
      fs.writeFileSync(path.join(agentsDir, 'README.md'), 'test', 'utf-8')

      const agents = listAvailableAgents(agentsDir)
      expect(agents).toEqual(['main', 'warren'])
    })

    it('returns main when directory does not exist', () => {
      const agents = listAvailableAgents('/nonexistent/path')
      expect(agents).toEqual(['main'])
    })
  })

  describe('buildAskAgentPromptHint', () => {
    it('lists other agents excluding current', () => {
      fs.mkdirSync(path.join(agentsDir, 'warren'), { recursive: true })
      fs.mkdirSync(path.join(agentsDir, 'gekko'), { recursive: true })

      const hint = buildAskAgentPromptHint('main', agentsDir)
      expect(hint).toContain('warren')
      expect(hint).toContain('gekko')
      expect(hint).toContain('ask_agent')
      expect(hint).not.toContain(': main')
    })

    it('returns empty string when no other agents exist', () => {
      const hint = buildAskAgentPromptHint('main', agentsDir)
      expect(hint).toBe('')
    })

    it('excludes the current agent from the list', () => {
      fs.mkdirSync(path.join(agentsDir, 'warren'), { recursive: true })

      const hint = buildAskAgentPromptHint('warren', agentsDir)
      expect(hint).toContain('main')
      expect(hint).not.toContain(': warren')
    })
  })
})
