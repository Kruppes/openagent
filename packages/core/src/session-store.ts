/**
 * session-store.ts — Pure functions for session persistence and topic-matching.
 * No class, no LLM, no embeddings — pure keyword extraction and Jaccard similarity.
 */

import type { Database } from './database.js'

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface ArchivedSession {
  id: string
  userId: string
  source: string
  startedAt: string
  endedAt: string
  messageCount: number
  topicTags: string[]
  tokenCount: number
}

// ─────────────────────────────────────────────────────────────────────────────
// Stop-word list (German + English, ~50 words)
// ─────────────────────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  // English
  'the', 'and', 'for', 'that', 'this', 'with', 'have', 'from', 'they', 'will',
  'what', 'when', 'then', 'than', 'there', 'their', 'about', 'which', 'would',
  'could', 'should', 'were', 'been', 'being', 'some', 'into', 'also', 'just',
  'more', 'very', 'your', 'here', 'like', 'over', 'only', 'back', 'other',
  'after', 'such', 'where', 'these',
  // German
  'und', 'der', 'die', 'das', 'ist', 'ich', 'mit', 'ein', 'eine', 'nicht',
  'auch', 'sich', 'von', 'dem', 'des', 'auf', 'wie', 'aber', 'noch', 'bei',
  'oder', 'wenn', 'dann', 'durch', 'wird', 'kann', 'sind', 'alle', 'als',
  'nach', 'hier', 'dass', 'mehr', 'nur', 'schon', 'sein', 'hat', 'haben',
  'wurde', 'aus', 'zum', 'zur',
])

// ─────────────────────────────────────────────────────────────────────────────
// Topic extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract topic fingerprint from an array of text strings.
 * Pure keyword extraction — no LLM, no embedding.
 *
 * Algorithm:
 *  1. Lowercase all text, combine into a single string
 *  2. Split on non-alpha characters
 *  3. Remove stop words and tokens <= 4 chars
 *  4. Count frequency
 *  5. Return top 8 by frequency
 */
export function extractTopicTags(texts: string[]): string[] {
  const combined = texts.join(' ').toLowerCase()

  // Split on any non-letter character (also handles umlauts via \p{L})
  const tokens = combined.split(/[^a-z\u00c0-\u024f]+/)

  const freq = new Map<string, number>()
  for (const token of tokens) {
    // Only keep tokens > 4 chars and not in stop-word list
    if (token.length > 4 && !STOP_WORDS.has(token)) {
      freq.set(token, (freq.get(token) ?? 0) + 1)
    }
  }

  // Sort by frequency descending, return top 8 keys
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word)
}

// ─────────────────────────────────────────────────────────────────────────────
// Topic similarity
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute Jaccard similarity between two tag arrays.
 * Returns a value in [0.0, 1.0].
 */
export function topicOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0
  if (a.length === 0 || b.length === 0) return 0.0

  const setA = new Set(a)
  const setB = new Set(b)

  let intersectionSize = 0
  for (const tag of setA) {
    if (setB.has(tag)) intersectionSize++
  }

  const unionSize = setA.size + setB.size - intersectionSize
  return unionSize === 0 ? 0.0 : intersectionSize / unionSize
}

// ─────────────────────────────────────────────────────────────────────────────
// DB helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the last N archived (ended) sessions for a user, most recent first.
 * Only returns sessions that have ended (ended_at IS NOT NULL).
 */
export function getRecentArchivedSessions(
  db: Database,
  userId: string,
  limit: number,
): ArchivedSession[] {
  const rows = db.prepare(
    `SELECT
       id,
       user_id     AS rawUserId,
       source,
       started_at  AS startedAt,
       ended_at    AS endedAt,
       message_count AS messageCount,
       topic_tags  AS topicTagsJson,
       token_count AS tokenCount
     FROM sessions
     WHERE ended_at IS NOT NULL
       AND (user_id = ? OR user_id IS NULL AND ? IS NULL)
     ORDER BY ended_at DESC
     LIMIT ?`,
  ).all(userId, userId, limit) as Array<{
    id: string
    rawUserId: string | null
    source: string
    startedAt: string
    endedAt: string
    messageCount: number
    topicTagsJson: string | null
    tokenCount: number
  }>

  return rows.map(row => ({
    id: row.id,
    userId: row.rawUserId ?? userId,
    source: row.source,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    messageCount: row.messageCount,
    topicTags: row.topicTagsJson ? (JSON.parse(row.topicTagsJson) as string[]) : [],
    tokenCount: row.tokenCount,
  }))
}

/**
 * Reactivate a previously archived session by clearing its ended_at timestamp.
 */
export function reactivateSession(db: Database, sessionId: string): void {
  db.prepare(
    `UPDATE sessions SET ended_at = NULL WHERE id = ?`,
  ).run(sessionId)
}

/**
 * Persist topic tags for a session as a JSON array.
 */
export function saveTopicTags(db: Database, sessionId: string, tags: string[]): void {
  db.prepare(
    `UPDATE sessions SET topic_tags = ? WHERE id = ?`,
  ).run(JSON.stringify(tags), sessionId)
}

/**
 * Increment the token_count for a session by `delta`.
 */
export function updateTokenCount(db: Database, sessionId: string, delta: number): void {
  db.prepare(
    `UPDATE sessions SET token_count = token_count + ? WHERE id = ?`,
  ).run(delta, sessionId)
}

/**
 * Read the current token_count for a session.
 */
export function getTokenCount(db: Database, sessionId: string): number {
  const row = db.prepare(
    `SELECT token_count FROM sessions WHERE id = ?`,
  ).get(sessionId) as { token_count: number } | undefined
  return row?.token_count ?? 0
}

/**
 * Load all chat_messages for a session and return their text content.
 * Used when computing topic tags for a session that is being archived.
 */
export function getSessionMessageTexts(db: Database, sessionId: string): string[] {
  const rows = db.prepare(
    `SELECT content FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC`,
  ).all(sessionId) as Array<{ content: string }>

  return rows.map(r => r.content)
}
