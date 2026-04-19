import { describe, expect, it } from 'vitest'
import {
  parseAgentId,
  parsePersonaFiles,
  parseCreatePersonaPayload,
  parseUpdatePersonaPayload,
  PERSONA_FILE_MAX_BYTES,
} from './personas.js'

describe('persona contracts', () => {
  describe('parseAgentId', () => {
    it('accepts "main"', () => {
      expect(parseAgentId('main')).toEqual({ ok: true, value: 'main' })
    })

    it('accepts valid lowercase IDs', () => {
      expect(parseAgentId('warren')).toEqual({ ok: true, value: 'warren' })
      expect(parseAgentId('my-agent')).toEqual({ ok: true, value: 'my-agent' })
      expect(parseAgentId('ab')).toEqual({ ok: true, value: 'ab' })
      expect(parseAgentId('agent123')).toEqual({ ok: true, value: 'agent123' })
    })

    it('rejects non-string inputs', () => {
      expect(parseAgentId(123).ok).toBe(false)
      expect(parseAgentId(null).ok).toBe(false)
      expect(parseAgentId(undefined).ok).toBe(false)
      expect(parseAgentId('').ok).toBe(false)
    })

    it('rejects uppercase', () => {
      expect(parseAgentId('UPPER').ok).toBe(false)
      expect(parseAgentId('Upper').ok).toBe(false)
    })

    it('rejects single character (except "main")', () => {
      expect(parseAgentId('a').ok).toBe(false)
    })

    it('rejects starting with hyphen', () => {
      expect(parseAgentId('-test').ok).toBe(false)
    })

    it('rejects path traversal characters', () => {
      expect(parseAgentId('../etc').ok).toBe(false)
      expect(parseAgentId('foo/bar').ok).toBe(false)
      expect(parseAgentId('foo..bar').ok).toBe(false)
    })
  })

  describe('parsePersonaFiles', () => {
    it('accepts valid file keys', () => {
      const result = parsePersonaFiles({ soul: '# Soul', identity: '# ID' })
      expect(result).toEqual({ ok: true, value: { soul: '# Soul', identity: '# ID' } })
    })

    it('accepts empty object', () => {
      expect(parsePersonaFiles({})).toEqual({ ok: true, value: {} })
    })

    it('rejects unknown keys', () => {
      const result = parsePersonaFiles({ invalid: 'test' })
      expect(result.ok).toBe(false)
    })

    it('rejects non-string values', () => {
      const result = parsePersonaFiles({ soul: 123 })
      expect(result.ok).toBe(false)
    })

    it('rejects files exceeding size limit', () => {
      const oversized = 'x'.repeat(PERSONA_FILE_MAX_BYTES + 1)
      const result = parsePersonaFiles({ soul: oversized })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('exceeds maximum size')
      }
    })

    it('accepts files at exactly the size limit', () => {
      // ASCII chars are 1 byte each
      const atLimit = 'x'.repeat(PERSONA_FILE_MAX_BYTES)
      const result = parsePersonaFiles({ soul: atLimit })
      expect(result.ok).toBe(true)
    })
  })

  describe('parseCreatePersonaPayload', () => {
    it('parses valid payload', () => {
      expect(parseCreatePersonaPayload({ id: 'my-bot' })).toEqual({
        ok: true,
        value: { id: 'my-bot' },
      })
    })

    it('rejects null/undefined', () => {
      expect(parseCreatePersonaPayload(null).ok).toBe(false)
      expect(parseCreatePersonaPayload(undefined).ok).toBe(false)
    })

    it('rejects missing id', () => {
      expect(parseCreatePersonaPayload({}).ok).toBe(false)
    })
  })

  describe('parseUpdatePersonaPayload', () => {
    it('parses valid payload', () => {
      const result = parseUpdatePersonaPayload({ files: { soul: '# Updated' } })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.files).toEqual({ soul: '# Updated' })
      }
    })

    it('rejects missing files', () => {
      expect(parseUpdatePersonaPayload({}).ok).toBe(false)
    })

    it('rejects invalid file content', () => {
      expect(parseUpdatePersonaPayload({ files: { soul: 42 } }).ok).toBe(false)
    })
  })
})
