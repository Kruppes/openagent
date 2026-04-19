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
  }
})

import { validateAgentId, validatePersonaFiles } from './schema.js'
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

  describe('validateAgentId', () => {
    it('accepts valid IDs', () => {
      expect(validateAgentId('main')).toBeNull()
      expect(validateAgentId('warren')).toBeNull()
      expect(validateAgentId('my-agent')).toBeNull()
      expect(validateAgentId('ab')).toBeNull()
    })

    it('rejects invalid IDs', () => {
      expect(validateAgentId('')).not.toBeNull()
      expect(validateAgentId(123)).not.toBeNull()
      expect(validateAgentId(null)).not.toBeNull()
      expect(validateAgentId('A')).not.toBeNull() // too short
      expect(validateAgentId('UPPER')).not.toBeNull() // uppercase
      expect(validateAgentId('-starts-with-hyphen')).not.toBeNull()
    })
  })

  describe('validatePersonaFiles', () => {
    it('accepts valid files', () => {
      expect(validatePersonaFiles({ soul: '# Test', identity: '# ID' })).toBeNull()
      expect(validatePersonaFiles({})).toBeNull()
    })

    it('rejects invalid files', () => {
      expect(validatePersonaFiles(null)).not.toBeNull()
      expect(validatePersonaFiles('string')).not.toBeNull()
      expect(validatePersonaFiles({ unknownKey: 'test' })).not.toBeNull()
      expect(validatePersonaFiles({ soul: 123 })).not.toBeNull()
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
})
