/* eslint-disable @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentCore, ResponseChunk } from '@openagent/core'

// Mock grammy before importing the module under test
vi.mock('grammy', () => {
  const handlers: Map<string, Function> = new Map()
  const commandHandlers: Map<string, Function> = new Map()

  const mockApi = {
    getMe: vi.fn().mockResolvedValue({
      id: 123456,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    }),
  }

  const MockBot = vi.fn().mockImplementation(() => ({
    api: mockApi,
    command: vi.fn((cmd: string, handler: Function) => {
      commandHandlers.set(cmd, handler)
    }),
    on: vi.fn((filter: string, handler: Function) => {
      handlers.set(filter, handler)
    }),
    catch: vi.fn(),
    start: vi.fn(({ onStart }: { onStart?: () => void }) => {
      onStart?.()
    }),
    stop: vi.fn(),
    _handlers: handlers,
    _commandHandlers: commandHandlers,
  }))

  return {
    Bot: MockBot,
    GrammyError: class GrammyError extends Error {
      error_code: number
      description: string
      parameters?: { retry_after?: number }
      constructor(message: string, error_code: number = 400, description: string = message) {
        super(message)
        this.error_code = error_code
        this.description = description
      }
    },
    HttpError: class HttpError extends Error {
      constructor(message: string) {
        super(message)
      }
    },
  }
})

// Mock @openagent/core
vi.mock('@openagent/core', () => ({
  loadConfig: vi.fn().mockReturnValue({
    enabled: true,
    botToken: 'test-token-123',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  }),
}))

import { TelegramBot, createTelegramBot } from './bot.js'
import type { TelegramConfig } from './bot.js'
import { loadConfig } from '@openagent/core'

function createMockAgentCore(): AgentCore {
  return {
    sendMessage: vi.fn(),
    handleNewCommand: vi.fn(),
    resetSession: vi.fn(),
    abort: vi.fn(),
    getSessionManager: vi.fn(),
    refreshSystemPrompt: vi.fn(),
    getAgent: vi.fn(),
    dispose: vi.fn(),
  } as unknown as AgentCore
}

function createMockContext(overrides: Record<string, unknown> = {}) {
  return {
    from: {
      id: 12345,
      is_bot: false,
      first_name: 'John',
      last_name: 'Doe',
      username: 'johndoe',
    },
    chat: {
      id: 67890,
      type: 'private',
    },
    message: {
      text: 'Hello agent',
      message_id: 1,
    },
    reply: vi.fn().mockResolvedValue({}),
    replyWithChatAction: vi.fn().mockResolvedValue(true),
    ...overrides,
  }
}

type MockHandler = (ctx: ReturnType<typeof createMockContext>) => Promise<void>
type MockBotInternals = {
  _handlers: Map<string, MockHandler>
  _commandHandlers: Map<string, MockHandler>
}

const defaultConfig: TelegramConfig = {
  enabled: true,
  botToken: 'test-token-123',
  adminUserIds: [],
  pollingMode: true,
  webhookUrl: '',
  batchingDelayMs: 2500,
}

describe('TelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('throws when no bot token provided', () => {
      expect(() => new TelegramBot({
        agentCore,
        config: { ...defaultConfig, botToken: '' },
      })).toThrow('Telegram bot token not configured')
    })

    it('creates bot successfully with valid config', () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      expect(bot).toBeDefined()
      expect(bot.isRunning()).toBe(false)
    })
  })

  describe('start', () => {
    it('verifies token and starts polling', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()

      expect(bot.isRunning()).toBe(true)
      const underlying = bot.getBot() as any
      expect(underlying.api.getMe).toHaveBeenCalled()
      expect(underlying.start).toHaveBeenCalled()
    })
  })

  describe('stop', () => {
    it('stops the bot', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      await bot.start()
      await bot.stop()

      expect(bot.isRunning()).toBe(false)
    })
  })

  describe('/start command', () => {
    it('sends welcome message', async () => {
      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('start')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledTimes(1)
      const msg = ctx.reply.mock.calls[0][0] as string
      expect(msg).toContain('Welcome to OpenAgent')
      expect(msg).toContain('/new')
      expect(msg).toContain('/start')
    })
  })

  describe('/new command', () => {
    it('delegates to agent core handleNewCommand', async () => {
      vi.mocked(agentCore.handleNewCommand).mockResolvedValue('Session summary here')

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(agentCore.handleNewCommand).toHaveBeenCalledWith('telegram-12345')
      expect(ctx.reply).toHaveBeenCalledWith('📝 Session summarized and saved. Starting fresh conversation!')
    })

    it('sends fresh conversation message when no summary', async () => {
      vi.mocked(agentCore.handleNewCommand).mockResolvedValue(null)

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith('🔄 Starting fresh conversation!')
    })

    it('handles errors gracefully', async () => {
      vi.mocked(agentCore.handleNewCommand).mockRejectedValue(new Error('db error'))

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._commandHandlers.get('new')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith('⚠️ Error resetting session. Please try again.')
    })
  })

  describe('message handling', () => {
    it('routes messages to agent core with user context', async () => {
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Hello ' }
        yield { type: 'text', text: 'human!' }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(agentCore.sendMessage).toHaveBeenCalledWith(
        'telegram-12345',
        'Message from @johndoe (John Doe): Hello agent',
        'telegram'
      )
      // Response should be sent
      expect(ctx.reply).toHaveBeenCalledWith('Hello human!')
    })

    it('includes user context in group chats', async () => {
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: 'Response' }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext({
        chat: { id: 67890, type: 'group' },
      })
      await handler(ctx)

      const sentMessage = vi.mocked(agentCore.sendMessage).mock.calls[0][1]
      expect(sentMessage).toContain('Message from @johndoe (John Doe):')
    })

    it('handles empty responses gracefully', async () => {
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)

      // reply should only have typing action, no text reply
      expect(ctx.reply).not.toHaveBeenCalled()
    })

    it('handles agent errors gracefully', async () => {
      vi.mocked(agentCore.sendMessage).mockImplementation(() => {
        throw new Error('agent failed')
      })

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)

      expect(ctx.reply).toHaveBeenCalledWith(
        expect.stringContaining('encountered an error')
      )
    })
  })

  describe('message splitting', () => {
    it('splits messages longer than 4096 chars', async () => {
      const longText = 'A'.repeat(5000)
      async function* mockStream(): AsyncGenerator<ResponseChunk> {
        yield { type: 'text', text: longText }
        yield { type: 'done' }
      }
      vi.mocked(agentCore.sendMessage).mockReturnValue(mockStream())

      const bot = new TelegramBot({ agentCore, config: defaultConfig })
      const underlying = bot.getBot() as unknown as MockBotInternals
      const handler = underlying._handlers.get('message:text')!

      const ctx = createMockContext()
      await handler(ctx)

      // Should be split into multiple messages
      expect(ctx.reply.mock.calls.length).toBeGreaterThanOrEqual(2)

      // Reconstruct and verify all text is present
      const allText = ctx.reply.mock.calls.map((c: unknown[]) => c[0] as string).join('')
      expect(allText.length).toBe(5000)
    })
  })
})

describe('createTelegramBot', () => {
  let agentCore: AgentCore

  beforeEach(() => {
    agentCore = createMockAgentCore()
    vi.clearAllMocks()
  })

  it('returns null when disabled', () => {
    vi.mocked(loadConfig).mockReturnValue({
      enabled: false,
      botToken: 'some-token',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns null when no token', () => {
    vi.mocked(loadConfig).mockReturnValue({
      enabled: true,
      botToken: '',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })

  it('returns TelegramBot instance when configured', () => {
    vi.mocked(loadConfig).mockReturnValue({
      enabled: true,
      botToken: 'valid-token',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeInstanceOf(TelegramBot)
  })

  it('returns null when config load fails', () => {
    vi.mocked(loadConfig).mockImplementation(() => {
      throw new Error('file not found')
    })

    const result = createTelegramBot(agentCore)
    expect(result).toBeNull()
  })
})
