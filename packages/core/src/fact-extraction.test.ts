import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  extractAndStoreFacts,
  callOllamaForFacts,
  parseFactLines,
  isDuplicateFact,
  storeFact,
} from './fact-extraction.js'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

describe('fact-extraction', () => {
  let db: Database
  let tmpDir: string
  let dbPath: string

  beforeEach(() => {
    tmpDir = path.join(os.tmpdir(), `openagent-fact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    dbPath = path.join(tmpDir, 'db', 'test.db')
    db = initDatabase(dbPath)
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  describe('parseFactLines', () => {
    it('parses numbered lines', () => {
      const content = `1. The user prefers dark mode.
2. The project uses TypeScript.
3. The database is SQLite.`
      const facts = parseFactLines(content)
      expect(facts).toEqual([
        'The user prefers dark mode.',
        'The project uses TypeScript.',
        'The database is SQLite.',
      ])
    })

    it('parses bullet lines', () => {
      const content = `- The user prefers dark mode.
- The project uses TypeScript.
* The database is SQLite.`
      const facts = parseFactLines(content)
      expect(facts).toEqual([
        'The user prefers dark mode.',
        'The project uses TypeScript.',
        'The database is SQLite.',
      ])
    })

    it('skips empty and very short lines', () => {
      const content = `1. The user prefers dark mode.

Short.
2. The project uses TypeScript and React for the frontend.`
      const facts = parseFactLines(content)
      expect(facts).toEqual([
        'The user prefers dark mode.',
        'The project uses TypeScript and React for the frontend.',
      ])
    })

    it('respects maxFacts limit', () => {
      const content = Array.from({ length: 20 }, (_, i) =>
        `${i + 1}. Fact number ${i + 1} is a long enough fact sentence.`
      ).join('\n')
      const facts = parseFactLines(content, 5)
      expect(facts.length).toBe(5)
    })

    it('handles parenthesized numbering', () => {
      const content = `1) The user prefers dark mode.
2) The project uses TypeScript.`
      const facts = parseFactLines(content)
      expect(facts).toEqual([
        'The user prefers dark mode.',
        'The project uses TypeScript.',
      ])
    })

    it('returns empty array for empty content', () => {
      expect(parseFactLines('')).toEqual([])
    })
  })

  describe('isDuplicateFact', () => {
    it('returns false when no facts exist', () => {
      expect(isDuplicateFact(db, 'The user prefers dark mode.')).toBe(false)
    })

    it('returns true when a similar fact exists', () => {
      storeFact(db, 'The user prefers dark mode.')
      expect(isDuplicateFact(db, 'The user prefers dark mode.')).toBe(true)
    })

    it('returns true on partial match (substring)', () => {
      storeFact(db, 'The user prefers dark mode.')
      // A longer fact containing the same core text matches
      expect(isDuplicateFact(db, 'The user prefers dark mode and uses it daily.')).toBe(true)
    })

    it('returns false for clearly different facts', () => {
      storeFact(db, 'The user prefers dark mode.')
      expect(isDuplicateFact(db, 'The project uses PostgreSQL for the production database.')).toBe(false)
    })
  })

  describe('storeFact', () => {
    it('stores a fact in the memories table', () => {
      storeFact(db, 'Test fact content.', 'test_source')

      const row = db.prepare('SELECT * FROM memories WHERE content = ?').get('Test fact content.') as {
        id: number
        content: string
        source: string
        timestamp: string
      }

      expect(row).toBeTruthy()
      expect(row.content).toBe('Test fact content.')
      expect(row.source).toBe('test_source')
    })

    it('uses default source when not specified', () => {
      storeFact(db, 'Another test fact.')

      const row = db.prepare('SELECT source FROM memories WHERE content = ?').get('Another test fact.') as {
        source: string
      }
      expect(row.source).toBe('fact_extraction')
    })
  })

  describe('extractAndStoreFacts', () => {
    it('returns 0 for empty conversation history', async () => {
      const count = await extractAndStoreFacts(db, '', 'test-session')
      expect(count).toBe(0)
    })

    it('returns 0 for very short conversation history', async () => {
      const count = await extractAndStoreFacts(db, 'Hi there!', 'test-session')
      expect(count).toBe(0)
    })

    it('calls Ollama and stores facts (mocked)', async () => {
      // Mock fetch globally
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: {
            content: `1. The user's name is John.
2. The project uses TypeScript with Node.js.
3. The deployment target is AWS ECS.`,
          },
        }),
        text: async () => '',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        const conversationHistory = `User: Hi, I'm John. I'm working on a TypeScript project.
Assistant: Hello John! How can I help you with your TypeScript project?
User: I need to deploy it to AWS ECS. Can you help me set up the Dockerfile?
Assistant: Of course! Let me help you create a Dockerfile for your TypeScript Node.js application that will run on AWS ECS.`

        const count = await extractAndStoreFacts(db, conversationHistory, 'test-session')

        expect(count).toBe(3)

        // Verify facts were stored
        const rows = db.prepare('SELECT content FROM memories ORDER BY id').all() as Array<{ content: string }>
        expect(rows.length).toBe(3)
        expect(rows[0].content).toBe("The user's name is John.")
        expect(rows[1].content).toBe('The project uses TypeScript with Node.js.')
        expect(rows[2].content).toBe('The deployment target is AWS ECS.')

        // Verify fetch was called with correct parameters
        expect(globalThis.fetch).toHaveBeenCalledTimes(1)
        const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
        expect(fetchCall[0]).toContain('/api/chat')
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string)
        expect(body.think).toBe(false)
        expect(body.stream).toBe(false)
        expect(body.messages).toHaveLength(2)
        expect(body.messages[0].role).toBe('system')
        expect(body.messages[1].role).toBe('user')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('deduplicates facts (mocked)', async () => {
      // Pre-store a fact
      storeFact(db, "The user's name is John.")

      const mockResponse = {
        ok: true,
        json: async () => ({
          message: {
            content: `1. The user's name is John.
2. The project uses TypeScript with Node.js.`,
          },
        }),
        text: async () => '',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        const conversationHistory = `User: I'm John, working on TypeScript.
Assistant: Hello John! What can I help you with?
User: Just checking in on the project status.
Assistant: Everything looks good with your TypeScript Node.js project.`

        const count = await extractAndStoreFacts(db, conversationHistory, 'test-session')

        // Only 1 new fact (John fact is a duplicate)
        expect(count).toBe(1)

        const rows = db.prepare('SELECT content FROM memories ORDER BY id').all() as Array<{ content: string }>
        expect(rows.length).toBe(2) // 1 pre-stored + 1 new
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('handles Ollama API errors gracefully', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        const conversationHistory = `User: This is a test conversation that is long enough.
Assistant: Yes, I understand. This is just for testing the error handling path.
User: What happens when Ollama returns an error?
Assistant: The function should handle it gracefully and propagate the error.`

        await expect(
          extractAndStoreFacts(db, conversationHistory, 'test-session')
        ).rejects.toThrow('Ollama API error 500')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('handles empty response from Ollama', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: { content: '' },
        }),
        text: async () => '',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        const conversationHistory = `User: This is a test conversation that should return no facts.
Assistant: Acknowledged. Let me process this for you.
User: Thanks for trying.
Assistant: You're welcome. Is there anything else I can help with?`

        const count = await extractAndStoreFacts(db, conversationHistory, 'test-session')
        expect(count).toBe(0)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })

  describe('callOllamaForFacts', () => {
    it('uses custom Ollama URL and model from options', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: { content: '1. Test fact with enough length to pass filter.' },
        }),
        text: async () => '',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        await callOllamaForFacts('Test conversation text', {
          ollamaUrl: 'http://custom-host:11434',
          model: 'llama3:8b',
        })

        const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
        expect(fetchCall[0]).toBe('http://custom-host:11434/api/chat')
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string)
        expect(body.model).toBe('llama3:8b')
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it('sends think: false for gemma4 compatibility', async () => {
      const mockResponse = {
        ok: true,
        json: async () => ({
          message: { content: '1. A fact that is long enough to pass the filter.' },
        }),
        text: async () => '',
      }

      const originalFetch = globalThis.fetch
      globalThis.fetch = vi.fn().mockResolvedValue(mockResponse) as unknown as typeof fetch

      try {
        await callOllamaForFacts('Test conversation text')

        const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0]
        const body = JSON.parse((fetchCall[1] as RequestInit).body as string)
        expect(body.think).toBe(false)
        expect(body.stream).toBe(false)
      } finally {
        globalThis.fetch = originalFetch
      }
    })
  })
})
