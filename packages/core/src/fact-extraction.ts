import type { Api, Model } from '@earendil-works/pi-ai'
import { completeSimple } from './pi-models.js'
import type { Database } from './database.js'
import { createMemory } from './memories-store.js'
import type { ProviderConfig } from './provider-config.js'
import { resolveModelTemperature } from './provider-config.js'
import { resolveBackgroundReasoning } from './thinking-level.js'

const MAX_FACTS = 10
const DUPLICATE_OVERLAP_THRESHOLD = 0.7
const DUPLICATE_SEARCH_LIMIT = 25

const COMMON_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'das', 'der', 'die', 'ein', 'eine', 'einer', 'einem', 'einen',
  'for', 'from', 'i', 'ich', 'in', 'is', 'it', 'mit', 'of', 'on', 'or', 'the', 'to', 'und', 'user', 'uses', 'with',
])

const systemPrompt = `You are a fact extraction assistant. Your job is to extract atomic, reusable facts from a conversation transcript.

Rules:
- Extract a maximum of 10 facts per conversation
- Each fact must be a single, self-contained statement
- Facts should be things worth remembering long-term (preferences, decisions, technical details, personal info)
- Do NOT extract ephemeral details (greetings, temporary commands, one-off questions)
- Do NOT extract opinions or subjective assessments by the assistant
- Write each fact on its own line, prefixed with "- "
- Write facts in the same language as the conversation
- If no facts worth remembering are found, respond with: NO_FACTS

Scope marker (rare exception):
- By default every fact belongs to the current persona. Do NOT add any marker.
- Only in the exceptional case that a fact is clearly actionable for SEVERAL
  personas at once (e.g. cross-cutting project facts like where a shared
  project's pricing lives in the code), prefix it with "[shared] ".
- Persona-specific material is NEVER shared: assignments given to one persona,
  a persona's opinions or assessments, and domain judgments stay unmarked.
- When in doubt, do NOT mark the fact as shared.

Example output:
- User prefers dark mode in all applications
- The project uses PostgreSQL on port 5433 (non-standard)
- [shared] The Halfway pricing model is implemented in packages/pricing/tiers.ts
- Deployment is done via Docker Compose with 3 services`

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function normalizeWord(word: string): string {
  return word
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
}

function getNormalizedWords(text: string): string[] {
  return Array.from(new Set(
    (text.match(/[\p{L}\p{N}]+/gu) ?? [])
      .map(normalizeWord)
      .filter(Boolean)
  ))
}

function getSearchKeywords(text: string): string[] {
  return getNormalizedWords(text)
    .filter(word => word.length >= 3 && !COMMON_WORDS.has(word))
    .sort((a, b) => b.length - a.length)
    .slice(0, 6)
}

function buildFtsOrQuery(keywords: string[]): string {
  return keywords
    .map(keyword => `"${keyword.replaceAll('"', '""')}"`)
    .join(' OR ')
}

function computeWordOverlap(a: string, b: string): number {
  const aWords = new Set(getNormalizedWords(a))
  const bWords = new Set(getNormalizedWords(b))

  if (aWords.size === 0 || bWords.size === 0) {
    return normalizeWhitespace(a).toLowerCase() === normalizeWhitespace(b).toLowerCase() ? 1 : 0
  }

  let intersection = 0
  for (const word of aWords) {
    if (bWords.has(word)) intersection += 1
  }

  return intersection / Math.max(aWords.size, bWords.size)
}

function normalizeFactCandidate(line: string): string {
  const trimmed = line.trim()
  if (!trimmed) return ''

  const withoutPrefix = trimmed
    .replace(/^[-*•]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')

  return normalizeWhitespace(withoutPrefix)
}

interface CandidateRow {
  content: string
}

export type FactScope = 'persona' | 'shared'

export interface ParsedFact {
  content: string
  scope: FactScope
}

const SHARED_MARKER_PATTERN = /^\[shared\]\s*/i

function parseScopedFact(candidate: string): ParsedFact | null {
  if (!candidate) return null

  if (SHARED_MARKER_PATTERN.test(candidate)) {
    const content = normalizeWhitespace(candidate.replace(SHARED_MARKER_PATTERN, ''))
    if (!content) return null
    return { content, scope: 'shared' }
  }

  return { content: candidate, scope: 'persona' }
}

/**
 * Parse an LLM fact extraction response into facts with an explicit scope.
 * A leading "[shared]" marker (set by the extraction LLM) flags a fact as
 * cross-persona; everything else stays scoped to the session's persona.
 */
export function parseFacts(response: string): ParsedFact[] {
  const trimmed = response.trim()
  if (!trimmed || trimmed.toUpperCase() === 'NO_FACTS') {
    return []
  }

  const lines = trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)

  const structuredFacts = lines
    .filter(line => /^([-*•]\s+|\d+[.)]\s+)/.test(line))
    .map(normalizeFactCandidate)
    .map(parseScopedFact)
    .filter((fact): fact is ParsedFact => fact !== null)

  if (structuredFacts.length > 0) {
    return structuredFacts.slice(0, MAX_FACTS)
  }

  return lines
    .map(normalizeFactCandidate)
    .map(parseScopedFact)
    .filter((fact): fact is ParsedFact => fact !== null)
    .slice(0, MAX_FACTS)
}

