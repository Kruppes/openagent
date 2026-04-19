import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadPersona, clearPersonaCache, seedPersonaFiles, getPersonaDir } from './persona-loader.js'

// Mock loadMultiPersonaSettings
vi.mock('./config.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>
  let mockEnabled = false
  return {
    ...actual,
    loadMultiPersonaSettings: vi.fn(() => ({
      enabled: mockEnabled,
      defaultAgentId: 'main',
    })),
    _setMultiPersonaEnabled: (enabled: boolean) => { mockEnabled = enabled },
  }
})

const configMock = await import('./config.js') as unknown as {
  _setMultiPersonaEnabled: (enabled: boolean) => void
}

let tempDir: string

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openagent-persona-test-'))
  clearPersonaCache()
  configMock._setMultiPersonaEnabled(false)
})

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true })
})

function createPersonaDir(agentId: string, files: Record<string, string>): string {
  const agentDir = path.join(tempDir, agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(agentDir, filename), content, 'utf-8')
  }
  return agentDir
}

describe('persona-loader', () => {
  describe('loadPersona', () => {
    it('returns empty context when feature is disabled', () => {
      configMock._setMultiPersonaEnabled(false)
      createPersonaDir('warren', {
        'SOUL.md': '# Warren Soul',
        'IDENTITY.md': '# Warren',
      })

      const persona = loadPersona('warren', { baseDir: tempDir })
      expect(persona.hasPersonaDir).toBe(false)
      expect(persona.soul).toBeNull()
      expect(persona.identity).toBeNull()
    })

    it('returns empty context for agentId "main" even when feature is on', () => {
      configMock._setMultiPersonaEnabled(true)
      createPersonaDir('main', {
        'SOUL.md': '# Main Soul',
      })

      const persona = loadPersona('main', { baseDir: tempDir })
      expect(persona.hasPersonaDir).toBe(false)
      expect(persona.soul).toBeNull()
    })

    it('loads persona files when feature is enabled and directory exists', () => {
      configMock._setMultiPersonaEnabled(true)
      createPersonaDir('warren', {
        'IDENTITY.md': '# IDENTITY\n- Name: Warren',
        'SOUL.md': '# SOUL.md — Warren\nDu bist Warren.',
        'USER.md': '# USER\n[REDACTED_USER]'s,
        'TOOLS.md': '# TOOLS\nWeb research',
        'MEMORY.md': '# MEMORY\nFacts about Warren',
        'AGENTS.md': '# AGENTS\nWarren rules',
        'HEARTBEAT.md': '# HEARTBEAT\nCheck stocks',
      })

      const persona = loadPersona('warren', { baseDir: tempDir })
      expect(persona.hasPersonaDir).toBe(true)
      expect(persona.agentId).toBe('warren')
      expect(persona.identity).toContain('Warren')
      expect(persona.soul).toContain('Du bist Warren')
      expect(persona.user).toContain('[REDACTED_USER]'s)
      expect(persona.tools).toContain('Web research')
      expect(persona.memory).toContain('Facts about Warren')
      expect(persona.agents).toContain('Warren rules')
      expect(persona.heartbeat).toContain('Check stocks')
    })

    it('returns empty context when persona directory does not exist', () => {
      configMock._setMultiPersonaEnabled(true)

      const persona = loadPersona('nonexistent', { baseDir: tempDir })
      expect(persona.hasPersonaDir).toBe(false)
      expect(persona.soul).toBeNull()
    })

    it('handles partial persona files (only some files present)', () => {
      configMock._setMultiPersonaEnabled(true)
      createPersonaDir('partial', {
        'SOUL.md': '# Partial soul',
      })

      const persona = loadPersona('partial', { baseDir: tempDir })
      expect(persona.hasPersonaDir).toBe(true)
      expect(persona.soul).toContain('Partial soul')
      expect(persona.identity).toBeNull()
      expect(persona.tools).toBeNull()
      expect(persona.memory).toBeNull()
    })

    it('uses skipFeatureCheck to bypass settings', () => {
      configMock._setMultiPersonaEnabled(false)
      createPersonaDir('test-agent', {
        'SOUL.md': '# Test soul',
      })

      // Without skip: empty
      const withoutSkip = loadPersona('test-agent', { baseDir: tempDir })
      expect(withoutSkip.hasPersonaDir).toBe(false)

      clearPersonaCache()

      // With skip: loads files
      const withSkip = loadPersona('test-agent', { baseDir: tempDir, skipFeatureCheck: true })
      expect(withSkip.hasPersonaDir).toBe(true)
      expect(withSkip.soul).toContain('Test soul')
    })

    it('caches persona context between calls', () => {
      configMock._setMultiPersonaEnabled(true)
      createPersonaDir('cached', {
        'SOUL.md': '# Cached soul',
      })

      const first = loadPersona('cached', { baseDir: tempDir })
      const second = loadPersona('cached', { baseDir: tempDir })
      expect(first).toBe(second) // Same object reference = cached
    })

    it('invalidates cache when clearPersonaCache is called', () => {
      configMock._setMultiPersonaEnabled(true)
      createPersonaDir('cache-test', {
        'SOUL.md': '# Original soul',
      })

      const first = loadPersona('cache-test', { baseDir: tempDir })
      expect(first.soul).toContain('Original soul')

      // Modify file on disk
      fs.writeFileSync(
        path.join(tempDir, 'cache-test', 'SOUL.md'),
        '# Updated soul',
        'utf-8',
      )

      clearPersonaCache()
      const second = loadPersona('cache-test', { baseDir: tempDir })
      expect(second.soul).toContain('Updated soul')
    })
  })

  describe('seedPersonaFiles', () => {
    it('copies seed files to target directory', () => {
      const sourceDir = path.join(tempDir, 'source')
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(path.join(sourceDir, 'SOUL.md'), '# Warren Soul', 'utf-8')
      fs.writeFileSync(path.join(sourceDir, 'IDENTITY.md'), '# Warren', 'utf-8')

      const targetBase = path.join(tempDir, 'target')
      const copied = seedPersonaFiles('warren', sourceDir, targetBase)

      expect(copied).toContain('SOUL.md')
      expect(copied).toContain('IDENTITY.md')

      const targetDir = path.join(targetBase, 'warren')
      expect(fs.existsSync(path.join(targetDir, 'SOUL.md'))).toBe(true)
      expect(fs.readFileSync(path.join(targetDir, 'SOUL.md'), 'utf-8')).toBe('# Warren Soul')
    })

    it('does not overwrite existing files', () => {
      const sourceDir = path.join(tempDir, 'source2')
      fs.mkdirSync(sourceDir, { recursive: true })
      fs.writeFileSync(path.join(sourceDir, 'SOUL.md'), '# Seed Soul', 'utf-8')

      const targetBase = path.join(tempDir, 'target2')
      const targetDir = path.join(targetBase, 'warren')
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(path.join(targetDir, 'SOUL.md'), '# User-edited Soul', 'utf-8')

      const copied = seedPersonaFiles('warren', sourceDir, targetBase)

      expect(copied).toHaveLength(0) // Nothing should be copied
      expect(fs.readFileSync(path.join(targetDir, 'SOUL.md'), 'utf-8')).toBe('# User-edited Soul')
    })

    it('returns empty array when source directory does not exist', () => {
      const copied = seedPersonaFiles('warren', '/nonexistent', path.join(tempDir, 'target3'))
      expect(copied).toHaveLength(0)
    })
  })

  describe('getPersonaDir', () => {
    it('uses DATA_DIR environment variable', () => {
      const result = getPersonaDir('warren')
      // Default /data/agents/warren when DATA_DIR is not set explicitly in test
      expect(result).toMatch(/agents[/\\]warren$/)
    })

    it('uses custom base directory', () => {
      const result = getPersonaDir('warren', '/custom/path')
      expect(result).toBe('/custom/path/warren')
    })
  })
})

