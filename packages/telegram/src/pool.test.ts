import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AgentCore } from '@openagent/core'

// Mock grammy before importing the module under test
vi.mock('grammy', () => {
  const mockApi = {
    getMe: vi.fn().mockResolvedValue({
      id: 123456,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    setMyCommands: vi.fn().mockResolvedValue(true),
  }

  const MockBot = vi.fn().mockImplementation(() => ({
    api: mockApi,
    command: vi.fn(),
    on: vi.fn(),
    callbackQuery: vi.fn(),
    catch: vi.fn(),
    start: vi.fn(({ onStart }: { onStart?: () => void }) => {
      onStart?.()
    }),
    stop: vi.fn(),
  }))

  return {
    Bot: MockBot,
    InputFile: vi.fn(),
    GrammyError: class GrammyError extends Error {
      error_code: number
      description: string
      constructor(message: string, error_code: number, description: string) {
        super(message)
        this.error_code = error_code
        this.description = description
      }
    },
    HttpError: class HttpError extends Error {},
  }
})

// Mock @openagent/core
vi.mock('@openagent/core', async () => {
  let mockMultiPersonaEnabled = false
  let mockTelegramConfig: Record<string, unknown> = {
    enabled: false,
    botToken: '',
    adminUserIds: [],
    pollingMode: true,
    webhookUrl: '',
    batchingDelayMs: 2500,
  }

  return {
    loadConfig: vi.fn((filename: string) => {
      if (filename === 'telegram.json') return { ...mockTelegramConfig }
      if (filename === 'settings.json') return {
        multiPersona: {
          enabled: mockMultiPersonaEnabled,
          defaultAgentId: 'main',
        },
      }
      return {}
    }),
    loadMultiPersonaSettings: vi.fn(() => ({
      enabled: mockMultiPersonaEnabled,
      defaultAgentId: 'main',
    })),
    loadSttSettings: vi.fn().mockReturnValue({ enabled: false }),
    loadProviders: vi.fn().mockReturnValue({ providers: [], activeProvider: null }),
    saveUpload: vi.fn(),
    serializeUploadsMetadata: vi.fn().mockReturnValue(''),
    parseUploadsMetadata: vi.fn().mockReturnValue([]),
    transcribeAudio: vi.fn(),
    setActiveProvider: vi.fn(),
    updateProvider: vi.fn(),
    setActiveModel: vi.fn(),
    getActiveModelId: vi.fn(),
    // Expose helpers to change mock state during tests
    _setMultiPersonaEnabled: (enabled: boolean) => { mockMultiPersonaEnabled = enabled },
    _setTelegramConfig: (config: Record<string, unknown>) => { mockTelegramConfig = config },
  }
})

import { normalizeToPoolConfig, TelegramBotPool } from './pool.js'
import { loadConfig, loadMultiPersonaSettings } from '@openagent/core'

// Access mock helpers
const coreMock = await import('@openagent/core') as unknown as {
  _setMultiPersonaEnabled: (enabled: boolean) => void
  _setTelegramConfig: (config: Record<string, unknown>) => void
}

function createMockAgentCore(): AgentCore {
  return {
    sendMessage: vi.fn(),
    getSessionManager: vi.fn().mockReturnValue({
      getOrCreateSession: vi.fn().mockReturnValue({ id: 'test-session' }),
    }),
    abort: vi.fn(),
    handleNewCommand: vi.fn(),
  } as unknown as AgentCore
}

describe('normalizeToPoolConfig', () => {
  beforeEach(() => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: false,
      botToken: '',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })
    vi.clearAllMocks()
  })

  it('returns empty accounts when telegram is disabled (v1, feature off)', () => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: false,
      botToken: '',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const config = normalizeToPoolConfig()
    expect(Object.keys(config.accounts)).toHaveLength(0)
  })

  it('normalizes v1 config to single main account (feature off)', () => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: true,
      botToken: 'test-token-123',
      adminUserIds: [12345],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 3000,
    })

    const config = normalizeToPoolConfig()
    expect(Object.keys(config.accounts)).toHaveLength(1)
    expect(config.accounts.main).toEqual({
      botToken: 'test-token-123',
      agentId: 'main',
      adminUserIds: [12345],
      enabled: true,
    })
    expect(config.batchingDelayMs).toBe(3000)
  })

  it('ignores accounts block when multiPersona is disabled', () => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: true,
      botToken: 'main-token',
      adminUserIds: [111],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
      accounts: {
        main: { botToken: 'main-token', agentId: 'main', adminUserIds: [111] },
        warren: { botToken: 'warren-token', agentId: 'warren', adminUserIds: [222] },
      },
    })

    const config = normalizeToPoolConfig()
    // Should use v1 path even though accounts block exists
    expect(Object.keys(config.accounts)).toHaveLength(1)
    expect(config.accounts.main.botToken).toBe('main-token')
  })

  it('uses accounts block when multiPersona is enabled', () => {
    coreMock._setMultiPersonaEnabled(true)
    coreMock._setTelegramConfig({
      enabled: true,
      botToken: 'main-token',
      adminUserIds: [111],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
      accounts: {
        main: { botToken: 'main-token', agentId: 'main', adminUserIds: [111] },
        warren: { botToken: 'warren-token', agentId: 'warren', adminUserIds: [222] },
      },
    })

    const config = normalizeToPoolConfig()
    expect(Object.keys(config.accounts)).toHaveLength(2)
    expect(config.accounts.main.botToken).toBe('main-token')
    expect(config.accounts.warren.botToken).toBe('warren-token')
    expect(config.accounts.warren.agentId).toBe('warren')
  })
})

