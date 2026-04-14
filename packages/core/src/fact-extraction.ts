/**
 * fact-extraction.ts — Extract atomic facts from a conversation and store them
 * in the memories table. Called at session-end, after the session summary is written.
 *
 * Uses Ollama /api/chat with a local model (default: gemma4:26b) to extract
 * factual statements worth remembering long-term.
 */

import type { Database } from './database.js'

export interface FactExtractionOptions {
  /** Ollama base URL (default: process.env.OLLAMA_URL || 'http://192.168.10.222:11434') */
  ollamaUrl?: string
  /** Model to use (default: process.env.FACT_EXTRACTION_MODEL || 'gemma4:26b') */
  model?: string
  /** Maximum number of facts to extract (default: 10) */
  maxFacts?: number
  /** Source label stored with each fact (default: 'fact_extraction') */
  source?: string
}

const SYSTEM_PROMPT = `Extract max 10 atomic, factual statements from this conversation. Each fact should be a single sentence. Only extract facts worth remembering long-term. Output one fact per line, nothing else. Skip greetings, small talk, and ephemeral details.`

/**
 * Call Ollama /api/chat to extract facts from conversation text.
 * Returns an array of fact strings (one per line).
 */
export async function callOllamaForFacts(
  conversationHistory: string,
  options?: FactExtractionOptions,
): Promise<string[]> {
  const ollamaUrl = options?.ollamaUrl || process.env.OLLAMA_URL || 'http://192.168.10.222:11434'
  const model = options?.model || process.env.FACT_EXTRACTION_MODEL || 'gemma4:26b'

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: conversationHistory },
    ],
    stream: false,
    // IMPORTANT: gemma4 models require think: false at top level,
    // otherwise you get empty content
    think: false,
  }

  const response = await fetch(`${ollamaUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Ollama API error ${response.status}: ${text}`)
  }

  const data = await response.json() as { message?: { content?: string } }
  const content = data?.message?.content ?? ''

  return parseFactLines(content, options?.maxFacts ?? 10)
}

/**
 * Parse the LLM response into individual fact lines.
 * Strips numbering, bullets, and empty lines.
 */
export function parseFactLines(content: string, maxFacts: number = 10): string[] {
  return content
    .split('\n')
    .map(line => line
      .trim()
      // Remove leading numbering: "1. ", "1) ", "- ", "* "
      .replace(/^\d+[.)]\s*/, '')
      .replace(/^[-*]\s+/, '')
      .trim()
    )
    .filter(line => line.length > 10) // Skip very short / empty lines
    .slice(0, maxFacts)
}

/**
 * Strip trailing punctuation for fuzzy matching.
 */
function stripTrailingPunct(s: string): string {
  return s.replace(/[.!?;:,]+$/, '')
}

/**
 * Check if a very similar fact already exists in the memories table.
 * Uses bidirectional LIKE matching:
 * 1. Check if any stored fact contains the new fact's core (first 40 chars)
 * 2. Check if the new fact contains any stored fact's core text
 */
export function isDuplicateFact(db: Database, fact: string): boolean {
  const normalized = stripTrailingPunct(fact.trim().toLowerCase())
  if (normalized.length === 0) return false

  // Direction 1: Check if any stored fact contains the core of the new fact
  const searchTerm = normalized.length > 40
    ? normalized.slice(0, 40)
    : normalized

  // Escape % and _ for LIKE
  const escaped = searchTerm.replace(/%/g, '\\%').replace(/_/g, '\\_')

  const row1 = db.prepare(
    `SELECT COUNT(*) as cnt FROM memories WHERE LOWER(content) LIKE ? ESCAPE '\\'`
  ).get(`%${escaped}%`) as { cnt: number }

  if (row1.cnt > 0) return true

  // Direction 2: Check if any stored fact's core is contained in the new fact
  const candidates = db.prepare(
    `SELECT content FROM memories`
  ).all() as Array<{ content: string }>

  for (const candidate of candidates) {
    const storedNorm = stripTrailingPunct(candidate.content.trim().toLowerCase())
    const storedCore = storedNorm.length > 40 ? storedNorm.slice(0, 40) : storedNorm
    if (storedCore.length > 10 && normalized.includes(storedCore)) return true
  }

  return false
}

/**
 * Store a single fact in the memories table.
 */
export function storeFact(
  db: Database,
  fact: string,
  source: string = 'fact_extraction',
): void {
  db.prepare(
    `INSERT INTO memories (content, source) VALUES (?, ?)`
  ).run(fact, source)
}

/**
 * Extract atomic facts from a conversation and store them in the memories table.
 *
 * @param db - Database instance
 * @param conversationHistory - The conversation text to extract facts from
 * @param sessionId - Session ID (used for logging)
 * @param options - Extraction options (Ollama URL, model, etc.)
 * @returns Number of new facts stored
 */
export async function extractAndStoreFacts(
  db: Database,
  conversationHistory: string,
  sessionId: string,
  options?: FactExtractionOptions,
): Promise<number> {
  if (!conversationHistory || conversationHistory.trim().length < 50) {
    return 0
  }

  const source = options?.source ?? 'fact_extraction'
  const facts = await callOllamaForFacts(conversationHistory, options)

  let stored = 0
  for (const fact of facts) {
    if (!isDuplicateFact(db, fact)) {
      storeFact(db, fact, source)
      stored++
    }
  }

  if (stored > 0) {
    console.log(`[fact-extraction] Stored ${stored} new facts from session ${sessionId} (${facts.length} extracted, ${facts.length - stored} duplicates skipped)`)
  }

  return stored
}
