import { describe, expect, it } from 'vitest'
import {
  mergeAgentHeartbeat,
  mergeConsolidation,
  mergeFactExtraction,
  mergeHealthMonitor,
  mergeMultiPersona,
  mergeStt,
  mergeTasks,
  mergeTts,
  normalizeSettingsPayload,
  validateEnum,
  validateHour,
  validateNonEmptyString,
  validateNonNegativeNumber,
  validatePositiveNumber,
} from './schema.js'

describe('settings schema', () => {
  it('supports legacy healthMonitor interval payloads', () => {
    expect(normalizeSettingsPayload({
      healthMonitor: {
        intervalMinutes: 11,
      },
    })).toEqual({
      healthMonitor: {
        intervalMinutes: 11,
      },
      healthMonitorIntervalMinutes: 11,
    })
  })

  it('validates scalar helper primitives', () => {
    expect(validatePositiveNumber(0, 'sessionTimeoutMinutes')).toBe('sessionTimeoutMinutes must be a positive number')
    expect(validatePositiveNumber(5, 'sessionTimeoutMinutes')).toBeNull()

    expect(validateNonNegativeNumber(-1, 'batchingDelayMs')).toBe('batchingDelayMs must be a non-negative number')
    expect(validateNonNegativeNumber(0, 'batchingDelayMs')).toBeNull()

    expect(validateHour(24, 'agentHeartbeat.nightMode.endHour')).toBe('agentHeartbeat.nightMode.endHour must be an integer 0-23')
    expect(validateHour(3, 'agentHeartbeat.nightMode.endHour')).toBeNull()

    expect(validateNonEmptyString('', 'language')).toBe('language must be a non-empty string')
    expect(validateNonEmptyString('German', 'language')).toBeNull()

    expect(validateEnum('invalid', ['a', 'b'], 'field')).toBe('field must be "a" or "b"')
    expect(validateEnum('a', ['a', 'b'], 'field')).toBeNull()
  })

  it('merges health monitor settings and validates fallback trigger', () => {
    const settingsRaw: Record<string, unknown> = {}

    const invalid = mergeHealthMonitor({ healthMonitor: { fallbackTrigger: 'invalid' } }, settingsRaw)
    expect(invalid).toEqual({
      error: 'healthMonitor.fallbackTrigger must be "down" or "degraded"',
      changed: false,
    })

    const valid = mergeHealthMonitor({
      healthMonitor: {
        fallbackTrigger: 'degraded',
        notifications: { degradedToDown: false },
      },
    }, settingsRaw)

    expect(valid).toEqual({ error: null, changed: true })
    expect(settingsRaw.healthMonitor).toEqual({
      fallbackTrigger: 'degraded',
      notifications: { degradedToDown: false },
    })
  })

  it('merges nested settings groups with boundary validation', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeConsolidation({ memoryConsolidation: { lookbackDays: 0 } }, settingsRaw)).toEqual({
      error: 'memoryConsolidation.lookbackDays must be an integer 1-30',
      changed: false,
    })

    expect(mergeFactExtraction({ factExtraction: { minSessionMessages: 5 } }, settingsRaw)).toEqual({
      error: null,
      changed: true,
    })

    expect(mergeAgentHeartbeat({
      agentHeartbeat: {
        nightMode: {
          startHour: 40,
        },
      },
    }, settingsRaw)).toEqual({
      error: 'agentHeartbeat.nightMode.startHour must be an integer 0-23',
      changed: false,
    })

    expect((settingsRaw.factExtraction as Record<string, unknown>).minSessionMessages).toBe(5)
  })

  it('validates tasks, tts, and stt payload fragments', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeTasks({ tasks: { telegramDelivery: 'never' } }, settingsRaw)).toEqual({
      error: 'tasks.telegramDelivery must be "auto" or "always"',
    })

    expect(mergeTts({ tts: { openaiVoice: '' } }, settingsRaw)).toEqual({
      error: 'tts.openaiVoice must be a non-empty string',
    })

    expect(mergeStt({ stt: { rewrite: { providerId: 42 } } }, settingsRaw)).toEqual({
      error: 'stt.rewrite.providerId must be a string',
    })
  })

  it('validates tasks.backgroundThinkingLevel against the enum', () => {
    const settingsRaw: Record<string, unknown> = {}

    expect(mergeTasks({ tasks: { backgroundThinkingLevel: 'extreme' } }, settingsRaw)).toEqual({
      error: 'tasks.backgroundThinkingLevel must be "off" or "minimal" or "low" or "medium" or "high" or "xhigh"',
    })

    expect(mergeTasks({ tasks: { backgroundThinkingLevel: 'medium' } }, settingsRaw)).toEqual({
      error: null,
    })
    expect((settingsRaw.tasks as Record<string, unknown>).backgroundThinkingLevel).toBe('medium')
  })

  it('merges multiPersona settings with validation', () => {
    const settingsRaw: Record<string, unknown> = {}

    // No input → no change
    expect(mergeMultiPersona({}, settingsRaw)).toEqual({ error: null, changed: false })

    // Enable
    expect(mergeMultiPersona({ multiPersona: { enabled: true } }, settingsRaw)).toEqual({ error: null, changed: true })
    expect((settingsRaw.multiPersona as Record<string, unknown>).enabled).toBe(true)

    // Valid defaultAgentId
    expect(mergeMultiPersona({ multiPersona: { defaultAgentId: 'warren' } }, settingsRaw)).toEqual({ error: null, changed: true })
    expect((settingsRaw.multiPersona as Record<string, unknown>).defaultAgentId).toBe('warren')

    // Invalid defaultAgentId (empty)
    expect(mergeMultiPersona({ multiPersona: { defaultAgentId: '' } }, settingsRaw)).toEqual({
      error: 'multiPersona.defaultAgentId must be a non-empty string',
      changed: false,
    })

    // Invalid defaultAgentId (uppercase)
    expect(mergeMultiPersona({ multiPersona: { defaultAgentId: 'Warren' } }, settingsRaw)).toEqual({
      error: 'multiPersona.defaultAgentId must be lowercase alphanumeric (hyphens allowed, must start with letter/digit)',
      changed: false,
    })

    // Valid with hyphen
    expect(mergeMultiPersona({ multiPersona: { defaultAgentId: 'my-agent-1' } }, settingsRaw)).toEqual({ error: null, changed: true })
  })
})