describe('TelegramBotPool', () => {
  beforeEach(() => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: false,
      botToken: '',
      adminUserIds: [],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })
    vi.clearAllMocks()
  })

  it('starts no bots when telegram is disabled', async () => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: false,
      botToken: '',
    })

    const pool = new TelegramBotPool({
      agentCore: createMockAgentCore(),
    })

    await pool.start()
    expect(pool.hasRunningBots()).toBe(false)
    expect(pool.getPrimaryBot()).toBeNull()
    await pool.stop()
  })

  it('starts single bot in legacy mode', async () => {
    coreMock._setMultiPersonaEnabled(false)
    coreMock._setTelegramConfig({
      enabled: true,
      botToken: 'test-token',
      adminUserIds: [12345],
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
    })

    const pool = new TelegramBotPool({
      agentCore: createMockAgentCore(),
    })

    await pool.start()
    expect(pool.hasRunningBots()).toBe(true)

    const mainBot = pool.getBot('main')
    expect(mainBot).not.toBeNull()
    expect(mainBot!.getAgentId()).toBe('main')

    const primaryBot = pool.getPrimaryBot()
    expect(primaryBot).toBe(mainBot)

    await pool.stop()
    expect(pool.hasRunningBots()).toBe(false)
  })

  it('starts multiple bots in multi-persona mode', async () => {
    coreMock._setMultiPersonaEnabled(true)
    coreMock._setTelegramConfig({
      enabled: true,
      botToken: 'main-token',
      pollingMode: true,
      webhookUrl: '',
      batchingDelayMs: 2500,
      accounts: {
        main: { botToken: 'main-token', agentId: 'main', adminUserIds: [111] },
        warren: { botToken: 'warren-token', agentId: 'warren', adminUserIds: [222] },
      },
    })

    const pool = new TelegramBotPool({
      agentCore: createMockAgentCore(),
    })

    await pool.start()
    expect(pool.hasRunningBots()).toBe(true)

    const mainBot = pool.getBot('main')
    expect(mainBot).not.toBeNull()
    expect(mainBot!.getAgentId()).toBe('main')

    const warrenBot = pool.getBot('warren')
    expect(warrenBot).not.toBeNull()
    expect(warrenBot!.getAgentId()).toBe('warren')

    const allBots = pool.getAllBots()
    expect(allBots.size).toBe(2)

    await pool.stop()
    expect(pool.hasRunningBots()).toBe(false)
  })

  it('skips disabled accounts', async () => {
    coreMock._setMultiPersonaEnabled(true)
    coreMock._setTelegramConfig({
      pollingMode: true,
      batchingDelayMs: 2500,
      accounts: {
        main: { botToken: 'main-token', agentId: 'main', adminUserIds: [111] },
        warren: { botToken: 'warren-token', agentId: 'warren', adminUserIds: [222], enabled: false },
      },
    })

    const pool = new TelegramBotPool({
      agentCore: createMockAgentCore(),
    })

    await pool.start()
    expect(pool.getBot('main')).not.toBeNull()
    expect(pool.getBot('warren')).toBeNull()

    await pool.stop()
  })

  it('provides backwards-compatible getPrimaryBot()', async () => {
    coreMock._setMultiPersonaEnabled(true)
    coreMock._setTelegramConfig({
      pollingMode: true,
      batchingDelayMs: 2500,
      accounts: {
        warren: { botToken: 'warren-token', agentId: 'warren', adminUserIds: [222] },
      },
    })

    const pool = new TelegramBotPool({
      agentCore: createMockAgentCore(),
    })

    await pool.start()
    // No 'main' bot, but getPrimaryBot should return the first available
    const primary = pool.getPrimaryBot()
    expect(primary).not.toBeNull()
    expect(primary!.getAgentId()).toBe('warren')

    await pool.stop()
  })
})
