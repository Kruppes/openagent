import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@earendil-works/pi-ai/compat', async (importOriginal) => {
  const original = await importOriginal() as Record<string, unknown>
  return {
    ...original,
    completeSimple: vi.fn(),
  }
})

import { completeSimple } from '@earendil-works/pi-ai/compat'
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

  it('isDuplicateFact scopes deduplication within an agent bucket (RC1)', () => {
    // A fact owned by persona 'bob' must not suppress the same fact for
    // persona 'main' (or any other agent) — their memories are independent.
    createMemory(db, 1, 'session-a', 'The project uses PostgreSQL on port 5433', 'extracted_fact', 'bob')

    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433', 'bob')).toBe(true)
    expect(isDuplicateFact(db, 1, 'Project uses PostgreSQL at port 5433', 'main')).toBe(false)
    // Default agent id is 'main', so an unscoped call sees only main's bucket.
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

  it('stores extracted facts under the session\'s agent id (RC1)', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse(
      '- Bob prefers concise answers',
    ))

    const result = await extractAndStoreFacts(
      db,
      1,
      'session-bob',
      'User: keep it short.\nAssistant: Got it.',
      makeModel(),
      'test-key',
      undefined,
      'bob',
    )

    expect(result).toEqual({ extracted: 1, stored: 1, duplicates: 0 })

    const row = db.prepare(
      "SELECT agent_id FROM memories WHERE content = 'Bob prefers concise answers'",
    ).get() as { agent_id: string }
    expect(row.agent_id).toBe('bob')
  })

  it('lets the same fact coexist across agents but dedupes within one (RC1)', async () => {
    // main already holds the fact.
    createMemory(db, 1, 'session-main', 'User prefers dark mode', 'extracted_fact', 'main')

    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User prefers dark mode'))

    // bob extracts the same fact — it must be stored (different bucket).
    const bobResult = await extractAndStoreFacts(
      db, 1, 'session-bob', 'User: dark mode please.\nAssistant: ok', makeModel(), 'test-key', undefined, 'bob',
    )
    expect(bobResult).toEqual({ extracted: 1, stored: 1, duplicates: 0 })

    // A second bob extraction of the same fact is a duplicate within bob.
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User prefers dark mode'))
    const bobAgain = await extractAndStoreFacts(
      db, 1, 'session-bob2', 'User: still dark mode.\nAssistant: ok', makeModel(), 'test-key', undefined, 'bob',
    )
    expect(bobAgain).toEqual({ extracted: 1, stored: 0, duplicates: 1 })

    const counts = db.prepare(
      "SELECT agent_id, COUNT(*) AS n FROM memories WHERE content = 'User prefers dark mode' GROUP BY agent_id ORDER BY agent_id",
    ).all() as { agent_id: string; n: number }[]
    expect(counts).toEqual([
      { agent_id: 'bob', n: 1 },
      { agent_id: 'main', n: 1 },
    ])
  })

  it('defaults extracted facts to the main agent when no agent id is given (RC1)', async () => {
    mockCompleteSimple.mockResolvedValueOnce(makeResponse('- User lives in Berlin'))

    await extractAndStoreFacts(
      db, 1, 'session-default', 'User: I live in Berlin.\nAssistant: noted', makeModel(), 'test-key',
    )

    const row = db.prepare(
      "SELECT agent_id FROM memories WHERE content = 'User lives in Berlin'",
    ).get() as { agent_id: string }
    expect(row.agent_id).toBe('main')
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
})