describe('assembleSystemPrompt with persona', () => {
  it('uses persona SOUL.md when available', async () => {
    configMock._setMultiPersonaEnabled(true)

    // Create persona files
    createPersonaDir('warren', {
      'SOUL.md': '# Warren Soul\nDu bist Warren, ein Anlageberater.',
      'IDENTITY.md': '# Warren Identity\n- Name: Warren\n- Emoji: 📈',
      'TOOLS.md': '# Warren Tools\n- Web-Recherche für Kurse',
      'USER.md': '# Warren User\n[REDACTED_USER] ist der User.',
      'AGENTS.md': '# Warren Rules\nSei fundiert und direkt.',
      'MEMORY.md': '# Warren Memory\nWarren-spezifische Fakten.',
    })

    // Set DATA_DIR to tempDir parent (persona-loader uses DATA_DIR/agents/<id>)
    const originalDataDir = process.env.DATA_DIR
    // We need a temp data dir with the right structure
    const dataDir = path.join(tempDir, 'data')
    fs.mkdirSync(path.join(dataDir, 'agents', 'warren'), { recursive: true })
    // Copy persona files to data dir
    for (const file of fs.readdirSync(path.join(tempDir, 'warren'))) {
      fs.copyFileSync(
        path.join(tempDir, 'warren', file),
        path.join(dataDir, 'agents', 'warren', file),
      )
    }
    // Create memory dir structure
    const memoryDir = path.join(dataDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, 'users'), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, 'wiki'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'SOUL.md'), '# Global Soul\nI am the global agent.', 'utf-8')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Global Memory\nGlobal facts.', 'utf-8')

    // Create config dir with AGENTS.md
    const configDir = path.join(dataDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'AGENTS.md'), '# Global Rules\nBe helpful.', 'utf-8')
    fs.writeFileSync(path.join(configDir, 'HEARTBEAT.md'), '# Heartbeat', 'utf-8')
    fs.writeFileSync(path.join(configDir, 'CONSOLIDATION.md'), '# Consolidation', 'utf-8')

    process.env.DATA_DIR = dataDir
    clearPersonaCache()

    try {
      const { assembleSystemPrompt } = await import('./memory.js')

      const prompt = assembleSystemPrompt({
        memoryDir,
        configDir,
        agentId: 'warren',
      })

      // Persona SOUL.md should override global
      expect(prompt).toContain('Du bist Warren, ein Anlageberater.')
      expect(prompt).not.toContain('I am the global agent.')

      // Identity should be included
      expect(prompt).toContain('Warren Identity')
      expect(prompt).toContain('📈')

      // Tool hints should be included
      expect(prompt).toContain('Web-Recherche für Kurse')

      // Persona AGENTS.md should override global rules
      expect(prompt).toContain('Sei fundiert und direkt.')
      expect(prompt).not.toContain('Be helpful.')

      // Persona USER.md should be used
      expect(prompt).toContain('[REDACTED_USER] ist der User.')

      // Global memory should still be present
      expect(prompt).toContain('Global facts.')

      // Agent-specific memory should be additional
      expect(prompt).toContain('Warren-spezifische Fakten.')

      // Now test without agentId — should use global files
      clearPersonaCache()
      const globalPrompt = assembleSystemPrompt({
        memoryDir,
        configDir,
      })

      expect(globalPrompt).toContain('I am the global agent.')
      expect(globalPrompt).not.toContain('Du bist Warren')
      expect(globalPrompt).toContain('Be helpful.')
    } finally {
      if (originalDataDir === undefined) {
        delete process.env.DATA_DIR
      } else {
        process.env.DATA_DIR = originalDataDir
      }
    }
  })

  it('falls back to global files when persona is disabled', async () => {
    configMock._setMultiPersonaEnabled(false)

    const dataDir = path.join(tempDir, 'data-disabled')
    const memoryDir = path.join(dataDir, 'memory')
    fs.mkdirSync(path.join(memoryDir, 'daily'), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, 'users'), { recursive: true })
    fs.mkdirSync(path.join(memoryDir, 'wiki'), { recursive: true })
    fs.writeFileSync(path.join(memoryDir, 'SOUL.md'), '# Global Soul Only', 'utf-8')
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '# Global Memory Only', 'utf-8')

    const configDir = path.join(dataDir, 'config')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(path.join(configDir, 'AGENTS.md'), '# Global Rules Only', 'utf-8')
    fs.writeFileSync(path.join(configDir, 'HEARTBEAT.md'), '# Heartbeat', 'utf-8')
    fs.writeFileSync(path.join(configDir, 'CONSOLIDATION.md'), '# Consolidation', 'utf-8')

    clearPersonaCache()

    const { assembleSystemPrompt } = await import('./memory.js')

    const prompt = assembleSystemPrompt({
      memoryDir,
      configDir,
      agentId: 'warren', // Feature OFF → should be ignored
    })

    expect(prompt).toContain('Global Soul Only')
    expect(prompt).toContain('Global Rules Only')
    expect(prompt).not.toContain('Warren')
  })
})