/**
 * Parse an LLM fact extraction response into a normalized fact array.
 * Scope markers are stripped; use parseFacts() when the scope is needed.
 */
export function parseFactLines(response: string): string[] {
  return parseFacts(response).map(fact => fact.content)
}

/**
 * Check whether a fact already exists for the same user.
 * Uses FTS5 candidate search followed by normalized word-overlap matching.
 */
export function isDuplicateFact(db: Database, userId: number | null, newFact: string, agentId: string = 'main'): boolean {
  const normalizedFact = normalizeWhitespace(newFact)
  if (!normalizedFact) return false

  const keywords = getSearchKeywords(normalizedFact)
  const fallbackWords = getNormalizedWords(normalizedFact).slice(0, 6)
  const queryTerms = keywords.length > 0 ? keywords : fallbackWords
  if (queryTerms.length === 0) return false

  const ftsQuery = buildFtsOrQuery(queryTerms)
  const userClause = userId === null ? 'm.user_id IS NULL' : 'm.user_id = ?'
  // Deduplication happens within the persona's own bucket PLUS the 'shared'
  // bucket: the same fact may legitimately exist for two personas (no
  // cross-persona dedupe — that would silently drop a persona's fact because
  // main already knows it), but a fact that already exists as 'shared' is
  // visible to every persona via retrieval and must not be stored again.
  const params = userId === null
    ? [ftsQuery, agentId, DUPLICATE_SEARCH_LIMIT]
    : [ftsQuery, userId, agentId, DUPLICATE_SEARCH_LIMIT]

  const candidates = db.prepare(`
    SELECT m.content
    FROM memories_fts
    INNER JOIN memories m ON m.id = memories_fts.rowid
    WHERE memories_fts MATCH ? AND ${userClause} AND m.agent_id IN (?, 'shared')
    ORDER BY bm25(memories_fts) ASC, m.timestamp DESC, m.id DESC
    LIMIT ?
  `).all(...params) as CandidateRow[]

  for (const candidate of candidates) {
    if (computeWordOverlap(candidate.content, normalizedFact) > DUPLICATE_OVERLAP_THRESHOLD) {
      return true
    }
  }

  return false
}

/**
 * Store a single extracted fact in the memories table.
 */
export function storeFact(db: Database, userId: number | null, sessionId: string, content: string, agentId: string = 'main'): number {
  return createMemory(db, userId, sessionId, normalizeWhitespace(content), 'extracted_fact', agentId)
}

/**
 * Extract facts from a conversation transcript, deduplicate them, and store new facts.
 */
export async function extractAndStoreFacts(
  db: Database,
  userId: number | null,
  sessionId: string,
  conversationHistory: string,
  model: Model<Api>,
  apiKey: string,
  /**
   * Optional provider config owning the model. When supplied, the helper
   * honors per-model temperature constraints (e.g. Kimi K2 thinking models
   * require temperature=1). When omitted, temperature defaults to 0.
   */
  provider?: Pick<ProviderConfig, 'providerType' | 'models'>,
  /**
   * Persona that owns the session the transcript came from. Facts are
   * stored under this agent_id so persona knowledge stays scoped to the
   * persona (and out of main's fact-injection). Defaults to 'main'.
   */
  agentId: string = 'main',
): Promise<{ extracted: number; stored: number; duplicates: number }> {
  const userMessage = `Analyze the following session transcript and extract atomic facts worth remembering:\n\n<transcript>\n${conversationHistory}\n</transcript>`

  const response = await completeSimple(model, {
    systemPrompt,
    messages: [{
      role: 'user' as const,
      content: userMessage,
      timestamp: Date.now(),
    }],
  }, {
    apiKey,
    temperature: provider ? resolveModelTemperature(provider, model.id, 0) : 0,
    reasoning: resolveBackgroundReasoning(),
  })

  const responseText = response.content
    .filter(item => item.type === 'text')
    .map(item => (item as { type: 'text'; text: string }).text)
    .join('')
    .trim()

  const facts = parseFacts(responseText)
  let stored = 0
  let duplicates = 0

  for (const fact of facts) {
    // isDuplicateFact checks the persona bucket AND 'shared', so a fact the
    // LLM now flags as shared is not stored again if a persona already has it.
    if (isDuplicateFact(db, userId, fact.content, agentId)) {
      duplicates += 1
      continue
    }

    // The extraction LLM decides the scope: '[shared]'-marked facts land in
    // the cross-persona 'shared' bucket (visible to every persona via the
    // agent_id IN (?, 'shared') retrieval filter); everything else stays
    // scoped to the session's persona.
    storeFact(db, userId, sessionId, fact.content, fact.scope === 'shared' ? 'shared' : agentId)
    stored += 1
  }

  return {
    extracted: facts.length,
    stored,
    duplicates,
  }
}
