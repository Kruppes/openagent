import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

import { completeSimple } from '@mariozechner/pi-ai'
import { initDatabase } from './database.js'
import type { Database } from './database.js'
import {
  extractAndStoreFacts,
  isDuplicateFact,
  parseFactLines,
} from './fact-extraction.js'
import { createMemory, listMemories } from './memories-store.js'

const mockCompleteSimple = vi.mocked(completeSimple)

function insertUser(db: Database, id: number, username: string): void {
  db.prepare(
    'INSERT INTO users (id, username, password_hash, role) VALUES (?, ?, ?, ?)',
  ).run(id, username, 'hash', 'user')
}

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

describe('fact-extraction', () => {
  let db: Database

  beforeEach(() => {
    db = initDatabase(':memory:')
    insertUser(db, 1, 'alice')
    insertUser(db, 2, 'bob')
    mockCompleteSimple.mockReset()
  })

  afterEach(() => {
    db.close()
  })

  it('parseFactLines handles bullet lists, numbered lists, empty lines, and NO_FACTS', () => {
    expect(parseFactLines('- User prefers dark mode\n- Project uses PostgreSQL')).toEqual([
      'User prefers dark mode',
      'Project uses PostgreSQL',
    ])

    expect(parseFactLines('1. User works in Berlin\n\n2) Deployment uses Docker Compose')).toEqual([
      'User works in Berlin',
      'Deployment uses Docker Compose',
    ])

    expect(parseFactLines('  NO_FACTS  ')).toEqual([])
    expect(parseFactLines('\n\n')).toEqual([])
  })

  it('isDuplicateFact returns true for highly overlapping facts', () => {
    createMemory(db, 1, 'session-a', 'The project uses PostgreSQL on port 5433', 'extracted_fact')

    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433')).toBe(true)
  })

  it('isDuplicateFact ignores memories from different users', () => {
    createMemory(db, 2, 'session-b', 'The project uses PostgreSQL on port 5433', 'extracted_fact')

    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433')).toBe(false)
  })

  it('extractAndStoreFacts calls the LLM, wraps the transcript, deduplicates, and stores new facts', async () => {
    createMemory(db, 1, 'session-old', 'Deployment is done via Docker Compose with 3 services', 'extracted_fact')
    mockCompleteSimple.mockResolvedValueOnce(makeResponse([
      '- Deployment is done via Docker Compose with 3 services',
      '- The project uses PostgreSQL on port 5433',
      '- User prefers dark mode in all applications',
    ].join('\n')))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-new',
      'User: Please remember that I prefer dark mode.\nAssistant: Got it.',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 3, stored: 2, duplicates: 1 })
    expect(mockCompleteSimple).toHaveBeenCalledOnce()

    const [, prompt, options] = mockCompleteSimple.mock.calls[0]
    expect(prompt.systemPrompt).toContain('extract atomic, reusable facts')
    expect(prompt.messages[0].content).toContain('<transcript>\nUser: Please remember that I prefer dark mode.')
    expect(prompt.messages[0].content).toContain('\n</transcript>')
    expect(options).toMatchObject({ apiKey: 'test-key', temperature: 0 })

    const storedFacts = listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts
      .filter(fact => fact.source === 'extracted_fact')
      .map(fact => fact.content)

    expect(storedFacts).toContain('The project uses PostgreSQL on port 5433')
    expect(storedFacts).toContain('User prefers dark mode in all applications')
  })

  it('returns zero counts when the LLM says NO_FACTS', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('NO_FACTS'))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-empty',
      'User: Hello\nAssistant: Hi there',
      makeModel(),
      'test-key',
    )

    expect(result).toEqual({ extracted: 0, stored: 0, duplicates: 0 })
    expect(listMemories(db, { userId: 1, limit: 10, offset: 0 }).facts).toHaveLength(0)
  })

  it('propagates LLM errors so callers can handle them', async () => {
    mockCompleteSimple.mockRejectedValueOnce(new Error('LLM unavailable'))

    await expect(extractAndStoreFacts(
      db,
      1,
      'session-error',
      'User: remember this',
      makeModel(),
      'test-key',
    )).rejects.toThrow('LLM unavailable')
  })

  describe('agentId scoping', () => {
    it('stores facts with the specified agentId', async () => {
      mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User prefers dark mode'))

      await extractAndStoreFacts(db, 1, 'session-w', 'test', makeModel(), 'key', 'warren')

      const rows = db.prepare(
        "SELECT agent_id FROM memories WHERE content LIKE '%dark mode%'"
      ).all() as Array<{ agent_id: string }>

      expect(rows).toHaveLength(1)
      expect(rows[0].agent_id).toBe('warren')
    })

    it('defaults agentId to main when not specified', async () => {
      mockCompleteSimple.mockResolvedValueOnce(makeResponse('- PostgreSQL on port 5433'))

      await extractAndStoreFacts(db, 1, 'session-m', 'test', makeModel(), 'key')

      const rows = db.prepare(
        "SELECT agent_id FROM memories WHERE content LIKE '%PostgreSQL%'"
      ).all() as Array<{ agent_id: string }>

      expect(rows).toHaveLength(1)
      expect(rows[0].agent_id).toBe('main')
    })

    it('two agents can store identical facts without cross-deduplication', async () => {
      mockCompleteSimple
        .mockResolvedValueOnce(makeResponse('- User lives in Berlin'))
        .mockResolvedValueOnce(makeResponse('- User lives in Berlin'))

      const r1 = await extractAndStoreFacts(db, 1, 's1', 'test', makeModel(), 'key', 'main')
      const r2 = await extractAndStoreFacts(db, 1, 's2', 'test', makeModel(), 'key', 'warren')

      expect(r1.stored).toBe(1)
      expect(r1.duplicates).toBe(0)
      expect(r2.stored).toBe(1)
      expect(r2.duplicates).toBe(0)

      const rows = db.prepare(
        "SELECT agent_id FROM memories WHERE content LIKE '%Berlin%' ORDER BY agent_id"
      ).all() as Array<{ agent_id: string }>

      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.agent_id)).toEqual(['main', 'warren'])
    })

    it('deduplicates within the same agentId bucket', async () => {
      // First extraction
      mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User prefers dark mode in all applications'))
      await extractAndStoreFacts(db, 1, 's1', 'test', makeModel(), 'key', 'warren')

      // Second extraction with same agentId
      mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User prefers dark mode in all applications'))
      const r2 = await extractAndStoreFacts(db, 1, 's2', 'test', makeModel(), 'key', 'warren')

      expect(r2.stored).toBe(0)
      expect(r2.duplicates).toBe(1)
    })

    it('isDuplicateFact respects agentId scoping', () => {
      createMemory(db, 1, 'session-a', 'The project uses PostgreSQL on port 5433', 'extracted_fact', 'warren')

      // Same fact, same agent → duplicate
      expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433', 'warren')).toBe(true)

      // Same fact, different agent → not a duplicate
      expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433', 'main')).toBe(false)
    })
  })
})
