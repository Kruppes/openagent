import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Mock config before any imports
vi.mock('@openagent/core', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    loadMultiPersonaSettings: vi.fn(() => ({ enabled: true, defaultAgentId: 'main' })),
    loadConfig: vi.fn(() => ({
      enabled: false,
      botToken: '',
      accounts: {},
    })),
    getConfigDir: vi.fn(() => '/tmp/config'),
    ensureConfigTemplates: vi.fn(),
    invalidatePersonaCache: vi.fn(),
  }
})

import { parseAgentId, parsePersonaFiles, parseCreatePersonaPayload, parseUpdatePersonaPayload } from '@openagent/core/contracts'
import * as service from './service.js'

describe('personas API', () => {
  let tmpDir: string
  let agentsDir: string
  let originalDataDir: string | undefined

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `openagent-personas-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    agentsDir = path.join(tmpDir, 'agents')
    fs.mkdirSync(agentsDir, { recursive: true })
    originalDataDir = process.env.DATA_DIR
    process.env.DATA_DIR = tmpDir
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir
    } else {
      delete process.env.DATA_DIR
    }
  })

  describe('parseAgentId', () => {
    it('accepts valid IDs', () => {
      expect(parseAgentId('main')).toEqual({ ok: true, value: 'main' })
      expect(parseAgentId('warren')).toEqual({ ok: true, value: 'warren' })
      expect(parseAgentId('my-agent')).toEqual({ ok: true, value: 'my-agent' })
      expect(parseAgentId('ab')).toEqual({ ok: true, value: 'ab' })
    })

    it('rejects invalid IDs', () => {
      expect(parseAgentId('')).toMatchObject({ ok: false })
      expect(parseAgentId(123)).toMatchObject({ ok: false })
      expect(parseAgentId(null)).toMatchObject({ ok: false })
      expect(parseAgentId('A')).toMatchObject({ ok: false }) // too short
      expect(parseAgentId('UPPER')).toMatchObject({ ok: false }) // uppercase
      expect(parseAgentId('-starts-with-hyphen')).toMatchObject({ ok: false })
    })
  })

  describe('parsePersonaFiles', () => {
    it('accepts valid files', () => {
      const result = parsePersonaFiles({ soul: '# Test', identity: '# ID' })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value).toEqual({ soul: '# Test', identity: '# ID' })
      }
    })

    it('accepts empty object', () => {
      const result = parsePersonaFiles({})
      expect(result.ok).toBe(true)
    })

    it('rejects invalid files', () => {
      expect(parsePersonaFiles(null)).toMatchObject({ ok: false })
      expect(parsePersonaFiles('string')).toMatchObject({ ok: false })
      expect(parsePersonaFiles({ unknownKey: 'test' })).toMatchObject({ ok: false })
      expect(parsePersonaFiles({ soul: 123 })).toMatchObject({ ok: false })
    })

    it('rejects oversized files (3.4)', () => {
      const oversized = 'x'.repeat(300_000) // > 256 KB
      const result = parsePersonaFiles({ soul: oversized })
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('exceeds maximum size')
      }
    })
  })

  describe('parseCreatePersonaPayload', () => {
    it('accepts valid create payload', () => {
      const result = parseCreatePersonaPayload({ id: 'my-bot' })
      expect(result).toEqual({ ok: true, value: { id: 'my-bot' } })
    })

    it('rejects missing id', () => {
      expect(parseCreatePersonaPayload({})).toMatchObject({ ok: false })
      expect(parseCreatePersonaPayload(null)).toMatchObject({ ok: false })
    })
  })

  describe('parseUpdatePersonaPayload', () => {
    it('accepts valid update payload', () => {
      const result = parseUpdatePersonaPayload({ files: { soul: '# Test' } })
      expect(result).toMatchObject({ ok: true, value: { files: { soul: '# Test' } } })
    })

    it('rejects missing files', () => {
      expect(parseUpdatePersonaPayload({})).toMatchObject({ ok: false })
    })
  })

  describe('service.listPersonas', () => {
    it('returns main when agents directory is empty', () => {
      const list = service.listPersonas()
      expect(list.length).toBeGreaterThanOrEqual(1)
      expect(list[0].id).toBe('main')
    })

    it('lists created persona directories', () => {
      fs.mkdirSync(path.join(agentsDir, 'warren'), { recursive: true })
      fs.mkdirSync(path.join(agentsDir, 'gekko'), { recursive: true })

      const list = service.listPersonas()
      const ids = list.map(p => p.id)
      expect(ids).toContain('main')
      expect(ids).toContain('warren')
      expect(ids).toContain('gekko')
    })
  })

  describe('service.createPersona', () => {
    it('creates a new persona with template files', () => {
      const persona = service.createPersona('test-bot')
      expect(persona.id).toBe('test-bot')
      expect(persona.files.soul).toContain('SOUL.md')
      expect(persona.files.identity).toContain('IDENTITY.md')

      // Directory should exist
      expect(fs.existsSync(path.join(agentsDir, 'test-bot'))).toBe(true)
      expect(fs.existsSync(path.join(agentsDir, 'test-bot', 'SOUL.md'))).toBe(true)
    })

    it('throws error for duplicate persona', () => {
      service.createPersona('test-bot')
      expect(() => service.createPersona('test-bot')).toThrow('already exists')
    })
  })

  describe('service.getPersona', () => {
    it('returns empty files for non-existent persona', () => {
      const persona = service.getPersona('nonexistent')
      expect(persona.id).toBe('nonexistent')
      expect(persona.files.soul).toBe('')
      expect(persona.files.identity).toBe('')
    })

    it('returns file content for existing persona', () => {
      const dir = path.join(agentsDir, 'warren')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'SOUL.md'), '# Warren Soul', 'utf-8')

      const persona = service.getPersona('warren')
      expect(persona.files.soul).toBe('# Warren Soul')
    })
  })

  describe('service.updatePersona', () => {
    it('updates persona files', () => {
      // Create persona first
      service.createPersona('test-bot')

      const updated = service.updatePersona('test-bot', {
        soul: '# Updated Soul',
        identity: '# Updated Identity',
      })

      expect(updated.files.soul).toBe('# Updated Soul')
      expect(updated.files.identity).toBe('# Updated Identity')
    })

    it('creates directory if not exists', () => {
      const updated = service.updatePersona('new-agent', { soul: '# New Soul' })
      expect(updated.files.soul).toBe('# New Soul')
      expect(fs.existsSync(path.join(agentsDir, 'new-agent', 'SOUL.md'))).toBe(true)
    })
  })

  describe('service.deletePersona', () => {
    it('deletes a persona directory', () => {
      service.createPersona('to-delete')
      expect(fs.existsSync(path.join(agentsDir, 'to-delete'))).toBe(true)

      service.deletePersona('to-delete')
      expect(fs.existsSync(path.join(agentsDir, 'to-delete'))).toBe(false)
    })

    it('throws error when trying to delete main', () => {
      expect(() => service.deletePersona('main')).toThrow('Cannot delete the main persona')
    })

    it('throws error for non-existent persona', () => {
      expect(() => service.deletePersona('nonexistent')).toThrow('not found')
    })
  })

  /* ── Security tests ── */

  describe('path traversal protection (3.3)', () => {
    it('rejects path traversal in agent ID via getPersona', () => {
      expect(() => service.getPersona('../etc/passwd')).toThrow('path traversal')
    })

    it('rejects path traversal in agent ID via createPersona', () => {
      expect(() => service.createPersona('../../etc')).toThrow('path traversal')
    })

    it('rejects path traversal in agent ID via updatePersona', () => {
      expect(() => service.updatePersona('../../../tmp', { soul: 'x' })).toThrow('path traversal')
    })

    it('rejects path traversal in agent ID via deletePersona', () => {
      expect(() => service.deletePersona('../../../tmp')).toThrow('path traversal')
    })

    it('rejects dot-dot-slash variations', () => {
      expect(() => service.getPersona('foo/../../../etc')).toThrow('path traversal')
      expect(() => service.getPersona('..')).toThrow('path traversal')
      expect(() => service.getPersona('../../')).toThrow('path traversal')
    })
  })

  describe('concurrent write safety (3.5)', () => {
    it('uses atomic writes (files are not corrupted)', () => {
      service.createPersona('concurrent-test')

      // Simulate rapid sequential writes
      for (let i = 0; i < 10; i++) {
        service.updatePersona('concurrent-test', { soul: `# Version ${i}` })
      }

      const persona = service.getPersona('concurrent-test')
      expect(persona.files.soul).toBe('# Version 9')

      // No .tmp files should remain
      const files = fs.readdirSync(path.join(agentsDir, 'concurrent-test'))
      const tmpFiles = files.filter(f => f.includes('.tmp.'))
      expect(tmpFiles).toHaveLength(0)
    })
  })

  describe('telegram binding guard on delete (3.7)', () => {
    it('refuses deletion when persona has active telegram binding', async () => {
      const { loadConfig } = await import('@openagent/core')
      const mockLoadConfig = vi.mocked(loadConfig)

      // Create persona
      service.createPersona('bound-bot')

      // Mock telegram config with binding
      mockLoadConfig.mockReturnValueOnce({
        enabled: true,
        botToken: '',
        accounts: {
          'bound-bot': { agentId: 'bound-bot', botToken: '123:ABC', enabled: true },
        },
      })

      expect(() => service.deletePersona('bound-bot')).toThrow('active Telegram binding')

      // Restore mock
      mockLoadConfig.mockReturnValue({
        enabled: false,
        botToken: '',
        accounts: {},
      })
    })
  })
})
